/**
 * POST /api/agent/confirm-policy   (V3 — multi-task batch)
 *
 * The single execution gate for all confirmed agent intents. Replaces
 * the V2 task_type-discriminated body with a uniform `tasks: Task[]`
 * array — one PIN unlocks the whole batch.
 *
 * Body:
 *   { pin: string, tasks: Task[] }     // Task is from lib/agent-types.ts
 *
 * Per-task dispatch:
 *   - trigger.type === "now"   → executePlan(steps, ctx) — runs immediately
 *   - any other trigger        → CREATE_POLICY skill — stores as agent_policies row
 *
 * Failure semantics: best-effort. Tasks run sequentially inside the
 * user lock. If task 2 fails, tasks 1 (already complete) stay applied —
 * Circle transfers can't be rolled back, so all-or-nothing is a lie.
 * The caller receives a result entry per task with ok/error, in order.
 *
 * Layered security (unchanged):
 *   L1 — Synesis JWT session
 *   L2 — Agent wallet ownership
 *   L3 — Agent PIN + lockout
 *   L4 — Per-user serialization (withUserLock) for fund-affecting batches
 */

import { NextResponse } from "next/server";
import { requireAgentSession, enforceAgentGate, getAgentBalance } from "@/lib/agent";
import { CircleUnavailableError } from "@/lib/circle";
import { verifyAgentPinOrThrow } from "@/lib/agent-pin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { claimIdempotency, finalizeIdempotency } from "@/lib/agent-idempotency";
import { logSkillExecution } from "@/lib/agent-audit";
import { withUserLock } from "@/lib/agent-lock";
import { skillRegistry } from "@/lib/skills";
import { batchRequiresPin, totalUpfrontUsdc } from "@/lib/skills/pin-policy";
import { toAppError } from "@/lib/errors";
import type { SkillContext } from "@/lib/skills";
import { resolveRecipient } from "@/lib/ans";
import { checkRateLimit } from "@/lib/rate-limit";
import type { Task, PlanStep } from "@/lib/agent-types";
import crypto from "node:crypto";

export const runtime = "nodejs";

// ── Types ─────────────────────────────────────────────────────────────

type TaskResult =
  | {
      ok: true;
      kind: "executed" | "policy";
      task_index: number;
      result: Record<string, unknown>;
      steps?: StepResult[];
    }
  | {
      ok: false;
      kind: "executed" | "policy";
      task_index: number;
      error: string;
      steps?: StepResult[];
    };

type StepResult = {
  step: number;
  description: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

type PlanRunResult =
  | { ok: true; steps: StepResult[]; lastResult: Record<string, unknown> }
  | { ok: false; error: string; steps: StepResult[] };

// ── Body validation ───────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate the incoming `tasks` array shape just deep enough to safely
 * dispatch. Per-skill param validation already happens inside each
 * skill's handler — we don't duplicate it here.
 */
function validateTasksShape(
  tasks: unknown,
): { ok: true; tasks: Task[] } | { ok: false; error: string } {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { ok: false, error: "tasks must be a non-empty array" };
  }
  if (tasks.length > 5) {
    return { ok: false, error: "tasks array exceeds maximum batch size of 5" };
  }
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (!isPlainObject(t)) {
      return { ok: false, error: `Task ${i + 1} is not an object` };
    }
    const trig = t.trigger as Record<string, unknown> | undefined;
    if (!trig || typeof trig.type !== "string") {
      return { ok: false, error: `Task ${i + 1}: trigger.type is required` };
    }
    if (!Array.isArray(t.steps) || t.steps.length === 0 || t.steps.length > 3) {
      return { ok: false, error: `Task ${i + 1}: steps must be an array of length 1–3` };
    }
    const stepsArr = t.steps as unknown[];
    for (let j = 0; j < stepsArr.length; j++) {
      const s = stepsArr[j];
      if (!isPlainObject(s) || typeof s.skill !== "string" || !isPlainObject(s.params)) {
        return { ok: false, error: `Task ${i + 1} step ${j + 1}: invalid shape` };
      }
    }
    if (t.execution_mode !== "once" && t.execution_mode !== "repeat") {
      return { ok: false, error: `Task ${i + 1}: execution_mode must be 'once' or 'repeat'` };
    }
  }
  return { ok: true, tasks: tasks as Task[] };
}

