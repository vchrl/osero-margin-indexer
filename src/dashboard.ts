/**
 * Stage 3: dashboard. Reads ONLY the derived tables (pnl_daily,
 * accrual_segments, ops tables) plus ASSUMPTIONS.md (embedded at build
 * time) and writes a single self-contained dashboard/index.html — inline
 * CSS + vanilla JS only, no build step, no external assets; the only
 * outbound references are etherscan.io links the viewer may click.
 *
 * Refuses to render unless the latest reconcile run exists, is pinned to
 * the same block as the latest accrual run, and has zero failed blocking
 * checks (rows whose check_name does not contain DIAGNOSTIC).
 *
 * Visual identity: design tokens sampled from stablewatch.io/analytics
 * (dark-first palette, card surfaces, radius scale, accent colors, number
 * conventions) — reproduced as values, not copied CSS; their custom font
 * (Innovator Grotesk) is NOT embedded, a metric-similar system stack is
 * used instead. Charts are hand-rolled SVG (susds-indexer lineage) with a
 * vanilla-JS crosshair tooltip.
 *
 * Break-even is computed here at render time, deliberately not stored, in
 * both views (instantaneous and structural); every numeric in the prose
 * and the margin-vs-borrow-rate curve is template-generated from DB state,
 * so the text and chart self-update on future runs.
 */

import "./lib/env.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPool } from "./lib/db.js";
import { rpow, RAY } from "./lib/rpow.js";

const YEAR_S = 31_536_000;

// ---------------------------------------------------------------------------
// Design tokens (sampled from stablewatch.io/analytics, 2026-08-04)
// ---------------------------------------------------------------------------

const T = {
  bg: "#050505", card: "#0d0d0d", subtle: "#080808",
  fg: "rgba(255,255,255,.95)", mutedFg: "rgba(255,255,255,.53)",
  border: "rgba(255,255,255,.08)", accentBg: "#242424",
  brand: "#1857ec", success: "#0bba71", destructive: "#f43f5e", warning: "#f0bf0d",
  sans: `"Innovator Grotesk", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`,
  mono: `"Geist Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace`,
};

// ---------------------------------------------------------------------------
// Etherscan links
// ---------------------------------------------------------------------------

const eBlock = (b: string) => `<a href="https://etherscan.io/block/${b}" target="_blank" rel="noopener">${b}</a>`;
const eTx = (h: string, label?: string) => `<a href="https://etherscan.io/tx/${h}" target="_blank" rel="noopener"><code>${label ?? `${h.slice(0, 10)}…${h.slice(-6)}`}</code></a>`;
const eAddr = (a: string, label: string) => `<a href="https://etherscan.io/address/${a}" target="_blank" rel="noopener"><code>${label}</code></a>`;

// ---------------------------------------------------------------------------
// SVG chart helpers
// ---------------------------------------------------------------------------

const W = 880, H = 300;
const M = { top: 20, right: 56, bottom: 40, left: 64 };
const PW = W - M.left - M.right, PH = H - M.top - M.bottom;

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

interface TooltipPoint { x: number; lines: string[] }

function chartSvg(id: string, yTicks: number[], yFmt: (v: number) => string,
  y: (v: number) => number, xLabels: { x: number; label: string }[],
  body: string, yAxisLabel: string, zeroLine: boolean,
  rightAxis?: { ticks: number[]; fmt: (v: number) => string; y: (v: number) => number; label: string }): string {
  const grid = yTicks.map((t) =>
    `<line class="grid" x1="${M.left}" x2="${M.left + PW}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>` +
    `<text class="tick" x="${M.left - 10}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${yFmt(t)}</text>`).join("");
  const right = rightAxis ? rightAxis.ticks.map((t) =>
    `<text class="tick" x="${M.left + PW + 10}" y="${(rightAxis.y(t) + 4).toFixed(1)}" text-anchor="start">${rightAxis.fmt(t)}</text>`).join("") +
    `<text class="tick" transform="rotate(90)" x="${M.top + PH / 2}" y="${-(W - 12)}" text-anchor="middle">${rightAxis.label}</text>` : "";
  const xAxis = xLabels.map((l) =>
    `<text class="tick" x="${l.x.toFixed(1)}" y="${M.top + PH + 20}" text-anchor="middle">${l.label}</text>`).join("");
  const zero = zeroLine && yTicks[0]! < 0 && yTicks[yTicks.length - 1]! > 0
    ? `<line class="zero" x1="${M.left}" x2="${M.left + PW}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>`
    : "";
  const axisLabel = `<text class="tick" transform="rotate(-90)" x="${-(M.top + PH / 2)}" y="14" text-anchor="middle">${yAxisLabel}</text>`;
  return `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%">
  ${grid}${right}${zero}${axisLabel}${xAxis}
  <line class="axisline" x1="${M.left}" x2="${M.left + PW}" y1="${M.top + PH}" y2="${M.top + PH}"/>
  ${body}
  <line class="crosshair" x1="0" x2="0" y1="${M.top}" y2="${M.top + PH}" style="display:none"/>
  <rect class="hover" x="${M.left}" y="${M.top}" width="${PW}" height="${PH}" fill="transparent"/>
</svg>`;
}

