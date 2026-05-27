/**
 * Skill: RECURRING_PAYMENT
 *
 * Saves a scheduled payment policy. Does NOT transfer funds immediately.
 * The cron runner reads active policies and calls onCronTick() on schedule.
 *
 * Policy rows are HMAC-signed at creation. The cron runner re-verifies the
 * HMAC before executing — a tampered DB row is silently rejected.
 *
 * Trigger examples:
 *   "send 10 USDC to sara.arc every week"
 *   "pay rent 50 USDC monthly on the 1st"
 *   "set up daily payment of 2 USDC to 0x848f…"
 *
 * Required params: { recipient, amount, frequency: "daily"|"weekly"|"monthly" }
 * Optional params: { day_of_week: 0-6, day_of_month: 1-31 }
 */

import "server-only";
import { isAddress } from "ethers";
import { resolveRecipient, normalizeName } from "@/lib/ans";
import {
  executeAgentSendUsdc,
  checkSpendLimits,
  checkBalanceSufficient,
  signPolicyHmac,
  verifyPolicyHmac,
  computeNextRun,
  startOfDayUTC,
  startOfWeekUTC,
  startOfMonthUTC,
} from "@/lib/agent";
import type {
  SkillHandler,
  SkillContext,
  SkillOutput,
  CronContext,
  CronTickOutput,
  AgentPolicy,
} from "./types";

type Frequency = "daily" | "weekly" | "monthly";
const VALID_FREQUENCIES: Frequency[] = ["daily", "weekly", "monthly"];

