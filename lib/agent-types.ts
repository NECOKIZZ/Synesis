/**
 * DotArc Smart Agent — shared types (no server-only).
 *
 * These types are used by both server-side agent logic and client-side UI.
 * They contain no runtime code and can be safely imported into "use client"
 * components via `import type`.
 */

/**
 * @deprecated V2 routing field. Kept for backward compatibility with the
 * legacy validator/executor until Phase 4 of the task-model refactor
 * migrates them to the new `Task` shape below. New code should use
 * `Trigger` + `Task` instead.
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

// ── V3 Task Model (Multi-Intent + Composable Triggers) ─────────────────
//
// The old `task_type` enum mashed THREE orthogonal dimensions into one
// field (trigger, structure, repetition), forcing the LLM to drop two of
// them into prose whenever a task combined more than one. V3 separates
// them into independent properties on a single `Task` envelope:
//
//   - trigger        : WHEN it fires        (now / scheduled / conditional)
//   - steps          : WHAT it does         (1 step = simple, N = compound)
//   - execution_mode : DOES IT REPEAT       (once / repeat)
//
// On top of that, `InterpretResult.tasks` is ALWAYS an array, so a single
// user message can produce N independent tasks. This is what makes
// utterances like "send X on Friday, send Y on Tuesday, send Z daily"
// representable without losing any intent.
//
// All field names are intentionally JSON-friendly (snake_case) because
// they're produced by the LLM and travel over the wire.

/**
 * Atomic trigger primitives. `and` lets a task fire only when ALL
 * sub-triggers are satisfied (e.g. "Tuesday AND balance > 70"). We keep
 * `or` out for now — every concrete user example we've seen is `and`.
 */
export type Trigger =
  | { type: "now" }
  | {
      type: "time";
      /** "daily" | "weekly" | "monthly" — same vocabulary the cron understands */
      schedule: "daily" | "weekly" | "monthly";
      /** Optional refinements; semantics match the old recurring task. */
      day_of_week?: number;          // 0=Sun..6=Sat
      day_of_month?: number;         // 1-31
      last_day_of_month?: boolean;
    }
  | {
      type: "price";
      asset: "BTC" | "ETH" | "USDC" | "EURC" | "cirBTC";
      direction: "above" | "below";
      threshold: number;
    }
  | {
      type: "balance_above";
      threshold_usdc: number;
    }
  | {
      type: "and";
      /**
       * Composite trigger — fires when every sub-trigger is satisfied.
       * Sub-triggers can be any primitive (no nested `and` — keep it flat).
       */
      conditions: Array<Exclude<Trigger, { type: "and" }>>;
    };

/**
 * A task is a single, atomic intent. It has:
 *   - one trigger (shared by all steps in the task)
 *   - one or more steps (length 1 = simple, length N = compound)
 *   - one execution mode (the whole task repeats or runs once)
 *
 * Steps inside a task ALWAYS share the same trigger. If two steps need
 * different triggers, they belong in two separate tasks.
 */
export type Task = {
  trigger: Trigger;
  steps: PlanStep[];
  execution_mode: "once" | "repeat";
  stop_conditions?: Array<Record<string, unknown>>;
  /** Plain-English summary, used as the per-task line in the confirm card. */
  confirmation_message: string;
};

/**
 * Result returned by `interpretInstruction` in V3. Always an array, even
 * when the user message only produces a single task. The unified shape
 * lets the dispatcher walk the list without branching on task count.
 */
export type InterpretResult = {
  tasks: Task[];
  /**
   * Single summary line shown above the per-task cards on the confirm
   * screen. Useful when the user message had multiple intents — gives
   * them a one-line overview before they read each card.
   */
  combined_confirmation_message: string;
  /**
   * Set when the LLM couldn't interpret the message at all. The dispatcher
   * uses this to short-circuit and render a friendly error to the user.
   */
  unknown_reason?: string;
};