// ---------------------------------------------------------------------------
// Minimal markdown renderer for the embedded ASSUMPTIONS.md
// ---------------------------------------------------------------------------

function mdToHtml(md: string): string {
  const escd = md.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const inline = (s: string) => s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
  const out: string[] = [];
  let list = false, para: string[] = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; } };
  const endList = () => { if (list) { out.push("</ul>"); list = false; } };
  for (const line of escd.split("\n")) {
    if (/^# /.test(line)) { flush(); endList(); continue; } // drop the H1, card has its own title
    if (/^## /.test(line)) { flush(); endList(); out.push(`<h3>${inline(line.slice(3))}</h3>`); continue; }
    if (/^- /.test(line)) { flush(); if (!list) { out.push("<ul>"); list = true; } out.push(`<li>${inline(line.slice(2))}</li>`); continue; }
    if (/^\s+/.test(line) && list) { out[out.length - 1] = out[out.length - 1]!.replace(/<\/li>$/, ` ${inline(line.trim())}</li>`); continue; }
    if (line.trim() === "") { flush(); endList(); continue; }
    para.push(line.trim());
  }
  flush(); endList();
  return out.join("\n");
}

// ---------------------------------------------------------------------------

interface DailyRow {
  day: string; revenue: string; cost: string; net: string;
  margin_bps: string; position_eod: string; utilization_avg: string;
}

const usds = (wei: bigint) => Number(wei) / 1e18;
const fmt = (n: number, d = 2) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (x: number, d = 2) => `${(x * 100).toFixed(d)}%`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function card(title: string, body: string, methodology: string): string {
  return `<section class="card">
  <h2>${title}</h2>
  ${body}
  <details class="method"><summary>Methodology</summary><div class="method-body">${methodology}</div></details>
</section>`;
}

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
  const checks = (await pool.query(
    `SELECT check_name, status FROM ops_reconciliation_runs WHERE run_id = $1 ORDER BY check_name`,
    [reconcile.run_id])).rows as { check_name: string; status: string }[];
  const failed = checks.filter((c) => c.status === "fail" && !c.check_name.includes("DIAGNOSTIC"));
  if (failed.length > 0) {
    throw new Error(`Reconciliation gate failed (${failed.map((c) => c.check_name).join(", ")}); refusing to render.`);
  }

  // ── Inputs ───────────────────────────────────────────────────────────────
  const strategyRow = (await pool.query(
    `SELECT id, atoken, debt_token, rate_strategy FROM strategies WHERE name='sparklend-usds'`)).rows[0] as
    { id: number; atoken: string; debt_token: string; rate_strategy: string };
  const strategyId = strategyRow.id;
  // As-of-pin state: every "current" number below comes from the pinned
  // block — reserve totals + normalized index + reserve factor from
  // pin_snapshots (captured by the accrual run), rates from the last
  // ReserveDataUpdated at or before the pin (piecewise-constant, so those
  // ARE the rates in force at the pin), SSR from the last File at or
  // before the pin. No live reads, no mixed vintages.
  const pin = (await pool.query(
    `SELECT atoken_total_supply::text AS supply, variable_debt_total_supply::text AS debt,
            liquidity_index_normalized::text AS norm, reserve_factor_bps::text AS rf
     FROM pin_snapshots WHERE block_number = $1`, [accrual.pb])).rows[0] as
    { supply: string; debt: string; norm: string; rf: string } | undefined;
  if (!pin) throw new Error(`No pin_snapshots row at block ${accrual.pb}; rerun accrue.`);
  const lastSsr = (await pool.query(
    `SELECT ssr::text AS ssr FROM ssr_changes WHERE block_number <= $1
     ORDER BY block_number DESC, log_index DESC LIMIT 1`, [accrual.pb])).rows[0] as { ssr: string };
  const lastReserve = (await pool.query(
    `SELECT variable_borrow_rate::text AS vbr, liquidity_rate::text AS lr
     FROM reserve_updates WHERE block_number <= $1
     ORDER BY block_number DESC, log_index DESC LIMIT 1`, [accrual.pb])).rows[0] as { vbr: string; lr: string };
  const posRows = (await pool.query(
    `SELECT kind, amount::text AS a, liquidity_index_at::text AS i FROM position_events
     WHERE strategy_id=$1 ORDER BY block_number, log_index`, [strategyId])).rows as
    { kind: string; a: string; i: string }[];
  const term = (await pool.query(
    `SELECT spread_bps::text AS bps FROM strategy_cost_terms WHERE strategy_id=$1
     ORDER BY effective_from DESC LIMIT 1`, [strategyId])).rows[0] as { bps: string };
  const entry = (await pool.query(
    `SELECT transaction_hash, block_number::text AS bn FROM position_events
     WHERE strategy_id=$1 ORDER BY block_number, log_index LIMIT 1`, [strategyId])).rows[0] as
    { transaction_hash: string; bn: string };

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

  const assumptionsHtml = mdToHtml(readFileSync("ASSUMPTIONS.md", "utf8"));

  const annSSR = Number(rpow(BigInt(lastSsr.ssr), BigInt(YEAR_S)) - RAY) / 1e27;
  const spread = Number(term.bps) / 10_000;
  const costRate = annSSR + spread;
  const liqRate = Number(lastReserve.lr) / 1e27;
  const borrowRate = Number(lastReserve.vbr) / 1e27;
  const util = Number(BigInt(pin.debt) * 10n ** 18n / BigInt(pin.supply)) / 1e18;
  const RESERVE_FACTOR = Number(pin.rf) / 10_000;
  let scaled = 0n;
  for (const r of posRows) {
    const sgn = r.kind === "supply" ? 1n : -1n;
    scaled += (sgn * BigInt(r.a) * RAY) / BigInt(r.i);
  }
  const position = usds((scaled * BigInt(pin.norm)) / RAY);
  // Current margin: the final segment's run-rate at the pin — what the
  // position earns minus owes RIGHT NOW, annualized. This decides the
  // headline; cumulative P&L is shown alongside.
  const currentMarginBps = (liqRate - costRate * util) * 1e4;
  const spreadBpsLabel = Number(term.bps).toFixed(0);
  const entryDay = daily[0]!.day;

  const totRev = daily.reduce((a, d) => a + BigInt(d.revenue), 0n);
  const totCost = daily.reduce((a, d) => a + BigInt(d.cost), 0n);
  const totNet = totRev - totCost;
  const windowDays = (Number(window.t1) - Number(window.t0)) / 86_400;
  const annMarginBps = (usds(totNet) / position) * (365 / windowDays) * 10_000;
  const perDay = usds(totNet) / windowDays;
  const lastDayPartial = Number(window.t1) % 86_400 !== 0;
  const partialDay = lastDayPartial ? daily[daily.length - 1]!.day : null;

  // Break-even — instantaneous view (current values, one variable moves).
  const beUtil = liqRate / costRate;
  // Break-even — structural view (the bracket decides the sign).
  const structuralSpread = borrowRate * (1 - RESERVE_FACTOR) - costRate;
  const beBorrowRate = costRate / (1 - RESERVE_FACTOR);
  const beSSR = borrowRate * (1 - RESERVE_FACTOR) - spread;

  const xAt = (i: number) => M.left + sc(i + 0.5, 0, daily.length, 0, PW);

  // ── Chart: cumulative lines ──────────────────────────────────────────────
  let cr = 0n, cc = 0n;
  const cum = daily.map((d) => { cr += BigInt(d.revenue); cc += BigInt(d.cost); return { rev: usds(cr), cost: usds(cc), net: usds(cr - cc) }; });
  const all = cum.flatMap((c) => [c.rev, c.cost, c.net, 0]);
  const cTicks = niceTicks(Math.min(...all), Math.max(...all));
  const cY = (v: number) => sc(v, cTicks[0]!, cTicks[cTicks.length - 1]!, M.top + PH, M.top);
  const linePath = (k: "rev" | "cost" | "net", cls: string) =>
    `<path class="${cls}" d="${cum.map((c, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${cY(c[k]).toFixed(1)}`).join("")}"/>`;
  const dayLabels = daily.map((d, i) => ({
    x: xAt(i), label: d.day.slice(5) + (d.day === partialDay ? "*" : ""),
  })).filter((_, i) => daily.length <= 16 || i % 2 === 0);
  const cumPoints: TooltipPoint[] = daily.map((d, i) => ({
    x: Number(xAt(i).toFixed(1)),
    lines: [
      d.day + (d.day === partialDay ? " (partial day)" : ""),
      `revenue ${fmt(cum[i]!.rev)} USDS`,
      `cost ${fmt(cum[i]!.cost)} USDS`,
      `net ${fmt(cum[i]!.net)} USDS`,
    ],
  }));
  const cumChart = chartSvg("chart-cum", cTicks, (v) => fmt(v, 0), cY, dayLabels,
    linePath("rev", "line-rev") + linePath("cost", "line-cost") + linePath("net", "line-net"),
    "USDS (cumulative)", true);

  // ── Chart: daily margin bars + avg utilization line (right axis) ────────
  const margins = daily.map((d) => Number(d.margin_bps));
  const mTicks = niceTicks(Math.min(0, ...margins), Math.max(0, ...margins));
  const mY = (v: number) => sc(v, mTicks[0]!, mTicks[mTicks.length - 1]!, M.top + PH, M.top);
  const uY = (v: number) => sc(v, 0, 1, M.top + PH, M.top);
  const bw = Math.min(44, (PW / daily.length) * 0.66);
  const bars = daily.map((d, i) => {
    const v = Number(d.margin_bps);
    const y0 = mY(0), y1 = mY(v);
    return `<rect class="${v >= 0 ? "barpos" : "barneg"}" rx="2" x="${(xAt(i) - bw / 2).toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(y1 - y0)).toFixed(1)}"/>`;
  }).join("");
  const utilLine = `<path class="line-util" d="${daily.map((d, i) =>
    `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${uY(Number(d.utilization_avg)).toFixed(1)}`).join("")}"/>`;
  const marginPoints: TooltipPoint[] = daily.map((d, i) => ({
    x: Number(xAt(i).toFixed(1)),
    lines: [
      d.day + (d.day === partialDay ? " (partial day)" : ""),
      `margin ${fmt(Number(d.margin_bps), 1)} bps ann.`,
      `avg utilization ${pct(Number(d.utilization_avg), 1)}`,
    ],
  }));
  const marginChart = chartSvg("chart-margin", mTicks, (v) => fmt(v, 0), mY, dayLabels,
    bars + utilLine, "bps (annualized)", true,
    { ticks: [0, 0.25, 0.5, 0.75, 1], fmt: (v) => `${(v * 100).toFixed(0)}%`, y: uY, label: "avg utilization" });

  // ── Chart: margin vs borrow rate (structural curve) ─────────────────────
  // margin(r) = u × [r × (1−RF) − (SSR+spread)], u/SSR/RF from DB state.
  const R0 = 0.02, R1 = 0.06;
  const marginAt = (r: number) => util * (r * (1 - RESERVE_FACTOR) - costRate) * 1e4;
  const bTicks = niceTicks(Math.min(marginAt(R0), 0), Math.max(marginAt(R1), 0));
  const bY = (v: number) => sc(v, bTicks[0]!, bTicks[bTicks.length - 1]!, M.top + PH, M.top);
  const bX = (r: number) => M.left + sc(r, R0, R1, 0, PW);
  const curve = `<path class="line-rev" d="M${bX(R0).toFixed(1)},${bY(marginAt(R0)).toFixed(1)}L${bX(R1).toFixed(1)},${bY(marginAt(R1)).toFixed(1)}"/>`;
  const shade = `<rect class="gapshade" x="${bX(Math.min(borrowRate, beBorrowRate)).toFixed(1)}" y="${M.top}" width="${Math.abs(bX(beBorrowRate) - bX(borrowRate)).toFixed(1)}" height="${PH}"/>`;
  const mark = (r: number, cls: string, label: string, dy: number) =>
    `<line class="${cls}" x1="${bX(r).toFixed(1)}" x2="${bX(r).toFixed(1)}" y1="${M.top}" y2="${M.top + PH}"/>` +
    `<text class="marklabel ${cls}-t" x="${(bX(r) + 6).toFixed(1)}" y="${M.top + dy}">${label}</text>`;
  const beLabels = [R0, 0.03, 0.04, 0.05, R1].map((r) => ({ x: bX(r), label: pct(r, 0) }));
  const beChart = chartSvg("chart-be", bTicks, (v) => fmt(v, 0), bY, beLabels,
    shade + curve +
    mark(borrowRate, "mark-cur", `current: ${pct(borrowRate)}`, 16) +
    mark(beBorrowRate, "mark-be", `break-even: ${pct(beBorrowRate)}`, 34),
    "margin (bps annualized)", true);

  // ── HTML ─────────────────────────────────────────────────────────────────
  const answer = currentMarginBps >= 0 ? "YES" : "NO";
  const answerColor = currentMarginBps >= 0 ? T.success : T.destructive;
  const rows = daily.map((d) => `<tr><td>${d.day}${d.day === partialDay ? ' <span class="muted">(partial)</span>' : ""}</td>
    <td class="num">${fmt(usds(BigInt(d.revenue)))}</td>
    <td class="num">${fmt(usds(BigInt(d.cost)))}</td>
    <td class="num ${BigInt(d.net) >= 0n ? "good" : "bad"}">${fmt(usds(BigInt(d.net)))}</td>
    <td class="num ${Number(d.margin_bps) >= 0 ? "good" : "bad"}">${fmt(Number(d.margin_bps), 1)}</td>
    <td class="num">${pct(Number(d.utilization_avg), 1)}</td></tr>`).join("\n");

  const checkList = checks.map((c) => {
    const diag = c.check_name.includes("DIAGNOSTIC");
    return `<li><span class="${c.status === "pass" ? "good" : "bad"}">${c.status.toUpperCase()}</span> <code>${esc(c.check_name)}</code>${diag ? ' <span class="muted">(diagnostic, non-blocking)</span>' : ""}</li>`;
  }).join("");

  const inputRows: [string, string, string][] = [
    ["SSR (annualized)", pct(annSSR), 'sUSDS File("ssr"), rpow-annualized'],
    ["Spread owed to Sky", `+${spreadBpsLabel} bps`, "strategy_cost_terms (brief)"],
    ["Cost rate on borrowed portion", pct(costRate), "SSR + spread"],
    ["SparkLend USDS borrow rate", pct(borrowRate), "ReserveDataUpdated"],
    ["Reserve factor", pct(RESERVE_FACTOR, 0), "pin_snapshots (getReserveConfigurationData at pin)"],
    ["Utilization", pct(util), "pin_snapshots (totalSupply at pin)"],
    ["Supply rate (liquidityRate)", pct(liqRate), "ReserveDataUpdated"],
    ["Deployed position", `${fmt(position)} USDS`, "scaled balance × normalized index at pin"],
  ];

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Osero margin — SparkLend USDS</title>
<style>
  :root {
    --bg: ${T.bg}; --card: ${T.card}; --subtle: ${T.subtle};
    --fg: ${T.fg}; --muted-fg: ${T.mutedFg}; --border: ${T.border};
    --accent-bg: ${T.accentBg}; --brand: ${T.brand};
    --success: ${T.success}; --destructive: ${T.destructive}; --warning: ${T.warning};
    color-scheme: dark;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--fg);
    font-family: ${T.sans};
    font-size: 14px; line-height: 1.55;
    max-width: 960px; margin: 0 auto; padding: 2.5rem 1.25rem 4rem;
  }
  h1 { font-size: 1.75rem; font-weight: 600; letter-spacing: -.02em; }
  h2 { font-size: 1rem; font-weight: 600; letter-spacing: -.01em; margin-bottom: .9rem; }
  h3 { font-size: .85rem; font-weight: 600; margin: .8rem 0 .3rem; color: var(--fg); }
  .muted { color: var(--muted-fg); }
  .good { color: var(--success); } .bad { color: var(--destructive); }
  code { font-family: ${T.mono}; font-size: .85em; }
  a { color: var(--brand); text-decoration: none; }
  a:hover { text-decoration: underline; }
  a code { color: inherit; }

  .gate {
    display: inline-flex; align-items: center; gap: .5rem;
    background: var(--card); border: 1px solid var(--border); border-radius: 9999px;
    padding: .3rem .9rem; margin: .9rem 0 1.4rem; font-size: .8rem; color: var(--muted-fg);
  }
  .gate .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success); }

  .headline {
    background: linear-gradient(180deg, color-mix(in srgb, ${answerColor} 9%, var(--card)), var(--card));
    border: 1px solid color-mix(in srgb, ${answerColor} 55%, transparent);
    border-radius: 1rem; padding: 1.5rem 1.75rem; margin-bottom: 1.25rem;
  }
  .headline .big { font-size: 2rem; font-weight: 700; letter-spacing: -.03em; color: ${answerColor}; }
  .headline .sub { color: var(--muted-fg); margin-top: .35rem; }
  .headline .sub strong { color: var(--fg); font-variant-numeric: tabular-nums; }

  .card {
    background: var(--card); border: 1px solid var(--border); border-radius: .875rem;
    padding: 1.4rem 1.6rem; margin-bottom: 1.25rem;
  }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: .75rem; margin-bottom: 1.1rem; }
  .stat { background: var(--subtle); border: 1px solid var(--border); border-radius: .5rem; padding: .8rem 1rem; }
  .stat .k { font-size: .75rem; color: var(--muted-fg); text-transform: uppercase; letter-spacing: .05em; }
  .stat .v { font-family: ${T.mono}; font-size: 1.25rem; font-weight: 600; margin-top: .15rem; font-variant-numeric: tabular-nums; }

  table { border-collapse: collapse; width: 100%; }
  th { font-size: .72rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted-fg); font-weight: 500; }
  th, td { padding: .5rem .65rem; border-bottom: 1px solid var(--border); text-align: left; }
  tbody tr:hover { background: rgba(255,255,255,.025); }
  tr:last-child td { border-bottom: none; }
  .num { text-align: right; font-family: ${T.mono}; font-size: .82rem; font-variant-numeric: tabular-nums; }

  .legend { display: flex; gap: 1.2rem; font-size: .78rem; color: var(--muted-fg); margin-bottom: .4rem; }
  .legend .sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: .4rem; vertical-align: -1px; }

  svg text { font-family: ${T.sans}; }
  svg .tick { font-size: 11px; fill: var(--muted-fg); }
  svg .grid { stroke: rgba(255,255,255,.06); stroke-width: 1; }
  svg .zero { stroke: rgba(255,255,255,.35); stroke-width: 1; stroke-dasharray: 2 3; }
  svg .axisline { stroke: rgba(255,255,255,.14); stroke-width: 1; }
  svg .line-rev { stroke: var(--brand); stroke-width: 2; fill: none; }
  svg .line-cost { stroke: var(--warning); stroke-width: 2; fill: none; }
  svg .line-net { stroke: var(--destructive); stroke-width: 2.4; fill: none; }
  svg .line-util { stroke: var(--brand); stroke-width: 1.8; fill: none; stroke-dasharray: 5 3; }
  svg .barpos { fill: var(--success); } svg .barneg { fill: var(--destructive); }
  svg .crosshair { stroke: rgba(255,255,255,.4); stroke-width: 1; stroke-dasharray: 3 3; pointer-events: none; }
  svg .gapshade { fill: color-mix(in srgb, var(--destructive) 10%, transparent); }
  svg .mark-cur { stroke: var(--warning); stroke-width: 1.4; stroke-dasharray: 4 3; }
  svg .mark-be { stroke: var(--success); stroke-width: 1.4; stroke-dasharray: 4 3; }
  svg .marklabel { font-size: 11px; }
  svg .mark-cur-t { fill: var(--warning); } svg .mark-be-t { fill: var(--success); }

  #tooltip {
    position: fixed; display: none; pointer-events: none; z-index: 10;
    background: var(--accent-bg); border: 1px solid var(--border); border-radius: .5rem;
    padding: .5rem .75rem; font-size: .78rem; font-family: ${T.mono};
    box-shadow: 0 .625rem 1rem 0 rgba(0,0,0,.5); white-space: pre; line-height: 1.6;
  }
  #tooltip .t0 { color: var(--muted-fg); }

  details.method { border-top: 1px solid var(--border); margin-top: 1.1rem; padding-top: .7rem; }
  details.method summary {
    cursor: pointer; list-style: none; font-size: .8rem; color: var(--muted-fg);
    display: flex; align-items: center; gap: .45rem; user-select: none;
  }
  details.method summary::before { content: ""; width: 7px; height: 7px; border-right: 1.5px solid var(--muted-fg); border-bottom: 1.5px solid var(--muted-fg); transform: rotate(-45deg); transition: transform .2s ease-out; }
  details.method[open] summary::before { transform: rotate(45deg); }
  .method-body { font-size: .82rem; color: var(--muted-fg); margin-top: .6rem; }
  .method-body p { margin-bottom: .5rem; } .method-body p:last-child { margin-bottom: 0; }
  .method-body code { color: var(--fg); }
  .method-body ul { margin: .3rem 0 .5rem 1.1rem; }
  .method-body h3 { margin-top: .9rem; }
  .footer { color: var(--muted-fg); font-size: .78rem; margin-top: 1.5rem; }
  @media (max-width: 640px) { .stats { grid-template-columns: 1fr; } }
