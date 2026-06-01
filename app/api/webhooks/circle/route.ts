/**
 * POST /api/webhooks/circle
 *
 * Receiver for Circle transaction notifications. Handles activity for BOTH
 * the user-controlled main wallet (`profiles.wallet_address`) and the
 * developer-controlled agent wallet (`agent_wallets.circle_wallet_address`).
 *
 * On a confirmed event:
 *   1. Identify the user + which wallet (main vs agent) the tx involves.
 *   2. Insert or update a row in `agent_spend_log` tagged with `wallet_type`.
 *   3. Refresh the cached USDC balance (`profiles.balance_cache_usdc` or
 *      `agent_wallets.balance_cache_usdc`) by re-reading on-chain.
 *
 * Idempotency: every Circle notification has a unique `notification.id`
 * we record as `circle_tx_id` AND `idempotency_key`. Re-deliveries are
 * silently no-ops via the unique partial index from migration 0007.
 *
 * Auth: Circle signs every notification with ECDSA. Each request carries:
 *   X-Circle-Key-Id     — UUID of the signing key
 *   X-Circle-Signature  — base64 ECDSA-SHA256 signature over the raw body
 * We fetch the public key from Circle's API (cached in-process) and verify
 * using node's crypto module. No shared secret is involved.
 *
 *   POST   https://wallet.dotarc.my/api/webhooks/circle
 *   HEAD   https://wallet.dotarc.my/api/webhooks/circle   (Circle health check)
 */

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { readUsdcBalanceWei } from "@/lib/circle";
import { formatUnits } from "ethers";

export const runtime = "nodejs";

const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY;
const CIRCLE_API_BASE = process.env.CIRCLE_API_BASE ?? "https://api.circle.com";
const USDC_ADDRESS =
  process.env.NEXT_PUBLIC_USDC_TOKEN_ADDRESS ||
  "0x3600000000000000000000000000000000000000";

// USDC has 6 decimals on Arc.
const USDC_DECIMALS = 6;

// ── Types ────────────────────────────────────────────────────────────

type CircleTxState =
  | "INITIATED"
  | "PENDING_RISK_SCREENING"
  | "QUEUED"
  | "SENT"
  | "CONFIRMED"
  | "COMPLETE"
  | "DENIED"
  | "FAILED"
  | "CANCELLED";

interface CircleNotification {
  id: string;
  state: CircleTxState;
  txHash?: string | null;
  amounts?: string[];
  destinationAddress?: string;
  sourceAddress?: string;
  walletId?: string;
  userId?: string;
  blockchain?: string;
}

interface CircleWebhookPayload {
  subscriptionId?: string;
  notificationId?: string;
  notificationType?: string;
  notification?: CircleNotification;
}

type WalletKind = "main" | "agent";

interface MatchedWallet {
  userId: string;
  walletKind: WalletKind;
  walletAddress: string; // canonical lower-case form
}

type SupabaseService = ReturnType<typeof createSupabaseServiceClient>;

// ── Signature verification ───────────────────────────────────────────

/**
 * In-process cache of Circle's signing public keys, keyed by `keyId`.
 * Keys are stable per `keyId`, so once fetched we never need to refetch
 * until the lambda instance recycles. Saves a round-trip per webhook.
 */
const publicKeyCache = new Map<string, crypto.KeyObject>();

async function fetchCirclePublicKey(keyId: string): Promise<crypto.KeyObject | null> {
  const cached = publicKeyCache.get(keyId);
  if (cached) return cached;
  if (!CIRCLE_API_KEY) {
    console.error("[webhooks/circle] CIRCLE_API_KEY missing — cannot fetch public key");
    return null;
  }

  const res = await fetch(`${CIRCLE_API_BASE}/v2/notifications/publicKey/${keyId}`, {
    headers: {
      authorization: `Bearer ${CIRCLE_API_KEY}`,
      accept: "application/json",
    },
  });
  if (!res.ok) {
    console.error("[webhooks/circle] public key fetch failed:", res.status, await res.text());
    return null;
  }

  const json = (await res.json()) as {
    data?: { publicKey?: string; algorithm?: string };
  };
  const b64 = json.data?.publicKey;
  if (!b64) return null;

  const keyObj = crypto.createPublicKey({
    key: Buffer.from(b64, "base64"),
    format: "der",
    type: "spki",
  });
  publicKeyCache.set(keyId, keyObj);
  return keyObj;
}

