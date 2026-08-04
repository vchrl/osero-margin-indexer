/**
 * Stage 1: the indexer. Fetches five event/state streams into raw Postgres
 * tables, each with its own forward-only watermark:
 *
 *   1. ssr        — sUSDS File("ssr") events (+ a seeded eth_call row at
 *                   range start). We index SSR *changes*, not Drip events:
 *                   Drip fires on every sUSDS deposit/withdraw (~93 per 800
 *                   blocks observed) but the SSR only moves on governance
 *                   File events (4 in the last ~5 months). Drip-per-row was
 *                   rejected because the accrual engine only needs the
 *                   piecewise-constant SSR history; thousands of Drip rows
 *                   plus a chi eth_call each would add RPC load and table
 *                   noise without adding information. chi mechanics are
 *                   still exercised: rpow recomputes chi across segments as
 *                   a reconciliation check.
 *   2. reserve    — SparkLend ReserveDataUpdated for the USDS reserve.
 *   3. position   — Supply/Withdraw on the Pool with onBehalfOf/user = ALM
 *                   proxy. Runs after stream 2: each row stores the
 *                   liquidity index from the same-block ReserveDataUpdated
 *                   (Aave updates reserve state in the same tx as any
 *                   supply/withdraw, so a missing row is an error).
 *   4. transfers  — USDS Transfer events touching the ALM proxy or the
 *                   allocator buffer (draw/repay audit trail).
 *   5. snapshots  — totalSupply() of spUSDS + variable debt token via
 *                   archive eth_call at every block with a reserve update
 *                   (utilization inputs; explicit snapshots, not rate-curve
 *                   inversion).
 */

import { createPublicClient, fallback, http, padHex, toFunctionSelector, type PublicClient } from "viem";
import { mainnet } from "viem/chains";
import type pg from "pg";
import {
  ALM_PROXY,
  ALLOCATOR_BUFFER,
  SPARK_POOL,
  SP_USDS,
  SUSDS,
  USDS,
  USDS_VARIABLE_DEBT,
} from "./addresses.js";
import {
  DEFAULT_RPC_URL,
  fetchLogsInChunks,
  parseBlockEnv,
  type LogFilter,
  type RawLog,
} from "./lib/fetch.js";
import {
  advanceWatermark,
  createPool,
  getWatermark,
  initSchema,
  insertBlocks,
  type BlockRow,
} from "./lib/db.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default backfill start: ~2026-07-16, the spell day, comfortably before the
 * ~Jul 18 strategy go-live (position entry itself was Jul 24, block
 * 25601435). Overridable via START_BLOCK for testing.
 */
const DEFAULT_START_BLOCK = 25_540_000n;

// Event topics. All verified against live mainnet logs 2026-08-03 (see
// README lineage section): Supply/ReserveDataUpdated checked against the
// actual 1M USDS entry tx 0xff4071...c19f3 at block 25601435, File("ssr")
// against the four SSR changes since block 24621023.
const TOPIC_FILE = "0xe986e40cc8c151830d4f61050f4fb2e4add8567caad2d5f5496f9158e91fe4c7"; // File(bytes32,uint256)
const TOPIC_RESERVE_DATA_UPDATED = "0x804c9b842b2748a22bb64b345453a3de7ca54a6ca45ce00d415894979e22897a";
const TOPIC_SUPPLY = "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61";
const TOPIC_WITHDRAW = "0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7";
const TOPIC_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SSR_BYTES32 = "0x7373720000000000000000000000000000000000000000000000000000000000"; // "ssr"

const SEL_TOTAL_SUPPLY = toFunctionSelector("totalSupply()");
const SEL_SSR = toFunctionSelector("ssr()");
const SEL_CHI = toFunctionSelector("chi()");

const ZERO_TX = `0x${"0".repeat(64)}` as const;

const topicAddr = (a: `0x${string}`) => padHex(a, { size: 32 }).toLowerCase() as `0x${string}`;

// ---------------------------------------------------------------------------
// Raw log decode helpers — fail loudly, never zero-fill.
// ---------------------------------------------------------------------------

/** Splits log data into 32-byte words as bigints; asserts exact word count. */
function dataWords(log: RawLog, expected: number): bigint[] {
  const hex = log.data.slice(2);
  if (hex.length !== expected * 64) {
    throw new Error(
      `Expected ${expected} data words, got ${hex.length / 64} in log at ` +
        `block ${BigInt(log.blockNumber)}, tx ${log.transactionHash}`,
    );
  }
  const words: bigint[] = [];
  for (let i = 0; i < expected; i++) {
    words.push(BigInt(`0x${hex.slice(i * 64, (i + 1) * 64)}`));
  }
  return words;
}