</style></head><body>

<h1>Is Osero making money?</h1>
<div class="gate"><span class="dot"></span>
  data as of block ${eBlock(accrual.pb)} · reconcile run ${reconcile.run_id} · all blocking checks passed
</div>

<div class="headline">
  <div class="big">${answer} — running at ${fmt(currentMarginBps, 1)} bps as of the pinned block</div>
  <div class="sub"><strong>Current margin</strong> (final segment at pin, annualized): <strong>${fmt(currentMarginBps, 1)} bps</strong>
   · <strong>Cumulative since inception</strong>: net <strong>${fmt(usds(totNet))} USDS</strong>
   (≈ ${fmt(annMarginBps, 1)} bps annualized, ${totNet < 0n ? "losing" : "earning"} ≈ <strong>$${fmt(Math.abs(perDay))}/day</strong>)
   over <strong>${fmt(windowDays, 1)}</strong> days (SparkLend USDS, entered ${entryDay})</div>
  <details class="method"><summary>Methodology</summary><div class="method-body">
    <p><strong>Current margin</strong> = liquidityRate − (SSR + spread) × utilization,
    all as of the pinned block, annualized — the run-rate of the final accrual
    segment. This decides the YES/NO. <strong>Cumulative</strong> = revenue − cost summed
    since the ${eTx(entry.transaction_hash, "1,000,000 USDS entry")} at block ${eBlock(entry.bn)};
    its annualized figure is net ÷ position × (365 ÷ ${fmt(windowDays, 1)} days) in bps.
    Position basis is the ${eAddr(strategyRow.atoken.trim(), "spUSDS")} balance
    (scaled balance × normalized liquidityIndex at the pin).</p>
  </div></details>
