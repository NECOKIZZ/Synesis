/**
 * Synesis Smart Agent — pure logic helpers (no server-only deps).
 *
 * After the V3 cutover, this file holds only the shared utilities that
 * the V3 interpreter (lib/agent-core-v3.ts) and the rest of the agent
 * codebase depend on: live prices, time-period helpers, spend-limit
 * checks, and the next_run calculator.
 *
 * The V2 prompt builder, validator, and OpenRouter wrapper used to live
 * here. They were removed when the task model migrated to the V3
 * multi-intent shape (`Trigger` + `Task` + `InterpretResult`). See
 * `lib/agent-core-v3.ts` for the V3 equivalents.
 */

import type {
  SkillName,
  PlanStep,
  SpendLimits,
  AgentTokenBalance,
  ActivePolicy,
} from "@/lib/agent-types";

export type {
  SkillName,
  PlanStep,
  SpendLimits,
  AgentTokenBalance,
  ActivePolicy,
};

// ── Live prices ──
//
// Re-exports the oracle's `getLivePrices` + `LivePrices` so the V3
// prompt builder and any legacy callers keep working unchanged. The
// real implementation lives in `lib/oracle/` (CoinGecko + cache +
// stale-while-error). Fallback to hardcoded constants is handled
// inside the oracle, so this file never needs a fallback of its own.

export { getLivePrices } from "./oracle";
export type { LivePrices } from "./oracle";

// ── Display helpers ──────────────────────────────────────────────────────

export function fmtUsdc(n: number): string {
  // Strip trailing zeros for friendly display, keep up to 6 decimals.
  return n.toFixed(6).replace(/\.?0+$/, "");
}

// ── Period helpers (UTC) ─────────────────────────────────────────────────

export function startOfDayUTC(now: Date = new Date()): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export function startOfWeekUTC(now: Date = new Date()): Date {
  const d = new Date(now);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - daysSinceMonday);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export function startOfMonthUTC(now: Date = new Date()): Date {
  const d = new Date(now);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// ── Spend limit validation ───────────────────────────────────────────────

export type SpendCheckResult = { allowed: true } | { allowed: false; reason: string };

export function checkSpendLimits(args: {
  amountUsdc: number;
  limits: SpendLimits;
  spentTodayUsdc: number;
  spentThisWeekUsdc: number;
  spentThisMonthUsdc: number;
}): SpendCheckResult {
  const { amountUsdc, limits, spentTodayUsdc, spentThisWeekUsdc, spentThisMonthUsdc } = args;

  if (amountUsdc > limits.max_per_transaction_usdc) {
    return {
      allowed: false,
      reason: `Exceeds per-transaction limit ($${limits.max_per_transaction_usdc.toFixed(2)})`,
    };
  }
  if (spentTodayUsdc + amountUsdc > limits.max_daily_usdc) {
    return {
      allowed: false,
      reason: `Would exceed daily limit ($${limits.max_daily_usdc.toFixed(2)}, already spent $${spentTodayUsdc.toFixed(2)})`,
    };
  }
  if (spentThisWeekUsdc + amountUsdc > limits.max_weekly_usdc) {
    return {
      allowed: false,
      reason: `Would exceed weekly limit ($${limits.max_weekly_usdc.toFixed(2)}, already spent $${spentThisWeekUsdc.toFixed(2)})`,
    };
  }
  if (spentThisMonthUsdc + amountUsdc > limits.max_monthly_usdc) {
    return {
      allowed: false,
      reason: `Would exceed monthly limit ($${limits.max_monthly_usdc.toFixed(2)}, already spent $${spentThisMonthUsdc.toFixed(2)})`,
    };
  }
  return { allowed: true };
}

// ── next_run calculator for recurring policies ─────────────────────────

export function computeNextRun(
  frequency: "daily" | "weekly" | "monthly",
  dayOfWeek?: number,  // 0-6 (for weekly)
  dayOfMonth?: number, // 1-28 (for monthly)
): string {
  const now = new Date();
  const next = new Date(now);

  if (frequency === "daily") {
    next.setUTCDate(next.getUTCDate() + 1);
    next.setUTCHours(9, 0, 0, 0); // 9am UTC
  } else if (frequency === "weekly") {
    const targetDow = dayOfWeek ?? 1; // default Monday
    const daysUntil = (targetDow - next.getUTCDay() + 7) % 7;
    next.setUTCDate(next.getUTCDate() + (daysUntil === 0 ? 7 : daysUntil));
    next.setUTCHours(9, 0, 0, 0);
  } else if (frequency === "monthly") {
    const targetDom = dayOfMonth ?? 1;
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + 1);
    next.setUTCDate(targetDom);
    next.setUTCHours(9, 0, 0, 0);
  }
  return next.toISOString();
}