export const RecurringPayment: SkillHandler = {
  category: "POLICY",
  version: 1,
  // execute() creates a policy row — no money moves until cron picks it up.
  // The cron path moves funds but is a separate code path; affectsFunds
  // describes execute() specifically.
  affectsFunds: false,

  // Two identical "send 10 USDC to sara.arc weekly" submissions within the
  // dedupe window should NOT create two policies.
  idempotencyKey(params): string | null {
    const recipient = String(params.recipient ?? "").toLowerCase().trim();
    const amount = Number(params.amount);
    const frequency = String(params.frequency ?? "");
    const dow = params.day_of_week  !== undefined ? Number(params.day_of_week)  : "";
    const dom = params.day_of_month !== undefined ? Number(params.day_of_month) : "";
    if (!recipient || !isFinite(amount) || amount <= 0 || !frequency) return null;
    return `RECURRING_PAYMENT:${recipient}:${amount.toFixed(6)}:${frequency}:${dow}:${dom}`;
  },

  // ── Save the policy ────────────────────────────────────────────────────
  async execute(ctx: SkillContext): Promise<SkillOutput> {
    const { supabase, supabaseUserId, limits, params } = ctx;

    const recipient  = String(params.recipient  ?? "");
    const amount     = Number(params.amount);
    const frequency  = String(params.frequency  ?? "") as Frequency;
    const dayOfWeek  = params.day_of_week  !== undefined ? Number(params.day_of_week)  : undefined;
    const dayOfMonth = params.day_of_month !== undefined ? Number(params.day_of_month) : undefined;

    if (!recipient || isNaN(amount) || amount <= 0) {
      return { ok: false, error: "recipient and amount are required", status: 400 };
    }
    if (!VALID_FREQUENCIES.includes(frequency)) {
      return { ok: false, error: `frequency must be daily, weekly, or monthly`, status: 400 };
    }
    if (amount > limits.max_per_transaction_usdc) {
      return {
        ok: false,
        error: `Amount $${amount} exceeds per-transaction limit of $${limits.max_per_transaction_usdc} USDC`,
        status: 400,
      };
    }

    let recipientAddress: string;
    try {
      recipientAddress = await resolveRecipient(recipient);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : `Could not resolve: ${recipient}`, status: 400 };
    }

    if (!isAddress(recipientAddress)) {
      return { ok: false, error: "Resolved recipient address is invalid", status: 400 };
    }

    const nextRun = computeNextRun(frequency, dayOfWeek, dayOfMonth);

    const { data: policyRow, error: insertErr } = await supabase
      .from("agent_policies")
      .insert({
        user_id: supabaseUserId,
        skill: "RECURRING_PAYMENT",
        params,
        recipient_arc_name: recipient.trim().startsWith("0x") ? null : normalizeName(recipient),
        recipient_address: recipientAddress,
        last_resolved_address: recipientAddress,
        amount_usdc: amount,
        frequency,
        next_run: nextRun.toISOString(),
        policy_hmac: "pending",
        confirmed_at: new Date().toISOString(),
      })
      .select("id, created_at")
      .single();

    if (insertErr || !policyRow) {
      console.error("[recurring-payment] insert failed:", insertErr);
      return { ok: false, error: "Failed to save policy", status: 500 };
    }

    // Layer 4: compute real HMAC and store it
    const hmac = signPolicyHmac({
      userId: supabaseUserId,
      policyId: policyRow.id,
      skill: "RECURRING_PAYMENT",
      recipientAddress,
      amountUsdc: amount,
      frequency,
      createdAt: policyRow.created_at,
    });

    await supabase
      .from("agent_policies")
      .update({ policy_hmac: hmac })
      .eq("id", policyRow.id);

    return {
      ok: true,
      status: 201,
      result: { policyId: policyRow.id, nextRun: nextRun.toISOString(), recipientAddress, amountUsdc: amount, frequency },
    };
  },

  // ── Cron execution ─────────────────────────────────────────────────────
  //
  // The skill owns the execution decision and spend-log record. The cron
  // runner (T2.1) owns policy state transitions (active, pause_reason,
  // next_run) based on the returned CronTickOutput:
  //
  //   { ok: true }                            → runner advances next_run
  //   { ok: false, pauseReason }              → runner deactivates policy
  //   { ok: false, retry: true }              → runner retries next tick
  //   { ok: false }                           → runner logs + skips
  async onCronTick(ctx: CronContext, policy: AgentPolicy): Promise<CronTickOutput> {
    const { serviceSupabase, supabaseUserId, agentWallet, limits, getSpentSince } = ctx;

    // ── Re-verify HMAC (version-aware: v1 legacy, v2 orchestration) ──
    const hmacValid = verifyPolicyHmac(
      {
        userId: supabaseUserId,
        policyId: policy.id,
        skill: policy.skill,
        recipientAddress: policy.recipient_address ?? "",
        amountUsdc: policy.amount_usdc,
        frequency: policy.frequency ?? "",
        createdAt: policy.created_at,
      },
      policy.policy_hmac,
      policy.hmac_version,
    );

    if (!hmacValid) {
      console.error(`[recurring-payment] HMAC mismatch on policy ${policy.id}`);
      return {
        ok: false,
        error: "HMAC verification failed",
        pauseReason: "HMAC verification failed",
      };
    }

    // ── Re-resolve .arc name (hijack protection) ──────────────────────
    const recipientAddress = policy.recipient_address ?? "";
    if (policy.params?.recipient && String(policy.params.recipient).endsWith(".arc")) {
      try {
        const fresh = await resolveRecipient(String(policy.params.recipient));
        if (fresh.toLowerCase() !== recipientAddress.toLowerCase()) {
          return {
            ok: false,
            error: `Recipient address changed: ${fresh}`,
            pauseReason: `Recipient address changed: ${fresh}`,
          };
        }
      } catch (err) {
        // Resolver could be transiently down — retry on next tick before
        // permanently pausing. The runner is responsible for upgrading
        // repeated retries into a pause if it wants stricter semantics.
        const msg = err instanceof Error ? err.message : "Resolver error";
        return { ok: false, error: `ANS resolve failed: ${msg}`, retry: true };
      }
    }

    if (!isAddress(recipientAddress)) {
      return {
        ok: false,
        error: "Stored recipient address is invalid",
        pauseReason: "Stored recipient address is invalid",
      };
    }

    // ── Balance check: does the wallet have enough for THIS transfer? ──
    const balanceCheck = await checkBalanceSufficient(
      agentWallet.circle_wallet_id,
      policy.amount_usdc,
    );
    if (!balanceCheck.sufficient) {
      // Pause rather than retry — the balance won't magically increase
      // before the next cron tick unless the user tops up.
      return {
        ok: false,
        error: balanceCheck.error,
        pauseReason: balanceCheck.error,
      };
    }

    // ── Spend limit check ─────────────────────────────────────────────
    const [spentToday, spentThisWeek, spentThisMonth] = await Promise.all([
      getSpentSince(startOfDayUTC()),
      getSpentSince(startOfWeekUTC()),
      getSpentSince(startOfMonthUTC()),
    ]);

    const check = checkSpendLimits({
      amountUsdc: policy.amount_usdc,
      limits,
      spentTodayUsdc: spentToday,
      spentThisWeekUsdc: spentThisWeek,
      spentThisMonthUsdc: spentThisMonth,
    });

    if (!check.allowed) {
      // Not a permanent pause — quota will refresh at the next period
      // boundary. Tell the runner to retry rather than deactivate.
      console.warn(`[recurring-payment] policy ${policy.id} blocked by limits: ${check.reason}`);
      return { ok: false, error: check.reason, retry: true };
    }

    // ── Log PENDING (service role — no user session in cron context) ──
    const { data: logRow } = await serviceSupabase
      .from("agent_spend_log")
      .insert({
        user_id: supabaseUserId,
        skill: "RECURRING_PAYMENT",
        policy_id: policy.id,
        recipient_address: recipientAddress,
        recipient_arc_name: policy.params?.recipient && !String(policy.params.recipient).startsWith("0x")
          ? normalizeName(String(policy.params.recipient))
          : null,
        amount_usdc: policy.amount_usdc,
        status: "PENDING",
      })
      .select("id")
      .single();

    // ── Execute the on-chain transfer ─────────────────────────────────
    let txHash: string;
    let circleTxId: string;
    try {
      const result = await executeAgentSendUsdc({
        agentWalletId: agentWallet.circle_wallet_id,
        recipientAddress,
        amountDecimal: policy.amount_usdc.toFixed(6),
      });
      txHash = result.txHash;
      circleTxId = result.circleTxId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Cron execution failed";
      if (logRow?.id) {
        await serviceSupabase
          .from("agent_spend_log")
          .update({ status: "FAILED", error_message: msg })
          .eq("id", logRow.id);
      }
      // Transient by default — runner can upgrade to pause if it sees
      // repeated failures.
      return { ok: false, error: msg, retry: true };
    }

    // ── Mark COMPLETE ─────────────────────────────────────────────────
    if (logRow?.id) {
      await serviceSupabase
        .from("agent_spend_log")
        .update({ status: "COMPLETE", tx_hash: txHash, circle_tx_id: circleTxId })
        .eq("id", logRow.id);
    }

    // ── Compute next run for the runner ───────────────────────────────
    // The runner is responsible for actually writing next_run + clearing
    // pause_reason. Returning it as result lets the runner apply it in a
    // single UPDATE alongside any orchestration columns it owns.
    const nextRun = computeNextRun(
      policy.frequency as Frequency,
      policy.params?.day_of_week !== undefined ? Number(policy.params.day_of_week) : undefined,
      policy.params?.day_of_month !== undefined ? Number(policy.params.day_of_month) : undefined,
    );

    return {
      ok: true,
      result: {
        txHash,
        circleTxId,
        amountUsdc: policy.amount_usdc,
        recipientAddress,
        nextRun: nextRun.toISOString(),
      },
    };
  },
};