/**
 * Verify the ECDSA-SHA256 signature on a raw webhook body.
 * Returns true if the signature is valid, false otherwise.
 */
async function verifyCircleSignature(
  rawBody: string,
  keyId: string,
  signatureB64: string
): Promise<boolean> {
  const publicKey = await fetchCirclePublicKey(keyId);
  if (!publicKey) return false;
  try {
    return crypto.verify(
      "sha256",
      Buffer.from(rawBody, "utf8"),
      publicKey,
      Buffer.from(signatureB64, "base64")
    );
  } catch (err) {
    console.error("[webhooks/circle] signature verify threw:", err);
    return false;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Look up which user (and which of their wallets — main vs agent) owns
 * the given on-chain address. Returns null if neither table has it.
 *
 * Addresses are normalized to lower-case because Circle's payloads aren't
 * consistent about address casing across event types.
 */
async function findWalletOwner(
  supabase: SupabaseService,
  address: string | undefined
): Promise<MatchedWallet | null> {
  if (!address) return null;
  const lower = address.toLowerCase();

  // Main wallet first — that's the common case.
  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .ilike("wallet_address", lower)
    .maybeSingle();
  if (profile?.id) {
    return { userId: profile.id, walletKind: "main", walletAddress: lower };
  }

  // Agent wallet fallback.
  const { data: agent } = await supabase
    .from("agent_wallets")
    .select("user_id")
    .ilike("circle_wallet_address", lower)
    .maybeSingle();
  if (agent?.user_id) {
    return { userId: agent.user_id, walletKind: "agent", walletAddress: lower };
  }

  return null;
}

/**
 * Re-fetch the wallet's USDC balance from Arc and write it to the cache
 * column on the corresponding row. Best-effort — RPC failures here don't
 * abort the webhook (the row insert was the important part).
 */
async function refreshBalanceCache(
  supabase: SupabaseService,
  match: MatchedWallet
): Promise<void> {
  try {
    const raw = await readUsdcBalanceWei(match.walletAddress, USDC_ADDRESS);
    const formatted = formatUnits(raw, USDC_DECIMALS);

    const patch = {
      balance_cache_usdc: formatted,
      balance_cache_at: new Date().toISOString(),
    };

    if (match.walletKind === "main") {
      await supabase.from("profiles").update(patch).eq("id", match.userId);
    } else {
      await supabase
        .from("agent_wallets")
        .update(patch)
        .eq("user_id", match.userId);
    }
  } catch (err) {
    // Don't block the webhook ack on a flaky RPC call — the next webhook
    // (or a manual UI fetch) will re-cache.
    console.error("[webhooks/circle] balance cache refresh failed:", err);
  }
}

/**
 * Map Circle's tx state onto our `agent_spend_log.status` vocabulary.
 */
function statusFromState(state: CircleTxState): "PENDING" | "COMPLETE" | "FAILED" {
  // Circle uses both CONFIRMED and COMPLETE as terminal-success in different
  // wallet flavours; treat both as our COMPLETE status.
  if (state === "CONFIRMED" || state === "COMPLETE") return "COMPLETE";
  if (state === "FAILED" || state === "CANCELLED" || state === "DENIED") return "FAILED";
  return "PENDING";
}

/** True when Circle's state means the on-chain tx settled successfully. */
function isTerminalSuccess(state: CircleTxState): boolean {
  return state === "CONFIRMED" || state === "COMPLETE";
}

/**
 * Insert (or update) the spend-log row for an outbound transfer.
 *
 * Matching strategy:
 *   1. By `circle_tx_id` — most reliable. Only hits on webhook re-delivery
 *      or if the row was created with the notification id ahead of time.
 *   2. Most recent PENDING row on the same user+wallet without a
 *      `circle_tx_id` yet — for sends initiated from our UI (skill code
 *      or send-modal) where we wrote a PENDING row at submit time.
 *   3. Insert a fresh row — for sends initiated outside the app (e.g.
 *      directly via Circle's API).
 */
async function recordOutbound(args: {
  supabase: SupabaseService;
  match: MatchedWallet;
  state: CircleTxState;
  notificationId: string;
  txHash: string | null;
  counterpartyAddress: string | null;
  amountUsdc: number;
}): Promise<void> {
  const { supabase, match, state, notificationId, txHash, counterpartyAddress, amountUsdc } = args;
  const status = statusFromState(state);

  // 1. Try by Circle tx id (idempotent re-delivery).
  const { data: byCircleId } = await supabase
    .from("agent_spend_log")
    .select("id")
    .eq("circle_tx_id", notificationId)
    .maybeSingle();

  if (byCircleId?.id) {
    await supabase
      .from("agent_spend_log")
      .update({ status, tx_hash: txHash })
      .eq("id", byCircleId.id);
    return;
  }

  // 2. Try to find a recent PENDING row this webhook is the resolution for.
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: candidates } = await supabase
    .from("agent_spend_log")
    .select("id")
    .eq("user_id", match.userId)
    .eq("wallet_type", match.walletKind)
    .eq("status", "PENDING")
    .is("circle_tx_id", null)
    .gte("executed_at", tenMinAgo)
    .order("executed_at", { ascending: false })
    .limit(1);

  if (candidates && candidates.length > 0) {
    await supabase
      .from("agent_spend_log")
      .update({
        status,
        tx_hash: txHash,
        circle_tx_id: notificationId,
        idempotency_key: notificationId,
      })
      .eq("id", candidates[0].id);
    return;
  }

  // 3. Last resort: insert a brand-new row. Only do this for terminal
  // states — we don't want to litter the log with an INITIATED row that
  // we'd then have to chase down later.
  if (status !== "PENDING") {
    await supabase.from("agent_spend_log").insert({
      user_id: match.userId,
      wallet_type: match.walletKind,
      skill: match.walletKind === "agent" ? "AGENT_SEND" : "SEND_USDC",
      recipient_address: counterpartyAddress,
      amount_usdc: amountUsdc,
      tx_hash: txHash,
      circle_tx_id: notificationId,
      idempotency_key: notificationId,
      status,
    });
  }
}

/**
 * Insert a RECEIVE row for a confirmed inbound transfer. The unique
 * partial index on `idempotency_key` guarantees a redelivered webhook
 * won't double-insert.
 */
async function recordInbound(args: {
  supabase: SupabaseService;
  match: MatchedWallet;
  notificationId: string;
  txHash: string | null;
  senderAddress: string | null;
  amountUsdc: number;
}): Promise<void> {
  const { supabase, match, notificationId, txHash, senderAddress, amountUsdc } = args;

  const { error } = await supabase.from("agent_spend_log").insert({
    user_id: match.userId,
    wallet_type: match.walletKind,
    skill: "RECEIVE",
    recipient_address: senderAddress, // for inbound, this slot holds the SENDER
    amount_usdc: amountUsdc,
    tx_hash: txHash,
    circle_tx_id: notificationId,
    idempotency_key: notificationId,
    status: "COMPLETE",
  });

  // Postgres unique_violation = 23505. Re-deliveries hit this and that's fine.
  if (error && error.code !== "23505") {
    console.error("[webhooks/circle] inbound insert failed:", error);
  }
}

// ── Handler ──────────────────────────────────────────────────────────

/**
 * Circle pings the endpoint with HEAD requests as a reachability check
 * when you register / re-enable the webhook. Just 200 it.
 */
export async function HEAD() {
  return new Response(null, { status: 200 });
}

export async function POST(req: Request) {
  // 1. Read the raw body BEFORE parsing — signature verification needs
  // the exact bytes Circle signed, not a re-serialized JSON.
  const rawBody = await req.text();

  // 2. Verify the ECDSA signature using Circle's public key (cached).
  // Skip only if we explicitly disabled it for local dev — never in prod.
  const keyId = req.headers.get("x-circle-key-id");
  const signature = req.headers.get("x-circle-signature");
  const skipVerify = process.env.CIRCLE_WEBHOOK_SKIP_VERIFY === "true";

  if (!skipVerify) {
    if (!keyId || !signature) {
      return NextResponse.json(
        { error: "Missing signature headers" },
        { status: 401 }
      );
    }
    const valid = await verifyCircleSignature(rawBody, keyId, signature);
    if (!valid) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  } else {
    console.warn("[webhooks/circle] CIRCLE_WEBHOOK_SKIP_VERIFY=true — signature check disabled");
  }

  // 3. Parse body. Circle always sends JSON.
  let payload: CircleWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as CircleWebhookPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { notificationType, notification } = payload;
  if (!notification) {
    // Ack unknown shapes so Circle doesn't retry. Logging makes it easy
    // to add a new handler if Circle starts sending a new event type.
    console.log("[webhooks/circle] unhandled payload shape:", notificationType);
    return NextResponse.json({ ok: true });
  }

  const state = notification.state;
  const txHash = notification.txHash ?? null;
  const amountStr = notification.amounts?.[0];
  const amountUsdc = amountStr ? parseFloat(amountStr) : null;
  const supabase = createSupabaseServiceClient();

  // 3. Classify event. Circle uses a few different `notificationType`
  // strings depending on the wallet flavour — accept anything that
  // contains "inbound" / "outbound" / "transactions". The state field
  // is the actual source of truth.
  const isInbound =
    notificationType === "transactions.inbound" ||
    !!notificationType?.toLowerCase().includes("inbound");
  const isOutbound =
    notificationType === "transactions.outbound" ||
    notificationType === "transactions.state" ||
    !!notificationType?.toLowerCase().includes("outbound");

  // 4. INBOUND confirmed: user (or their agent) received USDC.
  if (
    isInbound &&
    isTerminalSuccess(state) &&
    notification.destinationAddress &&
    amountUsdc !== null
  ) {
    const match = await findWalletOwner(supabase, notification.destinationAddress);
    if (match) {
      await recordInbound({
        supabase,
        match,
        notificationId: notification.id,
        txHash,
        senderAddress: notification.sourceAddress ?? null,
        amountUsdc,
      });
      await refreshBalanceCache(supabase, match);
    }
    return NextResponse.json({ ok: true });
  }

  // 5. OUTBOUND state change: confirm or fail an in-flight send.
  if (
    isOutbound &&
    (isTerminalSuccess(state) || state === "FAILED" || state === "CANCELLED" || state === "DENIED") &&
    notification.sourceAddress &&
    amountUsdc !== null
  ) {
    const match = await findWalletOwner(supabase, notification.sourceAddress);
    if (match) {
      await recordOutbound({
        supabase,
        match,
        state,
        notificationId: notification.id,
        txHash,
        counterpartyAddress: notification.destinationAddress?.toLowerCase() ?? null,
        amountUsdc,
      });
      // Only refresh cache on terminal states — PENDING webhooks would
      // pull a stale on-chain value and overwrite the cache for nothing.
      if (isTerminalSuccess(state) || state === "FAILED") {
        await refreshBalanceCache(supabase, match);
      }
    }
    return NextResponse.json({ ok: true });
  }

  // 6. Anything else — ack so Circle stops retrying, but log for triage.
  console.log("[webhooks/circle] event ignored:", notificationType, state);
  return NextResponse.json({ ok: true });
}