// ── Pre-flight helpers ────────────────────────────────────────────────
//
// `totalUpfrontUsdc` now lives in the shared gating SSOT (lib/skills/pin-policy.ts)
// so interpret and confirm-policy compute the pre-flight number identically —
// no drift between what the UI fast-fails on and what the server enforces (D2).

/**
 * Collect every recipient identifier across all "now" tasks' SEND_USDC
 * / SEND_TOKEN steps. Used for an early ANS-resolution sanity check —
 * we'd rather fail before the user types the PIN than after.
 *
 * Policy tasks resolve recipients inside CREATE_POLICY itself, so we
 * skip them here.
 */
function collectRecipientsForResolveCheck(tasks: Task[]): string[] {
  const out: string[] = [];
  for (const t of tasks) {
    if (t.trigger.type !== "now") continue;
    for (const s of t.steps) {
      if (s.skill !== "SEND_USDC" && s.skill !== "SEND_TOKEN") continue;
      const r = String(s.params.recipient ?? "").trim();
      if (!r || r.startsWith("0x") || r.startsWith("$prev")) continue;
      out.push(r);
    }
  }
  return out;
}

/**
 * True if the batch contains at least one fund-affecting task — used to
 * decide whether to acquire the per-user serialization lock.
 */
function batchAffectsFunds(tasks: Task[]): boolean {
  return tasks.some((t) => t.trigger.type === "now");
}

// ── $prev resolution ──────────────────────────────────────────────────

/**
 * Resolve any "$prev.foo" references in a step's params using the
 * previous step's result. Returns a shallow copy.
 */
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

// ── Sequential plan executor ──────────────────────────────────────────

/**
 * Execute an ordered list of PlanSteps within a single task. On failure,
 * stops at the failing step and surfaces a message that distinguishes
 * "nothing moved" from "step N succeeded but step N+1 failed" — important
 * for trust + UX, since on partial success the user's tokens may be in
 * an intermediate state (e.g. swapped but not yet sent).
 */
async function executePlan(
  steps: PlanStep[],
  baseCtx: SkillContext,
  serviceSupabase: ReturnType<typeof createSupabaseServiceClient>,
  userId: string,
  traceId: string,
): Promise<PlanRunResult> {
  const stepResults: StepResult[] = [];
  let prevResult: Record<string, unknown> = {};

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
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
    const stepMs = Date.now() - t0;

    // Single chokepoint that logs EVERY skill outcome — including the gate
    // rejections (balance / spend-limit / resolve / self-send) that the
    // individual skills return silently. Gives the console a full picture of
    // the money path without instrumenting each skill file.
    {
      const p = resolvedParams;
      const parts = [
        p.amount !== undefined ? `amount=${JSON.stringify(p.amount)}` : "",
        p.token !== undefined ? `token=${JSON.stringify(p.token)}` : "",
        p.recipient !== undefined ? `recipient=${JSON.stringify(p.recipient)}` : "",
        p.chain !== undefined ? `chain=${JSON.stringify(p.chain)}` : "",
      ].filter(Boolean).join(" ");
      console.log(
        `[agent/confirm] trace=${traceId} step=${i + 1}/${steps.length} skill=${step.skill}` +
          `${parts ? " " + parts : ""} ok=${output.ok}` +
          `${output.ok ? "" : ` status=${output.status ?? "?"} error=${JSON.stringify(output.error)}`}` +
          ` duration=${stepMs}ms`,
      );
    }

    await logSkillExecution({
      service: serviceSupabase,
      userId,
      skill: step.skill,
      category: handler.category,
      affectsFunds: handler.affectsFunds,
      params: resolvedParams,
      ok: output.ok,
      httpStatus: output.ok ? 200 : 400,
      error: output.ok ? null : output.error,
      durationMs: Date.now() - t0,
    });

    if (!output.ok) {
      const done = stepResults.filter((r) => r.ok).length;
      const msg =
        done > 0
          ? `Step ${i + 1} failed: ${output.error}. Step${done > 1 ? "s" : ""} 1–${done} completed — tokens are safe in your agent wallet.`
          : `Step ${i + 1} failed: ${output.error}. No tokens have moved.`;
      stepResults.push({ step: i + 1, description: step.description, ok: false, error: output.error });
      return { ok: false, error: msg, steps: stepResults };
    }

    prevResult = (output.result ?? {}) as Record<string, unknown>;
    stepResults.push({ step: i + 1, description: step.description, ok: true, result: output.result });
  }

  return { ok: true, steps: stepResults, lastResult: prevResult };
}

