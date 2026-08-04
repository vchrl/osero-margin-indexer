/**
 * Stage 2.5: reconciliation gate. Runs after accrue.ts, writes one row per
 * check to ops_reconciliation_runs, and exits nonzero if any BLOCKING check
 * fails — CI and the dashboard both refuse to proceed on a failed gate.
 *
 * Blocking checks:
 *  1. draws − repays (USDS mint/burn legs through the buffer) == vat.urns art
 *  2. scaled position × liquidityIndex == spUSDS.balanceOf(ALM proxy)
 *  3. Σ segment revenue == balanceOf growth over principal
 *  4. segment continuity: no gaps/overlaps between consecutive segments
 *  5. USDS.balanceOf(AllocatorBuffer) == net transfer flow into the buffer
 *  6. stored debt_token/rate_strategy == fresh on-chain resolution
 *     (regression guard for the EIP-55 checksum bug caught in this build)
 *  7. chi at the in-range File("ssr") block == rpow-recomputed chi from the
 *     seed row (validates the SSR math the cost integral rests on)
 *
 * Diagnostic (non-blocking):
 *  8. Σ(liquidityRate × position × Δt / YEAR) vs telescoped index revenue.
 *     Checks #2/#3 are mathematically dependent (revenue telescopes to the
 *     balance identity); this is the independent cross-validation of the
 *     rate stream against the index stream. Expected to differ by rate/index
 *     rounding and intra-block timing; documented tolerance 0.5%.
 *
 * Checks #2/#3 compare AT the pinned block using the normalized
 * (accrued-to-the-second) liquidity index captured in pin_snapshots by the
 * accrual run — the same quantity balanceOf uses internally, so the
 * assertion holds at the pin itself rather than at the last update block.
 */

import "./lib/env.js";
import { padHex, toFunctionSelector, stringToHex } from "viem";
import { createPool } from "./lib/db.js";
import { makeClient, callUint } from "./lib/client.js";
import { rpow, RAY } from "./lib/rpow.js";
import {
  ALM_PROXY, ALLOCATOR_BUFFER, ALLOCATOR_VAULT, MCD_VAT, SPARK_DATA_PROVIDER,
  SP_USDS, SUSDS, USDS,
} from "./addresses.js";

const YEAR = 31_536_000n;
const ZERO = "0x0000000000000000000000000000000000000000";
const ILK = stringToHex("ALLOCATOR-PRYSM-A", { size: 32 });

interface CheckResult {
  name: string;
  expected: string;
  actual: string;
  tolerance: string;
  blocking: boolean;
}

function abs(x: bigint): bigint { return x < 0n ? -x : x; }