interface Provenance {
  blockNumber: bigint;
  logIndex: number;
  transactionHash: `0x${string}`;
}

function provenance(log: RawLog): Provenance {
  return {
    blockNumber: BigInt(log.blockNumber),
    logIndex: Number(BigInt(log.logIndex)),
    transactionHash: log.transactionHash,
  };
}

// ---------------------------------------------------------------------------
// eth_call helpers (historical state reads)
// ---------------------------------------------------------------------------

async function callUint(
  client: PublicClient,
  to: `0x${string}`,
  selector: `0x${string}`,
  blockNumber: bigint,
): Promise<bigint> {
  const res = await client.call({ to, data: selector, blockNumber });
  if (res.data === undefined) {
    throw new Error(`eth_call ${selector} on ${to} at block ${blockNumber} returned no data`);
  }
  return BigInt(res.data);
}

// ---------------------------------------------------------------------------
// Block metadata: every persisted row's block gets a timestamp + hash.
// ---------------------------------------------------------------------------

async function fetchBlockRows(
  client: PublicClient,
  blockNumbers: bigint[],
): Promise<BlockRow[]> {
  const unique = [...new Set(blockNumbers.map((b) => b.toString()))].map(BigInt);
  const rows: BlockRow[] = [];
  // Small parallel batches: enough to hide latency, small enough for free
  // public endpoints.
  const BATCH = 4;
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = await Promise.all(
      unique.slice(i, i + BATCH).map(async (bn) => {
        const b = await client.getBlock({ blockNumber: bn });
        return { blockNumber: bn, timestamp: b.timestamp, hash: b.hash };
      }),
    );
    rows.push(...batch);
    // Cloudflare on public endpoints bans bursty eth_getBlockByNumber (seen
    // live: mevblocker error 1015); pace the batches instead.
    await new Promise((r) => setTimeout(r, 150));
  }
  return rows;
}

/** Runs one chunk's inserts + watermark advance in a single transaction. */
async function inTx(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Chunk-end block hash for the watermark's reorg tripwire. */
async function blockHashAt(client: PublicClient, bn: bigint): Promise<`0x${string}`> {
  const b = await client.getBlock({ blockNumber: bn });
  return b.hash;
}

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

interface StreamCounts {
  [stream: string]: number;
}

async function streamStart(
  pool: pg.Pool,
  source: string,
  defaultStart: bigint,
): Promise<bigint> {
  const wm = await getWatermark(pool, source);
  return wm === null ? defaultStart : wm.highestIndexedBlock + 1n;
}

/** Stream 1: SSR changes from File("ssr") + seed row at range start. */
async function indexSsr(
  client: PublicClient,
  pool: pg.Pool,
  startBlock: bigint,
  endBlock: bigint,
  counts: StreamCounts,
): Promise<void> {
  const from = await streamStart(pool, "ssr", startBlock);
  if (from > endBlock) return;

  // Seed: the SSR in force at range start predates any File event inside the
  // range; read it (and chi) via eth_call so the accrual engine never has to
  // infer the opening rate. log_index 0 + zero tx hash marks synthetic rows.
  if ((await getWatermark(pool, "ssr")) === null) {
    const [ssr, chi] = await Promise.all([
      callUint(client, SUSDS, SEL_SSR, startBlock),
      callUint(client, SUSDS, SEL_CHI, startBlock),
    ]);
    const blockRows = await fetchBlockRows(client, [startBlock]);
    await inTx(pool, async (c) => {
      await insertBlocks(c, blockRows);
      await c.query(
        `INSERT INTO ssr_changes (block_number, log_index, transaction_hash, ssr, chi)
         VALUES ($1, 0, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [startBlock.toString(), ZERO_TX, ssr.toString(), chi.toString()],
      );
    });
    counts.ssr_seed = 1;
    console.log(`  [ssr] seeded at block ${startBlock}: ssr=${ssr} chi=${chi}`);
  }

  const filters: LogFilter[] = [
    { address: SUSDS, topics: [TOPIC_FILE, SSR_BYTES32] },
  ];
  await fetchLogsInChunks(client, "ssr", filters, from, endBlock, async (logs, _f, chunkEnd) => {
    const rows = await Promise.all(
      logs.map(async (log) => {
        const p = provenance(log);
        const ssr = dataWords(log, 1)[0]!;
        // chi at the File block: governance drips before filing, so the
        // same-block chi is the accumulator the new rate starts from.
        const chi = await callUint(client, SUSDS, SEL_CHI, p.blockNumber);
        return { ...p, ssr, chi };
      }),
    );
    const blockRows = await fetchBlockRows(client, rows.map((r) => r.blockNumber));
    const endHash = await blockHashAt(client, chunkEnd);
    await inTx(pool, async (c) => {
      await insertBlocks(c, blockRows);
      for (const r of rows) {
        await c.query(
          `INSERT INTO ssr_changes (block_number, log_index, transaction_hash, ssr, chi)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [r.blockNumber.toString(), r.logIndex, r.transactionHash, r.ssr.toString(), r.chi.toString()],
        );
      }
      await advanceWatermark(c, "ssr", chunkEnd, endHash);
    });
    counts.ssr = (counts.ssr ?? 0) + rows.length;
  });
}

