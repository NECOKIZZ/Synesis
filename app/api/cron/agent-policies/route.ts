/**
 * GET /api/cron/agent-policies
 *
 * Cron runner for orchestrated policies (trigger + action + stop conditions).
 *
 * Responsibilities:
 *   L0 — Verify CRON_SECRET (prevent unauthorized execution)
 *   L1 — Load all active policies
 *   L2 — For each policy:
 *          a. Verify HMAC (tamper detection)
 *          b. Check stop conditions (balance_below, expires_at, max_executions, max_total_spend)
 *          c. Evaluate trigger (time, price, balance_above)
 *          d. If trigger fires → build SkillContext → dispatch to action skill
 *          e. Update policy execution state (count, spent, next_run, active)
 *
 * Trigger modes:
 *   time          — fires when next_run <= now()
 *   price         — fires when asset price crosses threshold (placeholder)
 *   balance_above — fires when agent balance > threshold_usdc
 *
 * Environment:
 *   CRON_SECRET — shared secret between cron scheduler and this route
 */

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { verifyPolicyHmac, getAgentBalance } from "@/lib/agent";
import { skillRegistry } from "@/lib/skills";
import type { AgentPolicy, SkillContext, CronContext } from "@/lib/skills/types";
import { isAddress } from "ethers";

export const runtime = "nodejs";

const CRON_SECRET = process.env.CRON_SECRET;

// Per-tick safety caps. The cron should never let a slow Circle call wedge
// the entire queue or let one outage cause unbounded retry storms.
const MAX_POLICIES_PER_TICK = Number(process.env.CRON_MAX_POLICIES_PER_TICK ?? 50);
const CRON_CONCURRENCY      = Number(process.env.CRON_CONCURRENCY          ?? 4);

/** Constant-time secret comparison so we don't leak via timing. */
function safeEqualSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function GET(req: Request) {
  // ── L0: Verify CRON_SECRET (timing-safe) ──────────────────────────
  const authHeader = req.headers.get("authorization") ?? "";
  const provided = authHeader.replace(/^Bearer\s+/i, "");
  if (!CRON_SECRET || !provided || !safeEqualSecret(provided, CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const serviceSupabase = createSupabaseServiceClient();
  const now = new Date();

  // ── L1: Load active policies, bounded ─────────────────────────────
  // Bounded so one stuck tick can never grow unboundedly. Anything not
  // processed this tick is picked up on the next.
  const { data: policies, error: loadErr } = await serviceSupabase
    .from("agent_policies")
    .select("*")
    .eq("active", true)
    .order("next_run", { ascending: true, nullsFirst: false })
    .limit(MAX_POLICIES_PER_TICK);

  if (loadErr) {
    console.error("[cron] failed to load policies:", loadErr);
    return NextResponse.json({ error: "DB load failed" }, { status: 500 });
  }

  type Result = {
    policyId: string;
    action: string;
    ok: boolean;
    error?: string;
    pauseReason?: string;
    retry?: boolean;
  };

  const queue = (policies ?? []) as unknown as AgentPolicy[];
  const results: Result[] = [];

  // Bounded concurrency: process up to CRON_CONCURRENCY policies in
  // parallel. One slow Circle call no longer serializes the whole queue.
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < queue.length) {
      const i = cursor++;
      const policy = queue[i]!;
      try {
        const r = await runPolicy(serviceSupabase, policy, now);
        results.push(r);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unhandled error";
        console.error(`[cron] policy ${policy.id} crashed:`, msg);
        results.push({
          policyId: policy.id,
          action: policy.action_skill ?? policy.skill,
          ok: false,
          error: msg,
          retry: true,
        });
      }
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(CRON_CONCURRENCY, queue.length)) },
    () => worker(),
  );
  await Promise.all(workers);

  const fired = results.filter((r) => r.ok && !r.retry).length;
  const paused = results.filter((r) => r.pauseReason).length;
  const retried = results.filter((r) => r.retry).length;
  const errors = results.filter((r) => !r.ok && !r.retry && !r.pauseReason).length;

  return NextResponse.json({
    processed: results.length,
    fired,
    paused,
    retried,
    errors,
    details: results,
  });
}

// ── per-policy execution ────────────────────────────────────────────

