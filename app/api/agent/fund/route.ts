/**
 * POST /api/agent/fund
 *
 * Prepare a USDC transfer from the user's main wallet to their agent wallet.
 * Returns a Circle challengeId — the frontend handles the PIN dialog, same
 * as a regular send.
 *
 * Body: { amount: string }  — decimal USDC, e.g. "25.00"
 */

import { NextResponse } from "next/server";
import { requireAgentSession, enforceAgentGate } from "@/lib/agent";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { prepareUserSendUsdc, readUsdcBalanceWei } from "@/lib/circle";
import { isAddress, formatUnits } from "ethers";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let agentSession: Awaited<ReturnType<typeof requireAgentSession>>;
  try {
    agentSession = await requireAgentSession();
    await enforceAgentGate(agentSession.supabaseUserId);
  } catch (res) {
    return res as Response;
  }

  const { session, supabaseUserId } = agentSession;

  let amount: string;
  try {
    const body = await req.json();
    amount = String(body.amount ?? "");
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const amountFloat = parseFloat(amount);
  if (isNaN(amountFloat) || amountFloat <= 0) {
    return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();

  // ── Get agent wallet address ──────────────────────────────────────
  const { data: agentWallet } = await supabase
    .from("agent_wallets")
    .select("circle_wallet_address")
    .eq("user_id", supabaseUserId)
    .maybeSingle();

  if (!agentWallet?.circle_wallet_address) {
    return NextResponse.json(
      { error: "Agent wallet not activated" },
      { status: 400 }
    );
  }

  if (!isAddress(agentWallet.circle_wallet_address)) {
    return NextResponse.json({ error: "Invalid agent wallet address" }, { status: 500 });
  }

  // ── Get main wallet ID from Circle ────────────────────────────────
  const { getUserWallet } = await import("@/lib/circle");
  const mainWallet = await getUserWallet(session.userId);
  if (!mainWallet) {
    return NextResponse.json({ error: "Main wallet not found" }, { status: 400 });
  }

  // ── Check main wallet balance ─────────────────────────────────────
  const usdcAddress = process.env.NEXT_PUBLIC_USDC_TOKEN_ADDRESS;
  if (!usdcAddress) {
    return NextResponse.json({ error: "USDC contract address not configured" }, { status: 500 });
  }

  const balanceWei = await readUsdcBalanceWei(session.walletAddress, usdcAddress);
  const balanceUsdc = parseFloat(formatUnits(balanceWei, 6));

  if (amountFloat > balanceUsdc) {
    return NextResponse.json(
      { error: `Insufficient balance. Main wallet has ${balanceUsdc.toFixed(2)} USDC.` },
      { status: 400 }
    );
  }

  // ── Prepare Circle send challenge (no signing here — browser does it) ──
  const result = await prepareUserSendUsdc({
    userId: session.userId,
    walletId: mainWallet.id,
    tokenContractAddress: usdcAddress,
    recipientAddress: agentWallet.circle_wallet_address,
    amountDecimal: amountFloat.toFixed(6),
  });

  return NextResponse.json({
    challengeId: result.challengeId,
    userToken: result.userToken,
    encryptionKey: result.encryptionKey,
    recipientAddress: agentWallet.circle_wallet_address,
    amountUsdc: amountFloat,
  });
}
