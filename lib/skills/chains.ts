/**
 * lib/skills/chains.ts — bridge chain-name normalization.
 *
 * The LLM emits free-form chain names ("Base", "arbitrum", "ETH"). Circle
 * App Kit's bridge() requires exact Blockchain enum identifiers
 * ("Base_Sepolia", "Arbitrum_Sepolia", ...). This maps the former to the
 * latter and validates against the SDK's own enum, so an unknown chain
 * fails fast with a clear message instead of a cryptic "unsupported chain"
 * deep inside the CCTP flow.
 *
 * Deployment is Arc TESTNET — bare names ("base", "ethereum") alias to
 * their testnet form. Swap this alias table when moving to mainnet.
 *
 * Server-only: imported by BRIDGE_USDC (and, later, the yield skill).
 */

import "server-only";
import { Blockchain } from "@circle-fin/app-kit";

// Every phrasing the model might emit → the exact testnet enum value.
// Keys are normalized (lowercase, spaces/dashes → underscore) before lookup.
const TESTNET_ALIASES: Record<string, Blockchain> = {
  arc: Blockchain.Arc_Testnet,
  arbitrum: Blockchain.Arbitrum_Sepolia,
  arb: Blockchain.Arbitrum_Sepolia,
  base: Blockchain.Base_Sepolia,
  ethereum: Blockchain.Ethereum_Sepolia,
  eth: Blockchain.Ethereum_Sepolia,
  polygon: Blockchain.Polygon_Amoy_Testnet,
  matic: Blockchain.Polygon_Amoy_Testnet,
  avalanche: Blockchain.Avalanche_Fuji,
  avax: Blockchain.Avalanche_Fuji,
  optimism: Blockchain.Optimism_Sepolia,
  op: Blockchain.Optimism_Sepolia,
  unichain: Blockchain.Unichain_Sepolia,
  solana: Blockchain.Solana_Devnet,
  sol: Blockchain.Solana_Devnet,
};

/**
 * Chains the standalone BRIDGE_USDC skill advertises and accepts (testnet).
 * Surfaced in error messages and the system-prompt block so the model only
 * ever emits names that resolve.
 */
export const SUPPORTED_BRIDGE_CHAINS: readonly Blockchain[] = [
  Blockchain.Base_Sepolia,
  Blockchain.Ethereum_Sepolia,
  Blockchain.Arbitrum_Sepolia,
  Blockchain.Avalanche_Fuji,
  Blockchain.Optimism_Sepolia,
  Blockchain.Polygon_Amoy_Testnet,
];

/**
 * Map a free-form chain name to an exact App Kit Blockchain identifier.
 * Returns null when the input doesn't resolve to a real enum value.
 *
 *   "base"            → "Base_Sepolia"
 *   "Arbitrum"        → "Arbitrum_Sepolia"
 *   "ethereum_sepolia"→ "Ethereum_Sepolia"   (already valid, normalized case)
 *   "dogechain"       → null
 */
export function normalizeBridgeChain(input: string): Blockchain | null {
  if (!input) return null;
  const key = input.trim().toLowerCase().replace(/[\s-]+/g, "_");

  // 1) alias hit ("base" → "Base_Sepolia")
  if (TESTNET_ALIASES[key]) return TESTNET_ALIASES[key];

  // 2) already a valid enum value, possibly wrong case ("base_sepolia")
  const exact = (Object.values(Blockchain) as string[]).find(
    (v) => v.toLowerCase() === key,
  );
  return (exact as Blockchain) ?? null;
}
