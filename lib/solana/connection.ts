/**
 * lib/solana/connection.ts — singleton Solana RPC connection.
 *
 * Mirrors how lib/circle.ts builds a single Arc JsonRpcProvider. Reused across
 * the engine so we don't open a socket per call.
 */

import "server-only";
import { Connection } from "@solana/web3.js";
import { SOLANA_RPC_URL } from "./config";

let cached: Connection | null = null;

export function getSolanaConnection(): Connection {
  if (!cached) {
    cached = new Connection(SOLANA_RPC_URL, "confirmed");
  }
  return cached;
}
