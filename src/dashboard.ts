/**
 * Stage 3: dashboard. Reads ONLY the derived tables (pnl_daily,
 * accrual_segments, ops tables) and writes a single self-contained
 * dashboard/index.html with inline SVG charts — no JS, no framework, no
 * external assets. "No points for design."
 *
 * Refuses to render unless the latest reconcile run exists, is pinned to
 * the same block as the latest accrual run, and has zero failed blocking
 * checks (rows whose check_name does not contain DIAGNOSTIC).
 *
 * Break-even is computed here at render time, deliberately not stored, in
 * both views:
 *  - instantaneous: holding current rates fixed, what utilization / SSR
 *    flips the sign of margin = liquidityRate − u × (SSR + spread).
 *  - structural: margin per unit deployed
 *      = u × [borrowRate × (1 − reserveFactor) − (SSR + spread)]
 *    so utilization only scales magnitude; the bracket decides the sign.
 *
 * SVG helpers adapted from susds-indexer's charts.ts (hand-rolled scales +
 * 1/2/5 ticks, theme-neutral palette).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createPool } from "./lib/db.js";
import { rpow, RAY } from "./lib/rpow.js";

const YEAR_S = 31_536_000;

/**
 * SparkLend USDS reserveFactor, verified via getReserveConfigurationData at
 * block 25,678,276 (see ASSUMPTIONS.md). A config constant, not indexed
 * state: it has never changed for this reserve; if Spark governance changes
 * it, reconcile check #8 (rate-integral diagnostic) drifts and flags it.
 */
const RESERVE_FACTOR = 0.10;

// ---------------------------------------------------------------------------
// SVG helpers (adapted from susds-indexer charts.ts)
// ---------------------------------------------------------------------------

const W = 920, H = 320;
const M = { top: 40, right: 24, bottom: 44, left: 64 };
const PW = W - M.left - M.right, PH = H - M.top - M.bottom;

const STYLE = `
  text { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 12px; fill: #768390; }
  .title { font-size: 14px; font-weight: 600; }
  .axis { stroke: #768390; stroke-width: 1; }
  .grid { stroke: #768390; stroke-width: 0.5; opacity: 0.25; }
  .rev { stroke: #4493f8; stroke-width: 1.8; fill: none; }
  .cost { stroke: #d29922; stroke-width: 1.8; fill: none; }
  .net { stroke: #f85149; stroke-width: 2.2; fill: none; }
  .pos { fill: #3fb950; } .neg { fill: #f85149; }
`;

const sc = (v: number, d0: number, d1: number, r0: number, r1: number) =>
  d1 === d0 ? r0 : r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);

function niceTicks(min: number, max: number): number[] {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let t = Math.floor(min / step) * step; t <= max + step * 0.999; t += step) ticks.push(t);
  return ticks;
}