</div>

${card("Cumulative P&amp;L since inception", `
<div class="stats">
  <div class="stat"><div class="k">Revenue (supply yield)</div><div class="v">${fmt(usds(totRev))} <span class="muted">USDS</span></div></div>
  <div class="stat"><div class="k">Cost (SSR+${spreadBpsLabel}bps × borrowed)</div><div class="v">${fmt(usds(totCost))} <span class="muted">USDS</span></div></div>
  <div class="stat"><div class="k">Net</div><div class="v ${totNet >= 0n ? "good" : "bad"}">${fmt(usds(totNet))} <span class="muted">USDS</span></div></div>
</div>
<div class="legend"><span><span class="sw" style="background:${T.brand}"></span>revenue</span>
<span><span class="sw" style="background:${T.warning}"></span>cost</span>
<span><span class="sw" style="background:${T.destructive}"></span>net</span></div>
${cumChart}`, `
  <p><strong>Revenue</strong> is liquidityIndex ratio growth on Osero's scaled
  aToken balance: per segment, <code>S × (index_end − index_start)</code>.
  Summing telescopes to the balance identity — reconcile checks #2/#3 assert
  it against <code>spUSDS.balanceOf</code> on-chain to within wei rounding.</p>
  <p><strong>Cost</strong> is <code>(annualized SSR + ${spreadBpsLabel}bps) × position ×
  utilization</code> integrated over piecewise-constant segments whose
  boundaries are every SSR change, reserve update, and position event.
  The +${spreadBpsLabel}bps is modeled as a linear annual spread (the brief does not
  specify compounding; see the Assumptions accordion below) and lives in
  <code>strategy_cost_terms</code> as data, not code.</p>`)}

