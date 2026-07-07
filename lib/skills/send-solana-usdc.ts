/**
 * Skill: SEND_SOLANA_USDC
 *
 * Send USDC (SPL) from the agent's Solana wallet to any base58 address on
 * Solana devnet. This is a genuine program interaction — it invokes the SPL
 * Token program (transferChecked) plus idempotent ATA creation — executed via
 * Circle's Signing API: we build the tx, Circle signs it, we broadcast + confirm
 * (see lib/solana/*). Enforces the same USD spend limits as EVM sends.
 *
 * Trigger examples:
 *   "send 1 USDC to <base58> on solana"
 *   "pay 5 usdc on sol to <base58>"
 *
 * Required params: { recipient: string (base58), amount: number }
 *
 * Prerequisite: the user must have activated Solana (POST /api/agent/activate-solana)
 * AND funded that wallet with devnet SOL for fees + devnet USDC to send.
 */

import "server-only";
import { PublicKey } from "@solana/web3.js";
import {
  checkSpendLimits,
  startOfDayUTC,
  startOfWeekUTC,
  startOfMonthUTC,
} from "@/lib/agent";
import { getSolanaConnection } from "@/lib/solana/connection";
import { assertSolForFees } from "@/lib/solana/fees";
import { buildUsdcTransferIxs, readUsdcBalance } from "@/lib/solana/spl";
import { signAndBroadcast } from "@/lib/solana/sign";
import { solanaExplorerTx } from "@/lib/solana/config";
import type { SkillHandler, SkillContext, SkillOutput } from "./types";

function isBase58Pubkey(s: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

export const SendSolanaUsdc: SkillHandler = {
  category: "TRANSFER",
  version: 1,
  affectsFunds: true,
  requiresPin: true,
  // The confirm-policy upfront pre-flight reads the EVM wallet's cached USDC
  // balance — a DIFFERENT wallet. So we must NOT opt into requiresBalanceCheck;
  // this skill runs its own balance check against the Solana wallet below.
  requiresBalanceCheck: false,

  idempotencyKey(params): string | null {
    const recipient = String(params.recipient ?? "").trim();
    const amount = Number(params.amount);
    if (!recipient || !isFinite(amount) || amount <= 0) return null;
    const day = new Date().toISOString().slice(0, 10);
    return `SEND_SOLANA_USDC:${recipient}:${amount.toFixed(6)}:${day}`;
  },

  async execute(ctx: SkillContext): Promise<SkillOutput> {
    const {
      supabase, serviceSupabase, supabaseUserId,
      agentSolanaWallet, limits, params, getSpentSince,
    } = ctx;

    if (!agentSolanaWallet) {
      return {
        ok: false,
        error: "Solana isn't activated for your agent wallet yet. Enable Solana first, then fund it with devnet SOL + USDC.",
        status: 400,
      };
    }

    const recipient = String(params.recipient ?? "").trim();
    const rawAmount = Number(params.amount);

    if (!recipient || isNaN(rawAmount) || rawAmount <= 0) {
      return { ok: false, error: "Invalid SEND_SOLANA_USDC params: recipient (base58) and amount required", status: 400 };
    }
    if (!isBase58Pubkey(recipient)) {
      return { ok: false, error: `"${recipient}" is not a valid Solana address.`, status: 400 };
    }

    const amount = parseFloat(rawAmount.toFixed(6));
    if (amount <= 0) {
      return { ok: false, error: "Amount is too small to transfer", status: 400 };
    }

    const fromAddress = agentSolanaWallet.circle_wallet_address;
    if (recipient === fromAddress) {
      return { ok: false, error: "Cannot send to the agent's own Solana wallet", status: 400 };
    }

    const connection = getSolanaConnection();

    // SOL-for-fees pre-check — USDC can't pay Solana network fees.
    try {
      await assertSolForFees(connection, fromAddress);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Solana wallet can't cover fees", status: 400 };
    }

    // In-skill USDC balance check on the SOLANA wallet.
    let usdcBalance: number;
    try {
      usdcBalance = await readUsdcBalance(connection, fromAddress);
    } catch {
      return { ok: false, error: "Couldn't read your Solana USDC balance. Please try again.", status: 500 };
    }
    if (amount > usdcBalance) {
      return { ok: false, error: `Not enough USDC on Solana. Wallet has ${usdcBalance.toFixed(2)} USDC, this send needs ${amount}.`, status: 400 };
    }

    // Spend limits — USDC leaving the agent counts toward the same USD caps.
    const [spentToday, spentThisWeek, spentThisMonth] = await Promise.all([
      getSpentSince(startOfDayUTC()),
      getSpentSince(startOfWeekUTC()),
      getSpentSince(startOfMonthUTC()),
    ]);
    const check = checkSpendLimits({
      amountUsdc: amount,
      limits,
      spentTodayUsdc: spentToday,
      spentThisWeekUsdc: spentThisWeek,
      spentThisMonthUsdc: spentThisMonth,
    });
    if (!check.allowed) {
      return { ok: false, error: check.reason, status: 400 };
    }

    // ── Log PENDING before broadcasting ───────────────────────────────
    const { data: logRow, error: logErr } = await supabase
      .from("agent_spend_log")
      .insert({
        user_id: supabaseUserId,
        wallet_type: "agent",
        blockchain: "SOL-DEVNET",
        skill: "SEND_SOLANA_USDC",
        recipient_address: recipient,
        amount_usdc: amount,
        token_symbol: "USDC",
        status: "PENDING",
      })
      .select("id")
      .single();

    if (logErr || !logRow?.id) {
      console.error("[send-solana-usdc] PENDING log insert failed:", logErr);
      return {
        ok: false,
        error: "Something went wrong before we could process your transfer. No money has moved. Please try again.",
        status: 500,
      };
    }

    // ── Build → Circle-sign → broadcast → confirm ─────────────────────
    try {
      const instructions = buildUsdcTransferIxs({
        fromOwner: fromAddress,
        toOwner: recipient,
        amount,
      });

      const { signature } = await signAndBroadcast({
        walletId: agentSolanaWallet.circle_wallet_id,
        feePayer: fromAddress,
        instructions,
        memo: `Send ${amount} USDC`,
      });

      await serviceSupabase
        .from("agent_spend_log")
        .update({ status: "COMPLETE", tx_hash: signature })
        .eq("id", logRow.id);

      return {
        ok: true,
        result: {
          txHash: signature,
          explorerUrl: solanaExplorerTx(signature),
          recipient,
          amountUsdc: amount,
          chain: "SOL-DEVNET",
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Solana transfer failed";
      console.error("[send-solana-usdc] error:", msg);
      await serviceSupabase
        .from("agent_spend_log")
        .update({ status: "FAILED", error_message: msg })
        .eq("id", logRow.id);
      return { ok: false, error: `Solana transfer failed: ${msg}`, status: 502 };
    }
  },
};
