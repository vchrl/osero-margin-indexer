/** Shared viem client construction + eth_call helper for stages 2/3. */

import { createPublicClient, fallback, http, type PublicClient } from "viem";
import { mainnet } from "viem/chains";
import { DEFAULT_RPC_URL } from "./fetch.js";

export function makeClient(): PublicClient {
  const urls = process.env.RPC_URL
    ? [process.env.RPC_URL]
    : (process.env.RPC_URLS?.split(",") ?? [
        DEFAULT_RPC_URL,
        "https://ethereum-rpc.publicnode.com",
        "https://eth.drpc.org",
      ]);
  return createPublicClient({
    chain: mainnet,
    transport: fallback(urls.map((u) => http(u.trim(), { retryCount: 2 }))),
  });
}

export async function callUint(
  client: PublicClient,
  to: `0x${string}`,
  data: `0x${string}`,
  blockNumber: bigint,
): Promise<bigint> {
  const res = await client.call({ to, data, blockNumber });
  if (res.data === undefined) {
    throw new Error(`eth_call ${data.slice(0, 10)} on ${to} at block ${blockNumber} returned no data`);
  }
  return BigInt(res.data);
}
