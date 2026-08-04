/**
 * Generic chunked eth_getLogs walker with adaptive chunk sizing.
 *
 * Carried over from susds-indexer (github.com/vchrl/susds-indexer) and made
 * generic: the original was bound to one contract's event ABI; this build
 * indexes five independent streams (Sky SSR, SparkLend reserve, position,
 * transfers, snapshots), so the walker takes raw topic filters and hands
 * undecoded logs to the caller. Decoding stays per-stream in index.ts where
 * it can fail loudly with stream context.
 */

import type { PublicClient } from "viem";

/**
 * dRPC's free tier caps eth_getLogs at 10,000 blocks per request and returns
 * an explicit error above that, so 10,000 is the largest chunk worth trying.
 */
export const DEFAULT_CHUNK_SIZE = 10_000n;

/**
 * Floor for the adaptive chunk size. If a request still fails at this size,
 * the problem is not the range width (it's an outage, rate limit, or a bad
 * range), so we abort instead of shrinking forever.
 */
export const MIN_CHUNK_SIZE = 500n;

/** Pause between chunk requests to stay under free-tier rate limits. */
const INTER_REQUEST_DELAY_MS = 250;

/**
 * Extra pause after a failed request, multiplied by the consecutive-failure
 * count. Halving the chunk only helps when the failure is about range width;
 * public RPCs also throw transient routing/rate errors where the fix is
 * waiting, not shrinking.
 */
const FAILURE_BACKOFF_MS = 3_000;
const MAX_BACKOFF_MS = 15_000;

/**
 * Consecutive failures tolerated at MIN_CHUNK_SIZE before aborting. At the
 * minimum size the range width is ruled out, but we still allow a transient
 * outage to pass before concluding the RPC genuinely cannot serve the range.
 */
const MAX_FAILURES_AT_MIN_CHUNK = 3;

/**
 * Default endpoint. Needs 10k-block eth_getLogs, historical eth_call, and
 * the `finalized` tag, all keyless; any archive-capable endpoint works via
 * RPC_URL. dRPC (https://eth.drpc.org) also qualifies but caps eth_getLogs
 * ranges harder and rate-bans heavy use faster.
 */
export const DEFAULT_RPC_URL = "https://rpc.mevblocker.io";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Raw log as returned by eth_getLogs; hex fields decoded by the caller. */
export interface RawLog {
  address: `0x${string}`;
  topics: `0x${string}`[];
  data: `0x${string}`;
  blockNumber: `0x${string}`;
  transactionHash: `0x${string}`;
  logIndex: `0x${string}`;
  blockHash: `0x${string}`;
  removed?: boolean;
}

/** One eth_getLogs filter. topics follows the JSON-RPC OR-list convention. */
export interface LogFilter {
  address: `0x${string}`;
  topics: (`0x${string}` | `0x${string}`[] | null)[];
}

async function getLogsForRange(
  client: PublicClient,
  filters: LogFilter[],
  fromBlock: bigint,
  toBlock: bigint,
): Promise<RawLog[]> {
  const results: RawLog[] = [];
  for (const f of filters) {
    const logs = (await client.request({
      method: "eth_getLogs",
      params: [
        {
          address: f.address,
          topics: f.topics,
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: `0x${toBlock.toString(16)}`,
        },
      ],
    })) as RawLog[];
    for (const log of logs) {
      if (log.removed) {
        // We only walk finalized ranges; a removed log there means the RPC
        // served us reorged data — abort rather than persist it.
        throw new Error(`Removed log in finalized range: ${JSON.stringify(log)}`);
      }
      results.push(log);
    }
  }
  // Multiple filters can overlap (e.g. transfers from AND to a tracked
  // address); order deterministically, dedupe on (block, logIndex).
  results.sort((a, b) => {
    const db = BigInt(a.blockNumber) - BigInt(b.blockNumber);
    if (db !== 0n) return db < 0n ? -1 : 1;
    const dl = BigInt(a.logIndex) - BigInt(b.logIndex);
    return dl < 0n ? -1 : dl > 0n ? 1 : 0;
  });
  return results.filter(
    (log, i) =>
      i === 0 ||
      BigInt(log.blockNumber) !== BigInt(results[i - 1]!.blockNumber) ||
      BigInt(log.logIndex) !== BigInt(results[i - 1]!.logIndex),
  );
}

