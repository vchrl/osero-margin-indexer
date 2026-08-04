# Writeup: Is Osero making money?

Answer: no. Since the Jul 24 entry the SparkLend USDS position has earned 595.93 USDS in supply yield and owed 675.20 USDS to Sky, a net of -79.28 USDS over 10.7 days, roughly -27 bps annualized on the 1M deployed. The reason is structural, not incidental: at the current rate configuration, every borrowed dollar loses money regardless of utilization. Section 6 covers what I would do about it.

Everything below reconciles against chain state at pinned block 25,678,138. The [dashboard](dashboard/index.html) refuses to render if any blocking check fails.

## 1. How I found everything

Starting anchors: the ilk `ALLOCATOR-PRYSM-A` and the ALM proxy `0x6d370e359e9cbd0Fd35Bb38fAF705D84238CB884`.

**Step 1, Chainlog.** An allocator ilk means the Sky allocator system, so the entry point is the Chainlog (`0xdA0Ab1e0017DEbCd72Be8599041a2aa3bA7e740F`, JSON mirror at chainlog.sky.money/api/mainnet/active.json). Filtering keys for PRYSM gave the vault, buffer, sub-proxy and StarGuard directly, plus the shared allocator infrastructure (ALLOCATOR_ROLES, ALLOCATOR_REGISTRY) and the core contracts (MCD_VAT, MCD_JUG, USDS, SUSDS).

**Step 2, governance history.** Searching vote.sky.money for the ilk dated the lifecycle. The Feb 26, 2026 executive initialized the ilk (line 10M, gap 10M, duty 0%, ttl 24h) with the same vault and buffer addresses the Chainlog carries, which cross-confirmed step 1. The Jul 16, 2026 executive is where the strategy appears: it onboards a Diamond PAU Controller on the Osero instance, authorizes the ALM proxy on the vault and buffer, whitelists it on the LitePSM, onboards "SparkLend USDS (spUSDS)" with rate limits, and cuts the ceiling to 5M with a 1M gap. The accompanying Atlas edit sets maximum exposure at 5,000,000 USDS and a 100% capital ratio requirement. That named the venue before I touched a single transaction.

**Step 3, verify on chain.** Governance text is a claim, not a fact, so I traced the ALM proxy itself. It has exactly two transactions. Deployment on Jun 23, 2026 (block 25,383,064) by the PAUFactory, plus role grants. Then one action on Jul 24, 2026 (block 25,601,435, tx `0xff40710593559c22a5a795dd4725a1a12447d350f28564d16fe732ba3d1c19f3`): in a single atomic transaction the proxy draws 1,000,000 USDS from the AllocatorVault, pulls it from the buffer, approves, and calls `Pool.supply` on SparkLend, receiving 1,000,000 spUSDS minted to itself. The trace confirmed the venue, resolved the spUSDS aToken address, and established that this is the entire position history: one entry, no withdrawals, no second draw.

**Step 4, resolve the venue's own contracts on chain.** I did not trust any remembered or third-party address for the SparkLend periphery. From the Pool: `ADDRESSES_PROVIDER()` then `getPoolDataProvider()` gives the ProtocolDataProvider, and from it `getReserveTokensAddresses(USDS)` and `getInterestRateStrategyAddress(USDS)` give the aToken (matching the trace exactly), the variable debt token, and the rate strategy. The reconcile suite re-runs this resolution every run and compares it to the stored values.

**Dead ends worth naming.** "Prysm" collides badly in search with the Prysm Ethereum consensus client and the Pryzm chain; queries had to be anchored with Sky or allocator terms. The naming triangle of sUSDS (the Sky savings vault), spUSDS (the SparkLend aToken for USDS) and Spark's separate savings products cost me one careful re-read of the Spark docs to keep straight; they are three different things and only one of them is the venue. The Sky forum blocks automated access, so spell details came from the executive vote pages and the spell addresses themselves.

## 2. Contract appendix