async function runPolicy(
  serviceSupabase: ReturnType<typeof createSupabaseServiceClient>,
  policy: AgentPolicy,
  now: Date
): Promise<{ policyId: string; action: string; ok: boolean; error?: string; pauseReason?: string; retry?: boolean }> {
  const userId = policy.user_id;

  // ── HMAC verification ────────────────────────────────────────────
  const hmacOk =
    policy.hmac_version === 2
      ? verifyPolicyHmac(
          {
            userId,
            policyId: policy.id,
            actionSkill: policy.action_skill,
            actionParams: policy.action_params,
            triggerType: policy.trigger_type,
            triggerParams: policy.trigger_params,
            executionMode: policy.execution_mode,
            cooldownSeconds: policy.cooldown_seconds,
            stopConditions: policy.stop_conditions,
            createdAt: policy.created_at,
          },
          policy.policy_hmac,
          2
        )
      : verifyPolicyHmac(
          {
            userId,
            policyId: policy.id,
            skill: policy.skill,
            recipientAddress: policy.recipient_address ?? "",
            amountUsdc: policy.amount_usdc,
            frequency: policy.frequency ?? "",
            createdAt: policy.created_at,
          },
          policy.policy_hmac,
          1
        );

  if (!hmacOk) {
    console.error(`[cron] HMAC mismatch on policy ${policy.id}`);
    await deactivate(serviceSupabase, policy.id, "HMAC verification failed");
    return { policyId: policy.id, action: policy.action_skill ?? policy.skill, ok: false, pauseReason: "HMAC verification failed" };
  }

  // ── Stop condition checks ────────────────────────────────────────
  const stopReason = await checkStopConditions(serviceSupabase, policy);
  if (stopReason) {
    await deactivate(serviceSupabase, policy.id, stopReason);
    return { policyId: policy.id, action: policy.action_skill ?? policy.skill, ok: false, pauseReason: stopReason };
  }

  // ── Trigger evaluation ───────────────────────────────────────────
  const triggerFired = await evaluateTrigger(serviceSupabase, policy, now);
  if (!triggerFired.fired) {
    return {
      policyId: policy.id,
      action: policy.action_skill ?? policy.skill,
      ok: true,
      error: triggerFired.reason,
    };
  }

  // ── Legacy path: RECURRING_PAYMENT v1 ────────────────────────────
  if (policy.hmac_version === 1 || policy.skill === "RECURRING_PAYMENT") {
    const handler = skillRegistry[policy.skill];
    if (!handler?.onCronTick) {
      return { policyId: policy.id, action: policy.skill, ok: false, error: "Legacy skill has no onCronTick" };
    }

    // Build minimal CronContext for legacy path
    const { agentWallet, limits, getSpentSince } = await buildCronDeps(serviceSupabase, userId);
    if (!agentWallet) {
      return { policyId: policy.id, action: policy.skill, ok: false, error: "Agent wallet not found" };
    }

    const cronCtx: CronContext = {
      supabase: serviceSupabase,
      serviceSupabase,
      supabaseUserId: userId,
      agentWallet,
      limits,
      getSpentSince,
    };

    const tickResult = await handler.onCronTick(cronCtx, policy);

    if (tickResult.ok) {
      await serviceSupabase
        .from("agent_policies")
        .update({
          execution_count: (policy.execution_count ?? 0) + 1,
          last_executed_at: now.toISOString(),
          next_run: (tickResult.result?.nextRun as string) ?? null,
        })
        .eq("id", policy.id);

      return { policyId: policy.id, action: policy.skill, ok: true };
    }

    // tickResult.ok === false
    if (tickResult.pauseReason) {
      await deactivate(serviceSupabase, policy.id, tickResult.pauseReason);
    }

    return {
      policyId: policy.id,
      action: policy.skill,
      ok: false,
      error: tickResult.error,
      pauseReason: tickResult.pauseReason,
      retry: tickResult.retry,
    };
  }

  // ── Orchestration path: v2 ───────────────────────────────────────
  const actionSkill = policy.action_skill;
  const handler = skillRegistry[actionSkill];
  if (!handler) {
    console.error(`[cron] unknown action skill: ${actionSkill}`);
    await deactivate(serviceSupabase, policy.id, `Unknown action skill: ${actionSkill}`);
    return { policyId: policy.id, action: actionSkill, ok: false, pauseReason: `Unknown action skill: ${actionSkill}` };
  }

  // Build execution dependencies
  const deps = await buildCronDeps(serviceSupabase, userId);
  if (!deps.agentWallet) {
    return { policyId: policy.id, action: actionSkill, ok: false, error: "Agent wallet not found" };
  }

  // For WITHDRAW, we need mainWalletAddress — look it up from profiles
  let mainWalletAddress = "";
  if (actionSkill === "WITHDRAW") {
    const { data: profile } = await serviceSupabase
      .from("profiles")
      .select("wallet_address")
      .eq("id", userId)
      .maybeSingle();
    mainWalletAddress = profile?.wallet_address ?? "";
    if (!isAddress(mainWalletAddress)) {
      await deactivate(serviceSupabase, policy.id, "Main wallet address invalid or missing");
      return { policyId: policy.id, action: actionSkill, ok: false, pauseReason: "Main wallet address invalid or missing" };
    }
  }

  // Build SkillContext for the action skill
  const ctx: SkillContext = {
    supabase: serviceSupabase,
    serviceSupabase,
    supabaseUserId: userId,
    mainWalletAddress,
    agentWallet: deps.agentWallet,
    limits: deps.limits,
    params: policy.action_params,
    getSpentSince: deps.getSpentSince,
  };

  const output = await handler.execute(ctx);

  // ── Update policy state based on result ──────────────────────────
  if (output.ok) {
    // Success: increment counters, update last_executed_at
    const amountUsdc = extractAmountFromResult(output.result) ?? extractAmountFromParams(policy.action_params) ?? 0;
    const newCount = (policy.execution_count ?? 0) + 1;
    const newSpent = Number(policy.total_spent_usdc ?? 0) + amountUsdc;

    const updates: Record<string, unknown> = {
      execution_count: newCount,
      total_spent_usdc: newSpent.toFixed(6),
      last_executed_at: now.toISOString(),
    };

    if (policy.execution_mode === "once") {
      updates.active = false;
      updates.pause_reason = "Completed (execution_mode = once)";
    } else if (policy.trigger_type === "time") {
      // Compute next run for time-based repeat policies
      const freq = policy.trigger_params?.frequency as string;
      const dow = policy.trigger_params?.day_of_week as number | undefined;
      const dom = policy.trigger_params?.day_of_month as number | undefined;
      if (freq) {
        const next = computeNextRunTime(freq, dow, dom);
        updates.next_run = next;
      }
    }

    await serviceSupabase.from("agent_policies").update(updates).eq("id", policy.id);

    return { policyId: policy.id, action: actionSkill, ok: true };
  }

  // Failure: decide retry vs pause
  const shouldRetry = output.status === 429 || output.status === 502 || output.status === 503;
  if (!shouldRetry) {
    // Permanent failure — pause the policy
    await deactivate(serviceSupabase, policy.id, output.error ?? "Execution failed");
    return { policyId: policy.id, action: actionSkill, ok: false, pauseReason: output.error };
  }

  // Transient failure — leave active, retry next tick
  return { policyId: policy.id, action: actionSkill, ok: false, error: output.error, retry: true };
}

