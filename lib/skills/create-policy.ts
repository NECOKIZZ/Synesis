/**
 * Skill: CREATE_POLICY (V3)
 *
 * Stores a V3 Task as an `agent_policies` row that the cron will fire
 * later. Does NOT move money — only persists intent.
 *
 * Input contract (from confirm-policy/route.ts when a Task has a
 * non-"now" trigger):
 *   params.task    : Task         // the full V3 Task envelope
 *
 * The Task shape (defined in lib/agent-types.ts):
 *   {
 *     trigger:        Trigger,        // time | price | balance_above | and
 *     steps:          PlanStep[],     // length 1 = simple, length N = compound
 *     execution_mode: "once" | "repeat",
 *     stop_conditions?: Array<...>,
 *     confirmation_message: string,
 *   }
 *
 * Storage strategy:
 *   - Simple (steps.length === 1): store action_skill + action_params from
 *     steps[0]. `steps` column is NULL. Cron uses the legacy single-action
 *     execution path.
 *   - Compound (steps.length > 1): store action_skill = "COMPOUND",
 *     action_params = {}, and the full step array in the new `steps`
 *     column. Cron dispatches via executePlan.
 *
 * Composite "and" trigger: stored as trigger_type = "and",
 * trigger_params = { conditions: [<sub-trigger>, ...] }. The cron
 * loads the conditions and ANDs the per-condition evaluators.
 *
 * Recipient resolution: SEND_USDC / SEND_TOKEN steps have their
 * recipient .arc names resolved server-side at policy creation time so
 * the cron doesn't have to redo ANS lookups (and so a typo fails
 * fast — at create — rather than at first scheduled fire).
 */

import "server-only";
import { isAddress } from "ethers";
import { resolveRecipient } from "@/lib/ans";
import { signPolicyHmac, getAgentBalance } from "@/lib/agent";
import type { SkillHandler, SkillContext, SkillOutput } from "./types";
import { skillRegistry } from "./index";
import type { Task, Trigger, PlanStep } from "@/lib/agent-types";

// ── Validation primitives ───────────────────────────────────────────────

const VALID_ACTION_SKILLS = new Set([
  "SEND_USDC",
  "SWAP_USDC",
  "WITHDRAW",
  "SEND_TOKEN",
  "BRIDGE_USDC",
  "PAY_X402",
]);

/**
 * Returns true if a PlanStep would move money to a third party in a way
 * that needs PIN authorization. Used by requiresPin() to decide whether
 * creating this policy needs a PIN.
 *
 *   SEND_USDC / SEND_TOKEN → always outward to a recipient
 *   BRIDGE_USDC            → outward only when toAddress is set and
 *                            differs from main wallet
 *   PAY_X402               → not gated (small machine-to-machine fees,
 *                            already capped by per-tx spend limit)
 *   everything else        → not outward
 */
function stepIsOutward(step: { skill?: string; params?: Record<string, unknown> }, mainWalletAddress: string): boolean {
  const skill = String(step.skill ?? "").toUpperCase();
  const params = (step.params ?? {}) as Record<string, unknown>;
  if (skill === "SEND_USDC" || skill === "SEND_TOKEN") return true;
  if (skill === "BRIDGE_USDC") {
    const to = String(params.toAddress ?? "").trim().toLowerCase();
    if (!to) return false; // defaults to main wallet
    return to !== mainWalletAddress.toLowerCase();
  }
  return false;
}

const VALID_STOP_TYPES = new Set([
  "balance_below",
  "expires_at",
  "max_executions",
  "max_total_spend",
]);

const COMPOUND_SENTINEL = "COMPOUND";
const MAX_STEPS_PER_POLICY = 3;

// ── Type guards ─────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isValidStopCondition(sc: unknown): boolean {
  if (!isPlainObject(sc)) return false;
  return typeof sc.type === "string" && VALID_STOP_TYPES.has(sc.type);
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Last calendar day of `month` (UTC), at 09:00 UTC. Used for
 * "last day of month" recurring schedules. `month` is 0-indexed.
 */
