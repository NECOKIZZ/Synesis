/**
 * POST /api/agent/activate
 *
 * Creates a Circle developer-controlled agent wallet for the current user,
 * inserts the agent_wallets row, seeds default spend limits, and optionally
 * registers an .arc name for the agent.
 *
 * Body: { arcNameLabel?: string }  — e.g. "alice-agent" (no .arc suffix). Omit to skip.
 *
 * Security:
 *  - requireAgentSession → Layer 1 (Synesis JWT) + Layer 2 (Supabase ownership)
 *  - Idempotent: returns existing wallet if already activated
 */

import { NextResponse } from "next/server";
import { requireAgentSession, enforceAgentGate, createAgentWalletInCircle } from "@/lib/agent";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { treasuryRegisterName } from "@/lib/circle";
import { isAddress } from "ethers";

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
  const supabase = await createSupabaseServerClient();

  // ── Idempotency: return early if already activated ────────────────
  // Scoped to the EVM (ARC-TESTNET) wallet — a user may now also hold a
  // separate SOL-DEVNET row, so an unscoped maybeSingle() would throw.
  const { data: existing } = await supabase
    .from("agent_wallets")
    .select("id, circle_wallet_id, circle_wallet_address, arc_name, active")
    .eq("user_id", supabaseUserId)
    .eq("blockchain", "ARC-TESTNET")
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ alreadyActivated: true, agentWallet: existing });
  }

  // ── Parse optional arc name ───────────────────────────────────────
  let arcNameLabel: string | null = null;
  try {
    const body = await req.json();
    if (typeof body.arcNameLabel === "string" && body.arcNameLabel.trim()) {
      arcNameLabel = body.arcNameLabel.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
    }
  } catch {
    // no body is fine
  }

  // ── Create Circle dev-controlled wallet ───────────────────────────
  let walletId: string;
  let walletAddress: string;
  try {
    const result = await createAgentWalletInCircle();
    walletId = result.walletId;
    walletAddress = result.address;
  } catch (err) {
    console.error("[agent/activate] createAgentWalletInCircle failed:", err);
    return NextResponse.json(
      { error: "Failed to create agent wallet. Check CIRCLE_AGENT_WALLET_SET_ID." },
      { status: 502 }
    );
  }

  if (!isAddress(walletAddress)) {
    return NextResponse.json({ error: "Circle returned invalid agent wallet address" }, { status: 502 });
  }

  // ── Optional .arc name registration ──────────────────────────────
  let arcNameTx: string | null = null;
  if (arcNameLabel) {
    try {
      const regResult = await treasuryRegisterName(arcNameLabel, walletAddress);
      arcNameTx = regResult.txHash;
    } catch (err) {
      console.warn("[agent/activate] agent name registration failed (non-fatal):", err);
      arcNameLabel = null; // don't persist a name we couldn't register
    }
  }

  // ── Persist agent wallet row ──────────────────────────────────────
  const { data: inserted, error: insertErr } = await supabase
    .from("agent_wallets")
    .insert({
      user_id: supabaseUserId,
      blockchain: "ARC-TESTNET",
      circle_wallet_id: walletId,
      circle_wallet_address: walletAddress,
      arc_name: arcNameLabel,
      arc_name_tx: arcNameTx,
    })
    .select("id, circle_wallet_id, circle_wallet_address, arc_name")
    .single();

  if (insertErr) {
    console.error("[agent/activate] DB insert failed:", insertErr);
    return NextResponse.json({ error: "Failed to persist agent wallet" }, { status: 500 });
  }

  // ── Seed default spend limits ─────────────────────────────────────
  await supabase.from("user_spend_limits").upsert(
    { user_id: supabaseUserId },
    { onConflict: "user_id", ignoreDuplicates: true }
  );

  // ── Seed user_security row (PIN not set yet) ──────────────────────
  await supabase.from("user_security").upsert(
    { user_id: supabaseUserId },
    { onConflict: "user_id", ignoreDuplicates: true }
  );

  return NextResponse.json({ alreadyActivated: false, agentWallet: inserted }, { status: 201 });
}
