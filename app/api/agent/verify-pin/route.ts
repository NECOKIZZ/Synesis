/**
 * POST /api/agent/verify-pin
 *
 * Verify the agent PIN without executing any action.  Used by the frontend
 * confirmation card to gate policy execution.
 *
 * Body: { pin: string }
 *
 * Lockout: 3 wrong attempts → 15 min lockout; 5 → 60 min.
 *
 * Returns: { valid: boolean, locked: boolean, lockedUntil?: string }
 */

import { NextResponse } from "next/server";
import { requireAgentSession, verifyPin } from "@/lib/agent";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const LOCKOUT_AFTER_3 = 15 * 60 * 1000;  // ms
const LOCKOUT_AFTER_5 = 60 * 60 * 1000;  // ms

export async function POST(req: Request) {
  let agentSession: Awaited<ReturnType<typeof requireAgentSession>>;
  try {
    agentSession = await requireAgentSession();
  } catch (res) {
    return res as Response;
  }

  const { supabaseUserId } = agentSession;

  let pin: string;
  try {
    const body = await req.json();
    pin = String(body.pin ?? "");
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();

  // ── Read security row ─────────────────────────────────────────────
  const { data: sec } = await supabase
    .from("user_security")
    .select("agent_pin_hash, pin_attempts, pin_locked_until")
    .eq("user_id", supabaseUserId)
    .maybeSingle();

  if (!sec?.agent_pin_hash) {
    return NextResponse.json({ error: "PIN not set. Call /api/agent/set-pin first." }, { status: 400 });
  }

  // ── Check lockout ─────────────────────────────────────────────────
  if (sec.pin_locked_until) {
    const lockedUntil = new Date(sec.pin_locked_until);
    if (lockedUntil > new Date()) {
      return NextResponse.json(
        { valid: false, locked: true, lockedUntil: lockedUntil.toISOString() },
        { status: 429 }
      );
    }
  }

  // ── Verify ────────────────────────────────────────────────────────
  const valid = await verifyPin(pin, sec.agent_pin_hash);

  if (valid) {
    // Reset attempt counter on success
    await supabase
      .from("user_security")
      .update({ pin_attempts: 0, pin_locked_until: null })
      .eq("user_id", supabaseUserId);

    return NextResponse.json({ valid: true, locked: false });
  }

  // ── Increment attempt counter + apply lockout ─────────────────────
  const attempts = (sec.pin_attempts ?? 0) + 1;
  let lockedUntil: Date | null = null;

  if (attempts >= 5) {
    lockedUntil = new Date(Date.now() + LOCKOUT_AFTER_5);
  } else if (attempts >= 3) {
    lockedUntil = new Date(Date.now() + LOCKOUT_AFTER_3);
  }

  await supabase
    .from("user_security")
    .update({
      pin_attempts: attempts,
      pin_locked_until: lockedUntil?.toISOString() ?? null,
    })
    .eq("user_id", supabaseUserId);

  return NextResponse.json({
    valid: false,
    locked: lockedUntil !== null,
    lockedUntil: lockedUntil?.toISOString(),
    attemptsRemaining: Math.max(0, 5 - attempts),
  });
}
