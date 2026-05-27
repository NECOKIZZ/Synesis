/**
 * lib/skills/types.ts
 *
 * Shared contract for every DotArc agent skill.
 *
 * Rules:
 *  - Skill files MUST NOT import from each other.
 *  - Skill files MUST NOT import from app/ or Next.js.
 *  - Skill files communicate with the outside world ONLY through SkillContext.
 *  - Adding a skill = create a file, implement SkillHandler, register in index.ts.
 *
 * Contract design notes:
 *  - Every skill DECLARES intent via the meta fields (category, affectsFunds,
 *    version). This lets the executor, UI, audit log, and future rate-limiter
 *    make decisions without hard-coding skill names.
 *  - `idempotencyKey` is declarative — when present, the executor (future
 *    pass) will reject a second request with the same key within a dedupe
 *    window. Skills that move money should always implement it.
 *  - `onCronTick` now returns a structured CronTickOutput so the cron runner
 *    (T2.1) can log, pause, retry, or alert without sniffing DB rows.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// ── Spend limits loaded from user_spend_limits ─────────────────────────────

export type SpendLimits = {
  max_per_transaction_usdc: number;
  max_daily_usdc: number;
  max_weekly_usdc: number;
  max_monthly_usdc: number;
};

// ── Agent wallet info loaded from agent_wallets ────────────────────────────

export type AgentWallet = {
  circle_wallet_id: string;
  circle_wallet_address: string;
  // Optional cache fields — populated by confirm-policy when present in
  // agent_wallets. Skills MAY use these for short-window dedupe or stale
  // fallback when Circle is unreachable.
  balance_cache_usdc?: string | null;
  balance_cache_at?: string | null;
};

// ── Context injected into every skill execute() call ──────────────────────
//
// Built once in confirm-policy/route.ts AFTER all security layers pass.
// Skills must not re-verify PIN or session — that already happened.
//
// supabase       — RLS-protected client. Use for: reads, policy inserts, user-owned writes.
// serviceSupabase — Service-role client. Use ONLY for: spend log status updates
//                  (PENDING → COMPLETE/FAILED). The agent_spend_log table has no
//                  UPDATE RLS policy by design (append-only from user side).

export type SkillContext = {
  supabase: SupabaseClient;
  serviceSupabase: SupabaseClient;
  supabaseUserId: string;
  mainWalletAddress: string;     // user's main wallet address, from verified JWT session
  agentWallet: AgentWallet;
  limits: SpendLimits;
  params: Record<string, unknown>;
  getSpentSince: (since: Date) => Promise<number>; // sum of COMPLETE spend log entries
};

// ── What a skill returns ───────────────────────────────────────────────────

export type SkillOutput =
  | { ok: true;  result: Record<string, unknown>; status?: number }
  | { ok: false; error: string;                   status?: number };

// ── Stored policy row (for cron execution) ────────────────────────────────

export type AgentPolicy = {
  id: string;
  user_id: string;
  skill: string;                 // DEPRECATED: legacy skill name
  params: Record<string, unknown>; // DEPRECATED: legacy params blob
  recipient_address: string | null;
  amount_usdc: number;
  frequency: string | null;
  next_run: string | null;
  policy_hmac: string;
  created_at: string;

  // ── Orchestration model (new) ───────────────────────────────────────
  trigger_type: string;           // 'time' | 'price' | 'balance_above'
  trigger_params: Record<string, unknown>;
  action_skill: string;           // 'SEND_USDC' | 'SWAP_USDC' | 'WITHDRAW'
  action_params: Record<string, unknown>;
  execution_mode: string;         // 'once' | 'repeat'
  cooldown_seconds: number;
  stop_conditions: Array<Record<string, unknown>>;
  execution_count: number;
  total_spent_usdc: number;
  last_executed_at: string | null;
  policy_summary: string | null;
  policy_category: string | null;
  hmac_version: number;
};

// ── Context passed to onCronTick (lighter than SkillContext — no params) ──

export type CronContext = {
  supabase: SupabaseClient;
  serviceSupabase: SupabaseClient;
  supabaseUserId: string;
  agentWallet: AgentWallet;
  limits: SpendLimits;
  getSpentSince: (since: Date) => Promise<number>;
};

// ── Skill metadata ─────────────────────────────────────────────────────────

export type SkillCategory =
  | "READ"      // pure read; no state changes (e.g. CHECK_BALANCE)
  | "TRANSFER"  // moves real USDC out of the agent wallet
  | "CONFIG"    // mutates user settings (limits, prefs)
  | "POLICY";   // creates or modifies recurring policies

// ── Cron tick result ───────────────────────────────────────────────────────
//
// The cron runner uses this to decide what to do next:
//   { ok: true }                            → advance next_run, clear pause
//   { ok: false, retry: true }              → retry on next tick (transient)
//   { ok: false, pauseReason: "..." }       → mark policy inactive
//   { ok: false }                           → log + skip; runner decides

export type CronTickOutput =
  | { ok: true; result?: Record<string, unknown> }
  | { ok: false; error: string; retry?: boolean; pauseReason?: string };

// ── The skill contract ─────────────────────────────────────────────────────

export interface SkillHandler {
  // ─── Metadata (required) ────────────────────────────────────────────────
  // category      — what kind of skill this is. Drives audit, UI, rate-limit.
  // version       — bump when params schema changes incompatibly. Lets the
  //                 cron runner refuse stale policy rows.
  // affectsFunds  — true if execute() can move real USDC. Forces stricter
  //                 logging, idempotency, and (future) per-user rate limits.
  readonly category: SkillCategory;
  readonly version: number;
  readonly affectsFunds: boolean;

  // ─── Behavior flags (optional) ──────────────────────────────────────────
  // requiresPin   — default true. Set false ONLY for READ skills that have
  //                 no side effects.
  readonly requiresPin?: boolean;

  // ─── Idempotency (optional but strongly recommended for affectsFunds) ──
  // Returns a stable string identifying "the same intent again." When the
  // future executor sees the same key from the same user inside the dedupe
  // window, it returns the prior result instead of re-executing.
  // Return null to opt out for a particular invocation (e.g. user-confirmed
  // intentional retry).
  idempotencyKey?(params: Record<string, unknown>): string | null;

  // ─── Validation (optional) ──────────────────────────────────────────────
  // Pre-flight params validator. Should THROW with a clear message on bad
  // input. Returning a value lets the skill normalize/coerce params before
  // execute() sees them. The interpreter layer can call this independently
  // of execute() to give the user fast feedback.
  validate?(params: Record<string, unknown>): Record<string, unknown>;

  // ─── Execution ──────────────────────────────────────────────────────────
  execute(ctx: SkillContext): Promise<SkillOutput>;

  // ─── Cron path (optional) ───────────────────────────────────────────────
  // Required for any skill that creates rows in agent_policies that should
  // execute on a schedule. Returns structured output so the cron runner can
  // observe + react without poking DB rows.
  onCronTick?(ctx: CronContext, policy: AgentPolicy): Promise<CronTickOutput>;
}