${card(`Daily margin${partialDay ? ` <span class="muted" style="font-weight:400;font-size:.8rem">— * ${partialDay} is a partial day</span>` : ""}`, `
<div class="legend"><span><span class="sw" style="background:${T.destructive}"></span>daily margin (left, bps ann.)</span>
<span><span class="sw" style="background:${T.brand};height:3px;margin-bottom:3px"></span>avg utilization (right)</span></div>
${marginChart}`, `
  <p>Bars: each UTC day's net (revenue − cost) annualized against the
  end-of-day position, in bps (left axis). Line: that day's time-weighted
  average utilization (right axis) — the bars are flat because utilization
  and rates have been flat; margin moves only when those inputs move.
  Segments are split at UTC midnights; within a segment accrual is linear
  in time, so day attribution is exact under the model. The final day
  covers only the hours up to the pinned block and is marked partial —
  its bar is an annualized rate, so it is comparable, just noisier.</p>`)}

${card("Current inputs", `<table>
<tr><th>Input</th><th class="num">Value</th><th>Source</th></tr>
${inputRows.map(([k, v, s]) => `<tr><td>${k}</td><td class="num">${v}</td><td class="muted">${s}</td></tr>`).join("\n")}
</table>`, `
  <p>All inputs come from the indexed Postgres state at the pinned block —
  the dashboard makes no RPC calls. SSR is the per-second ray rate from
  ${eAddr("0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD", "sUSDS")} <code>File("ssr")</code>
  events, annualized with MakerDAO's exact bigint <code>rpow</code>.
  Utilization = ${eAddr(strategyRow.debt_token.trim(), "variableDebtUSDS")}.totalSupply ÷
  ${eAddr(strategyRow.atoken.trim(), "spUSDS")}.totalSupply from archive snapshots
  (stable debt verified zero and disabled). Reserve factor read from
  <code>getReserveConfigurationData(USDS)</code>; rate curve from the
  ${eAddr(strategyRow.rate_strategy.trim(), "interest rate strategy")} contract.</p>`)}