function lastDayOfMonth(year: number, month: number): Date {
  return new Date(Date.UTC(year, month + 1, 0, 9, 0, 0, 0));
}

/** Clamp day_of_month to the actual last day of the given UTC month. */
function clampDom(year: number, month: number, dom: number): Date {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(dom, lastDay), 9, 0, 0, 0));
}

/**
 * Compute the next UTC fire time for a time-based trigger. Returns ISO
 * string or null if frequency is unrecognised (caller should reject).
 */
function computeNextRunTime(
  frequency: string,
  dayOfWeek?: number,
  dayOfMonth?: number,
  lastDayOfMonthFlag?: boolean,
): string | null {
  const now = new Date();

  if (frequency === "daily") {
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 9, 0, 0, 0));
    return next.toISOString();
  }

  if (frequency === "weekly") {
    const targetDow = dayOfWeek ?? 1; // default Monday
    const daysUntil = (targetDow - now.getUTCDay() + 7) % 7 || 7;
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntil, 9, 0, 0, 0));
    return next.toISOString();
  }

  if (frequency === "monthly") {
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    if (lastDayOfMonthFlag) {
      const thisLast = lastDayOfMonth(y, m);
      if (thisLast > now) return thisLast.toISOString();
      return lastDayOfMonth(y, m + 1).toISOString();
    }
    const targetDom = dayOfMonth ?? 1;
    const candidate = clampDom(y, m, targetDom);
    if (candidate > now) return candidate.toISOString();
    return clampDom(y, m + 1, targetDom).toISOString();
  }

  return null;
}

/**
 * Pull the embedded "time" sub-trigger out of a composite ("and") trigger
 * for the purposes of computing next_run. Returns null if there's no
 * time component (e.g. price + balance only — those rely on cron polling).
 */
function findTimeSubTrigger(trigger: Trigger): Extract<Trigger, { type: "time" }> | null {
  if (trigger.type === "time") return trigger;
  if (trigger.type === "and") {
    for (const c of trigger.conditions) {
      if (c.type === "time") return c;
    }
  }
  return null;
}

/**
 * Sum the up-front USDC requirement for a policy's first execution. Used
 * for the create-time balance check so we can fail fast before locking
 * a user into a policy they can't afford. Mirrors the logic in
 * confirm-policy's `extractPlanAmount`.
 */
// Skills whose `params.amount` is denominated in USDC AND drawn from the
// agent wallet up front. Kept in sync with the requiresBalanceCheck=true
// skills (SEND_USDC, WITHDRAW, BRIDGE_USDC). Declared locally rather than
// read from the registry to avoid a circular import (index → create-policy).
const USDC_DRAWING_SKILLS = new Set(["SEND_USDC", "WITHDRAW", "BRIDGE_USDC"]);

function estimateFirstExecutionAmountUsdc(steps: PlanStep[]): number {
  return steps.reduce((total, s) => {
    // Only count skills that draw USDC from the agent wallet up front.
    // Config/read steps and non-USDC sends/swaps never gate on balance.
    if (!USDC_DRAWING_SKILLS.has(s.skill)) return total;
    const raw = s.params.amount;
    // $prev references are runtime-resolved — skip
    if (typeof raw === "string" && raw.startsWith("$prev")) return total;
    if (raw === "all") return total;
    const amt = Number(raw ?? 0);
    return Number.isFinite(amt) && amt > 0 ? total + amt : total;
  }, 0);
}

// ── Per-step recipient resolution ───────────────────────────────────────

/**
 * Resolve any .arc names in SEND_USDC / SEND_TOKEN params to 0x
 * addresses, mutating the step's params with `recipient_address`.
 * Throws on resolution failure so the caller can surface an error.
 */
