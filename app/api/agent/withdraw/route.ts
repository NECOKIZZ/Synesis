/**
 * POST /api/agent/withdraw
 *
 * Move USDC from the agent wallet back to the user's main wallet.
 * Requires agent PIN. Executes synchronously via the Circle dev-controlled API.
 *
 * Body: { pin: string, amount: number | "all" }
 */

import { NextResponse } from "next/server";
import { requireAgentSession, executeAgentSendUsdc, getAgentBalance } from "@/lib/agent";
import { verifyAgentPinOrThrow } from "@/lib/agent-pin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { isAddress } from "ethers";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let agentSession: Awaited<ReturnType<typeof requireAgentSession>>;
  try {
    agentSession = await requireAgentSession();
  } catch (res) {
    return res as Response;
  }

  const { session, supabaseUserId } = agentSession;

  let pin: string, rawAmount: unknown;
  try {
    const body = await req.json();
    pin = String(body.pin ?? "");
    rawAmount = body.amount;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!pin) {
    return NextResponse.json({ error: "pin is required" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();

  // ── Verify PIN (shared helper: tracks attempts + enforces lockout) ──
  try {
    await verifyAgentPinOrThrow({ supabase, userId: supabaseUserId, pin });
  } catch (res) {
    return res as Response;
  }

  // ── Get agent wallet (Layer 2: must belong to this user) ──────────
  const { data: agentWallet } = await supabase
    .from("agent_wallets")
    .select("circle_wallet_id, circle_wallet_address")
    .eq("user_id", supabaseUserId)
    .maybeSingle();

  if (!agentWallet) {
    return NextResponse.json({ error: "Agent wallet not activated" }, { status: 400 });
  }

  // ── Resolve amount ────────────────────────────────────────────────
  let amountUsdc: number;
  if (rawAmount === "all") {
    const balance = await getAgentBalance(agentWallet.circle_wallet_id);
    amountUsdc = parseFloat(balance);
    if (amountUsdc <= 0) {
      return NextResponse.json({ error: "Agent wallet has no balance to withdraw" }, { status: 400 });
    }
    // Leave a tiny buffer to cover any rounding in Circle
    amountUsdc = Math.floor(amountUsdc * 1_000_000) / 1_000_000;
  } else {
    amountUsdc = Number(rawAmount);
    if (isNaN(amountUsdc) || amountUsdc <= 0) {
      return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
    }
  }

  // Destination: the user's main wallet address (from their verified session)
  const mainWalletAddress = session.walletAddress;
  if (!isAddress(mainWalletAddress)) {
    return NextResponse.json({ error: "Invalid main wallet address in session" }, { status: 500 });
  }

  // ── Log PENDING (user client — INSERT RLS allows own rows) ────────
  const { data: logRow } = await supabase
    .from("agent_spend_log")
    .insert({
      user_id: supabaseUserId,
      skill: "WITHDRAW",
      recipient_address: mainWalletAddress,
      amount_usdc: amountUsdc,
      status: "PENDING",
    })
    .select("id")
    .single();

  // Service role for status updates: agent_spend_log has no UPDATE RLS,
  // so updates from the user client silently no-op.
  const serviceSupabase = createSupabaseServiceClient();

  // ── Execute ───────────────────────────────────────────────────────
  let txHash: string;
  let circleTxId: string;
  try {
    const result = await executeAgentSendUsdc({
      agentWalletId: agentWallet.circle_wallet_id,
      recipientAddress: mainWalletAddress,
      amountDecimal: amountUsdc.toFixed(6),
    });
    txHash = result.txHash;
    circleTxId = result.circleTxId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Withdrawal failed";
    if (logRow?.id) {
      await serviceSupabase
        .from("agent_spend_log")
        .update({ status: "FAILED", error_message: msg })
        .eq("id", logRow.id);
    }
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  // ── Update log ────────────────────────────────────────────────────
  if (logRow?.id) {
    await serviceSupabase
      .from("agent_spend_log")
      .update({ status: "COMPLETE", tx_hash: txHash, circle_tx_id: circleTxId })
      .eq("id", logRow.id);
  }

  return NextResponse.json({ ok: true, txHash, amountUsdc, mainWalletAddress });
}