// ── Per-task dispatcher ───────────────────────────────────────────────

/**
 * Build a stable idempotency key for a single Task. Coarse on purpose —
 * enough to deduplicate accidental double-submits but not so tight that
 * the user can't legitimately re-issue the same intent.
 */
function computeTaskIdemKey(task: Task): string {
  const stepsKey = task.steps
    .map((s) => `${s.skill}:${JSON.stringify(s.params)}`)
    .join("|");
  return `T:${task.trigger.type}:${task.execution_mode}:${stepsKey}`.slice(0, 512);
}

/**
 * Dispatch a single Task — either run-now (executePlan) or persist as a
 * policy (CREATE_POLICY skill). Idempotency, audit logging, and result
 * shaping happen here so the outer route stays a thin loop.
 */
async function dispatchTask(args: {
  task: Task;
  taskIndex: number;
  baseCtx: SkillContext;
  serviceSupabase: ReturnType<typeof createSupabaseServiceClient>;
  userId: string;
  traceId: string;
}): Promise<TaskResult> {
  const { task, taskIndex, baseCtx, serviceSupabase, userId, traceId } = args;
  const isNow = task.trigger.type === "now";
  const auditSkill = !isNow
    ? "CREATE_POLICY"
    : task.steps.length > 1
      ? "COMPOUND"
      : task.steps[0].skill;

  const idemKey = computeTaskIdemKey(task);
  const idemTtl = isNow ? 90 : 30;

  if (idemKey) {
    const claim = await claimIdempotency({
      service: serviceSupabase,
      userId,
      skill: auditSkill,
      key: idemKey,
      ttlSeconds: idemTtl,
    });
    console.log(
      `[agent/confirm] trace=${traceId} task=${taskIndex} idempotency=${claim.kind} skill=${auditSkill}`,
    );
    if (claim.kind === "replay") {
      await logSkillExecution({
        service: serviceSupabase,
        userId,
        skill: auditSkill,
        category: !isNow ? "POLICY" : "TRANSFER",
        affectsFunds: isNow,
        params: { taskIndex },
        ok: claim.httpStatus < 400,
        httpStatus: claim.httpStatus,
        durationMs: 0,
        replayed: true,
      });
      return claim.httpStatus < 400
        ? {
            ok: true,
            kind: isNow ? "executed" : "policy",
            task_index: taskIndex,
            result: (claim.result ?? {}) as Record<string, unknown>,
          }
        : {
            ok: false,
            kind: isNow ? "executed" : "policy",
            task_index: taskIndex,
            error: "Replay of previously failed task",
          };
    }
    if (claim.kind === "in_flight") {
      return {
        ok: false,
        kind: isNow ? "executed" : "policy",
        task_index: taskIndex,
        error: "Identical task already in progress",
      };
    }
    if (claim.kind === "recent_failure") {
      return {
        ok: false,
        kind: isNow ? "executed" : "policy",
        task_index: taskIndex,
        error: "Identical task just failed; wait a moment before retrying",
      };
    }
    // claim.kind === "claimed" → fall through
  }

  // ── Run-now path ─────────────────────────────────────────────────
  if (isNow) {
    const t0 = Date.now();
    const planResult = await executePlan(task.steps, baseCtx, serviceSupabase, userId, traceId);
    const durationMs = Date.now() - t0;
    const httpStatus = planResult.ok ? 200 : 400;
    console.log(
      `[agent/confirm] trace=${traceId} task=${taskIndex} run-now ok=${planResult.ok} steps=${planResult.steps.length} duration=${durationMs}ms`,
    );

    if (idemKey) {
      await finalizeIdempotency({
        service: serviceSupabase,
        userId,
        skill: auditSkill,
        key: idemKey,
        ok: planResult.ok,
        httpStatus,
        resultJson: planResult.ok ? { steps: planResult.steps } : null,
      });
    }
    await logSkillExecution({
      service: serviceSupabase,
      userId,
      skill: auditSkill,
      category: "TRANSFER",
      affectsFunds: true,
      params: { taskIndex, stepCount: task.steps.length },
      ok: planResult.ok,
      httpStatus,
      error: planResult.ok ? null : planResult.error,
      durationMs,
    });

    if (!planResult.ok) {
      return {
        ok: false,
        kind: "executed",
        task_index: taskIndex,
        error: planResult.error,
        steps: planResult.steps,
      };
    }
    const result =
      task.steps.length === 1 ? planResult.lastResult : { steps: planResult.steps };
    return {
      ok: true,
      kind: "executed",
      task_index: taskIndex,
      result,
      steps: task.steps.length > 1 ? planResult.steps : undefined,
    };
  }

  // ── Policy-create path ───────────────────────────────────────────
  const cpHandler = skillRegistry["CREATE_POLICY"];
  const policyCtx: SkillContext = {
    ...baseCtx,
    params: {
      task,
      description: task.confirmation_message,
    },
  };
  const t0 = Date.now();
  const output = await cpHandler.execute(policyCtx);
  const durationMs = Date.now() - t0;
  const httpStatus = output.ok ? output.status ?? 201 : output.status ?? 400;
  console.log(
    `[agent/confirm] trace=${traceId} task=${taskIndex} policy ok=${output.ok} trigger=${task.trigger.type} duration=${durationMs}ms`,
  );

  if (idemKey) {
    await finalizeIdempotency({
      service: serviceSupabase,
      userId,
      skill: "CREATE_POLICY",
      key: idemKey,
      ok: output.ok,
      httpStatus,
      resultJson: output.ok ? output.result : null,
    });
  }
  await logSkillExecution({
    service: serviceSupabase,
    userId,
    skill: "CREATE_POLICY",
    category: "POLICY",
    affectsFunds: false,
    params: { taskIndex, triggerType: task.trigger.type },
    ok: output.ok,
    httpStatus,
    error: output.ok ? null : output.error,
    durationMs,
  });

  if (!output.ok) {
    return { ok: false, kind: "policy", task_index: taskIndex, error: output.error };
  }
  return { ok: true, kind: "policy", task_index: taskIndex, result: output.result };
}

