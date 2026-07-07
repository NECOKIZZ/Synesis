/**
 * lib/solana/config.ts — Solana engine configuration (devnet).
 *
 * Server-only. All values are env-overridable so we can point at a dedicated
 * RPC (Helius/QuickNode) or flip to mainnet without code changes.
 */

import "server-only";
import { clusterApiUrl } from "@solana/web3.js";

/** RPC endpoint. Public devnet by default — override with a dedicated provider. */
export const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || clusterApiUrl("devnet");

/**
 * Circle's USDC mint on Solana devnet. Override via env if Circle rotates it.
 * Verify against the Circle faucet before relying on it in a demo.
 */
export const SOLANA_USDC_MINT =
  process.env.SOLANA_USDC_MINT || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export const SOLANA_USDC_DECIMALS = 6;

/** Circle blockchain identifier for the agent's Solana wallet row. */
export const SOLANA_BLOCKCHAIN = "SOL-DEVNET" as const;

/** Priority fee (micro-lamports per compute unit) + compute unit limit. */
export const SOLANA_PRIORITY_FEE_MICROLAMPORTS = Number(
  process.env.SOLANA_PRIORITY_FEE_MICROLAMPORTS ?? "1000",
);
export const SOLANA_COMPUTE_UNIT_LIMIT = Number(
  process.env.SOLANA_COMPUTE_UNIT_LIMIT ?? "200000",
);

/**
 * Minimum SOL (lamports) the agent wallet must hold before we attempt to sign.
 * Covers tx fee + a possible ATA rent-exemption (~0.002 SOL) with headroom.
 * 0.005 SOL default.
 */
export const SOLANA_MIN_FEE_LAMPORTS = Number(
  process.env.SOLANA_MIN_FEE_LAMPORTS ?? "5000000",
);

export const SOLANA_EXPLORER_CLUSTER = process.env.SOLANA_EXPLORER_CLUSTER || "devnet";

/** Build an explorer link for a tx signature on the configured cluster. */
export function solanaExplorerTx(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=${SOLANA_EXPLORER_CLUSTER}`;
}
