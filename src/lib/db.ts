/**
 * Postgres persistence for the Osero margin indexer. Raw SQL via `pg`, no ORM.
 *
 * Amounts travel as strings between JS bigint and NUMERIC(78,0) — never
 * through JS number, which would corrupt anything above 2^53.
 *
 * Pattern carried over from susds-indexer (github.com/vchrl/susds-indexer):
 * per-event tables so NOT NULL is a whole-row invariant, natural key
 * (block_number, log_index) doubling as the range-scan index, and a
 * forward-only watermark advanced in the same transaction as each chunk.
 * New here: multiple event streams (per-source watermarks) and the
 * strategy_id FK so a second venue is an INSERT, not a rewrite.
 */

import pg from "pg";

export const DEFAULT_DATABASE_URL =
  "postgres://localhost:5432/osero_margin";

export function createPool(): pg.Pool {
  return new pg.Pool({
    connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  });
}

/**
 * Schema notes:
 *  - NUMERIC(78,0): uint256 max is 78 decimal digits. Rates/indexes are ray
 *    (1e27), token amounts are wei (1e18); both stored raw, scaled at read.
 *  - Cost convention (documented here, implemented in the accrual engine):
 *    Osero owes Sky SSR + 20bps on the *borrowed* portion of its deployed
 *    USDS. We treat the +20bps as a LINEAR ANNUAL SPREAD added to the
 *    annualized SSR (annualized via rpow over seconds-per-year), i.e.
 *      cost_rate = annualize(ssr) + 0.0020
 *    This is an ASSUMPTION: the brief does not specify the compounding
 *    convention for the spread. A per-second compounded spread would differ
 *    by <0.1bp at these magnitudes; flagged in the writeup as underspecified.
 *  - Break-even utilization/SSR are computed at dashboard render time from
 *    the latest segment inputs — deliberately not stored.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS strategies (
  id            SERIAL   PRIMARY KEY,
  name          TEXT     NOT NULL UNIQUE,
  venue         TEXT     NOT NULL,
  chain_id      INTEGER  NOT NULL,
  atoken        CHAR(42) NOT NULL,
  debt_token    CHAR(42) NOT NULL,
  rate_strategy CHAR(42) NOT NULL
);

-- Sky side: one row per sUSDS Drip event, with the ssr storage slot read at
-- the same block. chi is the rate accumulator, ssr the per-second rate (ray).
CREATE TABLE IF NOT EXISTS ssr_changes (
  block_number     BIGINT        NOT NULL,
  log_index        INTEGER       NOT NULL,
  transaction_hash CHAR(66)      NOT NULL,
  ssr              NUMERIC(78,0) NOT NULL CHECK (ssr >= 1000000000000000000000000000),
  chi              NUMERIC(78,0) NOT NULL CHECK (chi > 0),
  PRIMARY KEY (block_number, log_index)
);

-- SparkLend USDS reserve: every ReserveDataUpdated for the USDS reserve.
CREATE TABLE IF NOT EXISTS reserve_updates (
  block_number          BIGINT        NOT NULL,
  log_index             INTEGER       NOT NULL,
  transaction_hash      CHAR(66)      NOT NULL,
  liquidity_rate        NUMERIC(78,0) NOT NULL CHECK (liquidity_rate >= 0),
  variable_borrow_rate  NUMERIC(78,0) NOT NULL CHECK (variable_borrow_rate >= 0),
  liquidity_index       NUMERIC(78,0) NOT NULL CHECK (liquidity_index > 0),
  variable_borrow_index NUMERIC(78,0) NOT NULL CHECK (variable_borrow_index > 0),
  PRIMARY KEY (block_number, log_index)
);

-- Osero's position changes: Supply/Withdraw on the Pool for the USDS reserve
-- with onBehalfOf / user = ALM proxy.
CREATE TABLE IF NOT EXISTS position_events (
  block_number       BIGINT        NOT NULL,
  log_index          INTEGER       NOT NULL,
  transaction_hash   CHAR(66)      NOT NULL,
  strategy_id        INTEGER       NOT NULL REFERENCES strategies(id),
  kind               TEXT          NOT NULL CHECK (kind IN ('supply', 'withdraw')),
  amount             NUMERIC(78,0) NOT NULL CHECK (amount > 0),
  liquidity_index_at NUMERIC(78,0) NOT NULL CHECK (liquidity_index_at > 0),
  PRIMARY KEY (block_number, log_index)
);

-- USDS transfers touching the ALM proxy or the allocator buffer: the
-- draw/repay audit trail reconciled against vat.urns art.
CREATE TABLE IF NOT EXISTS usds_transfers (
  block_number     BIGINT        NOT NULL,
  log_index        INTEGER       NOT NULL,
  transaction_hash CHAR(66)      NOT NULL,
  from_addr        CHAR(42)      NOT NULL,
  to_addr          CHAR(42)      NOT NULL,
  amount           NUMERIC(78,0) NOT NULL CHECK (amount >= 0),
  PRIMARY KEY (block_number, log_index)
);

-- Utilization inputs: totalSupply of the aToken and the variable debt token,
-- read via archive eth_call at every block that has a reserve_updates row.
-- Explicit snapshots, not rate-curve inversion (decision 2026-08-03).
CREATE TABLE IF NOT EXISTS reserve_snapshots (
  block_number               BIGINT        PRIMARY KEY,
  atoken_total_supply        NUMERIC(78,0) NOT NULL CHECK (atoken_total_supply >= 0),
  variable_debt_total_supply NUMERIC(78,0) NOT NULL CHECK (variable_debt_total_supply >= 0)
);

-- One row per block that contains at least one indexed event or snapshot:
-- real timestamps for segment boundaries, plus the hash for reorg tripwires.
CREATE TABLE IF NOT EXISTS blocks (
  block_number    BIGINT      PRIMARY KEY,
  block_timestamp TIMESTAMPTZ NOT NULL,
  block_hash      CHAR(66)    NOT NULL
);

-- One watermark per event stream. highest_indexed_block is contiguous by
-- construction: it only advances inside the same transaction that persisted
-- every event of the chunk ending at that block.
CREATE TABLE IF NOT EXISTS sync_watermarks (
  source                TEXT        PRIMARY KEY,
  highest_indexed_block BIGINT      NOT NULL,
  highest_block_hash    CHAR(66)    NOT NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Derived tables (written by the accrual engine, stage 2) ────────────────

-- Piecewise-constant segments: one row per interval where position, ssr,
-- rates and utilization are all constant. Boundaries are the union of
-- ssr_changes, reserve_updates and position_events blocks. Continuity
-- (t_end[i] == t_start[i+1], no gaps/overlaps) is reconciliation check #4.
CREATE TABLE IF NOT EXISTS accrual_segments (
  id              BIGSERIAL      PRIMARY KEY,
  strategy_id     INTEGER        NOT NULL REFERENCES strategies(id),
  t_start         TIMESTAMPTZ    NOT NULL,
  t_end           TIMESTAMPTZ    NOT NULL CHECK (t_end > t_start),
  block_start     BIGINT         NOT NULL,
  block_end       BIGINT         NOT NULL CHECK (block_end >= block_start),
  position        NUMERIC(78,0)  NOT NULL CHECK (position >= 0),
  ssr             NUMERIC(78,0)  NOT NULL,
  liquidity_rate  NUMERIC(78,0)  NOT NULL,
  utilization     NUMERIC(38,18) NOT NULL CHECK (utilization >= 0 AND utilization <= 1),
  revenue         NUMERIC(78,0)  NOT NULL CHECK (revenue >= 0),
  cost            NUMERIC(78,0)  NOT NULL CHECK (cost >= 0),
  UNIQUE (strategy_id, t_start)
);

CREATE TABLE IF NOT EXISTS pnl_daily (
  strategy_id     INTEGER        NOT NULL REFERENCES strategies(id),
  day             DATE           NOT NULL,
  revenue         NUMERIC(78,0)  NOT NULL,
  cost            NUMERIC(78,0)  NOT NULL,
  net             NUMERIC(78,0)  NOT NULL,
  margin_bps      NUMERIC(20,6)  NOT NULL,
  position_eod    NUMERIC(78,0)  NOT NULL,
  utilization_avg NUMERIC(38,18) NOT NULL,
  PRIMARY KEY (strategy_id, day)
);

-- Commercial cost terms as data, not code: the +20bps lives here so a
-- renegotiated spread (or a second strategy with different terms) is an
-- INSERT with a new effective_from, not a redeploy.
CREATE TABLE IF NOT EXISTS strategy_cost_terms (
  strategy_id            INTEGER        NOT NULL REFERENCES strategies(id),
  effective_from         TIMESTAMPTZ    NOT NULL,
  spread_bps             NUMERIC(10,4)  NOT NULL,
  benchmark              TEXT           NOT NULL,
  compounding_convention TEXT           NOT NULL,
  source_note            TEXT           NOT NULL,
  PRIMARY KEY (strategy_id, effective_from)
);

-- Every accrual/reconcile run pins the block it computed against; the
-- dashboard prints "data as of block X" from the latest accrual run.
CREATE TABLE IF NOT EXISTS ops_runs (
  run_id            BIGSERIAL   PRIMARY KEY,
  kind              TEXT        NOT NULL CHECK (kind IN ('accrual', 'reconcile')),
  pinned_block      BIGINT      NOT NULL,
  pinned_block_hash CHAR(66)    NOT NULL,
  computed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reconciliation results as rows, not console output. A failed exact check
-- (tolerance '0') blocks dashboard generation.
CREATE TABLE IF NOT EXISTS ops_reconciliation_runs (
  run_id       BIGINT      NOT NULL REFERENCES ops_runs(run_id),
  check_name   TEXT        NOT NULL,
  pinned_block BIGINT      NOT NULL,
  expected     TEXT        NOT NULL,
  actual       TEXT        NOT NULL,
  difference   TEXT        NOT NULL,
  tolerance    TEXT        NOT NULL,
  status       TEXT        NOT NULL CHECK (status IN ('pass', 'fail')),
  checked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, check_name)
);

INSERT INTO strategies (name, venue, chain_id, atoken, debt_token, rate_strategy)
VALUES (
  'sparklend-usds', 'sparklend', 1,
  '0xC02aB1A5eaA8d1B114EF786D9bde108cD4364359',
  '0x8c147debea24Fb98ade8dDa4bf142992928b449e',
  '0x8a95998639A34462A1FdAaaA5506F66F90Ef2fDd'
)
ON CONFLICT (name) DO NOTHING;

INSERT INTO strategy_cost_terms
  (strategy_id, effective_from, spread_bps, benchmark, compounding_convention, source_note)
SELECT id, '2026-07-16T00:00:00Z', 20, 'SSR',
  'linear_annual_spread_on_annualized_benchmark',
  'Take-home brief: Osero owes Sky SSR + 20bps on the borrowed portion of deployed USDS. The brief does not specify the compounding convention for the spread; linear annual spread on the rpow-annualized SSR is assumed (see ASSUMPTIONS.md).'
FROM strategies WHERE name = 'sparklend-usds'
ON CONFLICT (strategy_id, effective_from) DO NOTHING;
`;

export async function initSchema(pool: pg.Pool): Promise<void> {
  await pool.query(SCHEMA_SQL);
}

export interface WatermarkState {
  highestIndexedBlock: bigint;
  highestBlockHash: `0x${string}`;
}

export async function getWatermark(
  pool: pg.Pool,
  source: string,
): Promise<WatermarkState | null> {
  const res = await pool.query(
    `SELECT highest_indexed_block::text AS block, highest_block_hash AS hash
     FROM sync_watermarks WHERE source = $1`,
    [source],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0] as { block: string; hash: string };
  return {
    highestIndexedBlock: BigInt(row.block),
    highestBlockHash: row.hash.trim() as `0x${string}`,
  };
}

/** Timestamp + hash for one block, as fetched from eth_getBlockByNumber. */
export interface BlockRow {
  blockNumber: bigint;
  /** Unix seconds. Converted to TIMESTAMPTZ at insert time. */
  timestamp: bigint;
  hash: `0x${string}`;
}

