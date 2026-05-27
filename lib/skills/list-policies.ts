/**
 * Skill: LIST_POLICIES
 *
 * Read-only skill that returns the user's active (and optionally paused)
 * policies. No PIN required — this is a query, not an action.
 *
 * Used by:
 *   - Frontend policy tab (direct call)
 *   - Interpreter context injection (called server-side before LLM call)
 */

import "server-only";
import type { SkillHandler, SkillContext, SkillOutput } from "./types";

export const ListPolicies: SkillHandler = {
  category: "READ",
  version: 1,
  affectsFunds: false,
  requiresPin: false,

  async execute({ supabase, supabaseUserId, params }: SkillContext): Promise<SkillOutput> {
    const includePaused = Boolean(params.include_paused);

    const { data: policies, error } = await supabase
      .from("agent_policies")
      .select(
        "id,active,policy_summary,policy_category,trigger_type,action_skill,execution_mode," +
        "execution_count,total_spent_usdc,next_run,created_at,pause_reason"
      )
      .eq("user_id", supabaseUserId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[list-policies] query failed:", error);
      return { ok: false, error: "Failed to load policies", status: 500 };
    }

    const allPolicies = (policies ?? []) as unknown as Record<string, unknown>[];
    const active = allPolicies.filter((p) => p.active === true);
    const paused = includePaused
      ? allPolicies.filter((p) => p.active !== true)
      : [];

    return {
      ok: true,
      result: {
        total: allPolicies.length,
        active: active.map(normalizePolicy),
        paused: paused.map(normalizePolicy),
      },
    };
  },
};

function normalizePolicy(p: Record<string, unknown>): Record<string, unknown> {
  return {
    id: p.id,
    summary: p.policy_summary ?? "Untitled policy",
    category: p.policy_category,
    trigger: p.trigger_type,
    action: p.action_skill,
    mode: p.execution_mode,
    executions: p.execution_count ?? 0,
    totalSpentUsdc: p.total_spent_usdc ?? 0,
    nextRun: p.next_run,
    createdAt: p.created_at,
    pauseReason: p.pause_reason ?? null,
  };
}
