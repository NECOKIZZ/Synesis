/**
 * Skill: CANCEL_POLICY
 *
 * Deactivates active policies for the user.
 *
 * Three modes:
 *   1. policy_ids: string[]  — cancel specific policies (from LLM matching)
 *   2. cancel_all: true      — cancel ALL active policies (explicit user request)
 *   3. description: string    — vague request, no match found → show "nothing matched"
 *
 * The LLM is instructed to return policy_ids when it can match the user's
 * description against the active policy list. Only cancel_all triggers
 * a mass cancellation.
 */

import "server-only";
import type { SkillHandler, SkillContext, SkillOutput } from "./types";

export const CancelPolicy: SkillHandler = {
  category: "POLICY",
  version: 2,
  affectsFunds: false,

  async execute({ supabase, supabaseUserId, params }: SkillContext): Promise<SkillOutput> {
    // ── Mode 1: specific policy IDs from LLM matching ──────────────
    const policyIds = Array.isArray(params.policy_ids)
      ? params.policy_ids.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];

    if (policyIds.length > 0) {
      const { data: cancelled, error } = await supabase
        .from("agent_policies")
        .update({ active: false, pause_reason: "Cancelled by user" })
        .eq("user_id", supabaseUserId)
        .in("id", policyIds)
        .eq("active", true)
        .select("id, policy_summary");

      if (error) {
        console.error("[cancel-policy] update failed:", error);
        return { ok: false, error: "Failed to cancel policies", status: 500 };
      }

      const cancelledCount = cancelled?.length ?? 0;
      const summaries = (cancelled ?? []).map((p) => p.policy_summary ?? "Unnamed policy");

      return {
        ok: true,
        result: {
          cancelledCount,
          cancelledIds: cancelled?.map((p) => p.id) ?? [],
          summaries,
        },
      };
    }

    // ── Mode 2: explicit cancel all ────────────────────────────────
    if (params.cancel_all === true) {
      const { data: cancelled, error } = await supabase
        .from("agent_policies")
        .update({ active: false, pause_reason: "Cancelled by user (all)" })
        .eq("user_id", supabaseUserId)
        .eq("active", true)
        .select("id, policy_summary");

      if (error) {
        console.error("[cancel-policy] bulk cancel failed:", error);
        return { ok: false, error: "Failed to cancel policies", status: 500 };
      }

      const cancelledCount = cancelled?.length ?? 0;
      const summaries = (cancelled ?? []).map((p) => p.policy_summary ?? "Unnamed policy");

      return {
        ok: true,
        result: {
          cancelledCount,
          cancelledIds: cancelled?.map((p) => p.id) ?? [],
          summaries,
          cancelledAll: true,
        },
      };
    }

    // ── Mode 3: vague description, nothing matched ─────────────────
    const description = String(params.description ?? "").trim();
    if (description) {
      // Fetch active policies so the frontend can show them
      const { data: activePolicies } = await supabase
        .from("agent_policies")
        .select("id, policy_summary, policy_category, trigger_type, action_skill, execution_mode")
        .eq("user_id", supabaseUserId)
        .eq("active", true)
        .order("created_at", { ascending: false });

      // Return ok: true with nothingMatched flag — frontend can show the list
      return {
        ok: true,
        result: {
          nothingMatched: true,
          description,
          activePolicies: (activePolicies ?? []).map((p) => ({
            id: p.id,
            summary: p.policy_summary ?? "Unnamed policy",
            category: p.policy_category,
            trigger: p.trigger_type,
            action: p.action_skill,
            mode: p.execution_mode,
          })),
        },
      };
    }

    // ── Fallback: no params at all ────────────────────────────────
    return {
      ok: false,
      error: "Please tell me which policy to cancel, or say 'cancel all'.",
      status: 400,
    };
  },
};