export async function insertBlocks(
  client: pg.PoolClient,
  rows: BlockRow[],
): Promise<number> {
  const res = await client.query(
    `INSERT INTO blocks (block_number, block_timestamp, block_hash)
     SELECT b, to_timestamp(t), h
     FROM unnest($1::bigint[], $2::bigint[], $3::text[]) AS u(b, t, h)
     ON CONFLICT (block_number) DO NOTHING`,
    [
      rows.map((r) => r.blockNumber.toString()),
      rows.map((r) => r.timestamp.toString()),
      rows.map((r) => r.hash),
    ],
  );
  return res.rowCount ?? 0;
}

/**
 * Advances one stream's watermark, forward-only, inside the caller's open
 * transaction. A non-advancing update means a concurrent or misordered run —
 * fail loudly rather than index twice.
 */
export async function advanceWatermark(
  client: pg.PoolClient,
  source: string,
  chunkEnd: bigint,
  chunkEndHash: `0x${string}`,
): Promise<void> {
  const res = await client.query(
    `INSERT INTO sync_watermarks (source, highest_indexed_block, highest_block_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (source) DO UPDATE
       SET highest_indexed_block = EXCLUDED.highest_indexed_block,
           highest_block_hash    = EXCLUDED.highest_block_hash,
           updated_at            = now()
       WHERE sync_watermarks.highest_indexed_block < EXCLUDED.highest_indexed_block`,
    [source, chunkEnd.toString(), chunkEndHash],
  );
  if (res.rowCount !== 1) {
    throw new Error(
      `watermark '${source}' did not advance to ${chunkEnd}; another run has ` +
        `moved it past this chunk. Refusing to continue.`,
    );
  }
}