// ── helpers ─────────────────────────────────────────────────────────

async function deactivate(
  serviceSupabase: ReturnType<typeof createSupabaseServiceClient>,
  policyId: string,
  reason: string
) {
  await serviceSupabase
    .from("agent_policies")
    .update({ active: false, pause_reason: reason })
    .eq("id", policyId);
}

async function checkStopConditions(
  serviceSupabase: ReturnType<typeof createSupabaseServiceClient>,
  policy: AgentPolicy
): Promise<string | null> {
  const stops = policy.stop_conditions ?? [];
  if (stops.length === 0) return null;

  for (const sc of stops) {
    const type = String((sc as Record<string, unknown>).type ?? "");
    const threshold = Number((sc as Record<string, unknown>).threshold_usdc);
    const date = String((sc as Record<string, unknown>).date ?? "");
    const count = Number((sc as Record<string, unknown>).count);
    const amount = Number((sc as Record<string, unknown>).amount_usdc);

    switch (type) {
      case "balance_below": {
        if (!isFinite(threshold)) continue;
        const { agentWallet } = await buildCronDeps(serviceSupabase, policy.user_id);
        if (!agentWallet) continue;
        const balanceStr = await getAgentBalance(agentWallet.circle_wallet_id);
        const balance = parseFloat(balanceStr);
        if (balance < threshold) {
          return `Balance below ${threshold} USDC (current: ${balance.toFixed(2)})`;
        }
        break;
      }
      case "expires_at": {
        if (!date) continue;
        const expiry = new Date(date);
        if (!isNaN(expiry.getTime()) && expiry <= new Date()) {
          return `Expired on ${date}`;
        }
        break;
      }
      case "max_executions": {
        if (!isFinite(count) || count <= 0) continue;
        if ((policy.execution_count ?? 0) >= count) {
          return `Max executions reached (${count})`;
        }
        break;
      }
      case "max_total_spend": {
        if (!isFinite(amount) || amount <= 0) continue;
        if (Number(policy.total_spent_usdc ?? 0) >= amount) {
          return `Max total spend reached (${amount} USDC)`;
        }
        break;
      }
    }
  }

  return null;
}

