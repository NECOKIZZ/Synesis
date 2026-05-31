/**
 * POST /api/agent/set-pin
 *
 * Hash and store the user's agent PIN.  The PIN is separate from the main
 * wallet PIN (which belongs to Circle).  We use Node crypto scrypt.
 *
 * Body: { pin: string }  — 4-8 digits
 *
 * Security: requireAgentSession + agent wallet ownership check
 */

import { NextResponse } from "next/server";
import { requireAgentSession, enforceAgentGate, hashPin } from "@/lib/agent";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let agentSession: Awaited<ReturnType<typeof requireAgentSession>>;
  try {
    agentSession = await requireAgentSession();
    await enforceAgentGate(agentSession.supabaseUserId);
  } catch (res) {
    return res as Response;
  }

  const { supabaseUserId } = agentSession;

  // ── Validate PIN format ───────────────────────────────────────────
  let pin: string;
  try {
    const body = await req.json();
    pin = String(body.pin ?? "");
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!/^\d{4,8}$/.test(pin)) {
    return NextResponse.json(
      { error: "PIN must be 4–8 digits" },
      { status: 400 }
    );
  }

  // ── Confirm agent wallet exists for this user ─────────────────────
  const supabase = await createSupabaseServerClient();
  const { data: wallet } = await supabase
    .from("agent_wallets")
    .select("id")
    .eq("user_id", supabaseUserId)
    .maybeSingle();

  if (!wallet) {
    return NextResponse.json(
      { error: "Agent wallet not activated. Call /api/agent/activate first." },
      { status: 400 }
    );
  }

  // ── Hash and store ────────────────────────────────────────────────
  const pinHash = await hashPin(pin);

  const { error } = await supabase
    .from("user_security")
    .upsert(
      { user_id: supabaseUserId, agent_pin_hash: pinHash, pin_attempts: 0, pin_locked_until: null },
      { onConflict: "user_id" }
    );

  if (error) {
    console.error("[agent/set-pin] DB upsert failed:", error);
    return NextResponse.json({ error: "Failed to store PIN" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
