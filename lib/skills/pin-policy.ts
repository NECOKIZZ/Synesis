/**
 * lib/skills/pin-policy.ts
 *
 * Single source of truth for a batch's GATING decisions — PIN, upfront
 * USDC requirement, and auto-confirm — all derived from per-skill metadata.
 *
 * Shared by:
 *   - app/api/agent/interpret/route.ts   — ships requires_pin, upfront_usdc,
 *                                          and auto_confirm to the UI so the
 *                                          client renders decisions instead
 *                                          of re-deriving them (D2 fix).
 *   - app/api/agent/confirm-policy/route.ts — gates the actual
 *                                             verifyAgentPinOrThrow call and
 *                                             the pre-flight balance check.
 *
 * Keeping these rules in ONE place prevents drift between "what the UI
 * thinks" and "what the server actually enforces" — the D2 root cause
 * (F-7 client balance denylist, F-8 client auto-confirm allowlist).
 *
 * PIN decision rule (matches user-stated policy "outward only"):
 *   - SkillHandler.requiresPin === false       → no PIN
 *   - SkillHandler.requiresPin === true        → PIN
 *   - SkillHandler.requiresPin === undefined   → PIN  (fail-safe)
 *   - SkillHandler.requiresPin (function)      → invoked with params +
 *                                                 mainWalletAddress
 *   - any throw inside the function form       → PIN  (fail-safe)
 */

import "server-only";
import { skillRegistry } from "./index";
import type { Task, PlanStep } from "@/lib/agent-types";

export function batchRequiresPin(tasks: Task[], mainWalletAddress: string): boolean {
  for (const task of tasks) {
    for (const step of task.steps) {
      const handler = skillRegistry[step.skill];
      if (!handler) return true; // unknown skill → fail-safe
      const r = handler.requiresPin;
      if (r === false) continue;
      if (r === undefined || r === true) return true;
      if (typeof r === "function") {
        try {
          if (r(step.params, { mainWalletAddress })) return true;
        } catch {
          return true;
        }
      }
    }
  }
  return false;
}

// ── Upfront USDC requirement ───────────────────────────────────────────────
//
// Only skills that draw USDC out of the agent wallet UP FRONT gate on balance.
// Each declares requiresBalanceCheck=true and its `params.amount` is in USDC
// (SEND_USDC, WITHDRAW, BRIDGE_USDC). Everything else — SET_LIMIT, GET_PRICE,
// SEND_TOKEN (non-USDC unit), SWAP_USDC (checked in-skill), CREATE_POLICY … —
// leaves the flag false so its numeric params are NEVER mistaken for a spend.
// This is the authoritative rule; the client no longer re-derives it (kills the
// F-7 denylist that summed SET_LIMIT's cap as if it were a spend).

function amountFromParams(params: Record<string, unknown>): number {
  if (params.amount === "all") return 0;
  const raw = Number(params.amount ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw;
}

function planUpfrontUsdc(steps: PlanStep[]): number {
  return steps.reduce((total, step) => {
    const handler = skillRegistry[step.skill];
    if (!handler?.requiresBalanceCheck) return total;
    const raw = step.params.amount;
    if (typeof raw === "string" && raw.startsWith("$prev")) return total;
    return total + amountFromParams(step.params);
  }, 0);
}

/**
 * Sum of upfront USDC required across every "now" task's steps. Policy tasks
 * (non-"now" triggers) don't draw funds at creation — the cron does that
 * later — so they're excluded.
 */
export function totalUpfrontUsdc(tasks: Task[]): number {
  return tasks.reduce((acc, t) => {
    if (t.trigger.type !== "now") return acc;
    return acc + planUpfrontUsdc(t.steps);
  }, 0);
}

/**
 * True when a batch can skip the confirm card entirely and execute
 * immediately — i.e. it needs no PIN (read-only, config, or same-user money
 * moves: withdraw-to-self, swap-in-place, self-bridge). Outward third-party
 * sends set requiresPin=true, so they always show the card + PIN. This is the
 * authoritative auto-confirm signal; the client no longer keeps its own
 * hardcoded read-only allowlist (kills F-8's card-shows-for-withdraw bug).
 */
export function batchAutoConfirm(tasks: Task[], mainWalletAddress: string): boolean {
  return tasks.length > 0 && !batchRequiresPin(tasks, mainWalletAddress);
}
