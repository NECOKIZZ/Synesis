/**
 * lib/solana/spl.ts — SPL (USDC) transfer instruction builder.
 *
 * Building these instructions IS the program interaction: we invoke the SPL
 * Token program (transferChecked) and the Associated Token Account program
 * (idempotent ATA creation). Circle does NOT create ATAs for recipients, so we
 * bundle an idempotent create before the transfer — a no-op if the recipient's
 * ATA already exists, otherwise it's created (sender pays the rent).
 */

import "server-only";
import { Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import { SOLANA_USDC_MINT, SOLANA_USDC_DECIMALS } from "./config";

/**
 * Read an owner's USDC (SPL) balance in human-readable units. Returns 0 if the
 * owner has no Associated Token Account for USDC yet (i.e. never received any).
 */
export async function readUsdcBalance(
  connection: Connection,
  owner: string,
): Promise<number> {
  const mint = new PublicKey(SOLANA_USDC_MINT);
  const ata = getAssociatedTokenAddressSync(mint, new PublicKey(owner));
  try {
    const res = await connection.getTokenAccountBalance(ata, "confirmed");
    return res.value.uiAmount ?? 0;
  } catch {
    // ATA doesn't exist → no USDC held.
    return 0;
  }
}

/**
 * Instructions for a USDC SPL transfer:
 *  1. Idempotently create the RECIPIENT's ATA (payer = sender).
 *  2. transferChecked from sender ATA → recipient ATA.
 * The sender ATA is assumed to exist (it holds the USDC the wallet is sending).
 */
export function buildUsdcTransferIxs(args: {
  fromOwner: string; // agent Solana address (sender / fee payer)
  toOwner: string; // recipient base58 address
  amount: number; // human-readable USDC
}): TransactionInstruction[] {
  const mint = new PublicKey(SOLANA_USDC_MINT);
  const fromOwner = new PublicKey(args.fromOwner);
  const toOwner = new PublicKey(args.toOwner);

  const fromAta = getAssociatedTokenAddressSync(mint, fromOwner);
  const toAta = getAssociatedTokenAddressSync(mint, toOwner);

  // Convert decimal USDC → base units without float drift.
  const rawAmount = BigInt(Math.round(args.amount * 10 ** SOLANA_USDC_DECIMALS));

  return [
    createAssociatedTokenAccountIdempotentInstruction(
      fromOwner, // payer
      toAta, // ata to create
      toOwner, // owner of the new ata
      mint,
    ),
    createTransferCheckedInstruction(
      fromAta, // source
      mint,
      toAta, // destination
      fromOwner, // authority (signer)
      rawAmount,
      SOLANA_USDC_DECIMALS,
    ),
  ];
}
