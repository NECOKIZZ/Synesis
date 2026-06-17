/**
 * GET /api/cron/agent-policies   (V3 — composite triggers + compound policies)
 *
 * Cron runner for orchestrated policies stored in `agent_policies`.
 *
 * V3 additions over V2:
 *   - "and" composite trigger: trigger_type='and' with
 *     trigger_params.conditions = [<sub-trigger>, ...]. All sub-triggers
 *     must evaluate true for the policy to fire. Time component (if
 *     any) drives next_run; non-time components are re-checked at fire
 *     time and a missed cycle just advances next_run.
 *   - Compound policies: when action_skill === "COMPOUND" or the new
 *     `steps` column is non-null, run the full step list via
 *     executePlan() rather than a single skill handler.
 *
 * Layers:
 *   L0 — CRON_SECRET bearer (timing-safe)
 *   L1 — Load active policies, bounded
 *   L2 — Per policy:
 *          a. HMAC verify (v1 legacy, v2 orchestration; steps included
 *             in v2 hash when the row is compound)
 *          b. Stop conditions (balance_below, expires_at, max_executions,
 *             max_total_spend)
 *          c. Trigger evaluation (time / price / balance_above / and)
 *          d. Execute: single skill OR compound executePlan
 *          e. Update execution state (count, spent, next_run, active)
 *
 * Environment:
 *   CRON_SECRET                  shared secret between scheduler and route
 *   CRON_MAX_POLICIES_PER_TICK   per-tick load cap (default 50)
 *   CRON_CONCURRENCY             parallel worker count (default 4)
 */

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { verifyPolicyHmac, getAgentBalance } from "@/lib/agent";
import { skillRegistry } from "@/lib/skills";
import type { AgentPolicy, SkillContext } from "@/lib/skills/types";
import { logSkillExecution } from "@/lib/agent-audit";
import { isAddress } from "ethers";

export const runtime = "nodejs";

const CRON_SECRET = process.env.CRON_SECRET;
const MAX_POLICIES_PER_TICK = Number(process.env.CRON_MAX_POLICIES_PER_TICK ?? 50);
const CRON_CONCURRENCY = Number(process.env.CRON_CONCURRENCY ?? 4);
// How long a run claim is considered "live" before another invocation may
// take it over. Must exceed the worst-case single-policy execution time
// (slow Circle calls) so we never re-claim a still-running policy.
const CRON_CLAIM_STALE_SECONDS = Number(process.env.CRON_CLAIM_STALE_SECONDS ?? 300);

// Used by the price-trigger evaluator. Validation in lib/agent-core-v3
// already enforces this on insert; we re-validate here defensively in
// case a hand-modified or legacy row sneaks through.
const VALID_PRICE_DIRECTIONS = new Set(["above", "below"]);

// ── Auth helper ──────────────────────────────────────────────────────

function safeEqualSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── Result shape ─────────────────────────────────────────────────────

type Result = {
  policyId: string;
  action: string;
  ok: boolean;
  error?: string;
  pauseReason?: string;
  retry?: boolean;
};