async function evaluateTrigger(
  serviceSupabase: ReturnType<typeof createSupabaseServiceClient>,
  policy: AgentPolicy,
  now: Date
): Promise<{ fired: boolean; reason?: string }> {
  switch (policy.trigger_type) {
    case "time": {
      if (!policy.next_run) return { fired: false, reason: "No next_run set" };
      const nextRun = new Date(policy.next_run);
      if (isNaN(nextRun.getTime())) return { fired: false, reason: "Invalid next_run" };
      return { fired: nextRun <= now, reason: nextRun <= now ? undefined : `Next run at ${policy.next_run}` };
    }
    case "price": {
      // TODO: integrate price oracle (CoinGecko, Chainlink, etc.)
      return { fired: false, reason: "Price triggers not yet implemented" };
    }
    case "balance_above": {
      const threshold = Number(policy.trigger_params?.threshold_usdc);
      if (!isFinite(threshold) || threshold <= 0) {
        return { fired: false, reason: "Invalid threshold" };
      }
      const { agentWallet } = await buildCronDeps(serviceSupabase, policy.user_id);
      if (!agentWallet) return { fired: false, reason: "Agent wallet not found" };
      const balanceStr = await getAgentBalance(agentWallet.circle_wallet_id);
      const balance = parseFloat(balanceStr);
      return {
        fired: balance >= threshold,
        reason: balance >= threshold ? undefined : `Balance ${balance.toFixed(2)} < threshold ${threshold}`,
      };
    }
    default:
      return { fired: false, reason: `Unknown trigger type: ${policy.trigger_type}` };
  }
}

async function buildCronDeps(
  serviceSupabase: ReturnType<typeof createSupabaseServiceClient>,
  userId: string
): Promise<{
  agentWallet: { circle_wallet_id: string; circle_wallet_address: string } | null;
  limits: { max_per_transaction_usdc: number; max_daily_usdc: number; max_weekly_usdc: number; max_monthly_usdc: number };
  getSpentSince: (since: Date) => Promise<number>;
}> {
  const { data: agentWallet } = await serviceSupabase
    .from("agent_wallets")
    .select("circle_wallet_id, circle_wallet_address")
    .eq("user_id", userId)
    .maybeSingle();

  const { data: limitsRow } = await serviceSupabase
    .from("user_spend_limits")
    .select("max_per_transaction_usdc, max_daily_usdc, max_weekly_usdc, max_monthly_usdc")
    .eq("user_id", userId)
    .maybeSingle();

  const limits = {
    max_per_transaction_usdc: Number(limitsRow?.max_per_transaction_usdc ?? 50),
    max_daily_usdc: Number(limitsRow?.max_daily_usdc ?? 100),
    max_weekly_usdc: Number(limitsRow?.max_weekly_usdc ?? 300),
    max_monthly_usdc: Number(limitsRow?.max_monthly_usdc ?? 500),
  };

  async function getSpentSince(since: Date): Promise<number> {
    const { data } = await serviceSupabase
      .from("agent_spend_log")
      .select("amount_usdc")
      .eq("user_id", userId)
      .in("status", ["PENDING", "COMPLETE"])
      .gte("executed_at", since.toISOString());
    return (data ?? []).reduce((acc, r) => acc + Number(r.amount_usdc), 0);
  }

  return { agentWallet: agentWallet ?? null, limits, getSpentSince };
}

function extractAmountFromResult(result: Record<string, unknown> | undefined): number {
  if (!result) return 0;
  const amt = Number(result.amountUsdc ?? result.amount ?? 0);
  return isFinite(amt) && amt > 0 ? amt : 0;
}

function extractAmountFromParams(params: Record<string, unknown>): number {
  const amt = Number(params.amount ?? 0);
  return isFinite(amt) && amt > 0 ? amt : 0;
}

function computeNextRunTime(
  frequency: string,
  dayOfWeek?: number,
  dayOfMonth?: number
): string | null {
  const now = new Date();
  const next = new Date(now);

  if (frequency === "daily") {
    next.setUTCDate(next.getUTCDate() + 1);
    next.setUTCHours(9, 0, 0, 0);
  } else if (frequency === "weekly") {
    const targetDow = dayOfWeek ?? 1;
    const daysUntil = (targetDow - next.getUTCDay() + 7) % 7;
    next.setUTCDate(next.getUTCDate() + (daysUntil === 0 ? 7 : daysUntil));
    next.setUTCHours(9, 0, 0, 0);
  } else if (frequency === "monthly") {
    const targetDom = dayOfMonth ?? 1;
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + 1);
    next.setUTCDate(targetDom);
    next.setUTCHours(9, 0, 0, 0);
  } else {
    return null;
  }

  if (next <= now) {
    if (frequency === "daily") next.setUTCDate(next.getUTCDate() + 1);
    else if (frequency === "weekly") next.setUTCDate(next.getUTCDate() + 7);
    else if (frequency === "monthly") next.setUTCMonth(next.getUTCMonth() + 1);
  }

  return next.toISOString();
}