${card("Break-even", `
<p><strong>Instantaneous view</strong> <span class="muted">(hold everything else at current values)</span>:
margin flips at utilization <strong>${pct(beUtil, 1)}</strong>
(current ${pct(util, 1)} — ${util > beUtil ? "above break-even, margin negative" : "below break-even, margin positive"}),
or at SSR <strong>${pct(beSSR)}</strong> (current ${pct(annSSR)}).
This view is partial: it treats the supply rate as fixed while utilization moves.</p>
<p style="margin:.8rem 0 1rem"><strong>Structural view</strong> <span class="muted">(the real break-even)</span>:
margin per unit deployed = u × [borrowRate × (1 − RF) − (SSR + ${spreadBpsLabel}bps)]
= u × [${pct(borrowRate)} × ${(1 - RESERVE_FACTOR).toFixed(2)} − ${pct(costRate)}]
= u × <strong class="bad">${pct(structuralSpread)}</strong>.
Utilization only scales the magnitude — <em>only the bracketed rate spread flips the sign</em>.
The borrow rate must exceed <strong>${pct(beBorrowRate)}</strong> (currently ${pct(borrowRate)}),
or equivalently SSR must fall below <strong>${pct(beSSR)}</strong> (currently ${pct(annSSR)}).</p>
${beChart}`, `
  <p>The instantaneous view answers "what flips the sign if this one number
  moves and nothing else does." It is internally inconsistent for
  utilization: on Aave-style curves the supply rate itself is a function of
  utilization. The structural identity
  <code>liquidityRate = borrowRate × u × (1 − reserveFactor)</code>
  substitutes that dependence out, leaving
  <code>margin = u × [borrowRate × (1−RF) − (SSR+spread)]</code>:
  utilization scales the magnitude of profit or loss but cannot change its
  sign. Only the rate spread can.</p>
  <p>The chart plots that identity as a function of the borrow rate with
  utilization (${pct(util, 1)}), SSR (${pct(annSSR)}) and RF (${pct(RESERVE_FACTOR, 0)})
  held at their current DB values; the shaded band is the gap between the
  current borrow rate and the break-even crossing. Every number here is
  generated from database state at build time — nothing is hardcoded.</p>`)}