// ── Route ────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization") ?? "";
  const provided = authHeader.replace(/^Bearer\s+/i, "");
  if (!CRON_SECRET || !provided || !safeEqualSecret(provided, CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const serviceSupabase = createSupabaseServiceClient();
  const now = new Date();

  // Load all active policies bounded by MAX_POLICIES_PER_TICK. Order
  // by next_run so policies due soonest run first within a tick.
  // Policies with NULL next_run (price/balance_above triggers without a
  // time component) sort last and still get evaluated each tick.
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

  const queue = (policies ?? []) as unknown as AgentPolicy[];
  const results: Result[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < queue.length) {
      const i = cursor++;
      const policy = queue[i];
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

  const workerCount = Math.max(1, Math.min(CRON_CONCURRENCY, queue.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

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

// ── Per-policy execution ─────────────────────────────────────────────

async function runPolicy(
  serviceSupabase: ReturnType<typeof createSupabaseServiceClient>,
  policy: AgentPolicy,
  now: Date,
): Promise<Result> {
  const userId = policy.user_id;
  const actionLabel = policy.action_skill ?? policy.skill;

  // ── HMAC verification ───────────────────────────────────────────
  const isCompound =
    policy.action_skill === "COMPOUND" ||
    (Array.isArray(policy.steps) && policy.steps.length > 0);

  // Only v2 (orchestration) HMAC is supported. Legacy v1 RECURRING_PAYMENT
  // policies were removed on 2026-06-07; any surviving v1 row is rejected
  // here and deactivated below.
  const hmacOk =
    policy.hmac_version === 2 &&
    verifyPolicyHmac(
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
        // Include steps only when this row is compound — keeps the
        // canonical hash byte-identical to what was signed at insert.
        steps: isCompound
          ? (policy.steps as unknown as Array<Record<string, unknown>> | null)
          : null,
      },
      policy.policy_hmac,
      2,
    );

  if (!hmacOk) {
    console.error(`[cron] HMAC mismatch on policy ${policy.id}`);
    await deactivate(serviceSupabase, policy.id, "HMAC verification failed");
    return { policyId: policy.id, action: actionLabel, ok: false, pauseReason: "HMAC verification failed" };
  }

  // ── Stop condition checks ───────────────────────────────────────
  const stopReason = await checkStopConditions(serviceSupabase, policy);
  if (stopReason) {
    await deactivate(serviceSupabase, policy.id, stopReason);
    return { policyId: policy.id, action: actionLabel, ok: false, pauseReason: stopReason };
  }

  // ── Trigger evaluation ──────────────────────────────────────────
  const triggerFired = await evaluateTrigger(serviceSupabase, policy, now);
  if (!triggerFired.fired) {
    // For time-based "and" composites where the time component DID hit
    // but a non-time condition failed: advance next_run so we don't busy-
    // poll the same cycle every tick. Trigger eval returns `advance:true`
    // in that case.
    if (triggerFired.advance) {
      const nextRun = computeNextRunForPolicy(policy);
      if (nextRun) {
        await serviceSupabase
          .from("agent_policies")
          .update({ next_run: nextRun })
          .eq("id", policy.id);
      }
    }
    return { policyId: policy.id, action: actionLabel, ok: true, error: triggerFired.reason };
  }

  // ── V3 orchestration path ───────────────────────────────────────
  const deps = await buildCronDeps(serviceSupabase, userId);
  if (!deps.agentWallet) {
    return { policyId: policy.id, action: actionLabel, ok: false, error: "Agent wallet not found" };
  }

  // For policies with WITHDRAW steps we need the main wallet address.
  // Look it up once if any step (or single action) needs it.
  const stepsForExec = (policy.steps ?? null) as Array<{ skill: string; params: Record<string, unknown>; description: string }> | null;
  const needsMainWallet =
    policy.action_skill === "WITHDRAW" ||
    (stepsForExec && stepsForExec.some((s) => s.skill === "WITHDRAW"));

  let mainWalletAddress = "";
  if (needsMainWallet) {
    const { data: profile } = await serviceSupabase
      .from("profiles")
      .select("wallet_address")
      .eq("id", userId)
      .maybeSingle();
    mainWalletAddress = profile?.wallet_address ?? "";
    if (!isAddress(mainWalletAddress)) {
      await deactivate(serviceSupabase, policy.id, "Main wallet address invalid or missing");
      return { policyId: policy.id, action: actionLabel, ok: false, pauseReason: "Main wallet address invalid or missing" };
    }
  }

  // ── Claim this run slot (concurrency lock + idempotency) ─────────
  // The single most important guard against double-PAYMENT: two concurrent
  // cron invocations (or a Vercel retry) racing the same due policy. The
  // claim is atomic in Postgres — only the winner proceeds; a fresh slot held
  // by a live invocation is refused, a stale one (crashed holder) is retaken.
  // Time triggers key on next_run (deterministic per cycle); price/balance
  // triggers (null next_run) key on the current minute bucket.
  const scheduledFor =
    policy.next_run ??
    new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
  const freeClaim = async () => {
    await serviceSupabase
      .from("cron_runs")
      .delete()
      .eq("policy_id", policy.id)
      .eq("scheduled_for", scheduledFor);
  };
  const { data: claimed, error: claimErr } = await serviceSupabase.rpc("claim_cron_run", {
    p_policy_id: policy.id,
    p_scheduled_for: scheduledFor,
    p_stale_seconds: CRON_CLAIM_STALE_SECONDS,
  });
  if (claimErr) {
    // Never risk a double-execute on uncertainty — skip and retry next tick.
    console.warn(`[cron] claim error for ${policy.id} (skipping):`, claimErr.message);
    return { policyId: policy.id, action: actionLabel, ok: false, error: "Run claim failed", retry: true };
  }
  if (claimed !== true) {
    return { policyId: policy.id, action: actionLabel, ok: true, error: "Already claimed this cycle (idempotent skip)" };
  }

  // ── Compound execution (multi-step) ─────────────────────────────
  if (isCompound && stepsForExec && stepsForExec.length > 0) {
    const planResult = await executePlanForCron(stepsForExec, {
      supabase: serviceSupabase,
      serviceSupabase,
      supabaseUserId: userId,
      mainWalletAddress,
      agentWallet: deps.agentWallet,
      limits: deps.limits,
      params: {},
      getSpentSince: deps.getSpentSince,
    });

    if (!planResult.ok) {
      // Best-effort partial-success: log and pause. The user can re-create
      // the policy after fixing whatever caused the failure.
      await deactivate(serviceSupabase, policy.id, `Compound step failure: ${planResult.error}`);
      return {
        policyId: policy.id,
        action: "COMPOUND",
        ok: false,
        pauseReason: planResult.error,
      };
    }

    // Sum USDC moved (best-effort) for spend accounting
    const moved = sumStepAmountsUsdc(stepsForExec);
    await advancePolicyState(serviceSupabase, policy, now, moved);
    return { policyId: policy.id, action: "COMPOUND", ok: true };
  }

  // ── Simple single-action execution ──────────────────────────────
  const handler = skillRegistry[policy.action_skill];
  if (!handler) {
    console.error(`[cron] unknown action skill: ${policy.action_skill}`);
    await deactivate(serviceSupabase, policy.id, `Unknown action skill: ${policy.action_skill}`);
    return { policyId: policy.id, action: policy.action_skill, ok: false, pauseReason: `Unknown action skill: ${policy.action_skill}` };
  }

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

  const t0 = Date.now();
  const output = await handler.execute(ctx);
  const durationMs = Date.now() - t0;

  await logSkillExecution({
    service: serviceSupabase,
    userId,
    skill: policy.action_skill,
    category: handler.category,
    affectsFunds: handler.affectsFunds,
    params: policy.action_params,
    ok: output.ok,
    httpStatus: output.ok ? output.status ?? 200 : output.status ?? 400,
    error: output.ok ? null : output.error,
    durationMs,
  });

  if (output.ok) {
    const moved =
      extractAmountFromResult(output.result) ?? extractAmountFromParams(policy.action_params) ?? 0;
    await advancePolicyState(serviceSupabase, policy, now, moved);
    return { policyId: policy.id, action: policy.action_skill, ok: true };
  }

  // Retry transient failures, pause on permanent ones.
  const shouldRetry = output.status === 429 || output.status === 502 || output.status === 503;
  if (!shouldRetry) {
    await deactivate(serviceSupabase, policy.id, output.error ?? "Execution failed");
    return { policyId: policy.id, action: policy.action_skill, ok: false, pauseReason: output.error };
  }
  // Transient failure: release the claim so the next tick can retry this slot
  // immediately instead of waiting out the stale window.
  await freeClaim();
  return { policyId: policy.id, action: policy.action_skill, ok: false, error: output.error, retry: true };
}

// ── Trigger evaluator ────────────────────────────────────────────────

type TriggerVerdict = { fired: boolean; reason?: string; advance?: boolean };

async function evaluateTrigger(
  serviceSupabase: ReturnType<typeof createSupabaseServiceClient>,
  policy: AgentPolicy,
  now: Date,
): Promise<TriggerVerdict> {
  return evaluateTriggerByType(serviceSupabase, policy, policy.trigger_type, policy.trigger_params, now);
}

/**
 * Trigger evaluation broken into a recursive helper so "and" composites
 * can dispatch their sub-conditions through the same code path.
 */
async function evaluateTriggerByType(
  serviceSupabase: ReturnType<typeof createSupabaseServiceClient>,
  policy: AgentPolicy,
  type: string,
  params: Record<string, unknown> | undefined,
  now: Date,
): Promise<TriggerVerdict> {
  switch (type) {
    case "time": {
      if (!policy.next_run) return { fired: false, reason: "No next_run set" };
      const nextRun = new Date(policy.next_run);
      if (isNaN(nextRun.getTime())) return { fired: false, reason: "Invalid next_run" };
      return {
        fired: nextRun <= now,
        reason: nextRun <= now ? undefined : `Next run at ${policy.next_run}`,
      };
    }

    case "price": {
      // Live price evaluation via lib/oracle (CoinGecko + cache).
      // Cache TTL is short (~30s) so a tick of the cron sees a near-live
      // value; failure to fetch falls back to a stale-cached number when
      // available — better to fire late than skip a trigger entirely.
      const asset = String(params?.asset ?? "").trim();
      const direction = String(params?.direction ?? "").trim();
      const threshold = Number(params?.threshold);
      if (!asset || !VALID_PRICE_DIRECTIONS.has(direction) || !isFinite(threshold) || threshold <= 0) {
        return { fired: false, reason: `Invalid price trigger params (asset=${asset}, dir=${direction}, thr=${threshold})` };
      }
      try {
        const { getPriceUSD } = await import("@/lib/oracle");
        const result = await getPriceUSD(asset);
        const fired = direction === "above" ? result.price > threshold : result.price < threshold;
        const cmp = direction === "above" ? ">" : "<";
        return {
          fired,
          reason: fired
            ? undefined
            : `${asset} $${result.price.toFixed(2)} not ${cmp} ${threshold} (source=${result.source}, ${result.ageSeconds}s old)`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Treat oracle outages as a soft "did-not-fire" — the next tick
        // tries again. Don't pause the policy on transient feed errors.
        return { fired: false, reason: `Price oracle error: ${msg}` };
      }
    }

    case "balance_above": {
      const threshold = Number(params?.threshold_usdc);
      if (!isFinite(threshold) || threshold <= 0) return { fired: false, reason: "Invalid threshold" };
      const { agentWallet } = await buildCronDeps(serviceSupabase, policy.user_id);
      if (!agentWallet) return { fired: false, reason: "Agent wallet not found" };
      const balanceStr = await getAgentBalance(agentWallet.circle_wallet_id);
      const balance = parseFloat(balanceStr);
      return {
        fired: balance >= threshold,
        reason: balance >= threshold ? undefined : `Balance ${balance.toFixed(2)} < threshold ${threshold}`,
      };
    }

    case "and": {
      const conditions = Array.isArray(params?.conditions)
        ? (params!.conditions as Array<{ type: string; [k: string]: unknown }>)
        : [];
      if (conditions.length === 0) {
        return { fired: false, reason: "Composite trigger has no conditions" };
      }
      let timeFiredButOthersFailed = false;
      for (const c of conditions) {
        const sub = await evaluateTriggerByType(serviceSupabase, policy, c.type, c as Record<string, unknown>, now);
        if (!sub.fired) {
          // If the time sub-condition would have fired but another
          // sub-condition (balance, etc.) failed, we still want to
          // advance next_run so we don't re-evaluate this cycle every
          // tick. Detect that case explicitly.
          if (c.type === "time") {
            return { fired: false, reason: sub.reason };
          }
          // Check whether the time sub-condition has already passed —
          // if so we missed this cycle; flag advance.
          if (policy.next_run) {
            const nr = new Date(policy.next_run);
            if (!isNaN(nr.getTime()) && nr <= now) timeFiredButOthersFailed = true;
          }
          return {
            fired: false,
            reason: `Composite missed: ${sub.reason}`,
            advance: timeFiredButOthersFailed,
          };
        }
      }
      return { fired: true };
    }

    default:
      return { fired: false, reason: `Unknown trigger type: ${type}` };
  }
}

// ── Stop conditions ──────────────────────────────────────────────────

async function checkStopConditions(
  serviceSupabase: ReturnType<typeof createSupabaseServiceClient>,
  policy: AgentPolicy,
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
        if (balance < threshold) return `Balance below ${threshold} USDC (current: ${balance.toFixed(2)})`;
        break;
      }
      case "expires_at": {
        if (!date) continue;
        const expiry = new Date(date);
        if (!isNaN(expiry.getTime()) && expiry <= new Date()) return `Expired on ${date}`;
        break;
      }
      case "max_executions": {
        if (!isFinite(count) || count <= 0) continue;
        if ((policy.execution_count ?? 0) >= count) return `Max executions reached (${count})`;
        break;
      }
      case "max_total_spend": {
        if (!isFinite(amount) || amount <= 0) continue;
        if (Number(policy.total_spent_usdc ?? 0) >= amount) return `Max total spend reached (${amount} USDC)`;
        break;
      }
    }
  }
  return null;
}

// ── Compound plan executor (cron variant) ────────────────────────────

type StepResult = { step: number; description: string; ok: boolean; result?: unknown; error?: string };
type PlanRunResult = { ok: true; steps: StepResult[] } | { ok: false; error: string; steps: StepResult[] };

async function executePlanForCron(
  steps: Array<{ skill: string; params: Record<string, unknown>; description: string }>,
  baseCtx: SkillContext,
): Promise<PlanRunResult> {
  const stepResults: StepResult[] = [];
  let prevResult: Record<string, unknown> = {};

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const handler = skillRegistry[step.skill];
    if (!handler) return { ok: false, error: `Unknown skill at step ${i + 1}: ${step.skill}`, steps: stepResults };

    let resolved: Record<string, unknown>;
    try {
      resolved = resolvePrevRefs(step.params, prevResult, i);
    } catch (err) {
      const msg = err instanceof Error ? err.message : `Step ${i + 1}: bad $prev reference`;
      return { ok: false, error: msg, steps: stepResults };
    }

    const stepCtx: SkillContext = { ...baseCtx, params: resolved };
    const t0 = Date.now();
    const output = await handler.execute(stepCtx);

    await logSkillExecution({
      service: baseCtx.serviceSupabase,
      userId: baseCtx.supabaseUserId,
      skill: step.skill,
      category: handler.category,
      affectsFunds: handler.affectsFunds,
      params: resolved,
      ok: output.ok,
      httpStatus: output.ok ? 200 : 400,
      error: output.ok ? null : output.error,
      durationMs: Date.now() - t0,
    });

    if (!output.ok) {
      stepResults.push({ step: i + 1, description: step.description, ok: false, error: output.error });
      return { ok: false, error: `Step ${i + 1}: ${output.error}`, steps: stepResults };
    }
    prevResult = (output.result ?? {}) as Record<string, unknown>;
    stepResults.push({ step: i + 1, description: step.description, ok: true, result: output.result });
  }
  return { ok: true, steps: stepResults };
}

function resolvePrevRefs(
  params: Record<string, unknown>,
  prev: Record<string, unknown>,
  stepIndex: number,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).map(([k, v]) => {
      if (typeof v === "string" && v.startsWith("$prev.")) {
        const field = v.slice(6);
        const resolved = prev[field];
        if (resolved === undefined) {
          throw new Error(`Step ${stepIndex + 1}: "$prev.${field}" was not set by the previous step.`);
        }
        return [k, resolved];
      }
      return [k, v];
    }),
  );
}

