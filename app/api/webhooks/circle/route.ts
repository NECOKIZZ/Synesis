/**
 * POST /api/webhooks/circle
 *
 * Receives Circle transaction notifications and writes them to agent_spend_log:
 *   - INBOUND confirmed  → RECEIVE row (user received USDC)
 *   - OUTBOUND confirmed → update existing PENDING SEND row with txHash + COMPLETE
 *   - OUTBOUND failed    → update existing PENDING SEND row with FAILED
 *
 * Security: verified via CIRCLE_WEBHOOK_SECRET bearer token.
 * Configure the webhook URL in Circle dashboard as:
 *   https://wallet.dotarc.app/api/webhooks/circle
 * and set the "Authorization" header secret to match CIRCLE_WEBHOOK_SECRET.
 *
 * Circle notification payload shape (user-controlled wallets):
 * {
 *   subscriptionId, notificationId, notificationType,
 *   notification: {
 *     id, state, txHash, amounts, blockchain,
 *     walletId, userId,
 *     destinationAddress, sourceAddress
 *   }
 * }
 */

import { NextResponse } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const WEBHOOK_SECRET = process.env.CIRCLE_WEBHOOK_SECRET;

type CircleTxState = "INITIATED" | "PENDING_RISK_SCREENING" | "DENIED" | "CONFIRMED" | "FAILED" | "CANCELLED";

interface CircleNotification {
  id: string;
  state: CircleTxState;
  txHash?: string | null;
  amounts?: string[];
  destinationAddress?: string;
  sourceAddress?: string;
  walletId?: string;
  userId?: string;
}

interface CircleWebhookPayload {
  subscriptionId?: string;
  notificationId?: string;
  notificationType?: string;
  notification?: CircleNotification;
}

export async function POST(req: Request) {
  // ── Auth: Bearer token ──────────────────────────────────────────────
  if (WEBHOOK_SECRET) {
    const authHeader = req.headers.get("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (token !== WEBHOOK_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let payload: CircleWebhookPayload;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { notificationType, notification } = payload;
  if (!notification) return NextResponse.json({ ok: true }); // ack unknown shapes

  const state = notification.state;
  const txHash = notification.txHash ?? null;
  const amountStr = notification.amounts?.[0];
  const amountUsdc = amountStr ? parseFloat(amountStr) : null;

  const supabase = createSupabaseServiceClient();

  // ── INBOUND confirmed: user received USDC ───────────────────────────
  if (
    (notificationType === "transactions.inbound" || notificationType?.includes("inbound")) &&
    state === "CONFIRMED" &&
    notification.destinationAddress &&
    amountUsdc !== null
  ) {
    const destAddress = notification.destinationAddress.toLowerCase();

    // Look up the recipient by wallet_address in profiles
    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .ilike("wallet_address", destAddress)
      .maybeSingle();

    if (profile?.id) {
      await supabase.from("agent_spend_log").insert({
        user_id: profile.id,
        skill: "RECEIVE",
        recipient_address: notification.sourceAddress ?? null,
        amount_usdc: amountUsdc,
        tx_hash: txHash,
        circle_tx_id: notification.id,
        status: "COMPLETE",
      });
    }

    return NextResponse.json({ ok: true });
  }

  // ── OUTBOUND confirmed or failed: update the PENDING send row ────────
  if (
    (notificationType === "transactions.outbound" || notificationType?.includes("outbound") ||
     notificationType === "transactions.state") &&
    (state === "CONFIRMED" || state === "FAILED") &&
    notification.sourceAddress &&
    amountUsdc !== null
  ) {
    const srcAddress = notification.sourceAddress.toLowerCase();

    // Find the sender profile
    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .ilike("wallet_address", srcAddress)
      .maybeSingle();

    if (profile?.id) {
      const newStatus = state === "CONFIRMED" ? "COMPLETE" : "FAILED";
      const destAddress = notification.destinationAddress ?? null;

      // Match the most recent PENDING SEND row for this user + recipient within last 10 min
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { data: rows } = await supabase
        .from("agent_spend_log")
        .select("id")
        .eq("user_id", profile.id)
        .eq("status", "PENDING")
        .eq("skill", "SEND_USDC")
        .gte("executed_at", tenMinAgo)
        .order("executed_at", { ascending: false })
        .limit(1);

      if (rows && rows.length > 0) {
        await supabase
          .from("agent_spend_log")
          .update({
            status: newStatus,
            tx_hash: txHash,
            circle_tx_id: notification.id,
          })
          .eq("id", rows[0].id);
      } else if (state === "CONFIRMED" && destAddress) {
        // No PENDING row found (e.g. send initiated outside the app) — insert anyway
        await supabase.from("agent_spend_log").insert({
          user_id: profile.id,
          skill: "SEND_USDC",
          recipient_address: destAddress,
          amount_usdc: amountUsdc,
          tx_hash: txHash,
          circle_tx_id: notification.id,
          status: "COMPLETE",
        });
      }
    }

    return NextResponse.json({ ok: true });
  }

  // Ack all other event types
  return NextResponse.json({ ok: true });
}
