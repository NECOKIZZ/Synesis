/**
 * POST /api/agent/activate-solana
 *
 * Provisions the agent's Solana (SOL-DEVNET) Circle wallet — a SEPARATE base58
 * address from the EVM agent wallet. Inserts an agent_wallets row tagged
 * blockchain='SOL-DEVNET'. Idempotent: returns the existing Solana wallet if
 * already activated. Requires the EVM agent wallet to exist first.
 *
 * Reminder: Solana fees are paid in native SOL, not USDC. After activation the
 * returned address must be funded with devnet SOL before any Solana skill can
 * sign (see lib/solana/fees.ts assertSolForFees). See SOLANA_INTEGRATION_PLAN.md.
 *
 * Security: requireAgentSession → Synesis JWT + Supabase ownership.
 */

import { NextResponse } from "next/server";
import { requireAgentSession, enforceAgentGate, createAgentWalletInCircle } from "@/lib/agent";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PublicKey } from "@solana/web3.js";

export const runtime = "nodejs";

export async function POST() {
  let agentSession: Awaited<ReturnType<typeof requireAgentSession>>;
  try {
    agentSession = await requireAgentSession();
    await enforceAgentGate(agentSession.supabaseUserId);
  } catch (res) {
    return res as Response;
  }

  const { supabaseUserId } = agentSession;
  const supabase = await createSupabaseServerClient();

  // ── Idempotency: return early if the Solana wallet already exists ──
  const { data: existing } = await supabase
    .from("agent_wallets")
    .select("id, circle_wallet_id, circle_wallet_address, blockchain")
    .eq("user_id", supabaseUserId)
    .eq("blockchain", "SOL-DEVNET")
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ alreadyActivated: true, agentWallet: existing });
  }

  // ── Require the EVM agent wallet first (activation prerequisite) ──
  const { data: evmWallet } = await supabase
    .from("agent_wallets")
    .select("id")
    .eq("user_id", supabaseUserId)
    .eq("blockchain", "ARC-TESTNET")
    .maybeSingle();

  if (!evmWallet) {
    return NextResponse.json(
      { error: "Activate your agent wallet first, then enable Solana." },
      { status: 409 },
    );
  }

  // ── Create the Circle Solana dev-controlled wallet ────────────────
  let walletId: string;
  let walletAddress: string;
  try {
    const result = await createAgentWalletInCircle("SOL-DEVNET");
    walletId = result.walletId;
    walletAddress = result.address;
  } catch (err) {
    console.error("[agent/activate-solana] createAgentWalletInCircle failed:", err);
    return NextResponse.json(
      { error: "Failed to create Solana agent wallet. Check CIRCLE_AGENT_WALLET_SET_ID." },
      { status: 502 },
    );
  }

  // Validate it's a real base58 Solana address (not an EVM 0x address).
  try {
    // Throws if not a valid base58 ed25519 pubkey.
    // eslint-disable-next-line no-new
    new PublicKey(walletAddress);
  } catch {
    return NextResponse.json(
      { error: "Circle returned an invalid Solana wallet address" },
      { status: 502 },
    );
  }

  // ── Persist the Solana agent wallet row ───────────────────────────
  const { data: inserted, error: insertErr } = await supabase
    .from("agent_wallets")
    .insert({
      user_id: supabaseUserId,
      blockchain: "SOL-DEVNET",
      circle_wallet_id: walletId,
      circle_wallet_address: walletAddress,
    })
    .select("id, circle_wallet_id, circle_wallet_address, blockchain")
    .single();

  if (insertErr) {
    console.error("[agent/activate-solana] DB insert failed:", insertErr);
    return NextResponse.json({ error: "Failed to persist Solana agent wallet" }, { status: 500 });
  }

  return NextResponse.json(
    {
      alreadyActivated: false,
      agentWallet: inserted,
      note: "Fund this address with devnet SOL (for fees) and devnet USDC before sending.",
    },
    { status: 201 },
  );
}