// ── State advancement ────────────────────────────────────────────────

/**
 * Update execution_count, total_spent_usdc, last_executed_at, and
 * next_run after a successful fire. Mirrors the logic from V2 but also
 * understands "and" composites — for those, next_run is recomputed
 * from the embedded time sub-trigger.
 */
async function advancePolicyState(
  serviceSupabase: ReturnType<typeof createSupabaseServiceClient>,
  policy: AgentPolicy,
  now: Date,
  amountMovedUsdc: number,
): Promise<void> {
  const updates: Record<string, unknown> = {
    execution_count: (policy.execution_count ?? 0) + 1,
    total_spent_usdc: (Number(policy.total_spent_usdc ?? 0) + amountMovedUsdc).toFixed(6),
    last_executed_at: now.toISOString(),
  };

  if (policy.execution_mode === "once") {
    updates.active = false;
    updates.pause_reason = "Completed (execution_mode = once)";
  } else {
    const nextRun = computeNextRunForPolicy(policy);
    if (nextRun) updates.next_run = nextRun;
  }

  await serviceSupabase.from("agent_policies").update(updates).eq("id", policy.id);
}

/**
 * Compute the next_run for a policy after a fire. For pure time
 * triggers this is the next slot. For "and" composites containing a
 * time sub-trigger, it's the next slot of that sub-trigger. For
 * non-time triggers (price, balance_above, or "and" with no time
 * component), returns null and the cron just polls every tick.
 */
