/**
 * POST /api/agent/confirm-policy
 *
 * The single execution gate for all agent skills.
 *
 * Responsibilities (only):
 *   L1 — Verify DotArc JWT session (requireAgentSession)
 *   L2 — Verify agent wallet ownership (DB lookup by supabaseUserId)
 *   L3 — Verify agent PIN + enforce lockout
 *   Build SkillContext → delegate to skillRegistry[skill].execute()
 *
 * All skill logic lives in lib/skills/<skill-name>.ts.
 * This route has zero knowledge of what each skill does.
 *
 * Body: { pin: string, skill: string, params: Record<string, unknown> }
 */

import { NextResponse } from "next/server";
import { requireAgentSession, getAgentBalance } from "@/lib/agent";
import { verifyAgentPinOrThrow } from "@/lib/agent-pin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { claimIdempotency, finalizeIdempotency } from "@/lib/agent-idempotency";
import { logSkillExecution } from "@/lib/agent-audit";
import { withUserLock } from "@/lib/agent-lock";
import { skillRegistry } from "@/lib/skills";
import type { SkillContext } from "@/lib/skills";
import { resolveRecipient } from "@/lib/ans";
import type { PlanStep } from "@/lib/agent";
import crypto from "node:crypto";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const traceId = crypto.randomUUID();

  // ── L1: DotArc JWT session ────────────────────────────────────────
  let agentSession: Awaited<ReturnType<typeof requireAgentSession>>;
  try {
    agentSession = await requireAgentSession();
  } catch (res) {
    return res as Response;
  }

  const { session, supabaseUserId } = agentSession;

  let body: {
    pin?: unknown;
    task_type?: unknown;
    skill?: unknown;
    params?: unknown;
    steps?: unknown;
    schedule?: unknown;
    condition?: unknown;
    action?: unknown;
    trigger?: unknown;
    execution_mode?: unknown;
    stop_conditions?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const pin       = String(body.pin        ?? "");
  const taskType  = String(body.task_type ?? "");
  const skill     = String(body.skill      ?? "");
  const params    = (body.params ?? {}) as Record<string, unknown>;
  const rawSteps  = Array.isArray(body.steps) ? body.steps as PlanStep[] : [];

  // Backward-compat: old clients may send skill==="PLAN" without task_type
  const isCompound = taskType === "compound" || skill === "PLAN";
  const isRecurring = taskType === "recurring";
  const isConditional = taskType === "conditional";
  const isImmediate = taskType === "immediate" || (!taskType && !isCompound && !isRecurring && !isConditional);

  console.log(`[agent/confirm] trace=${traceId} user=${supabaseUserId} taskType=${taskType || "immediate"} skill=${skill || "-"}`);

  if (!isImmediate && !isCompound && !isRecurring && !isConditional) {
    console.warn(`[agent/confirm] trace=${traceId} unknown_task_type=${taskType}`);
    return NextResponse.json({ error: `Unknown task_type: ${taskType}` }, { status: 400 });
  }

  // ── Resolve handler early — fail fast for unknown skills ──────────
  const handler = (isImmediate && skill) ? skillRegistry[skill] : null;
  if (isImmediate && skill && !handler) {
    console.warn(`[agent/confirm] trace=${traceId} unknown_skill=${skill}`);
    return NextResponse.json({ error: `Unknown skill: ${skill}` }, { status: 400 });
  }
  if (isCompound && rawSteps.length === 0) {
    console.warn(`[agent/confirm] trace=${traceId} empty_compound`);
    return NextResponse.json({ error: "compound task requires at least one step" }, { status: 400 });
  }
  if (isCompound && rawSteps.length > 3) {
    console.warn(`[agent/confirm] trace=${traceId} compound_too_long steps=${rawSteps.length}`);
    return NextResponse.json({ error: "compound task exceeds maximum of 3 steps" }, { status: 400 });
  }
  if (isCompound) {
    for (const step of rawSteps) {
      if (!skillRegistry[step.skill]) {
        console.warn(`[agent/confirm] trace=${traceId} unknown_step_skill=${step.skill}`);
        return NextResponse.json({ error: `Unknown skill in step: ${step.skill}` }, { status: 400 });
      }
    }
  }
  if ((isRecurring || isConditional) && !body.action && !body.steps) {
    console.warn(`[agent/confirm] trace=${traceId} missing_action_or_steps`);
    return NextResponse.json({ error: "Recurring/conditional task requires action or steps" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();

  // ── L2: agent wallet ownership ────────────────────────────────────
  const { data: agentWallet } = await supabase
    .from("agent_wallets")
    .select("circle_wallet_id, circle_wallet_address, balance_cache_usdc, balance_cache_at")
    .eq("user_id", supabaseUserId)
    .maybeSingle();

  if (!agentWallet) {
    return NextResponse.json({ error: "Agent wallet not activated" }, { status: 400 });
  }
  // Stable non-null alias — the nested runCriticalSection function below
  // doesn't preserve TS narrowing from the outer scope.
  const wallet = agentWallet;

  // ── Pre-flight balance check (before PIN) ────────────────────────
  const affectsFunds = isCompound
    ? true
    : (isRecurring || isConditional)
      ? false // policies don't move money now; cron does later
      : handler!.affectsFunds;
  // SEND_TOKEN amount is denominated in the token (EURC/cirBTC), not USDC.
  // Skip the USDC pre-flight check — the skill does its own token balance check.
  const needsUsdcPreFlight = affectsFunds && skill !== "SEND_TOKEN";
  if (needsUsdcPreFlight) {
    const amount = isCompound ? extractPlanAmount(rawSteps) : extractAmountFromParams(params);
    if (amount > 0) {
      const cachedBalance = parseFloat(wallet.balance_cache_usdc ?? "0");
      if (cachedBalance < amount) {
        console.warn(`[agent/confirm] trace=${traceId} preflight_balance_fail needed=${amount} cached=${cachedBalance}`);
        return NextResponse.json(
          { error: `Insufficient balance. Your agent wallet has ${cachedBalance.toFixed(2)} USDC but this action needs ${amount.toFixed(2)} USDC. Top up from the Agent tab.` },
          { status: 400 },
        );
      }
    }
  }

  // ── Pre-flight: name resolution (before PIN) ─────────────────────
  // Single skill: check params.recipient. Compound: check ALL steps' recipients.
  if (affectsFunds) {
    const recipientsToCheck: string[] = isCompound
      ? rawSteps
          .filter(s => s.skill === "SEND_USDC" || s.skill === "SEND_TOKEN")
          .map(s => String(s.params.recipient ?? "").trim())
          .filter(r => r && !r.startsWith("0x") && !r.startsWith("$prev"))
      : (params.recipient && !String(params.recipient).startsWith("0x")
          ? [String(params.recipient)]
          : []);
    for (const r of recipientsToCheck) {
      try {
        await resolveRecipient(r);
      } catch (err) {
        const msg = err instanceof Error ? err.message : `Could not resolve: ${r}`;
        console.warn(`[agent/confirm] trace=${traceId} preflight_resolve_fail recipient="${r}" msg="${msg}"`);
        return NextResponse.json({ error: msg }, { status: 400 });
      }
    }
  }

  // ── L3: PIN verification ────────────────────────────────────────────────────
  const requiresPin = isCompound || isRecurring || isConditional
    ? true
    : handler!.requiresPin !== false;
  if (requiresPin) {
    try {
      await verifyAgentPinOrThrow({ supabase, userId: supabaseUserId, pin });
      console.log(`[agent/confirm] trace=${traceId} pin_verified`);
    } catch (res) {
      console.warn(`[agent/confirm] trace=${traceId} pin_failed`);
      return res as Response;
    }
  }

  // ── Critical section ──────────────────────────────────────────────
  // For fund-affecting skills, serialize the balance-check → limit-check →
  // PENDING-insert → Circle-call path per user. Without this, two concurrent
  // requests can both pass the daily-cap check before either logs PENDING,
  // and the user overshoots their limit. The lock is a no-op for read-only
  // skills (CHECK_BALANCE, LIST_POLICIES, etc.).
  return affectsFunds
    ? withUserLock(supabaseUserId, () => runCriticalSection())
    : runCriticalSection();

  async function runCriticalSection(): Promise<Response> {
  // ── L3.5: Live balance gateway check ──────────────────────────────
  if (needsUsdcPreFlight) {
    const amount = isCompound ? extractPlanAmount(rawSteps) : extractAmountFromParams(params);
    if (amount > 0) {
      const balanceStr = await getAgentBalance(wallet.circle_wallet_id);
      const balance = parseFloat(balanceStr);
      if (balance < amount) {
        return NextResponse.json(
          { error: `Insufficient balance. You have ${balance.toFixed(2)} USDC but need ${amount.toFixed(2)} USDC.` },
          { status: 400 }
        );
      }
    }
  }

  // ── Load spend limits ─────────────────────────────────────────────
  const { data: limitsRow } = await supabase
    .from("user_spend_limits")
    .select("max_per_transaction_usdc, max_daily_usdc, max_weekly_usdc, max_monthly_usdc")
    .eq("user_id", supabaseUserId)
    .maybeSingle();

  const limits = {
    max_per_transaction_usdc: Number(limitsRow?.max_per_transaction_usdc ?? 50),
    max_daily_usdc:           Number(limitsRow?.max_daily_usdc           ?? 100),
    max_weekly_usdc:          Number(limitsRow?.max_weekly_usdc          ?? 300),
    max_monthly_usdc:         Number(limitsRow?.max_monthly_usdc         ?? 500),
  };

  // ── Build SkillContext ────────────────────────────────────────────
  const serviceSupabase = createSupabaseServiceClient();

  // Count both COMPLETE and PENDING toward spend totals.
  // PENDING rows represent in-flight tx that may still settle; counting them
  // is the cheap defense against the limit-bypass race where two concurrent
  // sends both read the same "spent" snapshot before either completes.
  // FAILED rows are excluded — money never moved.
  async function getSpentSince(since: Date): Promise<number> {
    const { data } = await supabase
      .from("agent_spend_log")
      .select("amount_usdc")
      .eq("user_id", supabaseUserId)
      .in("status", ["PENDING", "COMPLETE"])
      .gte("executed_at", since.toISOString());
    return (data ?? []).reduce((acc, r) => acc + Number(r.amount_usdc), 0);
  }

  const ctx: SkillContext = {
    supabase,
    serviceSupabase,
    supabaseUserId,
    mainWalletAddress: session.walletAddress,
    agentWallet: wallet,
    limits,
    params,
    getSpentSince,
  };

  // ── Idempotency: claim before executing ───────────────────────────
  // Skills that move money should always declare an idempotencyKey. If
  // they don't (or return null), we just skip dedupe for that call.
  // TTL: 60s for fund-affecting skills, 30s for everything else.
  let idemKey: string | null = null;
  if (isCompound) {
    idemKey = rawSteps.map(s => `${s.skill}:${JSON.stringify(s.params)}`).join("|").slice(0, 512);
  } else if (isImmediate && handler) {
    idemKey = handler.idempotencyKey?.(params) ?? null;
  } else if (isRecurring || isConditional) {
    // Policies use CREATE_POLICY's idempotency logic
    const cpHandler = skillRegistry["CREATE_POLICY"];
    const cpParams = buildCreatePolicyParams(body);
    idemKey = cpHandler.idempotencyKey?.(cpParams) ?? null;
  }
  const idemTtl = affectsFunds ? 90 : 30;

  if (idemKey) {
    const claim = await claimIdempotency({
      service: serviceSupabase,
      userId:   supabaseUserId,
      skill,
      key:      idemKey,
      ttlSeconds: idemTtl,
    });

    if (claim.kind === "replay") {
      // Audit the replay so dashboard shows it happened, but don't
      // re-execute the skill. The cached httpStatus + result come from
      // the original call.
      await logSkillExecution({
        service: serviceSupabase,
        userId: supabaseUserId,
        skill,
        category: isCompound ? "TRANSFER" : (handler?.category ?? "POLICY"),
        affectsFunds: isCompound ? true : (handler?.affectsFunds ?? false),
        params,
        ok: claim.httpStatus < 400,
        httpStatus: claim.httpStatus,
        durationMs: 0,
        replayed: true,
      });
      return NextResponse.json(
        { skill, result: claim.result, replayed: true },
        { status: claim.httpStatus },
      );
    }
    if (claim.kind === "in_flight") {
      return NextResponse.json(
        { error: "Identical request already in progress" },
        { status: 409 },
      );
    }
    if (claim.kind === "recent_failure") {
      return NextResponse.json(
        { error: "Identical request just failed; wait a moment before retrying" },
        { status: 409 },
      );
    }
    // claim.kind === "claimed" → fall through to execute
  }

  // ── Execute: compound (multi-step, one-time) ────────────────────
  if (isCompound) {
    const t0 = Date.now();
    const planResult = await executePlan(rawSteps, ctx, serviceSupabase, supabaseUserId);
    const planDuration = Date.now() - t0;
    const planStatus = planResult.ok ? 200 : 400;
    console.log(`[agent/confirm] trace=${traceId} compound ok=${planResult.ok} steps=${planResult.steps.length} duration=${planDuration}ms`);
    if (idemKey) {
      await finalizeIdempotency({
        service: serviceSupabase, userId: supabaseUserId, skill, key: idemKey,
        ok: planResult.ok, httpStatus: planStatus,
        resultJson: planResult.ok ? { steps: planResult.steps } : null,
      });
    }
    await logSkillExecution({
      service: serviceSupabase, userId: supabaseUserId,
      skill: "COMPOUND", category: "TRANSFER", affectsFunds: true,
      params: {}, ok: planResult.ok, httpStatus: planStatus,
      error: planResult.ok ? null : planResult.error,
      durationMs: planDuration,
    });
    if (!planResult.ok) {
      return NextResponse.json({ error: planResult.error, steps: planResult.steps }, { status: 400 });
    }
    return NextResponse.json({ task_type: "compound", steps: planResult.steps }, { status: 200 });
  }

  // ── Execute: recurring / conditional (stored as policy) ───────────
  if (isRecurring || isConditional) {
    const cpParams = buildCreatePolicyParams(body);
    const policyCtx: SkillContext = { ...ctx, params: cpParams };
    const cpHandler = skillRegistry["CREATE_POLICY"];
    const startedAt = Date.now();
    const output = await cpHandler.execute(policyCtx);
    const durationMs = Date.now() - startedAt;
    const httpStatus = output.ok ? (output.status ?? 200) : (output.status ?? 400);
    console.log(`[agent/confirm] trace=${traceId} policy ok=${output.ok} type=${isRecurring ? "recurring" : "conditional"} duration=${durationMs}ms`);

    if (idemKey) {
      await finalizeIdempotency({
        service: serviceSupabase, userId: supabaseUserId, skill, key: idemKey,
        ok: output.ok, httpStatus,
        resultJson: output.ok ? output.result : null,
      });
    }
    await logSkillExecution({
      service: serviceSupabase, userId: supabaseUserId,
      skill: "CREATE_POLICY", category: "POLICY", affectsFunds: false,
      params: cpParams, ok: output.ok, httpStatus,
      error: output.ok ? null : output.error,
      durationMs,
    });
    if (!output.ok) {
      return NextResponse.json({ error: output.error }, { status: httpStatus });
    }
    return NextResponse.json({ task_type: isRecurring ? "recurring" : "conditional", result: output.result }, { status: httpStatus });
  }

  // ── Execute: immediate (single skill) ─────────────────────────────
  const startedAt = Date.now();
  const output = await handler!.execute(ctx);
  const durationMs = Date.now() - startedAt;
  const httpStatus = output.ok ? (output.status ?? 200) : (output.status ?? 400);
  console.log(`[agent/confirm] trace=${traceId} immediate skill=${skill} ok=${output.ok} duration=${durationMs}ms`);

  // ── Persist outcome to idempotency cache (best-effort) ────────────
  if (idemKey) {
    await finalizeIdempotency({
      service: serviceSupabase,
      userId: supabaseUserId,
      skill,
      key: idemKey,
      ok: output.ok,
      httpStatus,
      resultJson: output.ok ? output.result : null,
    });
  }

  // ── Audit log (best-effort, never blocks response) ────────────────
  await logSkillExecution({
    service: serviceSupabase,
    userId: supabaseUserId,
    skill,
    category: handler!.category,
    affectsFunds: handler!.affectsFunds,
    params,
    ok: output.ok,
    httpStatus,
    error: output.ok ? null : output.error,
    durationMs,
  });

  if (!output.ok) {
    return NextResponse.json({ error: output.error }, { status: httpStatus });
  }
  return NextResponse.json({ task_type: "immediate", skill, result: output.result }, { status: httpStatus });
  } // end runCriticalSection
}

// ── helpers ─────────────────────────────────────────────────────────

/**
 * Extract the numeric USDC amount from skill params for pre-flight balance checks.
 * Returns 0 for "all" or unparseable amounts (skills handle those at runtime).
 */
function extractAmountFromParams(params: Record<string, unknown>): number {
  if (params.amount === "all") return 0;
  const raw = Number(params.amount ?? 0);
  if (!isFinite(raw) || raw <= 0) return 0;
  return raw;
}

function extractPlanAmount(steps: PlanStep[]): number {
  return steps.reduce((total, step) => {
    const raw = step.params.amount;
    // $prev references are only known at runtime — skip
    if (typeof raw === "string" && raw.startsWith("$prev")) return total;
    // SEND_TOKEN: amount is in the token (EURC, cirBTC) — NOT USDC — skip
    if (step.skill === "SEND_TOKEN") return total;
    // SWAP_USDC: amount is in tokenIn — only USDC-in swaps count toward USDC balance
    if (step.skill === "SWAP_USDC") {
      const tokenIn = String(step.params.tokenIn ?? "USDC").toUpperCase();
      if (tokenIn !== "USDC") return total;
    }
    // SEND_USDC, BRIDGE_USDC, PAY_X402 — amount is always USDC
    return total + extractAmountFromParams(step.params);
  }, 0);
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

type StepResult = { step: number; description: string; ok: boolean; result?: unknown; error?: string };
type PlanRunResult = { ok: true; steps: StepResult[] } | { ok: false; error: string; steps: StepResult[] };

async function executePlan(
  steps: PlanStep[],
  baseCtx: SkillContext,
  serviceSupabase: ReturnType<typeof createSupabaseServiceClient>,
  userId: string,
): Promise<PlanRunResult> {
  const stepResults: StepResult[] = [];
  let prevResult: Record<string, unknown> = {};

  for (let i = 0; i < steps.length; i++) {
    const step    = steps[i];
    const handler = skillRegistry[step.skill];
    if (!handler) {
      return { ok: false, error: `Unknown skill at step ${i + 1}: ${step.skill}`, steps: stepResults };
    }

    let resolvedParams: Record<string, unknown>;
    try {
      resolvedParams = resolvePrevRefs(step.params, prevResult, i);
    } catch (err) {
      const msg = err instanceof Error ? err.message : `Step ${i + 1}: bad $prev reference`;
      return { ok: false, error: msg, steps: stepResults };
    }

    const stepCtx: SkillContext = { ...baseCtx, params: resolvedParams };
    const t0 = Date.now();
    const output = await handler.execute(stepCtx);

    await logSkillExecution({
      service:      serviceSupabase,
      userId,
      skill:        step.skill,
      category:     handler.category,
      affectsFunds: handler.affectsFunds,
      params:       resolvedParams,
      ok:           output.ok,
      httpStatus:   output.ok ? 200 : 400,
      error:        output.ok ? null : output.error,
      durationMs:   Date.now() - t0,
    });

    if (!output.ok) {
      const done = stepResults.filter(r => r.ok).length;
      const msg = done > 0
        ? `Step ${i + 1} failed: ${output.error}. Step${done > 1 ? "s" : ""} 1–${done} completed — tokens are safe in your agent wallet.`
        : `Step ${i + 1} failed: ${output.error}. No tokens have moved.`;
      stepResults.push({ step: i + 1, description: step.description, ok: false, error: output.error });
      return { ok: false, error: msg, steps: stepResults };
    }

    prevResult = (output.result ?? {}) as Record<string, unknown>;
    stepResults.push({ step: i + 1, description: step.description, ok: true, result: output.result });
  }

  return { ok: true, steps: stepResults };
}

/**
 * Translate V2 recurring / conditional task format into the legacy
 * CREATE_POLICY params that the CreatePolicy skill expects.
 */
function buildCreatePolicyParams(body: {
  task_type?: unknown;
  schedule?: unknown;
  schedule_params?: unknown;
  trigger?: unknown;
  action?: unknown;
  steps?: unknown;
  execution_mode?: unknown;
  stop_conditions?: unknown;
  confirmation_message?: unknown;
}): Record<string, unknown> {
  const executionMode = String(body.execution_mode ?? "repeat");
  const stopConditions = Array.isArray(body.stop_conditions) ? body.stop_conditions : [];
  const description = String(body.confirmation_message ?? "");
  const action = body.action as Record<string, unknown> | undefined;
  const steps = Array.isArray(body.steps) ? body.steps : undefined;

  if (body.task_type === "recurring") {
    const schedule = String(body.schedule ?? "");
    const scheduleParams = body.schedule_params as Record<string, unknown> | undefined;
    const trigger: Record<string, unknown> = { type: "time", frequency: schedule };
    if (scheduleParams?.day_of_week !== undefined) trigger.day_of_week = scheduleParams.day_of_week;
    if (scheduleParams?.day_of_month !== undefined) trigger.day_of_month = scheduleParams.day_of_month;
    if (scheduleParams?.last_day_of_month === true) trigger.last_day_of_month = true;
    return { trigger, action, steps, execution_mode: executionMode, stop_conditions: stopConditions, description };
  }

  // conditional
  const trigger = body.trigger as Record<string, unknown> | undefined;
  return { trigger, action, steps, execution_mode: executionMode, stop_conditions: stopConditions, description };
}