async function main(): Promise<void> {
  const pool = createPool();
  const client = makeClient();

  const runRow = await pool.query(
    `SELECT run_id, pinned_block::text AS pb FROM ops_runs WHERE kind = 'accrual'
     ORDER BY run_id DESC LIMIT 1`,
  );
  if (runRow.rows.length === 0) throw new Error("No accrual run found; run accrue first.");
  const accrualRun = runRow.rows[0] as { run_id: string; pb: string };
  const pinned = BigInt(accrualRun.pb);

  const strategyRow = await pool.query(
    `SELECT id, debt_token, rate_strategy FROM strategies WHERE name = 'sparklend-usds'`,
  );
  const strategy = strategyRow.rows[0] as { id: number; debt_token: string; rate_strategy: string };

  // Index for balance checks: the normalized (accrued-to-the-second) index
  // at the pin, captured by the accrual run in pin_snapshots.
  const idxRow = await pool.query(
    `SELECT liquidity_index_normalized::text AS i FROM pin_snapshots WHERE block_number = $1`,
    [pinned.toString()],
  );
  if (idxRow.rows.length === 0) throw new Error(`No pin_snapshots row at block ${pinned}; rerun accrue.`);
  const idxBlock = pinned;
  const indexAt = BigInt((idxRow.rows[0] as { i: string }).i);

  const results: CheckResult[] = [];

  // ── 1. draws − repays == vat.urns(ilk, AllocatorVault).art ──────────────
  {
    const flows = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN from_addr = $1 THEN amount ELSE -amount END), 0)::text AS net
       FROM usds_transfers WHERE from_addr = $1 OR to_addr = $1`, [ZERO],
    );
    // Mints are from 0x0 (draw), burns to 0x0 (repay/wipe).
    const netDrawn = BigInt((flows.rows[0] as { net: string }).net);
    const urnData = await client.call({
      to: MCD_VAT,
      data: `0x${toFunctionSelector("urns(bytes32,address)").slice(2)}${ILK.slice(2)}${padHex(ALLOCATOR_VAULT, { size: 32 }).slice(2)}` as `0x${string}`,
      blockNumber: pinned,
    });
    const art = BigInt(`0x${urnData.data!.slice(2 + 64, 2 + 128)}`);
    const rate = await (async () => {
      const d = await client.call({
        to: MCD_VAT,
        data: `0x${toFunctionSelector("ilks(bytes32)").slice(2)}${ILK.slice(2)}` as `0x${string}`,
        blockNumber: pinned,
      });
      return BigInt(`0x${d.data!.slice(2 + 64, 2 + 128)}`);
    })();
    if (rate !== RAY) console.warn(`  NOTE: ilk rate != RAY (${rate}); art is normalized debt`);
    results.push({
      name: "1_draws_minus_repays_eq_vat_art",
      expected: art.toString(), actual: netDrawn.toString(), tolerance: "0", blocking: true,
    });
  }

  // ── 2. scaled × index == balanceOf(ALM proxy) at idxBlock ───────────────
  const scaledRow = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN kind = 'supply' THEN (amount * 1e27::numeric) / liquidity_index_at
                              ELSE -((amount * 1e27::numeric) / liquidity_index_at) END), 0)::numeric(78,0)::text AS s
     FROM position_events WHERE strategy_id = $1`, [strategy.id],
  );
  // SQL division truncates differently than bigint floor for negatives; the
  // single supply event makes this moot, but recompute in JS to be safe.
  const posRows = await pool.query(
    `SELECT kind, amount::text AS a, liquidity_index_at::text AS i FROM position_events
     WHERE strategy_id = $1 ORDER BY block_number, log_index`, [strategy.id],
  );
  let scaled = 0n;
  let principal = 0n;
  for (const r of posRows.rows as { kind: string; a: string; i: string }[]) {
    const amt = BigInt(r.a);
    const idx = BigInt(r.i);
    // Aave rayDiv rounds half-up; mirror it exactly (see accrue.ts).
    const sc = (amt * RAY + idx / 2n) / idx;
    scaled += r.kind === "supply" ? sc : -sc;
    principal += r.kind === "supply" ? amt : -amt;
  }
  void scaledRow;
  const balSelector = toFunctionSelector("balanceOf(address)");
  const balData = `0x${balSelector.slice(2)}${padHex(ALM_PROXY, { size: 32 }).slice(2)}` as `0x${string}`;
  const balanceAtIdx = await callUint(client, SP_USDS, balData, idxBlock);
  const computedBalance = (scaled * indexAt) / RAY;
  results.push({
    name: "2_scaled_times_index_eq_balanceOf",
    expected: balanceAtIdx.toString(), actual: computedBalance.toString(),
    tolerance: "2", blocking: true, // aToken rayMul rounds half-up; we floor
  });

  // ── 3. Σ revenue == balance growth over principal ────────────────────────
  const segAgg = await pool.query(
    `SELECT COALESCE(SUM(revenue), 0)::text AS rev, COALESCE(SUM(cost), 0)::text AS cost, COUNT(*)::int AS n
     FROM accrual_segments WHERE strategy_id = $1`, [strategy.id],
  );
  const seg = segAgg.rows[0] as { rev: string; cost: string; n: number };
  const sumRevenue = BigInt(seg.rev);
  results.push({
    name: "3_sum_revenue_eq_balance_growth",
    expected: (balanceAtIdx - principal).toString(), actual: sumRevenue.toString(),
    // Per-segment floor division loses < 1 wei per segment.
    tolerance: (BigInt(seg.n) + 2n).toString(), blocking: true,
  });

  // ── 4. Segment continuity (pure SQL) ─────────────────────────────────────
  const gaps = await pool.query(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT t_end, LEAD(t_start) OVER (ORDER BY t_start) AS next_start
       FROM accrual_segments WHERE strategy_id = $1
     ) x WHERE next_start IS NOT NULL AND next_start <> t_end`, [strategy.id],
  );
  results.push({
    name: "4_segment_continuity",
    expected: "0", actual: String((gaps.rows[0] as { n: number }).n),
    tolerance: "0", blocking: true,
  });

  // ── 5. Buffer balance == net transfer flow into buffer ──────────────────
  {
    const buf = ALLOCATOR_BUFFER.toLowerCase();
    const flows = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN to_addr = $1 THEN amount ELSE -amount END), 0)::text AS net
       FROM usds_transfers WHERE to_addr = $1 OR from_addr = $1`, [buf],
    );
    const expectedBuf = BigInt((flows.rows[0] as { net: string }).net);
    const bufData = `0x${balSelector.slice(2)}${padHex(ALLOCATOR_BUFFER, { size: 32 }).slice(2)}` as `0x${string}`;
    const actualBuf = await callUint(client, USDS, bufData, pinned);
    results.push({
      name: "5_buffer_balance_eq_net_flow",
      expected: expectedBuf.toString(), actual: actualBuf.toString(),
      tolerance: "0", blocking: true,
    });
  }

  // ── 6. Address regression guard ──────────────────────────────────────────
  {
    const usdsArg = padHex(USDS, { size: 32 }).slice(2);
    const tokens = await client.call({
      to: SPARK_DATA_PROVIDER,
      data: `0x${toFunctionSelector("getReserveTokensAddresses(address)").slice(2)}${usdsArg}` as `0x${string}`,
      blockNumber: pinned,
    });
    const freshDebt = `0x${tokens.data!.slice(2 + 128 + 24, 2 + 192)}`;
    const irs = await client.call({
      to: SPARK_DATA_PROVIDER,
      data: `0x${toFunctionSelector("getInterestRateStrategyAddress(address)").slice(2)}${usdsArg}` as `0x${string}`,
      blockNumber: pinned,
    });
    const freshIrs = `0x${irs.data!.slice(2 + 24, 2 + 64)}`;
    const stored = `${strategy.debt_token.trim().toLowerCase()},${strategy.rate_strategy.trim().toLowerCase()}`;
    results.push({
      name: "6_stored_addresses_eq_fresh_resolution",
      expected: `${freshDebt},${freshIrs}`, actual: stored,
      tolerance: "0", blocking: true,
    });
  }

  // ── 7. rpow chi recomputation across the in-range File("ssr") ───────────
  {
    const rows = await pool.query(
      `SELECT s.block_number::text AS bn, s.ssr::text AS ssr, s.chi::text AS chi,
              extract(epoch FROM b.block_timestamp)::bigint::text AS ts
       FROM ssr_changes s JOIN blocks b USING (block_number)
       ORDER BY s.block_number`,
    );
    const ssrs = rows.rows as { bn: string; ssr: string; chi: string; ts: string }[];
    if (ssrs.length >= 2) {
      const [a, b] = [ssrs[0]!, ssrs[1]!];
      // The seed chi (read via eth_call, not from a drip) corresponds to
      // rho — the last drip timestamp — NOT the seed block's timestamp.
      // First run of this check compounded from the block time and failed
      // by exactly the drip lag (~8e-8 relative ≈ 72s of accrual); read rho
      // at the seed block and compound from there. The File-row chi needs
      // no such correction: file() drips in the same tx, so its chi is
      // current as of the File block timestamp.
      const rho = await callUint(
        client, SUSDS, toFunctionSelector("rho()"), BigInt(a.bn),
      );
      const dt = BigInt(b.ts) - rho;
      const recomputed = (rpow(BigInt(a.ssr), dt) * BigInt(a.chi)) / RAY;
      results.push({
        name: "7_chi_rpow_recomputation",
        expected: b.chi, actual: recomputed.toString(),
        // chi compounds via per-drip rpow legs between our two observation
        // points; composing one rpow over the whole interval differs by
        // accumulated per-drip rounding. ~1e10 ray units ≈ 1e-17 relative.
        tolerance: "10000000000", blocking: true,
      });
    }
  }

  // ── 9. DIAGNOSTIC: three utilization definitions at the pin ─────────────
  // (a) debt / aToken totalSupply — what the cost engine uses: pro-rata
  //     attribution over supplier claims exactly exhausts total debt.
  // (b) debt / (availableLiquidity + debt) — the rate-model ratio Aave's
  //     IRS computes rates from.
  // (c) liquidityRate / (variableBorrowRate × (1 − RF)) — the utilization
  //     implied by the posted rates via the structural identity.
  // The (a)-(b) gap is the treasury accrual not yet minted as aTokens;
  // recorded every run so drift is visible, never blocking.
  {
    const pinRow = (await pool.query(
      `SELECT atoken_total_supply::text AS supply, variable_debt_total_supply::text AS debt,
              reserve_factor_bps::text AS rf FROM pin_snapshots WHERE block_number = $1`,
      [pinned.toString()])).rows[0] as { supply: string; debt: string; rf: string };
    const availData = `0x${balSelector.slice(2)}${padHex(SP_USDS, { size: 32 }).slice(2)}` as `0x${string}`;
    const avail = await callUint(client, USDS, availData, pinned);
    const rates = (await pool.query(
      `SELECT liquidity_rate::text AS lr, variable_borrow_rate::text AS vbr
       FROM reserve_updates WHERE block_number <= $1
       ORDER BY block_number DESC, log_index DESC LIMIT 1`, [pinned.toString()])).rows[0] as
      { lr: string; vbr: string };
    const supply = Number(pinRow.supply), debt = Number(pinRow.debt);
    const rf = Number(pinRow.rf) / 10_000;
    const a = debt / supply;
    const b = debt / (Number(avail) + debt);
    const c = Number(rates.lr) / (Number(rates.vbr) * (1 - rf));
    const p6 = (x: number) => x.toFixed(6);
    results.push({
      name: "9_DIAGNOSTIC_utilization_definitions",
      expected: `a_debt_over_atokenSupply=${p6(a)}`,
      actual: `b_debt_over_availPlusDebt=${p6(b)};c_rate_implied=${p6(c)};delta_b_a=${p6(b - a)};delta_c_a=${p6(c - a)};atokenSupply_minus_availPlusDebt_usds=${((supply - Number(avail) - debt) / 1e18).toFixed(2)}`,
      tolerance: "diagnostic", blocking: false,
    });
  }

  // ── 8. DIAGNOSTIC: rate-integrated vs index-telescoped revenue ──────────
  {
    const rateRev = await pool.query(
      `SELECT COALESCE(SUM( (position * liquidity_rate / 1e27::numeric)
                            * extract(epoch FROM (t_end - t_start)) / ${Number(YEAR)} ), 0)::numeric(78,0)::text AS r
       FROM accrual_segments WHERE strategy_id = $1`, [strategy.id],
    );
    const integrated = BigInt((rateRev.rows[0] as { r: string }).r);
    // 0.5% of telescoped revenue: rate/index rounding + intra-block timing.
    const tol = sumRevenue / 200n;
    results.push({
      name: "8_DIAGNOSTIC_rate_integral_vs_index_revenue",
      expected: sumRevenue.toString(), actual: integrated.toString(),
      tolerance: tol.toString(), blocking: false,
    });
  }

  // ── Persist + report ─────────────────────────────────────────────────────
  const pinnedHash = (await client.getBlock({ blockNumber: pinned })).hash;
  const c = await pool.connect();
  let failedBlocking = 0;
  try {
    await c.query("BEGIN");
    const run = await c.query(
      `INSERT INTO ops_runs (kind, pinned_block, pinned_block_hash) VALUES ('reconcile', $1, $2)
       RETURNING run_id`, [pinned.toString(), pinnedHash],
    );
    const runId = (run.rows[0] as { run_id: string }).run_id;
    console.log(`Reconcile run ${runId} pinned at block ${pinned}\n`);
    for (const r of results) {
      const diff = abs(
        (/^-?\d+$/.test(r.expected) ? BigInt(r.expected) : 0n) -
        (/^-?\d+$/.test(r.actual) ? BigInt(r.actual) : 0n),
      );
      const numeric = /^-?\d+$/.test(r.expected) && /^-?\d+$/.test(r.actual);
      // Non-numeric diagnostics are informational recordings (e.g. the
      // three utilization definitions): they cannot fail, only be read.
      const pass = numeric ? diff <= BigInt(r.tolerance)
        : r.blocking ? r.expected === r.actual : true;
      const status = pass ? "pass" : "fail";
      if (!pass && r.blocking) failedBlocking++;
      await c.query(
        `INSERT INTO ops_reconciliation_runs
           (run_id, check_name, pinned_block, expected, actual, difference, tolerance, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [runId, r.name, pinned.toString(), r.expected, r.actual,
         numeric ? diff.toString() : (pass ? "0" : "mismatch"), r.tolerance, status],
      );
      const tag = r.blocking ? "" : " (diagnostic)";
      console.log(`  ${pass ? "PASS" : "FAIL"}${tag}  ${r.name}`);
      console.log(`        expected ${r.expected}`);
      console.log(`        actual   ${r.actual}  (tolerance ${r.tolerance})`);
    }
    await c.query("COMMIT");
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
  await pool.end();

  if (failedBlocking > 0) {
    console.error(`\n${failedBlocking} blocking check(s) failed — dashboard generation is blocked.`);
    process.exit(1);
  }
  console.log("\nAll blocking checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