function computeNextRunForPolicy(policy: AgentPolicy): string | null {
  if (policy.trigger_type === "time") {
    const freq = policy.trigger_params?.frequency as string | undefined;
    const dow = policy.trigger_params?.day_of_week as number | undefined;
    const dom = policy.trigger_params?.day_of_month as number | undefined;
    return freq ? computeNextRunTime(freq, dow, dom) : null;
  }
  if (policy.trigger_type === "and") {
    const conditions = Array.isArray(policy.trigger_params?.conditions)
      ? (policy.trigger_params!.conditions as Array<{ type: string; [k: string]: unknown }>)
      : [];
    const timeSub = conditions.find((c) => c.type === "time");
    if (!timeSub) return null;
    return computeNextRunTime(
      timeSub.schedule as string,
      timeSub.day_of_week as number | undefined,
      timeSub.day_of_month as number | undefined,
    );
  }
  return null;
}

// ── Shared helpers ───────────────────────────────────────────────────

async function deactivate(
  serviceSupabase: ReturnType<typeof createSupabaseServiceClient>,
  policyId: string,
  reason: string,
): Promise<void> {
  await serviceSupabase
    .from("agent_policies")
    .update({ active: false, pause_reason: reason })
    .eq("id", policyId);
}

async function buildCronDeps(
  serviceSupabase: ReturnType<typeof createSupabaseServiceClient>,
  userId: string,
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

/**
 * Best-effort sum of USDC amounts across a compound plan's steps. Same
 * exclusions as confirm-policy's pre-flight (SEND_TOKEN counted as zero,
 * SWAP_USDC counts only when tokenIn=USDC).
 */
function sumStepAmountsUsdc(
  steps: Array<{ skill: string; params: Record<string, unknown> }>,
): number {
  return steps.reduce((total, s) => {
    const raw = s.params.amount;
    if (typeof raw === "string" && raw.startsWith("$prev")) return total;
    if (s.skill === "SEND_TOKEN") return total;
    if (s.skill === "SWAP_USDC") {
      const tokenIn = String(s.params.tokenIn ?? "USDC").toUpperCase();
      if (tokenIn !== "USDC") return total;
    }
    return total + extractAmountFromParams(s.params);
  }, 0);
}

function computeNextRunTime(
  frequency: string,
  dayOfWeek?: number,
  dayOfMonth?: number,
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