${card("Daily P&amp;L", `<table>
<tr><th>Day (UTC)</th><th class="num">Revenue</th><th class="num">Cost</th><th class="num">Net</th><th class="num">Margin (bps ann.)</th><th class="num">Avg util</th></tr>
${rows}
</table>`, `
  <p><strong>Data provenance:</strong> pinned block ${eBlock(accrual.pb)}
  (hash <code>${accrual.ph.trim()}</code>), entry tx ${eTx(entry.transaction_hash)},
  accrual run ${accrual.run_id} computed ${accrual.computed_at.toISOString()},
  reconcile run ${reconcile.run_id}. The dashboard refuses to render if any
  blocking check fails. Latest run:</p>
  <ul>${checkList}</ul>
  <p>Amounts in USDS (2dp), rates 2dp, margins 1dp bps. Check definitions:
  <code>src/reconcile.ts</code>; conventions: Assumptions below.</p>`)}

<section class="card">
  <h2>Assumptions</h2>
  <details class="method"><summary>Full ASSUMPTIONS.md (embedded at build time)</summary>
  <div class="method-body">${assumptionsHtml}</div></details>
</section>

<p class="footer">Generated from reconciled Postgres state; opening this file makes no network
requests. Numbers are frozen at pinned block ${eBlock(accrual.pb)} and can only change by
rerunning the pipeline through the reconciliation gate.
Visual language after stablewatch.io/analytics.</p>