/**
 * Called after each successfully fetched chunk, in block order. The DB
 * writer persists per-chunk transactionally; a thrown error aborts the walk
 * (a chunk that can't be persisted must not be silently skipped).
 */
export type ChunkConsumer = (
  logs: RawLog[],
  fromBlock: bigint,
  toBlock: bigint,
) => void | Promise<void>;

export interface FetchStats {
  logsFetched: number;
  chunksFetched: number;
  chunkFailures: number;
}

/**
 * Walks [fromBlock, toBlock] in chunks. Public RPCs cap eth_getLogs by range
 * width (and sometimes result count), so one request for the whole range is
 * not an option. On a failed request the same window is retried with half the
 * chunk size; on success the chunk size recovers additively. An empty result
 * array is valid data and is never treated as a failure — only a thrown RPC
 * error triggers shrinking. A failure at MIN_CHUNK_SIZE aborts with the RPC
 * error attached as `cause`.
 */
export async function fetchLogsInChunks(
  client: PublicClient,
  label: string,
  filters: LogFilter[],
  fromBlock: bigint,
  toBlock: bigint,
  onChunk: ChunkConsumer,
  initialChunkSize: bigint = DEFAULT_CHUNK_SIZE,
): Promise<FetchStats> {
  let chunkSize = initialChunkSize;
  let cursor = fromBlock;
  let logsFetched = 0;
  let chunksFetched = 0;
  let chunkFailures = 0;
  let failureStreak = 0;

  while (cursor <= toBlock) {
    const chunkEnd =
      cursor + chunkSize - 1n > toBlock ? toBlock : cursor + chunkSize - 1n;

    try {
      const logs = await getLogsForRange(client, filters, cursor, chunkEnd);
      await onChunk(logs, cursor, chunkEnd);
      logsFetched += logs.length;
      chunksFetched++;
      failureStreak = 0;
      console.log(
        `  [${label}] blocks ${cursor}-${chunkEnd}: ${logs.length} logs (chunk size ${chunkSize})`,
      );
      cursor = chunkEnd + 1n;
      if (chunkSize < initialChunkSize) {
        chunkSize =
          chunkSize + 1_000n > initialChunkSize
            ? initialChunkSize
            : chunkSize + 1_000n;
      }
    } catch (error) {
      chunkFailures++;
      failureStreak++;
      if (chunkSize <= MIN_CHUNK_SIZE && failureStreak > MAX_FAILURES_AT_MIN_CHUNK) {
        throw new Error(
          `[${label}] eth_getLogs failed for blocks ${cursor}-${chunkEnd} ` +
            `${failureStreak} times in a row at the minimum chunk size ` +
            `(${MIN_CHUNK_SIZE}); giving up.`,
          { cause: error },
        );
      }
      const halved = chunkSize / 2n;
      chunkSize = halved < MIN_CHUNK_SIZE ? MIN_CHUNK_SIZE : halved;
      const backoff = Math.min(FAILURE_BACKOFF_MS * failureStreak, MAX_BACKOFF_MS);
      console.warn(
        `  [${label}] blocks ${cursor}-${chunkEnd} failed ` +
          `(${(error as Error).message.split("\n")[0]}); ` +
          `retrying with chunk size ${chunkSize} after ${backoff}ms`,
      );
      await sleep(backoff);
    }

    await sleep(INTER_REQUEST_DELAY_MS);
  }

  return { logsFetched, chunksFetched, chunkFailures };
}

export function parseBlockEnv(name: string): bigint | null {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return null;
  let value: bigint;
  try {
    value = BigInt(raw);
  } catch {
    throw new Error(`${name} must be a decimal block number, got "${raw}"`);
  }
  if (value < 0n) throw new Error(`${name} must be non-negative, got ${value}`);
  return value;
}