| Contract | Address | Role | How identified |
|---|---|---|---|
| ALM Proxy | 0x6d370e359e9cbd0Fd35Bb38fAF705D84238CB884 | Holds the spUSDS position, executes all capital movement via doCall | Given in brief; behavior verified by full tx trace |
| AllocatorVault | 0x146181Aa9B362EaEC2eC3aDd7429a06D53B43d1a | draw/wipe USDS against the ilk; is itself the urn in the vat | Chainlog ALLOCATOR_PRYSM_A_VAULT; confirmed by Feb 26 exec and the draw call in the entry tx |
| AllocatorBuffer | 0xD0BB61b34771146e31055f20f329cDf97429F889 | USDS transit between vault and proxy | Chainlog; confirmed by transferFrom in the entry tx |
| SubProxy | 0x24fdcd3bFA5C2553e05B2f9AD0365EBC296278D3 | Governance sub-proxy executing Osero proxy spells | Chainlog PRYSM_SUBPROXY |
| StarGuard | 0xBfA2D1dA838E55A74c61699e164cDFF8cF0cF0e2 | Whitelists Osero proxy spells | Chainlog PRYSM_STARGUARD |
| MCD_VAT | 0x35D1b3F3D7966A1DFe207aa4514C12a259A0492B | Core accounting; vat.urns(ilk, vault).art is the drawn debt | Chainlog; used in reconcile check 1 |
| MCD_JUG | 0x19c0976f590D67707E62397C87829d896Dc0f1F1 | Stability fee; duty is 0% for this ilk | Chainlog; confirms the brief's statement that the cost is not an on-chain accrual |
| USDS | 0xdC035D45d973E3EC169d2276DDab16f1e407384F | The stablecoin | Chainlog |
| sUSDS | 0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD | SSR source; File("ssr") events give the rate history | Chainlog; I had indexed this contract before (see section 8) |
| SparkLend Pool | 0xC13e21B648A5Ee794902342038FF3aDAB66BE987 | The venue; Supply/Withdraw/ReserveDataUpdated | Named by Jul 16 exec; confirmed as the supply target in the entry tx |
| spUSDS aToken | 0xC02aB1A5eaA8d1B114EF786D9bde108cD4364359 | Osero's position token; balanceOf includes accrued yield | Minted to the proxy in the entry tx; matches getReserveTokensAddresses |
| USDS variable debt token | 0x8c147debea24Fb98ade8dDa4bf142992928b449e | totalSupply is the borrowed side of utilization | getReserveTokensAddresses(USDS) |
| USDS stable debt token | 0xDFf828d767E560cf94E4907b2e60673E772748A4 | Zero supply, stable borrowing disabled; excluded from utilization with evidence recorded | getReserveTokensAddresses(USDS) |
| Interest rate strategy | 0x8a95998639A34462A1FdAaaA5506F66F90Ef2fDd | Rate curve params (base 0%, slope1 ~4.71%, slope2 15%, kink 80%) used for break-even | getInterestRateStrategyAddress(USDS) |
| ProtocolDataProvider | 0xFc21d6d146E6086B8359705C8b28512a983db0cb | Canonical address resolution | Pool.ADDRESSES_PROVIDER() then getPoolDataProvider() |
| LitePSM USDC | 0xf6e72Db5454dd049d0788e411b06CfAF16853042 | Proxy whitelisted here in the Jul 16 exec; unused so far, no USDC leg exists in the history | Jul 16 exec text; no matching transfers found |

## 3. The economics, including what I got wrong

**The mechanic.** Osero owes Sky SSR plus 20 bps, but only on the slice of its deployed USDS that someone downstream actually borrowed. In a pooled market like SparkLend, capital is fungible, so Osero's borrowed slice is its position times the reserve's utilization. Idle liquidity in the pool costs nothing and earns nothing.

