/**
 * lib/solana/fees.ts — compute budget + SOL-for-fees pre-check.
 *
 * Solana fees are paid in native SOL, NOT in the USDC the wallet holds. A wallet
 * with USDC but 0 SOL cannot broadcast ANY transaction. We fail loudly and early
 * so the user gets a clear "fund SOL" message instead of a cryptic broadcast
 * error. This is the user-chosen funding model (vs. Gas Station sponsorship).
 */

import "server-only";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  SOLANA_COMPUTE_UNIT_LIMIT,
  SOLANA_PRIORITY_FEE_MICROLAMPORTS,
  SOLANA_MIN_FEE_LAMPORTS,
} from "./config";

/** ComputeBudget instructions (CU limit + priority fee) prepended to every tx. */
export function computeBudgetIxs(): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: SOLANA_COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: SOLANA_PRIORITY_FEE_MICROLAMPORTS,
    }),
  ];
}

/** Throws a user-readable error if the wallet can't cover Solana network fees. */
export async function assertSolForFees(
  connection: Connection,
  address: string,
): Promise<void> {
  let lamports: number;
  try {
    lamports = await connection.getBalance(new PublicKey(address), "confirmed");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Couldn't read the Solana wallet's SOL balance: ${msg}`);
  }
  if (lamports < SOLANA_MIN_FEE_LAMPORTS) {
    const have = (lamports / 1e9).toFixed(4);
    const need = (SOLANA_MIN_FEE_LAMPORTS / 1e9).toFixed(4);
    throw new Error(
      `Solana agent wallet needs SOL for network fees — has ${have} SOL, needs at least ${need}. ` +
        `Fund ${address} with devnet SOL and try again.`,
    );
  }
}