<div id="tooltip"></div>
<script>
(function () {
  "use strict";
  var tip = document.getElementById("tooltip");
  function attach(id, points) {
    var svg = document.getElementById(id);
    if (!svg) return;
    var cross = svg.querySelector(".crosshair");
    var hover = svg.querySelector(".hover");
    function toSvgX(evt) {
      var r = svg.getBoundingClientRect();
      return (evt.clientX - r.left) * (${W} / r.width);
    }
    hover.addEventListener("mousemove", function (evt) {
      var x = toSvgX(evt), best = 0, bd = 1e9;
      for (var i = 0; i < points.length; i++) {
        var d = Math.abs(points[i].x - x);
        if (d < bd) { bd = d; best = i; }
      }
      var p = points[best];
      cross.setAttribute("x1", p.x); cross.setAttribute("x2", p.x);
      cross.style.display = "";
      tip.innerHTML = p.lines.map(function (l, j) {
        return "<div" + (j === 0 ? " class='t0'" : "") + ">" + l + "</div>";
      }).join("");
      tip.style.display = "block";
      var tw = tip.offsetWidth;
      var left = evt.clientX + 14;
      if (left + tw > window.innerWidth - 8) left = evt.clientX - tw - 14;
      tip.style.left = left + "px";
      tip.style.top = (evt.clientY - 10) + "px";
    });
    hover.addEventListener("mouseleave", function () {
      cross.style.display = "none"; tip.style.display = "none";
    });
  }
  attach("chart-cum", ${JSON.stringify(cumPoints)});
  attach("chart-margin", ${JSON.stringify(marginPoints)});
})();
</script>
</body></html>`;

  mkdirSync("dashboard", { recursive: true });
  writeFileSync("dashboard/index.html", html);
  console.log(`dashboard/index.html written (as of block ${accrual.pb}; net ${fmt(usds(totNet))} USDS, ${fmt(annMarginBps, 1)} bps).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
