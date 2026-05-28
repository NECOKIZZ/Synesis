/**
 * Skill: CREATE_POLICY
 *
 * Creates a new orchestrated policy: trigger + action + stop conditions.
 * Does NOT move money — just stores the policy for the cron runner.
 *
 * Trigger examples:
 *   "pay sara 5 USDC every week"
 *   "buy BTC once the price drops below 80000"
 *   "withdraw everything when my balance hits 200"
 *
 * Required params from interpreter:
 *   {
 *     trigger: { type: "time"|"price"|"balance_above", ... },
 *     action:  { skill: "SEND_USDC"|"SWAP_USDC"|"WITHDRAW", params: {...} },
 *     execution_mode: "once"|"repeat",
 *     stop_conditions: [{ type, ... }],
 *     description: string
 *   }
 */

import "server-only";
import { isAddress } from "ethers";
import { resolveRecipient } from "@/lib/ans";
import { signPolicyHmac, getAgentBalance } from "@/lib/agent";
import type { SkillHandler, SkillContext, SkillOutput } from "./types";
import { skillRegistry } from "./index";

const VALID_TRIGGERS = ["time", "price", "balance_above"] as const;
const VALID_ACTIONS = ["SEND_USDC", "SWAP_USDC", "WITHDRAW"] as const;
const VALID_EXECUTION_MODES = ["once", "repeat"] as const;
const VALID_STOP_TYPES = [
  "balance_below",
  "expires_at",
  "max_executions",
  "max_total_spend",
] as const;

function isValidStopCondition(
  sc: unknown
): sc is { type: string; threshold_usdc?: number; date?: string; count?: number; amount_usdc?: number } {
  if (typeof sc !== "object" || sc === null) return false;
  const t = (sc as Record<string, unknown>).type;
  return typeof t === "string" && VALID_STOP_TYPES.includes(t as typeof VALID_STOP_TYPES[number]);
}

