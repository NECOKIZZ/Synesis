/**
 * lib/agent-pin.ts
 *
 * Centralized agent-PIN verification with attempt tracking + lockout.
 *
 * Why this exists:
 *   Multiple routes used to inline PIN verification. Some incremented the
 *   `pin_attempts` counter on failure; some did not. That meant an attacker
 *   could brute-force through the weakest endpoint. This helper makes the
 *   policy uniform across every sensitive route.
 *
 * Policy:
 *   3 wrong attempts -> 15 min lockout
 *   5 wrong attempts -> 60 min lockout
 *   success -> reset counter
 *
 * Usage:
 *   try {
 *     await verifyAgentPinOrThrow({ supabase, userId, pin });
 *   } catch (res) {
 *     return res as Response;
 *   }
 */

import "server-only";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { verifyPin } from "@/lib/agent";

const LOCKOUT_AFTER_3 = 15 * 60 * 1000; // 15 min
const LOCKOUT_AFTER_5 = 60 * 60 * 1000; // 60 min

export async function verifyAgentPinOrThrow(args: {
  supabase: SupabaseClient;
  userId: string;
  pin: string;
}): Promise<void> {
  const { supabase, userId, pin } = args;

  if (!pin) {
    throw NextResponse.json({ error: "PIN is required" }, { status: 400 });
  }

  const { data: sec } = await supabase
    .from("user_security")
    .select("agent_pin_hash, pin_attempts, pin_locked_until")
    .eq("user_id", userId)
    .maybeSingle();

  if (!sec?.agent_pin_hash) {
    throw NextResponse.json({ error: "PIN not set" }, { status: 400 });
  }

  if (sec.pin_locked_until && new Date(sec.pin_locked_until) > new Date()) {
    throw NextResponse.json(
      { error: "PIN locked. Try again later.", lockedUntil: sec.pin_locked_until },
      { status: 429 }
    );
  }

  const valid = await verifyPin(pin, sec.agent_pin_hash);

  if (!valid) {
    const attempts = (sec.pin_attempts ?? 0) + 1;
    const lockedUntil =
      attempts >= 5 ? new Date(Date.now() + LOCKOUT_AFTER_5) :
      attempts >= 3 ? new Date(Date.now() + LOCKOUT_AFTER_3) :
      null;

    await supabase
      .from("user_security")
      .update({
        pin_attempts: attempts,
        pin_locked_until: lockedUntil?.toISOString() ?? null,
      })
      .eq("user_id", userId);

    throw NextResponse.json(
      {
        error: "Incorrect PIN",
        attemptsRemaining: Math.max(0, 5 - attempts),
        lockedUntil: lockedUntil?.toISOString() ?? null,
      },
      { status: 403 }
    );
  }

  // Success: reset counter
  await supabase
    .from("user_security")
    .update({ pin_attempts: 0, pin_locked_until: null })
    .eq("user_id", userId);
}
