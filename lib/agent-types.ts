/**
 * Synesis Smart Agent — shared types (no server-only).
 *
 * These types are used by both server-side agent logic and client-side UI.
 * They contain no runtime code and can be safely imported into "use client"
 * components via `import type`.
 */

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
  | "GET_PRICE"
  | "IKNOW"
  | "RETRIEVE_TRANSACTIONS"
  | "SEND_SOLANA_USDC"
  | "UNKNOWN";

export type LeafSkill = Exclude<SkillName, "CREATE_POLICY" | "UNKNOWN">;

export type PlanStep = {
  skill: LeafSkill;
  params: Record<string, unknown>;
  description: string;
};

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
      /**
       * WHEN a time task fires. Beyond the legacy daily/weekly/monthly
       * recurrences: `once` fires a single time at `at`; `hourly` fires
       * every hour at `time_of_day`'s minute; `interval` fires every
       * `every_minutes` minutes. Recurring fire times default to 09:00 UTC
       * when `time_of_day` is omitted (preserves legacy behavior).
       */
      schedule: "once" | "hourly" | "daily" | "weekly" | "monthly" | "interval";
      /** ISO datetime — REQUIRED for `once`. Bare (no Z/offset) → interpreted in `tz`. */
      at?: string;
      /** "HH:MM" 24h — fire time for hourly (minute) / daily / weekly / monthly. */
      time_of_day?: string;
      /** REQUIRED for `interval` — fire every N minutes. */
      every_minutes?: number;
      /** IANA timezone (e.g. "Africa/Lagos"). Omitted → times are UTC. */
      tz?: string;
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
  /**
   * Server-computed (in /api/agent/interpret) — true if at least one step
   * in this batch requires a PIN. Lets the UI hide the PIN input entirely
   * for read-only / config / withdraw-to-self batches. When the field is
   * absent, the UI MUST default to true (fail-safe).
   */
  requires_pin?: boolean;
  /**
   * Server-computed — total USDC drawn UP FRONT across every "now" task
   * (the requiresBalanceCheck skills only: SEND_USDC / WITHDRAW / BRIDGE).
   * The client uses THIS for its pre-PIN insufficient-balance fast-fail
   * instead of re-summing step amounts (which mis-counted config caps — F-7).
   * Absent → treat as 0.
   */
  upfront_usdc?: number;
  /**
   * Server-computed — true when the batch needs no PIN and can execute
   * immediately without a confirm card (reads, config, same-user money
   * moves). Replaces the client's hardcoded read-only allowlist (F-8).
   * Absent → treat as false (fail-safe: show the card).
   */
  auto_confirm?: boolean;
  /**
   * INTERNAL / logs-only — the model's short explanation of WHY it chose
   * these tasks (triggers, skills, amounts). Populated by the interpreter,
   * logged server-side for prompt tuning, and STRIPPED before the response
   * reaches the client. Never shown to the user.
   */
  reasoning?: string;
  /**
   * INTERNAL / logs-only — the specific context inputs the model relied on
   * (e.g. "balance=42 USDC", "memory: sara=sara.arc", "prior turn"). Same
   * lifecycle as `reasoning`: logged, then stripped from the client response.
   */
  citations?: string[];
};