/** Stream 2: SparkLend USDS ReserveDataUpdated. */
async function indexReserve(
  client: PublicClient,
  pool: pg.Pool,
  startBlock: bigint,
  endBlock: bigint,
  counts: StreamCounts,
): Promise<void> {
  const from = await streamStart(pool, "reserve", startBlock);
  if (from > endBlock) return;
  const filters: LogFilter[] = [
    { address: SPARK_POOL, topics: [TOPIC_RESERVE_DATA_UPDATED, topicAddr(USDS)] },
  ];
  await fetchLogsInChunks(client, "reserve", filters, from, endBlock, async (logs, _f, chunkEnd) => {
    const rows = logs.map((log) => {
      const p = provenance(log);
      const w = dataWords(log, 5);
      const [liquidityRate, variableBorrowRate, liquidityIndex, variableBorrowIndex] =
        [w[0]!, w[2]!, w[3]!, w[4]!];
      return { ...p, liquidityRate, variableBorrowRate, liquidityIndex, variableBorrowIndex };
    });
    const blockRows = await fetchBlockRows(client, rows.map((r) => r.blockNumber));
    const endHash = await blockHashAt(client, chunkEnd);
    await inTx(pool, async (c) => {
      await insertBlocks(c, blockRows);
      await c.query(
        `INSERT INTO reserve_updates (block_number, log_index, transaction_hash,
           liquidity_rate, variable_borrow_rate, liquidity_index, variable_borrow_index)
         SELECT * FROM unnest($1::bigint[], $2::int[], $3::text[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[])
         ON CONFLICT (block_number, log_index) DO NOTHING`,
        [
          rows.map((r) => r.blockNumber.toString()),
          rows.map((r) => r.logIndex),
          rows.map((r) => r.transactionHash),
          rows.map((r) => r.liquidityRate.toString()),
          rows.map((r) => r.variableBorrowRate.toString()),
          rows.map((r) => r.liquidityIndex.toString()),
          rows.map((r) => r.variableBorrowIndex.toString()),
        ],
      );
      await advanceWatermark(c, "reserve", chunkEnd, endHash);
    });
    counts.reserve = (counts.reserve ?? 0) + rows.length;
  });
}

