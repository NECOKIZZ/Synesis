/**
 * Skill: SEND_USDC
 *
 * One-time immediate USDC transfer from the agent wallet to any
 * address or .arc name. Enforces per-transaction, daily, and monthly
 * spend limits. Logs every attempt (PENDING → COMPLETE / FAILED).
 *
 * Trigger examples:
 *   "send 5 USDC to sara.arc"
 *   "pay 10 USDC to 0x848f…"
 *   "transfer 2 dollars to john.arc"
 *
 * Required params: { recipient: string, amount: number }
 */

import "server-only";
import { isAddress } from "ethers";
import { resolveRecipient, normalizeName } from "@/lib/ans";
import {
  executeAgentSendUsdc,
  checkSpendLimits,
  checkBalanceSufficient,
  startOfDayUTC,
  startOfWeekUTC,
  startOfMonthUTC,
} from "@/lib/agent";
import type { SkillHandler, SkillContext, SkillOutput } from "./types";

export const SendUsdc: SkillHandler = {
  category: "TRANSFER",
  version: 1,
  affectsFunds: true,
  // Draws USDC out of the agent wallet; amount is in USDC → gate on balance.
  requiresBalanceCheck: true,

  // Same recipient + same amount = same intent. The future executor will
  // dedupe within a short window (e.g. 60 s) to neutralize double-click
  // submits without preventing legitimate "send 5 again" sequences.
  idempotencyKey(params): string | null {
    const recipient = String(params.recipient ?? "").toLowerCase().trim();
    const amount = Number(params.amount);
    if (!recipient || !isFinite(amount) || amount <= 0) return null;
    return `SEND_USDC:${recipient}:${amount.toFixed(6)}`;
  },

  async execute(ctx: SkillContext): Promise<SkillOutput> {
    const { supabase, serviceSupabase, supabaseUserId, agentWallet, limits, params, getSpentSince } = ctx;

    const recipient = String(params.recipient ?? "");
    const rawAmount = Number(params.amount);

    if (!recipient || isNaN(rawAmount) || rawAmount <= 0) {
      return { ok: false, error: "Invalid SEND_USDC params: recipient and amount required", status: 400 };
    }

    // ── S4: Normalise amount to fixed 6-decimal precision before any downstream use
    const amount = parseFloat(rawAmount.toFixed(6));
    if (amount <= 0) {
      return { ok: false, error: "Amount is too small to transfer", status: 400 };
    }

    // ── S1: Balance check FIRST — before recipient resolution, limits, logging, Circle
    const balanceCheck = await checkBalanceSufficient(agentWallet.circle_wallet_id, amount);
    if (!balanceCheck.sufficient) {
      return { ok: false, error: balanceCheck.error, status: 400 };
    }

    // Resolve recipient server-side — never trust Claude's address resolution
    let recipientAddress: string;
    try {
      recipientAddress = await resolveRecipient(recipient);
    } catch (err) {
      const msg = err instanceof Error ? err.message : `Could not resolve: ${recipient}`;
      return { ok: false, error: msg, status: 400 };
    }

    if (!isAddress(recipientAddress)) {
      return { ok: false, error: "Resolved recipient address failed isAddress() check", status: 400 };
    }

    if (recipientAddress.toLowerCase() === agentWallet.circle_wallet_address.toLowerCase()) {
      return { ok: false, error: "Cannot send to own agent wallet", status: 400 };
    }

    // Server-side spend limit check (independent of interpreter output)
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

    // ── S2: Log as PENDING before executing. Hard-stop if the insert fails.
    const { data: logRow, error: logErr } = await supabase
      .from("agent_spend_log")
      .insert({
        user_id: supabaseUserId,
        wallet_type: "agent",
        skill: "SEND_USDC",
        recipient_address: recipientAddress,
        recipient_arc_name: recipient.trim().startsWith("0x") ? null : normalizeName(recipient),
        amount_usdc: amount,
        status: "PENDING",
      })
      .select("id")
      .single();

    if (logErr || !logRow?.id) {
      console.error("[send-usdc] PENDING log insert failed:", logErr);
      return {
        ok: false,
        error:
          "Something went wrong on our end before we could process your transfer. " +
          "No money has moved. Please try again in a moment.",
        status: 500,
      };
    }

    // ── Execute transfer via Circle developer-controlled wallet ───────
    let txHash: string;
    let circleTxId: string;
    try {
      const result = await executeAgentSendUsdc({
        agentWalletId: agentWallet.circle_wallet_id,
        recipientAddress,
        amountDecimal: amount.toFixed(6),
      });
      txHash = result.txHash;
      circleTxId = result.circleTxId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Circle transfer failed";
      // Use service role for status update — agent_spend_log has no UPDATE RLS policy
      await serviceSupabase
        .from("agent_spend_log")
        .update({ status: "FAILED", error_message: msg })
        .eq("id", logRow.id);

      // ── S5: Map known Circle errors to friendly messages
      const friendly = mapCircleErrorToFriendly(msg);
      return { ok: false, error: friendly, status: 502 };
    }

    // Mark COMPLETE (service role — see above)
    await serviceSupabase
      .from("agent_spend_log")
      .update({ status: "COMPLETE", tx_hash: txHash, circle_tx_id: circleTxId })
      .eq("id", logRow.id);

    return {
      ok: true,
      result: { txHash, recipientAddress, amountUsdc: amount },
    };
  },
};

// ── S5: Friendly error mapping for known Circle failure modes ────────

function mapCircleErrorToFriendly(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("insufficient") || lower.includes("balance")) {
    return "Your agent wallet doesn't have enough USDC to complete this transfer.";
  }
  if (lower.includes("invalid") && lower.includes("address")) {
    return "The recipient address doesn't look right. Double-check the .arc name and try again.";
  }
  if (lower.includes("timeout") || lower.includes("etimedout")) {
    return "The transfer timed out. No money has left your wallet. Please try again in a moment.";
  }
  // Safe generic fallback — never leak raw Circle internals
  return "The transfer didn't go through. No money has left your wallet. You can try again — if the problem keeps happening, contact support.";
}