**Which utilization.** Two definitions are defensible and they differ: debt over aToken totalSupply (supplier-claims basis), and debt over availableLiquidity plus debt (the ratio Aave's rate model prices from). Cost attribution uses the first, because pro-rata attribution over supplier claims exactly exhausts total debt — conservation; every borrowed dollar lands on exactly one supplier dollar. The second leaves the treasury-accrual gap unattributed: aToken supply excludes yield accrued to the Spark treasury but not yet minted. Measured as of block 25,682,510, that gap is 67,414 USDS on a ~727M reserve, 0.0058pp of utilization, roughly 6 cents of cost over this window; the live values are re-recorded every run in the check-9 row of `ops_reconciliation_runs`, so quote that row, not this sentence, for current numbers. The structural break-even identity uses the rate-model ratio, since that is what the IRS actually prices from; reconcile diagnostic check 9 records both definitions and their deltas every run ([ASSUMPTIONS.md](ASSUMPTIONS.md)).

**Revenue.** The ground truth for what SparkLend pays is the liquidity index. The aToken balance is scaled balance times the index, so revenue over any window is the scaled position times the index growth. Summing per-segment revenue telescopes to exactly the balance growth, which makes the primary number immune to segment boundary errors. Integrating the posted liquidityRate over time is used only as an independent cross-check (check 8), never as the primary number. This mirrors how the contract itself computes balances.

**Cost.** There is no contract that reports it, as the brief says: jug duty is 0% and the obligation is commercial. So the engine computes a piecewise integral. Boundaries are the union of SSR changes, reserve updates and position events; within a segment every input is constant, so cost is position times (annualized SSR plus 20 bps) times utilization times elapsed seconds over a 365-day year. The 20 bps convention is not specified in the brief; I model it as a linear annual spread on the rpow-annualized SSR ([ASSUMPTIONS.md](ASSUMPTIONS.md)), record it as data in `strategy_cost_terms` rather than code, and flag it in section 7. A per-second compounded spread would differ by well under 0.1 bp at these magnitudes.

**What I got wrong first.**

First, the chi cross-check. Reconcile check 7 recomputes chi at the Jul 22 File block from the previous rate and elapsed time using an exact bigint port of MakerDAO's rpow. My first version compounded from the seed block's timestamp and failed by a small, stable amount. The miss was exactly the drip lag: a chi value read via eth_call corresponds to rho, the last drip time, not the block time of the read. Compounding from rho() fixed it to a residual of about 1,000 ray units, roughly 1e-24 in relative terms; the remaining dust comes from intermediate rounding in rpow's ray arithmetic. The failing check did its job; the bug never reached the P&L.

Second, two addresses I typed by hand (the variable debt token and the rate strategy) had invalid EIP-55 casing. viem rejected them. The fix was to stop hand-casing anything: every periphery address is resolved on chain, and check 6 now re-resolves and compares on every run so a future regression cannot slip through.

Third, a refinement rather than a bug. My first break-even framing was "margin flips at 54.6% utilization." That view is internally inconsistent on an Aave-style curve, because the supply rate is itself a function of utilization. Substituting liquidityRate = borrowRate x utilization x (1 - reserveFactor) gives margin per unit deployed = utilization x [borrowRate x (1 - RF) - (SSR + 20bps)]. Utilization scales the magnitude of profit or loss; only the bracketed rate spread can flip the sign. With the borrow rate at 3.65%, RF at 10% and the cost rate at 3.72%, the bracket is -0.44%. The [dashboard](src/dashboard.ts) shows both views and says which one is real.

## 4. Data model, and why

Three stages, physically separate scripts writing separate tables, so each can be tested and replaced independently.

Raw tables (stage 1, indexer): one table per event stream (`ssr_changes`, `reserve_updates`, `position_events`, `usds_transfers`, `reserve_snapshots`), amounts as NUMERIC(78,0) raw wei/ray, natural key (block_number, log_index), per-stream watermarks, real block timestamps in a `blocks` table. One deliberate deviation: `ssr_changes` stores File("ssr") events, not Drip events. Drip fires on every sUSDS deposit and withdrawal, thousands of times a month, while the SSR changed four times in five months; the accrual engine only needs the piecewise-constant rate history, and the drip mechanics still get exercised through check 7.

Derived tables (stage 2, accrual engine): `accrual_segments` (one row per interval where all inputs are constant; half-open [start, end); position, SSR, utilization, revenue, cost per segment) and `pnl_daily` (segments split exactly at UTC midnights, so daily attribution is exact under the model, not prorated). Both are rebuilt transactionally each run; derived data is idempotent by reconstruction.

Ops tables: `ops_runs` (pinned block, block hash, computed_at per run), `ops_reconciliation_runs` (every check result with expected, actual, difference and tolerance), `strategy_cost_terms` (the 20 bps spread as data with its source cited, because a commercial assumption should not masquerade as chain state).

Extension path: `strategies` carries venue, chain_id, and the token addresses, and every derived row is keyed by strategy_id. A second venue is a new strategies row, a venue adapter for its events, and no schema rewrite. That claim is tested in practice by the fact that all venue-specific addresses live in one row today.

## 5. Validation against on-chain reality

Eight checks run after every accrual, write their results to `ops_reconciliation_runs`, and gate the dashboard: a failed blocking check exits nonzero and nothing renders. At block 25,678,138:

| # | Check | Type | Result |
|---|---|---|---|
| 1 | Sum of draws minus repays equals vat.urns(ilk).art | exact | pass, 0 (both exactly 1,000,000e18) |
| 2 | Scaled balance x index equals spUSDS.balanceOf(proxy) | tolerance 2 wei | pass, observed difference 1 wei (aToken rounds half-up, engine floors) |
| 3 | Sum of segment revenue equals balance growth | tolerance | pass, 173 wei over 371 segments |
| 4 | Segment continuity, no gaps or overlaps | exact | pass |
| 5 | Buffer USDS balance equals net transfer flows | exact | pass, 0 equals 0 |
| 6 | Stored periphery addresses equal fresh on-chain resolution | exact | pass, byte-identical |
| 7 | chi at the File block recomputed via rpow from prior rate | tolerance 1e10 ray units | pass, observed difference 1,014 (~1e-24 relative) |
| 8 | Rate-integral revenue versus index revenue | diagnostic | pass, 173 wei, twelve significant figures of agreement |

Tolerances are documented where exact equality is impossible and are sized in wei, not percentages, because these checks are identities: a loose tolerance would absorb real bugs. Checks 2 and 3 are mathematically related (the revenue sum telescopes to the balance identity), which is why check 8 exists as the genuinely independent cross-validation of the revenue path.

Separately, a replay test proves the pipeline is deterministic: a fresh database fully re-indexed and re-accrued to the same pinned block produces byte-identical `accrual_segments` and `pnl_daily` to the incrementally synced production database.

This draft itself tripped the same class of error: three addresses transcribed by hand into the appendix failed validation against the stored values and were corrected from on-chain resolution before commit.

## 6. What the [dashboard](src/dashboard.ts) says, and what I would do

The position is a 1M pilot against a 5M ceiling, 10.7 days old, losing about 7.42 USDS per day, margin around -27 bps annualized. The loss is structural at the current rate configuration: the bracket [borrowRate x (1 - RF) - (SSR + 20bps)] is -0.44%, so every borrowed dollar is underwater and utilization only decides how fast.

What has to change for the sign to flip: the SparkLend USDS borrow rate must exceed 4.13% (currently 3.65%), or SSR must fall below 3.08% (currently 3.52%) without SparkLend rates following it down. On the current curve (kink 80%, slope2 15%), utilization sustained above the kink would push the borrow rate through 4.13% quickly; utilization is 62% today.

My recommendation, in order:

1. Do not scale the position. The 1M pilot is doing its job, which is producing exactly this measurement. Adding the remaining 4M at a -0.44% unit spread just multiplies the daily loss by five.
2. Treat the bracket, not utilization, as the monitored quantity. The pipeline computes it every run; alert when it crosses zero, or set a tolerance band around zero to avoid flapping.
3. Decide a time limit for the pilot. The bleed is small in absolute terms (roughly 225 USDS per month at current rates), which is a defensible price for keeping the integration warm and the measurement running, but it should be a conscious line item, not an accident. If the spread has not flipped within an agreed window, wipe the draw back to zero; re-entry later costs one transaction.
4. If the goal is spread over SSR specifically, this venue is the wrong shape at current rates: SparkLend's USDS supply side is structurally paying less than SSR plus 20 after the reserve factor. Venues where the earn side is not itself downstream of Sky rates would not have the bracket pinned this tightly.

One observation the brief invites: the utilization example in the brief (1M at 50% utilization owes on 500k) is correct for the cost side, but on this venue utilization cannot flip profitability by itself, because the revenue side moves with it. Magnitude yes, sign no. If the intent behind the example was that higher idle liquidity protects the margin, the on-chain rate structure says otherwise.

## 7. Ambiguities flagged

1. The compounding convention of the 20 bps spread is unspecified. Modeled as a linear annual spread on the annualized SSR, stored as configuration with the brief cited as source ([ASSUMPTIONS.md](ASSUMPTIONS.md)). The alternative differs by under 0.1 bp here, so I did not email about it; had the position been 100x larger I would have.
2. "Deployed USDS" could mean the original principal or the current balance including accrued yield. I use the current balance at each segment start, since that is Osero's actual exposure in the pool at that moment. The difference over this window is a few cents of cost.
3. The brief says the position and rates are reachable from the two anchors, and they are, but the venue was named in governance before the chain confirmed it. I treated the executive text as a hypothesis and the transaction trace as the confirmation; if they had disagreed, the chain would have won.

## 8. Prior work and sources

The fetcher (adaptive chunking, backoff, endpoint rotation), the NUMERIC(78,0) and watermark schema patterns, the rpow port, and the reconciliation-gate idea are carried over from my public sUSDS indexer (github.com/vchrl/susds-indexer), built and published before this take-home. Everything Osero-specific, the discovery, the venue integration, the accrual engine, the cost model and the checks in section 5, is new for this exercise.

Sources leaned on: the Sky Chainlog and its JSON API, vote.sky.money executive and Atlas edit texts, the sky-ecosystem/diamond-pau repository for the PAU architecture, Spark protocol docs for the aToken and rate model, Etherscan and Herd for traces and contract metadata, and Aave V3 source for index and rate semantics. No third-party indexer code was used.

## 9. Where this breaks at 100x, more strategies, more chains

**Data volume.** At 100x position size the event volume barely moves (position events are still rare), but at 100x venues or chains the bespoke fetch loop becomes the wrong tool. I would move the raw event layer to Ponder, which handles cursor management, reorgs and multi-chain natively, and keep the accrual engine exactly where it is: a separate computation stage reading Ponder's Postgres tables. The financial math does not belong inside an indexing framework.

**The snapshot stream is the first real bottleneck.** Utilization inputs currently come from two archive eth_calls per reserve-update block, about 1,264 calls for three weeks of one reserve. Across many reserves and chains that becomes the dominant RPC cost. The fix is to derive reserve totals from the event stream itself (Supply, Withdraw, Borrow, Repay, plus index growth) and demote archive snapshots to a sampled reconciliation check, the same pattern already used for revenue.

**Aggregation math.** Per-strategy margins do not average into a portfolio margin without weighting by deployed capital and time; `pnl_daily` keyed by strategy_id already supports exact summation in USDS terms, which is the correct aggregate.

**ABI drift.** The PAU Controller is an EIP-2535 Diamond: facets can be swapped and the effective ABI changes over time. At one venue this is invisible; at many, the indexer needs the DiamondCut event stream and a selector-to-facet map with validity windows, so decoded history stays correct as facets rotate.

**Reorg posture.** Everything indexes to `finalized` only, which is a structural answer rather than a reactive one. Cross-chain, finality semantics differ, so the per-chain watermark needs a per-chain finality rule next to it.

**The commercial layer.** `strategy_cost_terms` already models the cost basis as time-versioned data. More strategies with different spreads, benchmarks or conventions are new rows, not new code. That separation, chain truth in raw tables and commercial assumptions in configuration, is the piece I would defend hardest at any scale.
