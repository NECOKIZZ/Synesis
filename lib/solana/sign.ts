/**
 * lib/solana/sign.ts — the build → Circle-sign → broadcast → confirm loop.
 *
 * Circle holds the key, so the flow differs from EVM (where Circle builds, signs
 * AND broadcasts in one call). Here:
 *   1. Build a legacy Transaction with a fresh blockhash.
 *   2. Serialize it UNSIGNED (requireAllSignatures:false).
 *   3. Hand the base64 to Circle's Signing API (auto-injects the entity secret,
 *      same as createContractExecutionTransaction).
 *   4. Broadcast the signed bytes ourselves and confirm.
 *
 * Blockhash safety: Circle's signing is an async round-trip; if the blockhash
 * ages out during it, the signed tx is dead on arrival. We rebuild + re-sign
 * ONCE with a fresh blockhash. Before any rebuild we check the signature status,
 * so we never re-broadcast a transaction that actually landed.
 */

import "server-only";
import {
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { circleDev } from "@/lib/circle";
import { computeBudgetIxs } from "./fees";
import { getSolanaConnection } from "./connection";

export type SolanaBroadcastResult = { signature: string; slot?: number };

const SIGN_TIMEOUT_MS = Number(process.env.SOLANA_SIGN_TIMEOUT_MS ?? "20000");
const STALE_BLOCKHASH = /blockhash|block height|expired|TransactionExpired/i;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`Solana ${label} timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * Build, sign (via Circle), broadcast and confirm a legacy Solana transaction.
 * Throws on failure — the caller marks the spend FAILED and the user can retry.
 */
export async function signAndBroadcast(args: {
  walletId: string; // Circle Solana wallet id
  feePayer: string; // agent Solana address (base58)
  instructions: TransactionInstruction[];
  memo?: string;
}): Promise<SolanaBroadcastResult> {
  if (!circleDev) throw new Error("Circle dev client not configured");
  const connection = getSolanaConnection();
  const feePayer = new PublicKey(args.feePayer);

  let lastErr: unknown;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");

    const tx = new Transaction();
    tx.add(...computeBudgetIxs(), ...args.instructions);
    tx.feePayer = feePayer;
    tx.recentBlockhash = blockhash;

    const rawTransaction = tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");

    // Circle signs. Bounded so a hung socket can't stall the whole request.
    const signRes = await withTimeout(
      circleDev.signTransaction({
        walletId: args.walletId,
        rawTransaction,
        memo: args.memo,
      }),
      SIGN_TIMEOUT_MS,
      "signTransaction",
    );
    const signedB64 = signRes.data?.signedTransaction;
    if (!signedB64) throw new Error("Circle returned no signedTransaction");

    const signedBuf = Buffer.from(signedB64, "base64");

    // Broadcast the signed bytes ourselves.
    let signature: string;
    try {
      signature = await connection.sendRawTransaction(signedBuf, {
        skipPreflight: false,
        maxRetries: 3,
      });
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt === 1 && STALE_BLOCKHASH.test(msg)) {
        console.warn("[solana.sign] stale blockhash on send, rebuilding:", msg);
        continue;
      }
      throw err;
    }

    // Confirm.
    try {
      const conf = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed",
      );
      if (conf.value.err) {
        throw new Error(
          `Transaction failed on-chain: ${JSON.stringify(conf.value.err)}`,
        );
      }
      return { signature, slot: conf.context?.slot };
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt === 1 && STALE_BLOCKHASH.test(msg)) {
        // Before rebuilding, make sure it didn't actually land — never
        // re-broadcast a transaction that already succeeded.
        const status = await connection.getSignatureStatus(signature, {
          searchTransactionHistory: true,
        });
        const s = status.value;
        if (s && !s.err && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
          return { signature, slot: s.slot };
        }
        console.warn("[solana.sign] blockhash expired during confirm, retrying once:", msg);
        continue;
      }
      throw err;
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error("Solana sign/broadcast failed");
}