// ── Route handler ─────────────────────────────────────────────────────

export async function POST(req: Request) {
  const traceId = crypto.randomUUID();

  // L1: Synesis JWT session
  let agentSession: Awaited<ReturnType<typeof requireAgentSession>>;
  try {
    agentSession = await requireAgentSession();
    await enforceAgentGate(agentSession.supabaseUserId);
  } catch (res) {
    return res as Response;
  }
  const { session, supabaseUserId } = agentSession;

  // L1.5: rate limit money-moving confirmations (abuse / runaway-retry guard).
  // Stricter than interpret. Fail-open — the real money-safety controls are
  // PIN + idempotency + withUserLock below.
  const rl = await checkRateLimit(supabaseUserId, "confirm-policy", { max: 5, windowSeconds: 60 });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many confirmations in a short time. Try again in ${rl.retryAfterSeconds}s.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  // Body
  let body: { pin?: unknown; tasks?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const pin = String(body.pin ?? "");
  const shape = validateTasksShape(body.tasks);
  if (!shape.ok) {
    console.warn(`[agent/confirm] trace=${traceId} bad_tasks_shape: ${shape.error}`);
    return NextResponse.json({ error: shape.error }, { status: 400 });
  }
  const tasks = shape.tasks;

  console.log(
    `[agent/confirm] trace=${traceId} user=${supabaseUserId} tasks=${tasks.length} triggers=${tasks.map((t) => t.trigger.type).join(",")}`,
  );

  // Up-front: resolve each step's skill against the registry so we fail
  // fast on typos instead of partway through the batch.
  for (let i = 0; i < tasks.length; i++) {
    for (let j = 0; j < tasks[i].steps.length; j++) {
      const sk = tasks[i].steps[j].skill;
      if (!skillRegistry[sk]) {
        return NextResponse.json(
          { error: `Task ${i + 1} step ${j + 1}: unknown skill '${sk}'` },
          { status: 400 },
        );
      }
    }
  }

  const supabase = await createSupabaseServerClient();

  // L2: agent wallet ownership. A user may hold multiple wallets (one per
  // blockchain), so load all rows and split by chain rather than maybeSingle().
  const { data: agentWalletRows } = await supabase
    .from("agent_wallets")
    .select("circle_wallet_id, circle_wallet_address, blockchain, balance_cache_usdc, balance_cache_at")
    .eq("user_id", supabaseUserId);

  const evmWallet = (agentWalletRows ?? []).find(
    (w) => (w.blockchain ?? "ARC-TESTNET") === "ARC-TESTNET",
  );
  if (!evmWallet) {
    return NextResponse.json({ error: "Agent wallet not activated" }, { status: 400 });
  }
  // Assign to a fresh const AFTER the guard so the non-undefined narrowing is
  // baked into the type and survives into the runBatch() closure below.
  const wallet = evmWallet;
  // Present only once the user has activated Solana. Solana skills read this
  // and fail clearly when it's null.
  const solanaWallet =
    (agentWalletRows ?? []).find((w) => w.blockchain === "SOL-DEVNET") ?? null;

  // ── Pre-flight: cached balance check across the batch ────────────
  const upfrontUsdc = totalUpfrontUsdc(tasks);
  if (upfrontUsdc > 0) {
    const cachedBalance = parseFloat(wallet.balance_cache_usdc ?? "0");
    if (cachedBalance < upfrontUsdc) {
      console.warn(
        `[agent/confirm] trace=${traceId} preflight_balance_fail need=${upfrontUsdc} cached=${cachedBalance}`,
      );
      return NextResponse.json(
        {
          error: `Insufficient balance. Your agent wallet has ${cachedBalance.toFixed(2)} USDC but this batch needs ${upfrontUsdc.toFixed(2)} USDC. Top up from the Agent tab.`,
        },
        { status: 400 },
      );
    }
  }

  // ── Pre-flight: ANS resolution for run-now SEND steps ────────────
  for (const r of collectRecipientsForResolveCheck(tasks)) {
    try {
      await resolveRecipient(r);
    } catch (err) {
      const appErr = toAppError(err);
      const msg = appErr.message || `Could not resolve: ${r}`;
      console.warn(
        `[agent/confirm] trace=${traceId} preflight_resolve_fail "${r}" code=${appErr.code} retryable=${appErr.retryable} msg="${msg}"`,
      );
      // A transient ANS/RPC failure (F-17) isn't the user's fault — signal it as
      // retryable (503) with a "try again" message, not a terminal 400 "bad
      // recipient". A genuine RECIPIENT_NOT_FOUND stays a 400.
      return NextResponse.json({ error: msg }, { status: appErr.retryable ? 503 : 400 });
    }
  }

  // L3: PIN verification — only when at least one step in the batch
  // requires it. Read-only / config / withdraw-to-self / in-place swap
  // skills declare requiresPin=false and skip this gate entirely so the
  // user isn't asked for a PIN to e.g. check their balance.
  const needsPin = batchRequiresPin(tasks, session.walletAddress);
  if (needsPin) {
    try {
      await verifyAgentPinOrThrow({ supabase, userId: supabaseUserId, pin });
      console.log(`[agent/confirm] trace=${traceId} pin_verified`);
    } catch (res) {
      console.warn(`[agent/confirm] trace=${traceId} pin_failed`);
      return res as Response;
    }
  } else {
    console.log(`[agent/confirm] trace=${traceId} pin_skipped (no outward step in batch)`);
  }

  const affectsFunds = batchAffectsFunds(tasks);
  console.log(
    `[agent/confirm] trace=${traceId} plan needsPin=${needsPin} affectsFunds=${affectsFunds} ` +
      `upfrontUsdc=${upfrontUsdc} solana=${solanaWallet ? "yes" : "no"} lock=${affectsFunds ? "on" : "off"}`,
  );
  return affectsFunds
    ? withUserLock(supabaseUserId, () => runBatch())
    : runBatch();

  async function runBatch(): Promise<Response> {
    // L3.5: live-balance gateway check (only once, not per task — the
    // upfront sum already rolls all "now" tasks together)
    if (upfrontUsdc > 0) {
      let balance: number;
      try {
        balance = parseFloat(await getAgentBalance(wallet.circle_wallet_id));
      } catch (err) {
        // Circle is down / timed out — fail fast and friendly rather than
        // hanging or surfacing a raw 500. No money has moved.
        const msg =
          err instanceof CircleUnavailableError
            ? err.message
            : "Couldn't reach Circle to confirm your balance. No money has moved — please try again in a moment.";
        return NextResponse.json({ error: msg }, { status: 503 });
      }
      console.log(
        `[agent/confirm] trace=${traceId} live_balance source=live balance=${balance} need=${upfrontUsdc}`,
      );
      if (balance < upfrontUsdc) {
        return NextResponse.json(
          {
            error: `Insufficient balance. You have ${balance.toFixed(2)} USDC but this batch needs ${upfrontUsdc.toFixed(2)} USDC.`,
          },
          { status: 400 },
        );
      }
    }

    // Spend limits — loaded once for the whole batch.
    const { data: limitsRow } = await supabase
      .from("user_spend_limits")
      .select("max_per_transaction_usdc, max_daily_usdc, max_weekly_usdc, max_monthly_usdc")
      .eq("user_id", supabaseUserId)
      .maybeSingle();

    const limits = {
      max_per_transaction_usdc: Number(limitsRow?.max_per_transaction_usdc ?? 50),
      max_daily_usdc: Number(limitsRow?.max_daily_usdc ?? 100),
      max_weekly_usdc: Number(limitsRow?.max_weekly_usdc ?? 300),
      max_monthly_usdc: Number(limitsRow?.max_monthly_usdc ?? 500),
    };

    const serviceSupabase = createSupabaseServiceClient();

    async function getSpentSince(since: Date): Promise<number> {
      const { data } = await supabase
        .from("agent_spend_log")
        .select("amount_usdc")
        .eq("user_id", supabaseUserId)
        .in("status", ["PENDING", "COMPLETE"])
        .gte("executed_at", since.toISOString());
      return (data ?? []).reduce((acc, r) => acc + Number(r.amount_usdc), 0);
    }

    const baseCtx: SkillContext = {
      supabase,
      serviceSupabase,
      supabaseUserId,
      mainWalletAddress: session.walletAddress,
      agentWallet: wallet,
      agentSolanaWallet: solanaWallet,
      limits,
      params: {}, // per-task params injected inside dispatchTask
      getSpentSince,
    };

    // Sequential dispatch — each task awaits the previous so a SWAP
    // landing before a SEND in the next task observes the new balance.
    const results: TaskResult[] = [];
    for (let i = 0; i < tasks.length; i++) {
      const r = await dispatchTask({
        task: tasks[i],
        taskIndex: i,
        baseCtx,
        serviceSupabase,
        userId: supabaseUserId,
        traceId,
      });
      results.push(r);
      // We do NOT abort on failure — best-effort continues to the next
      // task. Already-completed transfers can't be undone, and the user
      // sees per-task outcomes in the response.
    }

    // Contact memory is recorded from the Circle webhook on confirmed
    // transfers (lib/memory/contact-mem.ts via app/api/webhooks/circle),
    // so there is nothing to persist here — the executor stays out of the
    // memory path entirely.

    const successCount = results.filter((r) => r.ok).length;
    const httpStatus = successCount === tasks.length ? 200 : successCount === 0 ? 400 : 207;
    return NextResponse.json(
      {
        results,
        ok: successCount === tasks.length,
        successCount,
        totalCount: tasks.length,
      },
      { status: httpStatus },
    );
  }
}