/** Stream 3: Osero position events. MUST run after stream 2 (index lookup). */
async function indexPosition(
  client: PublicClient,
  pool: pg.Pool,
  startBlock: bigint,
  endBlock: bigint,
  strategyId: number,
  counts: StreamCounts,
): Promise<void> {
  const from = await streamStart(pool, "position", startBlock);
  if (from > endBlock) return;
  // Supply: onBehalfOf is topic2; Withdraw: user is topic2. Both must be the
  // ALM proxy for the event to be Osero's.
  const filters: LogFilter[] = [
    {
      address: SPARK_POOL,
      topics: [[TOPIC_SUPPLY, TOPIC_WITHDRAW], topicAddr(USDS), topicAddr(ALM_PROXY)],
    },
  ];
  await fetchLogsInChunks(client, "position", filters, from, endBlock, async (logs, _f, chunkEnd) => {
    const rows = logs.map((log) => {
      const p = provenance(log);
      const isSupply = log.topics[0] === TOPIC_SUPPLY;
      // Supply data: (user, amount); Withdraw data: (amount) — reserve, user
      // and to are all indexed on Withdraw.
      const amount = isSupply ? dataWords(log, 2)[1]! : dataWords(log, 1)[0]!;
      return { ...p, kind: isSupply ? "supply" : "withdraw", amount };
    });
    const blockRows = await fetchBlockRows(client, rows.map((r) => r.blockNumber));
    const endHash = await blockHashAt(client, chunkEnd);
    await inTx(pool, async (c) => {
      await insertBlocks(c, blockRows);
      for (const r of rows) {
        // Aave updates reserve state (emitting ReserveDataUpdated) in the
        // same tx as any supply/withdraw; stream 2 has already persisted it.
        const idx = await c.query(
          `SELECT liquidity_index::text AS li FROM reserve_updates
           WHERE block_number = $1 ORDER BY log_index DESC LIMIT 1`,
          [r.blockNumber.toString()],
        );
        if (idx.rows.length === 0) {
          throw new Error(
            `No reserve_updates row at block ${r.blockNumber} for position event ` +
              `${r.transactionHash}; run order violated or reserve stream incomplete.`,
          );
        }
        await c.query(
          `INSERT INTO position_events (block_number, log_index, transaction_hash,
             strategy_id, kind, amount, liquidity_index_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
          [
            r.blockNumber.toString(), r.logIndex, r.transactionHash,
            strategyId, r.kind, r.amount.toString(), (idx.rows[0] as { li: string }).li,
          ],
        );
      }
      await advanceWatermark(c, "position", chunkEnd, endHash);
    });
    counts.position = (counts.position ?? 0) + rows.length;
  });
}

/** Stream 4: USDS transfers touching the ALM proxy or allocator buffer. */
async function indexTransfers(
  client: PublicClient,
  pool: pg.Pool,
  startBlock: bigint,
  endBlock: bigint,
  counts: StreamCounts,
): Promise<void> {
  const from = await streamStart(pool, "transfers", startBlock);
  if (from > endBlock) return;
  const tracked = [topicAddr(ALM_PROXY), topicAddr(ALLOCATOR_BUFFER)];
  // Two filters (from-side, to-side); the walker dedupes internal transfers
  // that match both on (block, logIndex).
  const filters: LogFilter[] = [
    { address: USDS, topics: [TOPIC_TRANSFER, tracked] },
    { address: USDS, topics: [TOPIC_TRANSFER, null, tracked] },
  ];
  await fetchLogsInChunks(client, "transfers", filters, from, endBlock, async (logs, _f, chunkEnd) => {
    const rows = logs.map((log) => {
      const p = provenance(log);
      const amount = dataWords(log, 1)[0]!;
      return {
        ...p,
        fromAddr: `0x${log.topics[1]!.slice(26)}`,
        toAddr: `0x${log.topics[2]!.slice(26)}`,
        amount,
      };
    });
    const blockRows = await fetchBlockRows(client, rows.map((r) => r.blockNumber));
    const endHash = await blockHashAt(client, chunkEnd);
    await inTx(pool, async (c) => {
      await insertBlocks(c, blockRows);
      await c.query(
        `INSERT INTO usds_transfers (block_number, log_index, transaction_hash, from_addr, to_addr, amount)
         SELECT * FROM unnest($1::bigint[], $2::int[], $3::text[], $4::text[], $5::text[], $6::numeric[])
         ON CONFLICT (block_number, log_index) DO NOTHING`,
        [
          rows.map((r) => r.blockNumber.toString()),
          rows.map((r) => r.logIndex),
          rows.map((r) => r.transactionHash),
          rows.map((r) => r.fromAddr),
          rows.map((r) => r.toAddr),
          rows.map((r) => r.amount.toString()),
        ],
      );
      await advanceWatermark(c, "transfers", chunkEnd, endHash);
    });
    counts.transfers = (counts.transfers ?? 0) + rows.length;
  });
}

/**
 * Stream 5: utilization snapshots. Driven off stored reserve_updates blocks,
 * not a log walk: two archive eth_calls (aToken + variable debt totalSupply)
 * per distinct update block. Resumable via its own watermark since this is
 * the slow stream.
 */
async function indexSnapshots(
  client: PublicClient,
  pool: pg.Pool,
  counts: StreamCounts,
): Promise<void> {
  const wm = await getWatermark(pool, "snapshots");
  const res = await pool.query(
    `SELECT DISTINCT block_number AS bn FROM reserve_updates
     WHERE block_number > $1 ORDER BY block_number`,
    [(wm?.highestIndexedBlock ?? 0n).toString()],
  );
  const blocks = res.rows.map((r) => BigInt((r as { bn: string }).bn));
  if (blocks.length === 0) return;
  console.log(`  [snapshots] ${blocks.length} blocks to snapshot`);

  const BATCH = 5;
  for (let i = 0; i < blocks.length; i += BATCH) {
    const batch = blocks.slice(i, i + BATCH);
    // Archive eth_calls are the flakiest requests on free public endpoints
    // (timeouts, temporary bans); retry the whole batch a few times with
    // backoff before giving up — the watermark makes reruns cheap anyway.
    let rows: { bn: bigint; atoken: bigint; debt: bigint }[] | null = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        rows = await Promise.all(
          batch.map(async (bn) => {
            const [atoken, debt] = await Promise.all([
              callUint(client, SP_USDS, SEL_TOTAL_SUPPLY, bn),
              callUint(client, USDS_VARIABLE_DEBT, SEL_TOTAL_SUPPLY, bn),
            ]);
            return { bn, atoken, debt };
          }),
        );
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        const backoff = 3_000 * attempt;
        console.warn(
          `  [snapshots] batch at ${batch[0]} failed ` +
            `(${(error as Error).message.split("\n")[0]}); retry in ${backoff}ms`,
        );
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    if (rows === null) throw new Error("unreachable");
    await new Promise((r) => setTimeout(r, 250));
    const last = batch[batch.length - 1]!;
    const endHash = await blockHashAt(client, last);
    await inTx(pool, async (c) => {
      await c.query(
        `INSERT INTO reserve_snapshots (block_number, atoken_total_supply, variable_debt_total_supply)
         SELECT * FROM unnest($1::bigint[], $2::numeric[], $3::numeric[])
         ON CONFLICT (block_number) DO NOTHING`,
        [
          rows.map((r) => r.bn.toString()),
          rows.map((r) => r.atoken.toString()),
          rows.map((r) => r.debt.toString()),
        ],
      );
      await advanceWatermark(c, "snapshots", last, endHash);
    });
    counts.snapshots = (counts.snapshots ?? 0) + rows.length;
    if ((i / BATCH) % 10 === 0) {
      console.log(`  [snapshots] ${Math.min(i + BATCH, blocks.length)}/${blocks.length}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // RPC_URL pins a single endpoint; otherwise rotate across public
  // endpoints (RPC_URLS to customize) so one endpoint's rate-limit ban
  // doesn't kill a long backfill. All must serve archive eth_call.
  const urls = process.env.RPC_URL
    ? [process.env.RPC_URL]
    : (process.env.RPC_URLS?.split(",") ?? [
        DEFAULT_RPC_URL,
        "https://ethereum-rpc.publicnode.com",
        "https://eth.drpc.org",
      ]);
  const client = createPublicClient({
    chain: mainnet,
    transport: fallback(urls.map((u) => http(u.trim(), { retryCount: 2 }))),
  });
  const rpcUrl = urls.join(", ");
  const pool = createPool();
  await initSchema(pool);

  const strategy = await pool.query(`SELECT id FROM strategies WHERE name = 'sparklend-usds'`);
  const strategyId = (strategy.rows[0] as { id: number }).id;

  const startBlock = parseBlockEnv("START_BLOCK") ?? DEFAULT_START_BLOCK;
  const endOverride = parseBlockEnv("END_BLOCK");
  const finalized = await client.getBlock({ blockTag: "finalized" });
  const endBlock = endOverride ?? finalized.number;
  console.log(`Indexing to block ${endBlock} (finalized: ${finalized.number}) via ${rpcUrl}`);

  const counts: StreamCounts = {};
  // Order matters: position (3) reads reserve_updates (2) for same-block
  // liquidity indexes; snapshots (5) walk reserve_updates blocks.
  await indexSsr(client, pool, startBlock, endBlock, counts);
  await indexReserve(client, pool, startBlock, endBlock, counts);
  await indexPosition(client, pool, startBlock, endBlock, strategyId, counts);
  await indexTransfers(client, pool, startBlock, endBlock, counts);
  await indexSnapshots(client, pool, counts);

  console.log("\nDone. New rows per stream:");
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
