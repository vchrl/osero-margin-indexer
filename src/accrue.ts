/**
 * Stage 2: the accrual engine. Reads the raw tables, builds piecewise-
 * constant segments, computes revenue/cost per segment, writes
 * accrual_segments + pnl_daily, and records the run in ops_runs.
 *
 * All conventions documented in ASSUMPTIONS.md. Highlights:
 *  - Revenue = liquidityIndex ratio growth on the scaled position (ground
 *    truth); liquidityRate integration is only a diagnostic cross-check in
 *    reconcile.ts.
 *  - Cost rate = rpow-annualized SSR + linear spread from
 *    strategy_cost_terms (the +20bps is data, not code), applied to
 *    position × utilization. ASSUMPTION: linear annual spread — the brief
 *    does not specify the compounding convention.
 *  - Segments are [start, end); boundary values are the latest at or before
 *    the segment start. Utilization = snapshot at segment start.
 *  - Derived tables are deleted and rebuilt in one transaction per run:
 *    segments are derived data, idempotent by reconstruction.
 */

import "./lib/env.js";
import { toFunctionSelector, padHex } from "viem";
import type pg from "pg";
import { createPool } from "./lib/db.js";
import { makeClient, callUint } from "./lib/client.js";
import { rpow, RAY } from "./lib/rpow.js";
import { SPARK_POOL, SPARK_DATA_PROVIDER, SP_USDS, USDS, USDS_VARIABLE_DEBT } from "./addresses.js";

const YEAR = 31_536_000n;
const WAD = 10n ** 18n;

interface Boundary {
  ts: number; // unix seconds
  block: bigint;
}

interface Row {
  [k: string]: string;
}

/** Latest element of `xs` (sorted by ts asc) with ts <= t; error if none. */
function latestAtOrBefore<T extends { ts: number }>(xs: T[], t: number, what: string): T {
  let lo = 0, hi = xs.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]!.ts <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (ans === -1) throw new Error(`No ${what} at or before t=${t}`);
  return xs[ans]!;
}