async function resolveStepRecipients(steps: PlanStep[]): Promise<void> {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.skill !== "SEND_USDC" && s.skill !== "SEND_TOKEN") continue;
    const recipient = String(s.params.recipient ?? "").trim();
    if (!recipient) {
      throw new Error(`Step ${i + 1} (${s.skill}) requires a recipient`);
    }
    // $prev references can't be resolved at policy creation time — skip
    if (recipient.startsWith("$prev")) continue;
    let resolved: string;
    try {
      resolved = await resolveRecipient(recipient);
    } catch (err) {
      const msg = err instanceof Error ? err.message : `Could not resolve "${recipient}"`;
      throw new Error(`Step ${i + 1}: ${msg}`);
    }
    if (!isAddress(resolved)) {
      throw new Error(`Step ${i + 1}: resolved recipient address is invalid`);
    }
    s.params.recipient_address = resolved;
  }
}

// ── Trigger validation ──────────────────────────────────────────────────

/**
 * Validate a V3 Trigger object and return the (trigger_type,
 * trigger_params) pair to persist. The `now` type is rejected here
 * because immediate tasks shouldn't reach this skill — confirm-policy
 * dispatches them straight to executePlan.
 */
function validateTriggerForPersistence(trigger: Trigger): {
  triggerType: string;
  triggerParams: Record<string, unknown>;
} {
  if (trigger.type === "now") {
    throw new Error("Refusing to persist a `now` trigger as a policy");
  }

  if (trigger.type === "time") {
    const params: Record<string, unknown> = { frequency: trigger.schedule };
    if (typeof trigger.day_of_week === "number") params.day_of_week = trigger.day_of_week;
    if (typeof trigger.day_of_month === "number") params.day_of_month = trigger.day_of_month;
    if (trigger.last_day_of_month) params.last_day_of_month = true;
    return { triggerType: "time", triggerParams: params };
  }

  if (trigger.type === "price") {
    return {
      triggerType: "price",
      triggerParams: {
        asset: trigger.asset,
        direction: trigger.direction,
        threshold: trigger.threshold,
      },
    };
  }

  if (trigger.type === "balance_above") {
    return {
      triggerType: "balance_above",
      triggerParams: { threshold_usdc: trigger.threshold_usdc },
    };
  }

  // Composite "and"
  return {
    triggerType: "and",
    triggerParams: { conditions: trigger.conditions },
  };
}

// ── The skill handler ──────────────────────────────────────────────────

