/**
 * GET /api/agent/status
 *
 * Returns the current user's agent wallet status:
 *   - wallet address + balance (refreshed from Circle)
 *   - active policies
 *   - spend limits
 *   - PIN set flag
 *   - recent spend log (last 10)
 */

import { NextResponse } from "next/server";
import { requireAgentSession, getAgentBalance } from "@/lib/agent";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET() {
  let agentSession: Awaited<ReturnType<typeof requireAgentSession>>;
  try {
    agentSession = await requireAgentSession();
  } catch (res) {
    return res as Response;
  }

  const { supabaseUserId } = agentSession;
  const supabase = await createSupabaseServerClient();

  // ── Agent wallet ──────────────────────────────────────────────────
  const { data: wallet } = await supabase
    .from("agent_wallets")
    .select("id, circle_wallet_id, circle_wallet_address, arc_name, active, balance_cache_usdc, balance_cache_at")
    .eq("user_id", supabaseUserId)
    .maybeSingle();

  if (!wallet) {
    return NextResponse.json({ activated: false });
  }

  // Use cached balance; only hit Circle if cache is older than 30s
  const BALANCE_CACHE_TTL_MS = 30_000;
  const cacheAgeMs = wallet.balance_cache_at
    ? Date.now() - new Date(wallet.balance_cache_at).getTime()
    : Infinity;
  let balanceUsdc = wallet.balance_cache_usdc ?? "0";
  if (cacheAgeMs > BALANCE_CACHE_TTL_MS) {
    try {
      balanceUsdc = await getAgentBalance(wallet.circle_wallet_id);
      await supabase
        .from("agent_wallets")
        .update({ balance_cache_usdc: balanceUsdc, balance_cache_at: new Date().toISOString() })
        .eq("user_id", supabaseUserId);
    } catch (err) {
      console.warn("[agent/status] balance refresh failed (serving cache):", err instanceof Error ? err.message : err);
    }
  }

  // ── Spend limits ──────────────────────────────────────────────────
  const { data: limits } = await supabase
    .from("user_spend_limits")
    .select("max_per_transaction_usdc, max_daily_usdc, max_weekly_usdc, max_monthly_usdc, large_tx_alert_threshold_usdc")
    .eq("user_id", supabaseUserId)
    .maybeSingle();

  // ── PIN set flag ──────────────────────────────────────────────────
  const { data: sec } = await supabase
    .from("user_security")
    .select("agent_pin_hash")
    .eq("user_id", supabaseUserId)
    .maybeSingle();

  const pinSet = Boolean(sec?.agent_pin_hash);

  // ── Active policies (orchestration format) ────────────────────────
  const { data: rawPolicies } = await supabase
    .from("agent_policies")
    .select("id,active,policy_summary,policy_category,trigger_type,action_skill,execution_mode,execution_count,total_spent_usdc,next_run,created_at,pause_reason")
    .eq("user_id", supabaseUserId)
    .eq("active", true)
    .order("created_at", { ascending: false })
    .limit(20);

  const policies = (rawPolicies ?? []).map((p) => ({
    id: p.id,
    active: p.active,
    summary: p.policy_summary ?? "",
    category: p.policy_category ?? "",
    triggerType: p.trigger_type ?? "",
    actionSkill: p.action_skill ?? "",
    executionMode: p.execution_mode ?? "",
    executionCount: p.execution_count ?? 0,
    totalSpentUsdc: p.total_spent_usdc ?? "0",
    nextRun: p.next_run,
    createdAt: p.created_at,
    pauseReason: p.pause_reason,
  }));

  // ── Recent spend log ──────────────────────────────────────────────
  const { data: spendLog } = await supabase
    .from("agent_spend_log")
    .select("id, skill, recipient_address, recipient_arc_name, amount_usdc, tx_hash, status, executed_at")
    .eq("user_id", supabaseUserId)
    .order("executed_at", { ascending: false })
    .limit(10);

  return NextResponse.json({
    activated: pinSet, // truly "activated" only when wallet + PIN are both ready
    walletCreated: true,
    limitsSet: !!limits,
    wallet: {
      address: wallet.circle_wallet_address,
      arcName: wallet.arc_name ? `${wallet.arc_name}.arc` : null,
      balanceUsdc,
      active: wallet.active,
    },
    pinSet,
    limits: limits ?? {
      max_per_transaction_usdc: 50,
      max_daily_usdc: 100,
      max_weekly_usdc: 300,
      max_monthly_usdc: 500,
      large_tx_alert_threshold_usdc: 25,
    },
    policies: policies ?? [],
    recentActivity: spendLog ?? [],
  });
}