function chartFrame(title: string, yTicks: number[], yFmt: (v: number) => string,
  y: (v: number) => number, xLabels: { x: number; label: string }[], body: string): string {
  const grid = yTicks.map((t) =>
    `<line class="grid" x1="${M.left}" x2="${M.left + PW}" y1="${y(t)}" y2="${y(t)}"/>` +
    `<text x="${M.left - 8}" y="${y(t) + 4}" text-anchor="end">${yFmt(t)}</text>`).join("");
  const xAxis = xLabels.map((l) =>
    `<text x="${l.x}" y="${M.top + PH + 18}" text-anchor="middle">${l.label}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%">
  <style>${STYLE}</style>
  <text class="title" x="${M.left}" y="22">${title}</text>
  ${grid}${xAxis}
  <line class="axis" x1="${M.left}" x2="${M.left + PW}" y1="${M.top + PH}" y2="${M.top + PH}"/>
  ${body}</svg>`;
}

// ---------------------------------------------------------------------------

interface DailyRow {
  day: string; revenue: string; cost: string; net: string;
  margin_bps: string; position_eod: string; utilization_avg: string;
}

const usds = (wei: bigint) => Number(wei) / 1e18;
const fmt = (n: number, d = 2) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (x: number, d = 2) => `${(x * 100).toFixed(d)}%`;

async function main(): Promise<void> {
  const pool = createPool();

  // ── Gate ─────────────────────────────────────────────────────────────────
  const accrual = (await pool.query(
    `SELECT run_id, pinned_block::text AS pb, pinned_block_hash AS ph, computed_at
     FROM ops_runs WHERE kind='accrual' ORDER BY run_id DESC LIMIT 1`)).rows[0] as
    { run_id: string; pb: string; ph: string; computed_at: Date } | undefined;
  if (!accrual) throw new Error("No accrual run; run accrue first.");
  const reconcile = (await pool.query(
    `SELECT run_id, pinned_block::text AS pb FROM ops_runs WHERE kind='reconcile'
     ORDER BY run_id DESC LIMIT 1`)).rows[0] as { run_id: string; pb: string } | undefined;
  if (!reconcile || reconcile.pb !== accrual.pb) {
    throw new Error("Latest reconcile run missing or pinned to a different block than the accrual run.");
  }
  const failed = (await pool.query(
    `SELECT check_name FROM ops_reconciliation_runs
     WHERE run_id = $1 AND status = 'fail' AND check_name NOT LIKE '%DIAGNOSTIC%'`,
    [reconcile.run_id])).rows;
  if (failed.length > 0) {
    throw new Error(`Reconciliation gate failed (${failed.map((r) => (r as { check_name: string }).check_name).join(", ")}); refusing to render.`);
  }

  // ── Inputs ───────────────────────────────────────────────────────────────
  const strategyId = ((await pool.query(`SELECT id FROM strategies WHERE name='sparklend-usds'`)).rows[0] as { id: number }).id;
  const lastSeg = (await pool.query(
    `SELECT position::text AS pos, ssr::text AS ssr, liquidity_rate::text AS lr, utilization::text AS u
     FROM accrual_segments WHERE strategy_id=$1 ORDER BY t_start DESC LIMIT 1`, [strategyId])).rows[0] as
    { pos: string; ssr: string; lr: string; u: string };
  const lastReserve = (await pool.query(
    `SELECT variable_borrow_rate::text AS vbr FROM reserve_updates WHERE block_number <= $1
     ORDER BY block_number DESC, log_index DESC LIMIT 1`, [accrual.pb])).rows[0] as { vbr: string };
  const term = (await pool.query(
    `SELECT spread_bps::text AS bps FROM strategy_cost_terms WHERE strategy_id=$1
     ORDER BY effective_from DESC LIMIT 1`, [strategyId])).rows[0] as { bps: string };

  const daily = (await pool.query(
    `SELECT day::text AS day, revenue::text AS revenue, cost::text AS cost, net::text AS net,
            margin_bps::text AS margin_bps, position_eod::text AS position_eod,
            utilization_avg::text AS utilization_avg
     FROM pnl_daily WHERE strategy_id=$1 ORDER BY day`, [strategyId])).rows as DailyRow[];
  const window = (await pool.query(
    `SELECT extract(epoch FROM min(t_start))::bigint::text AS t0,
            extract(epoch FROM max(t_end))::bigint::text AS t1
     FROM accrual_segments WHERE strategy_id=$1`, [strategyId])).rows[0] as { t0: string; t1: string };
  await pool.end();

  const annSSR = Number(rpow(BigInt(lastSeg.ssr), BigInt(YEAR_S)) - RAY) / 1e27;
  const spread = Number(term.bps) / 10_000;
  const costRate = annSSR + spread;
  const liqRate = Number(lastSeg.lr) / 1e27;
  const borrowRate = Number(lastReserve.vbr) / 1e27;
  const util = Number(lastSeg.u);
  const position = usds(BigInt(lastSeg.pos));

  const totRev = daily.reduce((a, d) => a + BigInt(d.revenue), 0n);
  const totCost = daily.reduce((a, d) => a + BigInt(d.cost), 0n);
  const totNet = totRev - totCost;
  const windowDays = (Number(window.t1) - Number(window.t0)) / 86_400;
  const annMarginBps = (usds(totNet) / position) * (365 / windowDays) * 10_000;
  const perDay = usds(totNet) / windowDays;

  // Break-even — instantaneous view (current values, one variable moves).
  const beUtil = liqRate / costRate;
  // Break-even — structural view (the bracket decides the sign).
  const structuralSpread = borrowRate * (1 - RESERVE_FACTOR) - costRate;
  const beBorrowRate = costRate / (1 - RESERVE_FACTOR);
  const beSSR = borrowRate * (1 - RESERVE_FACTOR) - spread;

  // ── Charts ───────────────────────────────────────────────────────────────
  const margins = daily.map((d) => Number(d.margin_bps));
  const mTicks = niceTicks(Math.min(0, ...margins), Math.max(0, ...margins));
  const mY = (v: number) => sc(v, mTicks[0]!, mTicks[mTicks.length - 1]!, M.top + PH, M.top);
  const bw = Math.min(48, (PW / daily.length) * 0.7);
  const bars = daily.map((d, i) => {
    const x = M.left + sc(i + 0.5, 0, daily.length, 0, PW) - bw / 2;
    const v = Number(d.margin_bps);
    const y0 = mY(0), y1 = mY(v);
    return `<rect class="${v >= 0 ? "pos" : "neg"}" x="${x}" y="${Math.min(y0, y1)}" width="${bw}" height="${Math.abs(y1 - y0)}"/>`;
  }).join("");
  const mLabels = daily.map((d, i) => ({
    x: M.left + sc(i + 0.5, 0, daily.length, 0, PW), label: d.day.slice(5),
  })).filter((_, i) => daily.length <= 16 || i % 2 === 0);
  const marginChart = chartFrame("Daily margin (annualized bps on deployed position)",
    mTicks, (v) => fmt(v, 0), mY, mLabels, bars);

  let cr = 0n, cc = 0n;
  const cum = daily.map((d) => { cr += BigInt(d.revenue); cc += BigInt(d.cost); return { rev: usds(cr), cost: usds(cc), net: usds(cr - cc) }; });
  const all = cum.flatMap((c) => [c.rev, c.cost, c.net, 0]);
  const cTicks = niceTicks(Math.min(...all), Math.max(...all));
  const cY = (v: number) => sc(v, cTicks[0]!, cTicks[cTicks.length - 1]!, M.top + PH, M.top);
  const cX = (i: number) => M.left + sc(i + 0.5, 0, daily.length, 0, PW);
  const path = (k: "rev" | "cost" | "net") =>
    `<path class="${k}" d="${cum.map((c, i) => `${i === 0 ? "M" : "L"}${cX(i).toFixed(1)},${cY(c[k]).toFixed(1)}`).join("")}"/>`;
  const legend = `<text x="${M.left + PW - 220}" y="22"><tspan fill="#4493f8">■ revenue</tspan>  <tspan fill="#d29922">■ cost</tspan>  <tspan fill="#f85149">■ net</tspan></text>`;
  const cumChart = chartFrame("Cumulative revenue / cost / net (USDS)",
    cTicks, (v) => fmt(v, 0), cY, mLabels, path("rev") + path("cost") + path("net") + legend);

  // ── HTML ─────────────────────────────────────────────────────────────────
  const answer = totNet >= 0n ? "YES" : "NO";
  const rows = daily.map((d) => `<tr><td>${d.day}</td>
    <td class="num">${fmt(usds(BigInt(d.revenue)), 4)}</td>
    <td class="num">${fmt(usds(BigInt(d.cost)), 4)}</td>
    <td class="num ${BigInt(d.net) >= 0n ? "good" : "bad"}">${fmt(usds(BigInt(d.net)), 4)}</td>
    <td class="num ${Number(d.margin_bps) >= 0 ? "good" : "bad"}">${fmt(Number(d.margin_bps), 1)}</td>
    <td class="num">${pct(Number(d.utilization_avg), 1)}</td></tr>`).join("\n");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Osero margin — SparkLend USDS</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
  .headline { border: 2px solid ${totNet >= 0n ? "#3fb950" : "#f85149"}; border-radius: 8px; padding: 1rem 1.4rem; margin: 1.2rem 0; }
  .headline .big { font-size: 1.6rem; font-weight: 700; color: ${totNet >= 0n ? "#3fb950" : "#f85149"}; }
  table { border-collapse: collapse; width: 100%; margin: .8rem 0; }
  th, td { padding: .35rem .6rem; border-bottom: 1px solid #76839044; text-align: left; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .good { color: #3fb950; } .bad { color: #f85149; }
  .asof { opacity: .7; font-size: .85rem; }
  code { font-size: .9em; }
</style></head><body>
<h1>Is Osero making money? — SparkLend USDS strategy</h1>
<p class="asof">Data as of block <strong>${accrual.pb}</strong>
 (${accrual.ph.slice(0, 14)}…), computed ${accrual.computed_at.toISOString()},
 reconcile run ${reconcile.run_id}: all blocking checks passed.</p>

<div class="headline">
  <div class="big">${answer} — net ${fmt(usds(totNet))} USDS since inception</div>
  <div>Annualized margin ≈ <strong>${fmt(annMarginBps, 1)} bps</strong> on the deployed position
   · ${totNet < 0n ? "losing" : "earning"} ≈ <strong>$${fmt(Math.abs(perDay))}/day</strong>
   over ${fmt(windowDays, 1)} days</div>
</div>

<h2>Current inputs</h2>
<table>
<tr><th>Input</th><th class="num">Value</th><th>Source</th></tr>
<tr><td>SSR (annualized)</td><td class="num">${pct(annSSR)}</td><td>sUSDS File("ssr"), rpow-annualized</td></tr>
<tr><td>Spread owed to Sky</td><td class="num">+${Number(term.bps).toFixed(0)} bps</td><td>strategy_cost_terms (brief)</td></tr>
<tr><td>Cost rate on borrowed portion</td><td class="num">${pct(costRate)}</td><td>SSR + spread</td></tr>
<tr><td>SparkLend USDS borrow rate</td><td class="num">${pct(borrowRate)}</td><td>ReserveDataUpdated</td></tr>
<tr><td>Reserve factor</td><td class="num">${pct(RESERVE_FACTOR, 0)}</td><td>getReserveConfigurationData</td></tr>
<tr><td>Utilization</td><td class="num">${pct(util, 2)}</td><td>totalSupply snapshots</td></tr>
<tr><td>Supply rate (liquidityRate)</td><td class="num">${pct(liqRate)}</td><td>ReserveDataUpdated</td></tr>
<tr><td>Deployed position</td><td class="num">${fmt(position)} USDS</td><td>scaled balance × liquidityIndex</td></tr>
</table>

<h2>Cumulative P&amp;L since inception (2026-07-24 entry)</h2>
<table>
<tr><th>Revenue (supply yield)</th><th>Cost (SSR+${Number(term.bps).toFixed(0)}bps × borrowed share)</th><th>Net</th></tr>
<tr><td class="num">${fmt(usds(totRev), 2)} USDS</td>
    <td class="num">${fmt(usds(totCost), 2)} USDS</td>
    <td class="num ${totNet >= 0n ? "good" : "bad"}"><strong>${fmt(usds(totNet), 2)} USDS</strong></td></tr>
</table>
${cumChart}
${marginChart}

<h2>Break-even</h2>
<p><strong>Instantaneous view</strong> (hold everything else at current values):
margin flips at utilization <strong>${pct(beUtil, 1)}</strong>
(current: ${pct(util, 1)} — ${util > beUtil ? "above" : "below"} break-even, margin ${util > beUtil ? "negative" : "positive"}), or at SSR
<strong>${pct(beSSR)}</strong> (current: ${pct(annSSR)}).
This view is partial: it treats the supply rate as fixed while utilization moves.</p>
<p><strong>Structural view</strong> (the real break-even):
margin per unit deployed = u × [borrowRate × (1 − RF) − (SSR + ${Number(term.bps).toFixed(0)}bps)]
= u × [${pct(borrowRate)} × ${(1 - RESERVE_FACTOR).toFixed(2)} − ${pct(costRate)}]
= u × <strong>${pct(structuralSpread)}</strong>.
Utilization only scales the magnitude — <em>only the bracketed rate spread flips the sign</em>.
At current SSR the borrow rate must exceed <strong>${pct(beBorrowRate)}</strong>
(currently ${pct(borrowRate)}); equivalently, at the current borrow rate the SSR must fall below
<strong>${pct(beSSR)}</strong> (currently ${pct(annSSR)}).</p>

<h2>Daily P&amp;L</h2>
<table>
<tr><th>Day (UTC)</th><th class="num">Revenue</th><th class="num">Cost</th><th class="num">Net</th><th class="num">Margin (bps ann.)</th><th class="num">Avg util</th></tr>
${rows}
</table>
<p class="asof">Generated by <code>src/dashboard.ts</code> from reconciled Postgres state only —
no live RPC calls at render time. Conventions: ASSUMPTIONS.md.</p>
</body></html>`;

  mkdirSync("dashboard", { recursive: true });
  writeFileSync("dashboard/index.html", html);
  console.log(`dashboard/index.html written (as of block ${accrual.pb}; net ${fmt(usds(totNet))} USDS, ${fmt(annMarginBps, 1)} bps).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
