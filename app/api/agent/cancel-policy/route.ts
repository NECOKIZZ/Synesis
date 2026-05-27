/**
 * POST /api/agent/cancel-policy
 *
 * Deactivate one or more policies. Requires agent PIN.
 *
 * Supports three modes (in priority order):
 *   1. policyId (string)      — legacy single-policy cancel
 *   2. policy_ids (string[])  — batch cancel specific policies
 *   3. cancel_all (boolean)   — cancel all active policies
 *   4. description (string)   — vague request → return active list for user to pick
 *
 * Body: { pin: string, policyId?: string, policy_ids?: string[], cancel_all?: boolean, description?: string }
 */

import { NextResponse } from "next/server";
import { requireAgentSession } from "@/lib/agent";
import { verifyAgentPinOrThrow } from "@/lib/agent-pin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { CancelPolicy } from "@/lib/skills/cancel-policy";
import type { SkillContext } from "@/lib/skills";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let agentSession: Awaited<ReturnType<typeof requireAgentSession>>;
  try {
    agentSession = await requireAgentSession();
  } catch (res) {
    return res as Response;
  }

  const { supabaseUserId } = agentSession;

  let body: {
    pin?: unknown;
    policyId?: unknown;
    policy_ids?: unknown;
    cancel_all?: unknown;
    description?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const pin = String(body.pin ?? "");
  if (!pin) {
    return NextResponse.json({ error: "pin is required" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();

  // ── Verify PIN ──────────────────────────────────────────────────────
  try {
    await verifyAgentPinOrThrow({ supabase, userId: supabaseUserId, pin });
  } catch (res) {
    return res as Response;
  }

  // ── Normalize params ───────────────────────────────────────────────
  const params: Record<string, unknown> = {};

  if (body.policyId) {
    // Legacy single-ID mode → wrap as policy_ids array
    params.policy_ids = [String(body.policyId)];
  } else if (Array.isArray(body.policy_ids)) {
    params.policy_ids = body.policy_ids
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  } else if (body.cancel_all === true) {
    params.cancel_all = true;
  } else if (typeof body.description === "string" && body.description.trim().length > 0) {
    params.description = body.description.trim();
  }

  if (!params.policy_ids && !params.cancel_all && !params.description) {
    return NextResponse.json(
      { error: "Provide policyId, policy_ids, cancel_all, or description" },
      { status: 400 }
    );
  }

  // ── Build SkillContext and delegate to CANCEL_POLICY ──────────────
  const serviceSupabase = createSupabaseServiceClient();

  const ctx: SkillContext = {
    supabase,
    serviceSupabase,
    supabaseUserId,
    mainWalletAddress: "",
    agentWallet: { circle_wallet_id: "", circle_wallet_address: "", balance_cache_usdc: "0", balance_cache_at: null },
    limits: { max_per_transaction_usdc: 0, max_daily_usdc: 0, max_weekly_usdc: 0, max_monthly_usdc: 0 },
    params,
    getSpentSince: async () => 0,
  };

  const output = await CancelPolicy.execute(ctx);

  if (!output.ok) {
    return NextResponse.json({ error: output.error }, { status: output.status ?? 400 });
  }

  // Forward the skill result (includes nothingMatched + activePolicies for vague requests)
  return NextResponse.json(output.result, { status: output.status ?? 200 });
}
