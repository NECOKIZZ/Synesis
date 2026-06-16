/**
 * Skill: SET_LIMIT
 *
 * Updates one of the user's spend guardrails. Hard ceilings are enforced
 * server-side and cannot be overridden by the interpreter.
 *
 * Trigger examples:
 *   "set my daily limit to 200 USDC"
 *   "change per-transaction limit to 25"
 *   "lower my monthly cap to 300"
 *
 * Required params: { type: "per_transaction"|"daily"|"weekly"|"monthly", amount: number }
 */

import "server-only";
import type { SkillHandler, SkillContext, SkillOutput } from "./types";

// Hard ceilings — cannot be raised above these values via chat
const HARD_CEILINGS: Record<string, number> = {
  per_transaction: 500,
  daily:           1_000,
  weekly:          2_000,
  monthly:         5_000,
};

const COL_MAP: Record<string, string> = {
  per_transaction: "max_per_transaction_usdc",
  daily:           "max_daily_usdc",
  weekly:          "max_weekly_usdc",
  monthly:         "max_monthly_usdc",
};

export const SetLimit: SkillHandler = {
  category: "CONFIG",
  version: 1,
  affectsFunds: false,
  // No PIN: this only updates the user's own spend-limit row.
  requiresPin: false,

  async execute({ supabase, supabaseUserId, params }: SkillContext): Promise<SkillOutput> {
    const type   = String(params.type   ?? "");
    const amount = Number(params.amount);

    if (!type || isNaN(amount) || amount <= 0) {
      return { ok: false, error: "type and a positive amount are required", status: 400 };
    }

    const col = COL_MAP[type];
    if (!col) {
      return { ok: false, error: `Unknown limit type: ${type}. Use per_transaction, daily, weekly, or monthly`, status: 400 };
    }

    const ceiling = HARD_CEILINGS[type];
    if (amount > ceiling) {
      return {
        ok: false,
        error: `$${amount} exceeds the hard ceiling of $${ceiling} USDC for ${type} limit`,
        status: 400,
      };
    }

    const { error: upsertErr } = await supabase
      .from("user_spend_limits")
      .upsert({ user_id: supabaseUserId, [col]: amount }, { onConflict: "user_id" });

    if (upsertErr) {
      console.error("[set-limit] upsert failed:", upsertErr);
      return { ok: false, error: "Failed to update limit", status: 500 };
    }

    return { ok: true, result: { updated: type, amount } };
  },
};
