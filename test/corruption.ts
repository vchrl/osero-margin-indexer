/**
 * Corruption test: proves the reconciliation gate actually bites.
 *
 * For each of three mutations — a snapshot's debt, the seed SSR row, the
 * cost-term spread — copy the production database, corrupt exactly one raw
 * row, run reconcile against the copy, and assert it EXITS NONZERO. A gate
 * that never fails is indistinguishable from no gate.
 *
 * The copies run with RECONCILE_ARTIFACTS=0 so the deliberately-failing
 * runs cannot clobber dashboard/reconciliation.json or the writeup table.
 *
 * Usage: npx tsx test/corruption.ts  (needs CREATEDB rights; copies are
 * dropped afterward, pass or fail.)
 */

import "../src/lib/env.js";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { DEFAULT_DATABASE_URL } from "../src/lib/db.js";

const prodUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;

interface Mutation {
  label: string;
  sql: string;
}

const MUTATIONS: Mutation[] = [
  {
    // Must be a snapshot INSIDE the accrual window: rows before the first
    // position event are shadowed by later snapshots and legitimately
    // never read by the cost integral (the first draft mutated the
    // earliest row and the gate — correctly — did not care).
    label: "snapshot debt doubled (first in-window reserve_snapshots row)",
    sql: `UPDATE reserve_snapshots SET variable_debt_total_supply = variable_debt_total_supply * 2
          WHERE block_number = (SELECT min(block_number) FROM reserve_snapshots
                                WHERE block_number >= (SELECT min(block_number) FROM position_events))`,
  },
  {
    label: "seed SSR inflated by 1bp-equivalent (earliest ssr_changes row)",
    sql: `UPDATE ssr_changes SET ssr = ssr + 3000000000000000000
          WHERE block_number = (SELECT min(block_number) FROM ssr_changes)`,
  },
  {
    label: "cost-term spread changed 20 -> 200 bps",
    sql: `UPDATE strategy_cost_terms SET spread_bps = 200`,
  },
];

function urls(prod: string, name: string) {
  const base = new URL(prod);
  const dbName = `${base.pathname.slice(1)}_${name}`;
  const admin = new URL(prod); admin.pathname = "/postgres";
  const copy = new URL(prod); copy.pathname = `/${dbName}`;
  return { dbName, adminUrl: admin.toString(), copyUrl: copy.toString(), prodDb: base.pathname.slice(1) };
}

async function main(): Promise<void> {
  let failures = 0;
  for (let i = 0; i < MUTATIONS.length; i++) {
    const m = MUTATIONS[i]!;
    const { dbName, adminUrl, copyUrl, prodDb } = urls(prodUrl, `corruption${i}`);
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    // TEMPLATE copy requires no active connections on the source.
    await admin.query(`CREATE DATABASE ${dbName} TEMPLATE ${prodDb}`);
    await admin.end();

    const copy = new pg.Client({ connectionString: copyUrl });
    await copy.connect();
    await copy.query(m.sql);
    await copy.end();

    const run = spawnSync("npx", ["tsx", "src/reconcile.ts"], {
      env: { ...process.env, DATABASE_URL: copyUrl, RECONCILE_ARTIFACTS: "0" },
      encoding: "utf8",
    });
    const gateFailed = run.status !== 0;
    const failedChecks = (run.stdout.match(/^ {2}FAIL {2}(\S+)/gm) ?? [])
      .map((l) => l.trim().split(/\s+/)[1]);
    console.log(`${gateFailed ? "OK  " : "BAD "} ${m.label}`);
    console.log(`      gate exit ${run.status}; failing checks: ${failedChecks.join(", ") || "(none)"}`);
    if (!gateFailed) failures++;

    const admin2 = new pg.Client({ connectionString: adminUrl });
    await admin2.connect();
    await admin2.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin2.end();
  }
  if (failures > 0) {
    console.error(`\n${failures} mutation(s) were NOT caught by the gate.`);
    process.exit(1);
  }
  console.log("\nAll mutations tripped the gate. Corruption test passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
