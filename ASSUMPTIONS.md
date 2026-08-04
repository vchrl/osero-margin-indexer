# Assumptions & conventions

Every modeling choice the accrual engine makes, with the on-chain evidence
behind it. Anything the brief leaves unspecified is flagged **ASSUMPTION**.

## Utilization

- Two defensible definitions exist and they are NOT equal:
  1. `debt / aToken.totalSupply()` — supplier-claims basis (what the cost
     engine uses);
  2. `debt / (availableLiquidity + debt)` — the rate-model ratio Aave's
     interest rate strategy computes rates from.
- Cost attribution uses definition 1: pro-rata attribution of the borrowed
  amount over supplier claims exactly exhausts total debt (conservation —
  every borrowed dollar is attributed to exactly one supplier dollar).
  Definition 2 leaves the treasury-accrual gap unattributed: aToken
  totalSupply excludes yield accrued to the Spark treasury but not yet
  minted, so `availableLiquidity + debt` exceeds it. Measured as of block
  25,682,510: gap 67,414 USDS on a ~727M reserve, a utilization difference
  of 0.0058pp, worth roughly 6 cents of cost over this window. These
  figures move with the pin; the authoritative current values are the
  check-9 (`9_DIAGNOSTIC_utilization_definitions`) row that reconcile
  writes to `ops_reconciliation_runs` every run.
- The structural break-even identity
  (`liquidityRate = borrowRate × u × (1 − RF)`) uses the rate-model ratio
  (definition 2), because that is the u the IRS actually prices from; where
  the dashboard quotes utilization it states which definition it is using.
- Sampling: archive `eth_call` at every block with a `ReserveDataUpdated`
  event (table `reserve_snapshots`), plus an as-of-pin snapshot
  (`pin_snapshots`) each accrual run.
- Stable debt is excluded because it is zero and disabled:
  `stableDebtToken.totalSupply()` (`0xDFf828d767E560cf94E4907b2e60673E772748A4`)
  returned `0` at block 25,678,276 (2026-08-04 UTC), and
  `getReserveConfigurationData(USDS)` returns
  `stableRateBorrowingEnabled = false`.
- Segments use the snapshot at the **segment start** boundary,
  piecewise-constant until the next boundary — consistent with Aave forward
  rate semantics (rates set at an update apply until the next update).

## Cost side (what Osero owes Sky)

- Basis: SSR + 20bps on the **borrowed portion** of deployed USDS:
  `cost_rate(t) = (annualized_SSR(t) + 0.0020) × utilization(t)`, applied to
  the deployed position.
- **ASSUMPTION — spread convention**: the brief does not specify how the
  +20bps combines with SSR. Conventions range from a linear annual add
  (chosen: `(ssr/1e27)^31,536,000 − 1 + 0.0020`) to a multiplicative APY
  combination (`(1+SSR_apy)(1+0.0020) − 1`). The largest alternative
  differs by ~0.7bps in rate, ≈1.36 USDS of cost over this window
  as of block 25,683,360 (0.002 × SSR_apy applied to the borrowed
  exposure). Stored as data
  in `strategy_cost_terms`, not hardcoded.
- SSR history is piecewise-constant from sUSDS `File("ssr")` events plus a
  seeded `eth_call` at range start. In the strategy window: ray
  1.000000001121484774769253326 (≈3.60% APY) until block 25,596,101
  (2026-07-22), then ray 1.000000001096988989836188433 (≈3.52% APY).
- The on-chain stability fee (jug duty) for ALLOCATOR-PRYSM-A is 0%; the
  SSR+20bps cost is an off-chain commercial arrangement, which is why it is
  modeled here rather than read from the chain.

## Revenue side (what SparkLend pays Osero)

- Ground truth is **liquidityIndex ratio growth** on Osero's scaled aToken
  balance: `revenue(seg) = position × (index_end / index_start − 1)`.
  Integrating `liquidityRate` over time is used only as a reconciliation
  cross-check, never as the primary number.
- At segment boundaries that are not reserve updates (SSR changes, position
  events, cost-term starts), the liquidityIndex is **linearly interpolated
  in time** within the surrounding reserve interval. Interpolation cancels
  in the telescoping sum — cumulative revenue is unchanged to the wei — it
  only affects attribution between the two segments sharing the boundary.
- Position basis: aToken `balanceOf(ALM proxy)` equivalent at segment start
  (scaled balance × segment-start liquidityIndex).

## Structural margin (dashboard + writeup)

- Margin per unit deployed
  = `utilization × [variableBorrowRate × (1 − reserveFactor) − (SSR + 20bps)]`.
  Utilization scales the magnitude; **only the bracketed rate spread flips
  the sign**. The instantaneous "break-even utilization" view is shown too,
  but the rate spread is the real break-even.
- `reserveFactor(USDS)` = **10%** (1000bp), read from
  `getReserveConfigurationData(USDS)` at block 25,678,276.
- Interest rate strategy `0x8a95998639A34462A1FdAaaA5506F66F90Ef2fDd`
  parameters (same block): base variable rate 0%, slope1 ≈ 4.7095%
  (0x26f4adcf307fb60c42eb80 ray), slope2 = 15%, optimal usage ratio
  (kink) = 80%. Used for break-even and what-if math on the dashboard.

## Time & interval conventions

- Day-count: actual seconds / 31,536,000 (365-day year), matching both
  MakerDAO rpow-per-second math and Aave ray-per-second rate semantics.
- Segments are half-open `[start, end)`: a boundary event's new values apply
  from its own timestamp forward. No gaps, no overlaps — enforced by
  reconciliation check #4.
- Timestamps come from `blocks` (real block timestamps), never
  blocks-per-second approximations.

## Address provenance

All SparkLend addresses were resolved on-chain (never trusted from memory):
`Pool.ADDRESSES_PROVIDER()` → `getPoolDataProvider()` →
`getReserveTokensAddresses(USDS)` / `getInterestRateStrategyAddress(USDS)`.
The reconcile suite re-runs these two calls every run and compares against
the stored `strategies` row (regression guard for the checksum bug caught
during the build — two hand-cased addresses failed EIP-55 validation).
