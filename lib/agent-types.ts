/**
 * DotArc Smart Agent — shared types (no server-only).
 *
 * These types are used by both server-side agent logic and client-side UI.
 * They contain no runtime code and can be safely imported into "use client"
 * components via `import type`.
 */

export type TaskType = "immediate" | "compound" | "recurring" | "conditional";

export type SkillName =
  | "SEND_USDC"
  | "CHECK_BALANCE"
  | "SET_LIMIT"
  | "CANCEL_POLICY"
  | "WITHDRAW"
  | "CREATE_POLICY"
  | "LIST_POLICIES"
  | "SWAP_USDC"
  | "BRIDGE_USDC"
  | "PAY_X402"
  | "SEND_TOKEN"
  | "UNKNOWN";

export type LeafSkill = Exclude<SkillName, "CREATE_POLICY" | "UNKNOWN">;

export type PlanStep = {
  skill: LeafSkill;
  params: Record<string, unknown>;
  description: string;
};

export type PolicyAction = {
  skill: LeafSkill;
  params: Record<string, unknown>;
};

// ── Task Results (V2) ──────────────────────────────────────────────────

export type ImmediateTaskResult = {
  task_type: "immediate";
  skill: SkillName;
  params: Record<string, unknown>;
  confirmation_message: string;
  requires_confirmation: boolean;
};

export type CompoundTaskResult = {
  task_type: "compound";
  steps: PlanStep[];
  confirmation_message: string;
  requires_confirmation: true;
};

export type RecurringTaskResult = {
  task_type: "recurring";
  schedule: string;
  schedule_params?: Record<string, unknown>;
  action?: PolicyAction;
  steps?: PlanStep[];
  execution_mode?: "once" | "repeat";
  stop_conditions?: Array<Record<string, unknown>>;
  confirmation_message: string;
  requires_confirmation: true;
};

export type ConditionalTaskResult = {
  task_type: "conditional";
  trigger: Record<string, unknown>;
  action?: PolicyAction;
  steps?: PlanStep[];
  execution_mode?: "once" | "repeat";
  stop_conditions?: Array<Record<string, unknown>>;
  confirmation_message: string;
  requires_confirmation: true;
};

export type AnyTaskResult =
  | ImmediateTaskResult
  | CompoundTaskResult
  | RecurringTaskResult
  | ConditionalTaskResult;

// ── Backward-compatible aliases ────────────────────────────────────────
// These exist so existing code that references AnySkillResult / PlanResult
// continues to compile.  Internally we now prefer AnyTaskResult.

/** @deprecated Use `AnyTaskResult` instead. */
export type SkillResult = ImmediateTaskResult;

/** @deprecated Use `CompoundTaskResult` instead. */
export type PlanResult = CompoundTaskResult;

/** @deprecated Use `AnyTaskResult` instead. */
export type AnySkillResult = AnyTaskResult;

// ── Other shared types ─────────────────────────────────────────────────

export type SpendLimits = {
  max_per_transaction_usdc: number;
  max_daily_usdc: number;
  max_weekly_usdc: number;
  max_monthly_usdc: number;
};

export type AgentTokenBalance = {
  symbol: string;
  amount: string;
  amountNumber: number;
  tokenAddress: string | null;
  approxUsdValue: number;
};

export type ActivePolicy = {
  id: string;
  summary: string;
  category: string | null;
  trigger: string | null;
  action: string | null;
  mode: string | null;
};

