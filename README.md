# osero-margin-indexer

**Is Osero making money?** As of block 25,678,138 (2026-08-03): **No.**
Net **−79.28 USDS** since the Jul 24 entry — annualized margin ≈ **−27 bps**
on the 1,000,000 USDS position, losing ≈ **$7.40/day**. Structurally:
margin per unit deployed = `u × [borrowRate×(1−RF) − (SSR+20bps)]` =
`u × [3.65%×0.90 − 3.72%]` = `u × −0.44%` — utilization only scales the loss;
the borrow rate must exceed ~4.13% (or SSR fall below ~3.08%) to flip the sign.

The fetcher, reconciliation-gate, and schema patterns are carried over from my
public sUSDS indexer ([github.com/vchrl/susds-indexer](https://github.com/vchrl/susds-indexer));
everything Osero-specific — discovery, the accrual model, the P&L engine — is
new for this exercise.

## Reconciliation (the numbers are checked before they are shown)

Every accrual run is followed by a reconcile run pinned to the same block;
results are stored in `ops_reconciliation_runs` and **any failed blocking
check blocks dashboard generation and fails CI**. Latest run (block 25,678,138):

| # | Check | Expected | Actual | Status |
|---|-------|----------|--------|--------|
| 1 | draws − repays == `vat.urns(ilk, AllocatorVault).art` | 1,000,000e18 | 1,000,000e18 | PASS (exact) |
| 2 | scaled position × liquidityIndex == `spUSDS.balanceOf(ALM proxy)` | 1000595926618431405702308 | …702307 | PASS (1 wei; aToken rounds half-up, we floor) |
| 3 | Σ segment revenue == balance growth over principal | 595926618431405702308 | …702135 | PASS (173 wei over 371 floor-divided segments) |
| 4 | segment continuity (no gaps/overlaps) | 0 | 0 | PASS (exact) |
| 5 | `USDS.balanceOf(AllocatorBuffer)` == net transfer flow | 0 | 0 | PASS (exact) |
| 6 | stored debtToken/rateStrategy == fresh on-chain resolution | — | byte-identical | PASS (exact) |
| 7 | chi rpow recomputation across the Jul 22 `File("ssr")` | 1103935849059635208099476332 | …475318 | PASS (1e-24 relative) |
| 8 | rate-integral vs index-telescoped revenue (**diagnostic**) | 595.9266184314057 | 595.9266184314059 | PASS (agree to 12 sig figs) |

Checks 2/3 are mathematically dependent (revenue telescopes to the balance
identity); check 8 is the independent cross-validation of the rate stream
against the index stream, non-blocking by design. Check 7 failed honestly in
its first version — it compounded from the seed block's timestamp instead of
`rho` (last drip time) and missed by exactly the ~72-second drip lag; the fix
and the story are in `src/reconcile.ts`.

There is also an equivalence test: `npm run test:replay` rebuilds a scratch
database from block zero state and asserts the derived tables are
byte-identical to the incrementally-synced production database.

## Quickstart (clone to running)

Requires: Node 22+, PostgreSQL 14+, an Ethereum mainnet RPC (defaults to
public keyless endpoints — no API key needed).

```bash
git clone <this repo> && cd osero-margin-indexer
npm install
createdb osero_margin
cp .env.example .env           # defaults work; edit if needed

npx tsx src/index.ts           # 1. index the five raw streams (~5-10 min)
npx tsx src/accrue.ts          # 2. build segments + P&L
npx tsx src/reconcile.ts       # 3. reconciliation gate (exits 1 on failure)
npx tsx src/dashboard.ts       # 4. writes dashboard/index.html
open dashboard/index.html
```

Re-running `src/index.ts` is incremental (per-stream watermarks) and
idempotent (natural-key upserts on immutable finalized rows). The pipeline
only reads `finalized` blocks, so no reorg handling is needed at read time;
watermarks still store block hashes as a tripwire.

### Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `DATABASE_URL` | `postgres://localhost:5432/osero_margin` | Postgres connection string |
| `RPC_URL` | *(unset)* | Pin a single RPC endpoint (must serve archive `eth_call` + 10k-block `eth_getLogs`) |
| `RPC_URLS` | mevblocker, publicnode, drpc | Comma-separated rotation list used when `RPC_URL` is unset |
| `START_BLOCK` | `25540000` | Backfill start (spell day, pre-go-live) |
| `END_BLOCK` | *(finalized)* | Pin the index end block (used by the replay test) |

## What it measures

Osero draws USDS from Sky via the `ALLOCATOR-PRYSM-A` vault and supplies it
to SparkLend, earning the USDS supply yield. It owes Sky **SSR + 20bps, but
only on the share of its deployed USDS actually borrowed** by SparkLend users:

- **Revenue** = liquidityIndex growth on the position (ground truth — the
  same quantity `balanceOf` grows by; the rate stream is only a cross-check).
- **Cost** = (rpow-annualized SSR + 20bps) × position × utilization,
  integrated over piecewise-constant segments whose boundaries are every
  SSR change, reserve update, and position event.
- **Margin** = revenue − cost. All conventions and their on-chain evidence:
  [ASSUMPTIONS.md](ASSUMPTIONS.md).

## Architecture

```
        eth_getLogs / eth_call (finalized only)
                     │
   1. src/index.ts   ▼   five watermarked streams
      ssr_changes · reserve_updates · position_events
      usds_transfers · reserve_snapshots · blocks
                     │
   2. src/accrue.ts  ▼   piecewise accrual engine
      accrual_segments · pnl_daily · ops_runs (pinned block+hash)
                     │
   2.5 src/reconcile.ts  reconciliation gate ── FAIL → exit 1, no dashboard
                     │
   3. src/dashboard.ts ▼  reads reconciled Postgres state only
      dashboard/index.html (static, self-contained)
```

Three stages, three concerns: the indexer knows nothing about finance, the
accrual engine knows nothing about RPC, the dashboard knows nothing about
either — it refuses to render unless the gate passed. The schema is
extensible by design: `strategies` + `strategy_cost_terms` make a second
venue (or renegotiated terms) an INSERT, not a rewrite.

## Scaling judgment (what changes at 100×)

At one strategy / one chain / one tx, hand-rolled `eth_getLogs` walking is
the right size. At 100× strategies or multi-chain I would adopt **Ponder**
for the indexing layer (cursor management, reorg handling, multi-chain
orchestration) while keeping the accrual engine as a separate computation
stage — the piecewise cost integral is exactly the part an indexing
framework does not solve. Similarly **Drizzle** (listed in the JD) becomes
worthwhile once schema evolution outpaces raw SQL; here raw SQL buys exact
NUMERIC(78,0) control for the reconciliation identities.

## Contract map

See [src/addresses.ts](src/addresses.ts) — every address carries its
provenance; the SparkLend-side ones are resolved on-chain, and reconcile
check #6 re-verifies them every run.
