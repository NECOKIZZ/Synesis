/**
 * Skill: WITHDRAW
 *
 * Moves USDC from the agent wallet back to the user's main wallet.
 * Destination is always session.mainWalletAddress — never a client param.
 * NOT subject to spend limits (returning funds to owner's control).
 *
 * Trigger examples:
 *   "withdraw everything from my agent"
 *   "move 20 USDC back to my main wallet"
 *   "pull out all my funds"
 *
 * Required params: { amount: number | "all" }
 */

import "server-only";
import { isAddress } from "ethers";
import { executeAgentSendUsdc, getAgentBalance, checkBalanceSufficient } from "@/lib/agent";
import type { SkillHandler, SkillContext, SkillOutput } from "./types";

export const Withdraw: SkillHandler = {
  category: "TRANSFER",
  version: 1,
  affectsFunds: true,
  // No PIN: withdraw moves USDC from agent → user's own main wallet.
  // Funds never leave the user's control, so we don't gate on PIN.
  requiresPin: false,
  // Numeric amount is in USDC and draws from the agent wallet → balance gate.
  // ("all" extracts as 0 in pre-flight and is sized live inside execute().)
  requiresBalanceCheck: true,

  // Withdraw "all" is intentionally retryable (user might want to drain a
  // dust amount that arrived after the first call). Numeric amounts are
  // deduped within the executor window.
  idempotencyKey(params): string | null {
    if (params.amount === "all") return null;
    const amount = Number(params.amount);
    if (!isFinite(amount) || amount <= 0) return null;
    return `WITHDRAW:${amount.toFixed(6)}`;
  },

  async execute(ctx: SkillContext): Promise<SkillOutput> {
    const { supabase, serviceSupabase, supabaseUserId, mainWalletAddress, agentWallet, params } = ctx;

    // Destination is always the verified session wallet — never from params
    if (!isAddress(mainWalletAddress)) {
      return { ok: false, error: "Invalid main wallet address in session", status: 500 };
    }

    // Resolve amount
    let amountUsdc: number;
    if (params.amount === "all") {
      const balanceStr = await getAgentBalance(agentWallet.circle_wallet_id);
      const balance = parseFloat(balanceStr);
      if (!Number.isFinite(balance) || balance <= 0) {
        return { ok: false, error: "Agent wallet has no balance to withdraw", status: 400 };
      }
      // Arc pays gas in USDC. Draining to zero leaves nothing to cover the
      // withdraw transaction's OWN gas, so the transfer fails (this caused
      // the "withdraw all" failures in stress testing). Keep a small reserve
      // so "withdraw all" clears reliably.
      const gasBuffer = Number(process.env.WITHDRAW_GAS_BUFFER_USDC ?? 0.1);
      if (balance <= gasBuffer) {
        return {
          ok: false,
          error:
            `Your agent wallet holds ${balance.toFixed(2)} USDC — too low to cover the ` +
            `~${gasBuffer} USDC gas reserve needed to withdraw. Nothing was moved.`,
          status: 400,
        };
      }
      // Floor to 6 decimal places to avoid Circle rounding errors
      amountUsdc = Math.floor((balance - gasBuffer) * 1_000_000) / 1_000_000;
    } else {
      const raw = Number(params.amount);
      if (isNaN(raw) || raw <= 0) {
        return { ok: false, error: "amount must be a positive number or \"all\"", status: 400 };
      }
      amountUsdc = parseFloat(raw.toFixed(6));

      // Balance check FIRST for numeric amounts ("all" is always sufficient)
      const balanceCheck = await checkBalanceSufficient(agentWallet.circle_wallet_id, amountUsdc);
      if (!balanceCheck.sufficient) {
        return { ok: false, error: balanceCheck.error, status: 400 };
      }
    }

    // Log PENDING (user's RLS client). Hard-stop if insert fails.
    const { data: logRow, error: logErr } = await supabase
      .from("agent_spend_log")
      .insert({
        user_id: supabaseUserId,
        wallet_type: "agent",
        skill: "WITHDRAW",
        recipient_address: mainWalletAddress,
        amount_usdc: amountUsdc,
        status: "PENDING",
      })
      .select("id")
      .single();

    if (logErr || !logRow?.id) {
      console.error("[withdraw] PENDING log insert failed:", logErr);
      return {
        ok: false,
        error:
          "Something went wrong on our end before we could process your withdrawal. " +
          "No money has moved. Please try again in a moment.",
        status: 500,
      };
    }

    // Execute
    let txHash: string;
    let circleTxId: string;
    try {
      const result = await executeAgentSendUsdc({
        agentWalletId: agentWallet.circle_wallet_id,
        recipientAddress: mainWalletAddress,
        amountDecimal: amountUsdc.toFixed(6),
      });
      txHash = result.txHash;
      circleTxId = result.circleTxId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Withdrawal failed";
      await serviceSupabase
        .from("agent_spend_log")
        .update({ status: "FAILED", error_message: msg })
        .eq("id", logRow.id);

      const friendly = mapCircleErrorToFriendly(msg);
      return { ok: false, error: friendly, status: 502 };
    }

    // Mark COMPLETE (service role — no UPDATE RLS policy on spend log)
    await serviceSupabase
      .from("agent_spend_log")
      .update({ status: "COMPLETE", tx_hash: txHash, circle_tx_id: circleTxId })
      .eq("id", logRow.id);

    return { ok: true, result: { txHash, amountUsdc, mainWalletAddress } };
  },
};

function mapCircleErrorToFriendly(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("insufficient") || lower.includes("balance")) {
    return "Your agent wallet doesn't have enough USDC to complete this withdrawal.";
  }
  if (lower.includes("invalid") && lower.includes("address")) {
    return "The destination address doesn't look right. Please try again.";
  }
  if (lower.includes("timeout") || lower.includes("etimedout")) {
    return "The withdrawal timed out. No money has left your wallet. Please try again in a moment.";
  }
  return "The withdrawal didn't go through. No money has left your wallet. You can try again — if the problem keeps happening, contact support.";
}