export const CreatePolicy: SkillHandler = {
  category: "POLICY",
  version: 3,
  affectsFunds: false,
  // PIN required only if any inner step is outward (SEND_USDC, SEND_TOKEN,
  // PAY_X402, or BRIDGE_USDC to a non-main-wallet address). The cron runs
  // policies without a PIN dialog, so we collect authorization here at
  // creation time. Pure-config policies (e.g. balance-tracked SET_LIMIT)
  // skip PIN.
  requiresPin(params, { mainWalletAddress }) {
    const task = params.task as Task | undefined;
    if (!task || !Array.isArray(task.steps)) return true; // fail-safe
    return task.steps.some((s) => stepIsOutward(s, mainWalletAddress));
  },

  /**
   * Idempotency key — coalesces duplicate submissions of the same
   * policy within the dedupe window. Two submissions are "the same" if
   * the trigger type + step skills + execution mode match. This is
   * intentionally coarser than a deep params hash because users often
   * tweak amounts and re-submit; we prefer false negatives here so we
   * don't accidentally hide real submissions.
   */
  idempotencyKey(params): string | null {
    try {
      const task = params.task as Task | undefined;
      if (!task) return null;
      const stepKeys = task.steps.map((s) => s.skill).join(">");
      return `CREATE_POLICY:${task.trigger.type}:${stepKeys}:${task.execution_mode}`;
    } catch {
      return null;
    }
  },

  async execute(ctx: SkillContext): Promise<SkillOutput> {
    const { supabase, supabaseUserId, params } = ctx;
    const task = params.task as Task | undefined;
    const description = String(params.description ?? "").trim();

    // ── 1. Shape validation ──────────────────────────────────────────
    if (!task || typeof task !== "object") {
      return { ok: false, error: "task object is required", status: 400 };
    }
    if (!Array.isArray(task.steps) || task.steps.length === 0) {
      return { ok: false, error: "task.steps must be a non-empty array", status: 400 };
    }
    if (task.steps.length > MAX_STEPS_PER_POLICY) {
      return {
        ok: false,
        error: `task.steps exceeds max of ${MAX_STEPS_PER_POLICY}`,
        status: 400,
      };
    }
    if (task.execution_mode !== "once" && task.execution_mode !== "repeat") {
      return { ok: false, error: "execution_mode must be 'once' or 'repeat'", status: 400 };
    }

    // ── 2. Validate trigger + derive persistence shape ───────────────
    let triggerType: string;
    let triggerParams: Record<string, unknown>;
    try {
      const persisted = validateTriggerForPersistence(task.trigger);
      triggerType = persisted.triggerType;
      triggerParams = persisted.triggerParams;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid trigger";
      return { ok: false, error: msg, status: 400 };
    }

    // ── 3. Validate each step's skill, then run skill-level validators
    const normalizedSteps: PlanStep[] = [];
    for (let i = 0; i < task.steps.length; i++) {
      const s = task.steps[i];
      if (!isPlainObject(s)) {
        return { ok: false, error: `Step ${i + 1} is not an object`, status: 400 };
      }
      const stepSkill = String(s.skill ?? "");
      if (!VALID_ACTION_SKILLS.has(stepSkill)) {
        return {
          ok: false,
          error: `Step ${i + 1}: skill '${stepSkill}' is not a valid policy action`,
          status: 400,
        };
      }
      const handler = skillRegistry[stepSkill];
      if (!handler) {
        return { ok: false, error: `Step ${i + 1}: unknown skill '${stepSkill}'`, status: 400 };
      }
      let stepParams = (s.params as Record<string, unknown>) ?? {};
      if (handler.validate) {
        try {
          stepParams = handler.validate(stepParams);
        } catch (err) {
          const msg = err instanceof Error ? err.message : `Step ${i + 1} params invalid`;
          return { ok: false, error: msg, status: 400 };
        }
      }
      normalizedSteps.push({
        skill: stepSkill as PlanStep["skill"],
        params: stepParams,
        description:
          typeof s.description === "string" && s.description.trim() !== ""
            ? s.description
            : `Step ${i + 1}`,
      });
    }

    // ── 4. Resolve recipient .arc names server-side ──────────────────
    try {
      await resolveStepRecipients(normalizedSteps);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Recipient resolution failed";
      return { ok: false, error: msg, status: 400 };
    }

    // ── 5. Validate stop_conditions ─────────────────────────────────
    const stopConditionsRaw = Array.isArray(task.stop_conditions) ? task.stop_conditions : [];
    const stopConditions: Array<Record<string, unknown>> = [];
    for (const sc of stopConditionsRaw) {
      if (!isValidStopCondition(sc)) {
        return { ok: false, error: `Invalid stop condition: ${JSON.stringify(sc)}`, status: 400 };
      }
      stopConditions.push(sc as Record<string, unknown>);
    }

    // ── 6. Balance check (best effort — first execution only) ────────
    const firstExecAmount = estimateFirstExecutionAmountUsdc(normalizedSteps);
    if (firstExecAmount > 0 && ctx.agentWallet?.circle_wallet_id) {
      try {
        const balanceStr = await getAgentBalance(ctx.agentWallet.circle_wallet_id);
        const balance = parseFloat(balanceStr);
        if (balance < firstExecAmount) {
          return {
            ok: false,
            error: `Insufficient balance to create this policy. You have ${balance.toFixed(2)} USDC but the first execution needs ${firstExecAmount.toFixed(2)} USDC.`,
            status: 400,
          };
        }
      } catch (err) {
        // Non-fatal — Circle is intermittently flaky; let the cron's
        // own balance check handle it on first fire.
        console.warn(
          "[create-policy] balance check skipped (Circle error):",
          err instanceof Error ? err.message : err,
        );
      }
    }

    // ── 7. Compute next_run for time-based triggers ──────────────────
    let nextRun: string | null = null;
    const timeSub = findTimeSubTrigger(task.trigger);
    if (timeSub) {
      nextRun = computeNextRunTime(
        timeSub.schedule,
        timeSub.day_of_week,
        timeSub.day_of_month,
        timeSub.last_day_of_month,
      );
    }

    // ── 8. Decide compound vs simple persistence shape ───────────────
    const isCompound = normalizedSteps.length > 1;
    const actionSkill = isCompound ? COMPOUND_SENTINEL : normalizedSteps[0].skill;
    const actionParams: Record<string, unknown> = isCompound
      ? {}
      : { ...normalizedSteps[0].params };
    const stepsForStorage = isCompound ? normalizedSteps : null;

    // Cooldown MUST be stored and signed with the SAME value, or the cron's
    // HMAC verify fails and the policy is deactivated ("HMAC verification
    // failed"). The `agent_policies.cooldown_seconds` column defaults to 3600,
    // so we must write this value EXPLICITLY (never `undefined`, which would
    // let the DB default diverge from what we sign below).
    const cooldownSeconds = triggerType === "price" ? 3600 : 0;

    // ── 9. Insert policy row (HMAC = "pending" first, then real) ─────
    const policyPayload = {
      trigger: task.trigger,
      steps: normalizedSteps,
      execution_mode: task.execution_mode,
      stop_conditions: stopConditions,
      description,
    };

    const { data: policyRow, error: insertErr } = await supabase
      .from("agent_policies")
      .insert({
        user_id: supabaseUserId,
        skill: "CREATE_POLICY", // legacy column — deprecated
        params: policyPayload,
        active: true,
        policy_hmac: "pending",
        trigger_type: triggerType,
        trigger_params: triggerParams,
        action_skill: actionSkill,
        action_params: actionParams,
        execution_mode: task.execution_mode,
        cooldown_seconds: cooldownSeconds,
        stop_conditions: stopConditions,
        steps: stepsForStorage,
        policy_summary: description || task.confirmation_message,
        policy_category: triggerType,
        hmac_version: 2,
        next_run: nextRun,
      })
      .select("id, created_at")
      .single();

    if (insertErr || !policyRow) {
      console.error("[create-policy] insert failed:", insertErr);
      return { ok: false, error: "Failed to save policy", status: 500 };
    }

    // ── 10. Compute HMAC and update the row ──────────────────────────
    const hmac = signPolicyHmac({
      version: 2,
      userId: supabaseUserId,
      policyId: policyRow.id,
      actionSkill,
      actionParams,
      triggerType,
      triggerParams,
      executionMode: task.execution_mode,
      cooldownSeconds,
      stopConditions,
      createdAt: policyRow.created_at,
      // Include steps in the HMAC for compound policies so tampering with
      // the steps array would invalidate the hash. Simple policies don't
      // need this — their action_skill + action_params already cover it.
      steps: stepsForStorage as Array<Record<string, unknown>> | null,
    });

    await supabase
      .from("agent_policies")
      .update({ policy_hmac: hmac })
      .eq("id", policyRow.id);

    return {
      ok: true,
      status: 201,
      result: {
        policyId: policyRow.id,
        triggerType,
        actionSkill,
        executionMode: task.execution_mode,
        steps: normalizedSteps.length,
        compound: isCompound,
        description: description || task.confirmation_message,
        nextRun,
      },
    };
  },
};
