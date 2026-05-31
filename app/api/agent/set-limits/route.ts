/**
 * POST /api/agent/set-limits
 *
 * Update the user's agent spend limits.  Requires agent PIN to confirm.
 *
 * Body: {
 *   pin: string,
 *   maxPerTransaction?: number,
 *   maxDaily?: number,
 *   maxWeekly?: number,
 *   maxMonthly?: number,
 * }
 *
 * Hard ceiling: max_per_transaction ≤ 500, max_monthly ≤ 10000.
 */

import { NextResponse } from "next/server";
import { requireAgentSession, enforceAgentGate } from "@/lib/agent";
import { verifyAgentPinOrThrow } from "@/lib/agent-pin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Hard ceilings — must match lib/skills/set-limit.ts (single source of truth)
const MAX_PER_TX  = 500;
const MAX_DAILY   = 1_000;
const MAX_WEEKLY  = 2_000;
const MAX_MONTHLY = 5_000;

export async function POST(req: Request) {
  let agentSession: Awaited<ReturnType<typeof requireAgentSession>>;
  try {
    agentSession = await requireAgentSession();
    await enforceAgentGate(agentSession.supabaseUserId);
  } catch (res) {
    return res as Response;
  }

  const { supabaseUserId } = agentSession;

  let body: {
    pin?: unknown;
    maxPerTransaction?: unknown;
    maxDaily?: unknown;
    maxWeekly?: unknown;
    maxMonthly?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const pin = String(body.pin ?? "");

  const supabase = await createSupabaseServerClient();

  // ── Verify PIN (shared helper: tracks attempts + enforces lockout) ──
  try {
    await verifyAgentPinOrThrow({ supabase, userId: supabaseUserId, pin });
  } catch (res) {
    return res as Response;
  }

  // ── Validate and clamp new limits ────────────────────────────────
  const updates: Record<string, number> = {};

  if (body.maxPerTransaction !== undefined) {
    const v = Number(body.maxPerTransaction);
    if (isNaN(v) || v <= 0) return NextResponse.json({ error: "Invalid maxPerTransaction" }, { status: 400 });
    updates.max_per_transaction_usdc = Math.min(v, MAX_PER_TX);
  }
  if (body.maxDaily !== undefined) {
    const v = Number(body.maxDaily);
    if (isNaN(v) || v <= 0) return NextResponse.json({ error: "Invalid maxDaily" }, { status: 400 });
    updates.max_daily_usdc = Math.min(v, MAX_DAILY);
  }
  if (body.maxWeekly !== undefined) {
    const v = Number(body.maxWeekly);
    if (isNaN(v) || v <= 0) return NextResponse.json({ error: "Invalid maxWeekly" }, { status: 400 });
    updates.max_weekly_usdc = Math.min(v, MAX_WEEKLY);
  }
  if (body.maxMonthly !== undefined) {
    const v = Number(body.maxMonthly);
    if (isNaN(v) || v <= 0) return NextResponse.json({ error: "Invalid maxMonthly" }, { status: 400 });
    updates.max_monthly_usdc = Math.min(v, MAX_MONTHLY);
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No limits provided to update" }, { status: 400 });
  }

  const { error } = await supabase
    .from("user_spend_limits")
    .upsert({ user_id: supabaseUserId, ...updates }, { onConflict: "user_id" });

  if (error) {
    console.error("[agent/set-limits] DB error:", error);
    return NextResponse.json({ error: "Failed to update limits" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, applied: updates });
}