export const CreatePolicy: SkillHandler = {
  category: "POLICY",
  version: 1,
  affectsFunds: false, // only stores intent; money moves later via cron

  // Deduplicate identical policy submissions within the confirm-policy window
  idempotencyKey(params): string | null {
    try {
      const trigger = params.trigger as Record<string, unknown>;
      const action = params.action as Record<string, unknown> | undefined;
      const steps = Array.isArray(params.steps) ? params.steps : undefined;
      const mode = String(params.execution_mode ?? "");
      if (!trigger?.type || (!action?.skill && !steps?.length) || !mode) return null;
      const actionKey = steps ? `steps:${steps.length}` : `action:${action!.skill}`;
      return `CREATE_POLICY:${trigger.type}:${actionKey}:${mode}`;
    } catch {
      return null;
    }
  },

  async execute(ctx: SkillContext): Promise<SkillOutput> {
    const { supabase, supabaseUserId, params } = ctx;

    const trigger = params.trigger as Record<string, unknown> | undefined;
    const action = params.action as Record<string, unknown> | undefined;
    const stepsRaw = Array.isArray(params.steps) ? params.steps : undefined;
    const executionMode = String(params.execution_mode ?? "");
    const stopConditionsRaw = Array.isArray(params.stop_conditions)
      ? params.stop_conditions
      : [];
    const description = String(params.description ?? "").trim();

    // ── 1. Validate trigger ──────────────────────────────────────────
    if (!trigger || typeof trigger !== "object") {
      return { ok: false, error: "trigger object is required", status: 400 };
    }

    const triggerType = String(trigger.type ?? "");
    if (!VALID_TRIGGERS.includes(triggerType as typeof VALID_TRIGGERS[number])) {
      return {
        ok: false,
        error: `trigger.type must be one of: ${VALID_TRIGGERS.join(", ")}`,
        status: 400,
      };
    }

    // Validate trigger-specific params
    const triggerParams: Record<string, unknown> = {};
    if (triggerType === "time") {
      const freq = String(trigger.frequency ?? "");
      if (!["daily", "weekly", "monthly"].includes(freq)) {
        return { ok: false, error: "time trigger requires frequency: daily|weekly|monthly", status: 400 };
      }
      triggerParams.frequency = freq;
      if (trigger.day_of_week !== undefined) {
        const dow = Number(trigger.day_of_week);
        if (dow < 0 || dow > 6) {
          return { ok: false, error: "day_of_week must be 0-6 (Sunday=0)", status: 400 };
        }
        triggerParams.day_of_week = dow;
      }
      if (trigger.last_day_of_month === true) {
        triggerParams.last_day_of_month = true;
      } else if (trigger.day_of_month !== undefined) {
        const dom = Number(trigger.day_of_month);
        if (dom < 1 || dom > 31) {
          return { ok: false, error: "day_of_month must be 1-31", status: 400 };
        }
        triggerParams.day_of_month = dom;
      }
    } else if (triggerType === "price") {
      const asset = String(trigger.asset ?? "");
      if (!["BTC", "ETH", "USDC"].includes(asset)) {
        return { ok: false, error: "price trigger requires asset: BTC|ETH|USDC", status: 400 };
      }
      const direction = String(trigger.direction ?? "");
      if (!["below", "above"].includes(direction)) {
        return { ok: false, error: "price trigger requires direction: below|above", status: 400 };
      }
      const threshold = Number(trigger.threshold);
      if (!isFinite(threshold) || threshold <= 0) {
        return { ok: false, error: "price trigger requires positive threshold", status: 400 };
      }
      triggerParams.asset = asset;
      triggerParams.direction = direction;
      triggerParams.threshold = threshold;
    } else if (triggerType === "balance_above") {
      const threshold = Number(trigger.threshold_usdc);
      if (!isFinite(threshold) || threshold <= 0) {
        return { ok: false, error: "balance_above trigger requires positive threshold_usdc", status: 400 };
      }
      triggerParams.threshold_usdc = threshold;
    }

    // ── 2. Validate action or steps ──────────────────────────────────
    let actionSkill: string;
    let actionParams: Record<string, unknown> = {};
    let normalizedSteps: Array<{ skill: string; params: Record<string, unknown>; description: string }> | undefined;

    if (stepsRaw && stepsRaw.length > 0) {
      // Compound policy: validate each step
      if (stepsRaw.length > 3) {
        return { ok: false, error: "Compound policies are limited to 3 steps", status: 400 };
      }
      normalizedSteps = [];
      for (let i = 0; i < stepsRaw.length; i++) {
        const s = stepsRaw[i] as Record<string, unknown>;
        if (typeof s !== "object" || s === null) {
          return { ok: false, error: `Step ${i} is not an object`, status: 400 };
        }
        const stepSkill = String(s.skill ?? "");
        if (!VALID_ACTIONS.includes(stepSkill as typeof VALID_ACTIONS[number])) {
          return { ok: false, error: `Step ${i} skill must be one of: ${VALID_ACTIONS.join(", ")}`, status: 400 };
        }
        const handler = skillRegistry[stepSkill];
        let stepParams = (s.params as Record<string, unknown>) ?? {};
        if (handler?.validate) {
          stepParams = handler.validate(stepParams);
        }
        // Resolve recipients for SEND_USDC steps
        if (stepSkill === "SEND_USDC") {
          const recipient = String(stepParams.recipient ?? "");
          if (!recipient) {
            return { ok: false, error: `Step ${i} SEND_USDC requires recipient`, status: 400 };
          }
          let resolved: string;
          try {
            resolved = await resolveRecipient(recipient);
          } catch (err) {
            const msg = err instanceof Error ? err.message : `Could not resolve: ${recipient}`;
            return { ok: false, error: msg, status: 400 };
          }
          if (!isAddress(resolved)) {
            return { ok: false, error: `Step ${i}: Resolved recipient address is invalid`, status: 400 };
          }
          stepParams.recipient_address = resolved;
        }
        normalizedSteps.push({
          skill: stepSkill,
          params: stepParams,
          description: typeof s.description === "string" ? s.description : `Step ${i + 1}`,
        });
      }
      actionSkill = "COMPOUND";
      actionParams = { steps: normalizedSteps };
    } else if (action && typeof action === "object") {
      // Single-action policy
      actionSkill = String(action.skill ?? "");
      if (!VALID_ACTIONS.includes(actionSkill as typeof VALID_ACTIONS[number])) {
        return {
          ok: false,
          error: `action.skill must be one of: ${VALID_ACTIONS.join(", ")}`,
          status: 400,
        };
      }
      const targetHandler = skillRegistry[actionSkill];
      if (!targetHandler) {
        return { ok: false, error: `Unknown action skill: ${actionSkill}`, status: 400 };
      }
      actionParams = (action.params as Record<string, unknown>) ?? {};
      if (targetHandler.validate) {
        actionParams = targetHandler.validate(actionParams);
      }
      // Server-side recipient resolution for SEND_USDC
      if (actionSkill === "SEND_USDC") {
        const recipient = String(actionParams.recipient ?? "");
        if (!recipient) {
          return { ok: false, error: "SEND_USDC action requires recipient", status: 400 };
        }
        let resolved: string;
        try {
          resolved = await resolveRecipient(recipient);
        } catch (err) {
          const msg = err instanceof Error ? err.message : `Could not resolve: ${recipient}`;
          return { ok: false, error: msg, status: 400 };
        }
        if (!isAddress(resolved)) {
          return { ok: false, error: "Resolved recipient address is invalid", status: 400 };
        }
        actionParams.recipient_address = resolved;
      }
    } else {
      return { ok: false, error: "action or steps is required", status: 400 };
    }

    // ── 3. Validate execution_mode ───────────────────────────────────
    if (!VALID_EXECUTION_MODES.includes(executionMode as typeof VALID_EXECUTION_MODES[number])) {
      return {
        ok: false,
        error: `execution_mode must be one of: ${VALID_EXECUTION_MODES.join(", ")}`,
        status: 400,
      };
    }

    // ── 4. Validate stop_conditions ────────────────────────────────────
    const stopConditions: Array<Record<string, unknown>> = [];
    for (const sc of stopConditionsRaw) {
      if (!isValidStopCondition(sc)) {
        return { ok: false, error: `Invalid stop condition: ${JSON.stringify(sc)}`, status: 400 };
      }
      stopConditions.push(sc as Record<string, unknown>);
    }

    // ── 5. Balance check: can the user afford at least one execution? ─
    let actionAmount = 0;
    if (normalizedSteps) {
      for (const step of normalizedSteps) {
        actionAmount += extractActionAmount(step.skill, step.params);
      }
    } else {
      actionAmount = extractActionAmount(actionSkill, actionParams);
    }
    if (actionAmount > 0 && ctx.agentWallet?.circle_wallet_id) {
      const balanceStr = await getAgentBalance(ctx.agentWallet.circle_wallet_id);
      const balance = parseFloat(balanceStr);
      if (balance < actionAmount) {
        return {
          ok: false,
          error: `Insufficient balance to create this policy. You have ${balance.toFixed(2)} USDC but the policy requires ${actionAmount.toFixed(2)} USDC per execution.`,
          status: 400,
        };
      }
    }

    // ── 6. Compute next_run for time triggers ────────────────────────
    let nextRun: string | null = null;
    if (triggerType === "time") {
      const freq = triggerParams.frequency as string;
      const dow = triggerParams.day_of_week as number | undefined;
      const dom = triggerParams.day_of_month as number | undefined;
      const lastDom = triggerParams.last_day_of_month === true;
      nextRun = computeNextRunTime(freq, dow, dom, lastDom);
    }

    // ── 7. Insert policy row (HMAC = "pending" first, then real) ────
    const policyPayload = normalizedSteps
      ? { trigger, steps: normalizedSteps, execution_mode: executionMode, stop_conditions: stopConditions, description }
      : { trigger, action, execution_mode: executionMode, stop_conditions: stopConditions, description };
    const { data: policyRow, error: insertErr } = await supabase
      .from("agent_policies")
      .insert({
        user_id: supabaseUserId,
        skill: "CREATE_POLICY", // legacy column — deprecated
        params: policyPayload,
        active: true,
        policy_hmac: "pending",
        // orchestration columns
        trigger_type: triggerType,
        trigger_params: triggerParams,
        action_skill: actionSkill,
        action_params: actionParams,
        execution_mode: executionMode,
        cooldown_seconds: triggerType === "price" ? 3600 : undefined,
        stop_conditions: stopConditions,
        policy_summary: description,
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

    // ── 7. Compute v2 HMAC over full orchestration intent ────────────
    const hmac = signPolicyHmac({
      version: 2,
      userId: supabaseUserId,
      policyId: policyRow.id,
      actionSkill: actionSkill,
      actionParams,
      triggerType,
      triggerParams,
      executionMode,
      cooldownSeconds: triggerType === "price" ? 3600 : 0,
      stopConditions,
      createdAt: policyRow.created_at,
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
        executionMode,
        description,
        nextRun,
      },
    };
  },
};

// ── helpers ───────────────────────────────────────────────────────────

/**
 * Extract the USDC amount required for a single execution of an action skill.
 * Returns 0 for "all" or unparseable amounts (skills handle those at runtime).
 */
function extractActionAmount(
  actionSkill: string,
  actionParams: Record<string, unknown>
): number {
  if (actionSkill === "WITHDRAW" && actionParams.amount === "all") {
    return 0; // runtime-resolved, skip creation-time check
  }
  const raw = Number(actionParams.amount ?? 0);
  if (!isFinite(raw) || raw <= 0) return 0;
  return raw;
}

/** Returns the last calendar day of a UTC month as a Date at 09:00 UTC. */
function lastDayOfMonth(year: number, month: number): Date {
  return new Date(Date.UTC(year, month + 1, 0, 9, 0, 0, 0));
}

/** Clamp day_of_month to the actual last day of the given UTC month. */
function clampDom(year: number, month: number, dom: number): Date {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(dom, lastDay), 9, 0, 0, 0));
}

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
      // Try this month's last day; if already past, use next month's
      const thisLast = lastDayOfMonth(y, m);
      if (thisLast > now) return thisLast.toISOString();
      return lastDayOfMonth(y, m + 1).toISOString();
    }

    const targetDom = dayOfMonth ?? 1;
    // Try target day this month; if past (or today), use next month
    const candidate = clampDom(y, m, targetDom);
    if (candidate > now) return candidate.toISOString();
    return clampDom(y, m + 1, targetDom).toISOString();
  }

  return null;
}
