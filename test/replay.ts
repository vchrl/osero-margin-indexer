/**
 * Equivalence test: a fresh-database full replay pinned to block B must
 * produce byte-identical derived tables (accrual_segments, pnl_daily) to the
 * incrementally-built production database at the same B.
 *
 * Proves that watermark-resumed incremental syncs converge to the same
 * state as a from-scratch backfill — the property that makes crash/resume
 * and the daily GH Actions refresh trustworthy.
 *
 * Usage: DATABASE_URL=<prod db> npx tsx test/replay.ts
 * Creates/drops <dbname>_replaytest on the same server. Needs RPC access;
 * takes ~10min (full re-index of the range).
 */

import { execFileSync } from "node:child_process";
import pg from "pg";
import { DEFAULT_DATABASE_URL } from "../src/lib/db.js";

const prodUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;

function replayUrl(prod: string): { url: string; dbName: string; adminUrl: string } {
  const u = new URL(prod);
  const dbName = `${u.pathname.slice(1)}_replaytest`;
  const admin = new URL(prod);
  admin.pathname = "/postgres";
  const r = new URL(prod);
  r.pathname = `/${dbName}`;
  return { url: r.toString(), dbName, adminUrl: admin.toString() };
}

async function fetchDerived(url: string): Promise<{ segments: unknown[]; daily: unknown[] }> {
  const pool = new pg.Pool({ connectionString: url });
  // id/run ids are serial artifacts, not derived state — exclude them.
  const segments = (await pool.query(
    `SELECT strategy_id, extract(epoch FROM t_start) AS ts, extract(epoch FROM t_end) AS te,
            block_start, block_end, position::text, ssr::text, liquidity_rate::text,
            utilization::text, revenue::text, cost::text
     FROM accrual_segments ORDER BY strategy_id, t_start`,
  )).rows;
  const daily = (await pool.query(
    `SELECT strategy_id, day, revenue::text, cost::text, net::text, margin_bps::text,
            position_eod::text, utilization_avg::text
     FROM pnl_daily ORDER BY strategy_id, day`,
  )).rows;
  await pool.end();
  return { segments, daily };
}

async function main(): Promise<void> {
  const prodPool = new pg.Pool({ connectionString: prodUrl });
  const run = await prodPool.query(
    `SELECT pinned_block::text AS b FROM ops_runs WHERE kind = 'accrual' ORDER BY run_id DESC LIMIT 1`,
  );
  if (run.rows.length === 0) throw new Error("No accrual run in production DB.");
  const pinned = (run.rows[0] as { b: string }).b;
  await prodPool.end();

  const { url, dbName, adminUrl } = replayUrl(prodUrl);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  console.log(`Replaying from scratch into ${dbName}, pinned to block ${pinned}...`);

  const env = { ...process.env, DATABASE_URL: url, END_BLOCK: pinned };
  for (const script of ["src/index.ts", "src/accrue.ts", "src/reconcile.ts"]) {
    console.log(`\n=== ${script} (replay) ===`);
    execFileSync("npx", ["tsx", script], { env, stdio: "inherit" });
  }

  const [prod, replay] = [await fetchDerived(prodUrl), await fetchDerived(url)];
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const segOk = eq(prod.segments, replay.segments);
  const dailyOk = eq(prod.daily, replay.daily);
  console.log(`\naccrual_segments: prod ${prod.segments.length} rows, replay ${replay.segments.length} rows — ${segOk ? "IDENTICAL" : "MISMATCH"}`);
  console.log(`pnl_daily:        prod ${prod.daily.length} rows, replay ${replay.daily.length} rows — ${dailyOk ? "IDENTICAL" : "MISMATCH"}`);
  if (!segOk || !dailyOk) {
    for (let i = 0; i < Math.max(prod.segments.length, replay.segments.length); i++) {
      if (!eq(prod.segments[i], replay.segments[i])) {
        console.error(`first segment mismatch at row ${i}:`);
        console.error("  prod:  ", JSON.stringify(prod.segments[i]));
        console.error("  replay:", JSON.stringify(replay.segments[i]));
        break;
      }
    }
    process.exit(1);
  }
  console.log("\nEquivalence holds: incremental == full replay.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