async function main(): Promise<void> {
  const pool = createPool();
  const client = makeClient();

  const strategy = await pool.query(`SELECT id FROM strategies WHERE name = 'sparklend-usds'`);
  const strategyId = (strategy.rows[0] as { id: number }).id;

  // Pin to the minimum watermark: every stream is complete up to this block.
  const wm = await pool.query(
    `SELECT min(highest_indexed_block)::text AS b FROM sync_watermarks
     WHERE source IN ('ssr','reserve','position','transfers','snapshots')`,
  );
  const pinnedBlock = BigInt((wm.rows[0] as Row).b!);
  const pinnedMeta = await client.getBlock({ blockNumber: pinnedBlock });
  const pinnedHash = pinnedMeta.hash;
  const pinnedTs = Number(pinnedMeta.timestamp);

  // ── Pin-block state snapshot ─────────────────────────────────────────────
  // Everything the dashboard shows as "current" is as-of THIS block: reserve
  // totals, the normalized (accrued-to-the-second) liquidity index, and the
  // reserve factor. Stored in pin_snapshots so downstream stages never mix
  // "latest event" state with "as of pin" state.
  const usdsArg = padHex(USDS, { size: 32 }).slice(2);
  const [pinAtoken, pinDebt, pinNormIncome, reserveCfg] = await Promise.all([
    callUint(client, SP_USDS, toFunctionSelector("totalSupply()"), pinnedBlock),
    callUint(client, USDS_VARIABLE_DEBT, toFunctionSelector("totalSupply()"), pinnedBlock),
    callUint(client, SPARK_POOL,
      `0x${toFunctionSelector("getReserveNormalizedIncome(address)").slice(2)}${usdsArg}` as `0x${string}`,
      pinnedBlock),
    client.call({
      to: SPARK_DATA_PROVIDER,
      data: `0x${toFunctionSelector("getReserveConfigurationData(address)").slice(2)}${usdsArg}` as `0x${string}`,
      blockNumber: pinnedBlock,
    }),
  ]);
  // getReserveConfigurationData word 4 (0-based) is reserveFactor in bps.
  const pinReserveFactorBps = BigInt(`0x${reserveCfg.data!.slice(2 + 4 * 64, 2 + 5 * 64)}`);
  await pool.query(
    `INSERT INTO pin_snapshots (block_number, atoken_total_supply, variable_debt_total_supply,
       liquidity_index_normalized, reserve_factor_bps)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (chain_id, block_number) DO NOTHING`,
    [pinnedBlock.toString(), pinAtoken.toString(), pinDebt.toString(),
     pinNormIncome.toString(), pinReserveFactorBps.toString()],
  );

  // ── Load raw streams (timestamps from the blocks table) ─────────────────
  const q = (sql: string) => pool.query(sql).then((r) => r.rows as Row[]);

  const positions = await q(`
    SELECT p.block_number::text AS block, extract(epoch FROM b.block_timestamp)::bigint::text AS ts,
           p.kind, p.amount::text AS amount, p.liquidity_index_at::text AS idx
    FROM position_events p JOIN blocks b USING (block_number)
    WHERE p.strategy_id = ${strategyId} ORDER BY p.block_number, p.log_index`);
  if (positions.length === 0) throw new Error("No position events indexed; nothing to accrue.");

  const ssrRows = (await q(`
    SELECT s.block_number::text AS block, extract(epoch FROM b.block_timestamp)::bigint::text AS ts,
           s.ssr::text AS ssr
    FROM ssr_changes s JOIN blocks b USING (block_number) ORDER BY s.block_number, s.log_index`))
    .map((r) => ({ ts: Number(r.ts), block: BigInt(r.block!), ssr: BigInt(r.ssr!) }));

  // Last update per block (log_index order) is the block's closing state.
  const reserveRows = (await q(`
    SELECT DISTINCT ON (r.block_number)
           r.block_number::text AS block, extract(epoch FROM b.block_timestamp)::bigint::text AS ts,
           r.liquidity_rate::text AS rate, r.liquidity_index::text AS idx
    FROM reserve_updates r JOIN blocks b USING (block_number)
    ORDER BY r.block_number, r.log_index DESC`))
    .map((r) => ({ ts: Number(r.ts), block: BigInt(r.block!), rate: BigInt(r.rate!), idx: BigInt(r.idx!) }));
  // Close the index timeline AT the pin: the normalized income accrues the
  // stored stepwise index to the pinned block's second, so the final
  // segment's revenue runs all the way to the pin instead of stopping at the
  // last ReserveDataUpdated. Rate carries over (piecewise-constant).
  if (reserveRows.length > 0 && reserveRows[reserveRows.length - 1]!.ts < pinnedTs) {
    reserveRows.push({
      ts: pinnedTs, block: pinnedBlock,
      rate: reserveRows[reserveRows.length - 1]!.rate, idx: pinNormIncome,
    });
  }

  const snapRows = (await q(`
    SELECT s.block_number::text AS block, extract(epoch FROM b.block_timestamp)::bigint::text AS ts,
           s.atoken_total_supply::text AS supply, s.variable_debt_total_supply::text AS debt
    FROM reserve_snapshots s JOIN blocks b USING (block_number) ORDER BY s.block_number`))
    .map((r) => ({ ts: Number(r.ts), block: BigInt(r.block!), supply: BigInt(r.supply!), debt: BigInt(r.debt!) }));
  if (snapRows.length === 0 || snapRows[snapRows.length - 1]!.ts < pinnedTs) {
    snapRows.push({ ts: pinnedTs, block: pinnedBlock, supply: pinAtoken, debt: pinDebt });
  }

  const terms = (await q(`
    SELECT extract(epoch FROM effective_from)::bigint::text AS ts, spread_bps::text AS bps
    FROM strategy_cost_terms WHERE strategy_id = ${strategyId} ORDER BY effective_from`))
    .map((r) => ({ ts: Number(r.ts), spreadBps: Number(r.bps) }));

  const posEvents = positions.map((r) => ({
    ts: Number(r.ts), block: BigInt(r.block!),
    signedAmount: r.kind === "supply" ? BigInt(r.amount!) : -BigInt(r.amount!),
    idx: BigInt(r.idx!),
  }));

  // ── Boundaries: union of event timestamps in [first position, pinned] ───
  const tStart = posEvents[0]!.ts;

  // Cost-term effective_from timestamps are boundaries too: a renegotiated
  // spread must start a new segment, not be smeared over an old one. Terms
  // have no block of their own; carry the latest reserve block at/before.
  const blockAtOrBefore = (t: number): bigint => {
    let b = reserveRows[0]?.block ?? pinnedBlock;
    for (const r of reserveRows) { if (r.ts <= t) b = r.block; else break; }
    return b;
  };
  const termBoundaries = terms.map((x) => ({ ts: x.ts, block: blockAtOrBefore(x.ts) }));

  const byTs = new Map<number, Boundary>();
  for (const e of [...ssrRows, ...reserveRows, ...posEvents, ...termBoundaries]) {
    if (e.ts >= tStart && e.ts < pinnedTs) {
      const prev = byTs.get(e.ts);
      if (!prev || e.block > prev.block) byTs.set(e.ts, { ts: e.ts, block: e.block });
    }
  }
  byTs.set(pinnedTs, { ts: pinnedTs, block: pinnedBlock });
  const boundaries = [...byTs.values()].sort((a, b) => a.ts - b.ts);

  /**
   * liquidityIndex at an arbitrary boundary time: exact at reserve-update
   * times; linearly interpolated in time inside the surrounding reserve
   * interval otherwise (SSR changes, position events and cost-term starts
   * rarely coincide with a reserve update). Interpolation cancels in the
   * telescoping revenue sum — cumulative revenue is unchanged to the wei —
   * it only moves attribution BETWEEN the two segments sharing the
   * boundary. Documented in ASSUMPTIONS.md.
   */
  const idxAt = (t: number): bigint => {
    let lo: typeof reserveRows[number] | null = null;
    let hi: typeof reserveRows[number] | null = null;
    for (const r of reserveRows) {
      if (r.ts <= t) lo = r;
      else { hi = r; break; }
    }
    if (lo === null) throw new Error(`No reserve index at or before t=${t}`);
    if (lo.ts === t || hi === null) return lo.idx;
    return lo.idx + ((hi.idx - lo.idx) * BigInt(t - lo.ts)) / BigInt(hi.ts - lo.ts);
  };

  // Scaled position S at each boundary: S = Σ ± rayDiv(amount, idx) over
  // events ≤ t, with Aave's HALF-UP rounding (WadRayMath.rayDiv), not floor —
  // the first floor version drifted 1 wei from the contract's scaled balance,
  // which surfaced as a 3-wei miss in check #2 once multiplied by the index.
  const rayDiv = (a: bigint, b: bigint): bigint => (a * RAY + b / 2n) / b;
  const scaledAt = (t: number): bigint => {
    let s = 0n;
    for (const e of posEvents) {
      if (e.ts > t) break;
      s += e.signedAmount >= 0n ? rayDiv(e.signedAmount, e.idx) : -rayDiv(-e.signedAmount, e.idx);
    }
    return s;
  };

  // ── Segments ─────────────────────────────────────────────────────────────
  interface Segment {
    tStart: number; tEnd: number; blockStart: bigint; blockEnd: bigint;
    position: bigint; ssr: bigint; rate: bigint; utilNum: bigint; utilDen: bigint;
    revenue: bigint; cost: bigint;
  }
  const segments: Segment[] = [];
  // Annualized SSR is expensive-ish (rpow); cache per distinct ssr value.
  const annualCache = new Map<bigint, bigint>();
  const annualized = (ssr: bigint): bigint => {
    let a = annualCache.get(ssr);
    if (a === undefined) { a = rpow(ssr, YEAR) - RAY; annualCache.set(ssr, a); }
    return a;
  };

  for (let i = 0; i < boundaries.length - 1; i++) {
    const b0 = boundaries[i]!, b1 = boundaries[i + 1]!;
    const dt = BigInt(b1.ts - b0.ts);
    const S = scaledAt(b0.ts);
    const res0 = latestAtOrBefore(reserveRows, b0.ts, "reserve update");
    const idx0 = idxAt(b0.ts);
    const idx1 = idxAt(b1.ts);
    const snap = latestAtOrBefore(snapRows, b0.ts, "reserve snapshot");
    const ssr = latestAtOrBefore(ssrRows, b0.ts, "ssr change").ssr;
    const term = [...terms].reverse().find((x) => x.ts <= b0.ts);
    if (!term) throw new Error(`No cost term effective at t=${b0.ts}`);

    const position = (S * idx0) / RAY;
    // Revenue: scaled balance × index growth across the segment.
    const revenue = (S * (idx1 - idx0)) / RAY;
    // Cost: position × (annualized SSR + spread) × dt/YEAR × utilization.
    // spread_bps in ray: 1bp = 1e-4 → ×1e23. All-bigint, single floor at end.
    const spreadRay = BigInt(Math.round(term.spreadBps * 1e4)) * 10n ** 19n;
    const costRate = annualized(ssr) + spreadRay;
    const cost = (position * costRate * dt * snap.debt) / (YEAR * RAY * snap.supply);

    segments.push({
      tStart: b0.ts, tEnd: b1.ts, blockStart: b0.block, blockEnd: b1.block,
      position, ssr, rate: res0.rate, utilNum: snap.debt, utilDen: snap.supply,
      revenue, cost,
    });
  }

  // ── Daily rollup: pro-rate each segment across UTC day boundaries ───────
  // Consistent with piecewise-constant rates: within a segment, accrual is
  // linear in time, so second-weighted allocation is exact under the model.
  interface Daily { revenue: bigint; cost: bigint; positionEod: bigint; utilSec: number; sec: number; posDt: number }
  const days = new Map<string, Daily>();
  const dayOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  for (const seg of segments) {
    let t = seg.tStart;
    const util = Number(seg.utilNum) / Number(seg.utilDen);
    // Per-slice flooring would drop up to (slices-1) wei per segment; track
    // what has been allocated and give the remainder to the segment's last
    // slice, so days sum to segments EXACTLY.
    let revAllocated = 0n, costAllocated = 0n;
    while (t < seg.tEnd) {
      const nextMidnight = (Math.floor(t / 86_400) + 1) * 86_400;
      const sliceEnd = Math.min(nextMidnight, seg.tEnd);
      const last = sliceEnd === seg.tEnd;
      const frac = { num: BigInt(sliceEnd - t), den: BigInt(seg.tEnd - seg.tStart) };
      const revSlice = last ? seg.revenue - revAllocated : (seg.revenue * frac.num) / frac.den;
      const costSlice = last ? seg.cost - costAllocated : (seg.cost * frac.num) / frac.den;
      revAllocated += revSlice;
      costAllocated += costSlice;
      const key = dayOf(t);
      const d = days.get(key) ?? { revenue: 0n, cost: 0n, positionEod: 0n, utilSec: 0, sec: 0, posDt: 0 };
      d.revenue += revSlice;
      d.cost += costSlice;
      d.positionEod = seg.position;
      d.utilSec += util * (sliceEnd - t);
      d.sec += sliceEnd - t;
      d.posDt += Number(seg.position) * (sliceEnd - t);
      days.set(key, d);
      t = sliceEnd;
    }
  }

  // ── Persist: rebuild derived tables + record the run, one transaction ───
  const pg_ = await pool.connect();
  try {
    await pg_.query("BEGIN");
    await pg_.query(`DELETE FROM accrual_segments WHERE strategy_id = $1`, [strategyId]);
    await pg_.query(`DELETE FROM pnl_daily WHERE strategy_id = $1`, [strategyId]);

    for (const s of segments) {
      const util = (s.utilNum * WAD) / s.utilDen; // 18-dp fixed point
      await pg_.query(
        `INSERT INTO accrual_segments (strategy_id, t_start, t_end, block_start, block_end,
           position, ssr, liquidity_rate, utilization, revenue, cost)
         VALUES ($1, to_timestamp($2), to_timestamp($3), $4, $5, $6, $7, $8, $9::numeric / 1e18, $10, $11)`,
        [strategyId, s.tStart, s.tEnd, s.blockStart.toString(), s.blockEnd.toString(),
         s.position.toString(), s.ssr.toString(), s.rate.toString(), util.toString(),
         s.revenue.toString(), s.cost.toString()],
      );
    }
    for (const [day, d] of [...days.entries()].sort()) {
      const net = d.revenue - d.cost;
      // Exposure-weighted annualized margin, in bps:
      //   net × YEAR × 1e4 / Σ(position × dt)
      // — position-seconds, not end-of-day position, so partial exposure
      // and mid-day position changes weight correctly. Float is fine for a
      // display metric.
      const marginBps = d.posDt > 0
        ? (Number(net) * Number(YEAR) * 1e4) / d.posDt
        : 0;
      await pg_.query(
        `INSERT INTO pnl_daily (strategy_id, day, revenue, cost, net, margin_bps, position_eod, utilization_avg)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [strategyId, day, d.revenue.toString(), d.cost.toString(), net.toString(),
         marginBps.toFixed(6), d.positionEod.toString(), (d.utilSec / d.sec).toFixed(18)],
      );
    }
    const run = await pg_.query(
      `INSERT INTO ops_runs (kind, pinned_block, pinned_block_hash) VALUES ('accrual', $1, $2)
       RETURNING run_id, computed_at`,
      [pinnedBlock.toString(), pinnedHash],
    );
    await pg_.query("COMMIT");
    const r = run.rows[0] as { run_id: string; computed_at: Date };

    const totRev = segments.reduce((a, s) => a + s.revenue, 0n);
    const totCost = segments.reduce((a, s) => a + s.cost, 0n);
    console.log(`Accrual run ${r.run_id} pinned at block ${pinnedBlock} (${pinnedHash.slice(0, 10)}…)`);
    console.log(`  segments: ${segments.length}, days: ${days.size}`);
    console.log(`  revenue: ${totRev} wei (${Number(totRev) / 1e18} USDS)`);
    console.log(`  cost:    ${totCost} wei (${Number(totCost) / 1e18} USDS)`);
    console.log(`  net:     ${totRev - totCost} wei (${Number(totRev - totCost) / 1e18} USDS)`);
  } catch (error) {
    await pg_.query("ROLLBACK");
    throw error;
  } finally {
    pg_.release();
  }
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
