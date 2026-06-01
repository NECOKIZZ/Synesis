import { NextResponse } from "next/server";
import { isAddress, parseUnits } from "ethers";
import {
  circleConfigured,
  getUserWallet,
  prepareUserSendUsdc,
  readUsdcBalanceWei,
  resolveCircleUserId,
} from "@/lib/circle";
import { normalizeName, resolveName } from "@/lib/ans";
import { getVerifiedEmail, createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";

const USDC_DECIMALS = 6;
const USDC_ADDRESS =
  process.env.NEXT_PUBLIC_USDC_TOKEN_ADDRESS ||
  "0x3600000000000000000000000000000000000000";

// ── Helpers ─────────────────────────────────────────────────────────

function reject(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function isProbablyArcName(input: string): boolean {
  // Anything that's NOT a 0x address we treat as a name candidate.
  // Could be "maya", "maya.arc", "Maya.ARC", etc. — normalizeName handles all.
  return !input.startsWith("0x");
}

/**
 * Server-side recipient resolution. This is the trust anchor for the send.
 * Whatever this returns is what gets signed. The client cannot influence it.
 */
async function resolveRecipientStrict(
  raw: string
): Promise<
  | { ok: true; address: string; arcName: string | null }
  | { ok: false; reason: string }
> {
  const input = raw.trim();
  if (!input) return { ok: false, reason: "Recipient is required" };

  if (isProbablyArcName(input)) {
    const label = normalizeName(input);
    if (!/^[a-z0-9-]{3,32}$/.test(label)) {
      return { ok: false, reason: "Invalid .arc name format" };
    }
    const address = await resolveName(label);
    if (!address) {
      return { ok: false, reason: `${label}.arc does not resolve to a wallet` };
    }
    return { ok: true, address, arcName: `${label}.arc` };
  }

  if (!isAddress(input)) {
    return { ok: false, reason: "Invalid wallet address" };
  }
  return { ok: true, address: input, arcName: null };
}

/**
 * POST /api/circle/send-prepare
 *
 * Prepares a USDC transfer FROM the signed-in user's wallet TO a recipient.
 *
 * Returns a Circle `challengeId` + `userToken` + `encryptionKey` for the
 * browser SDK to execute (PIN dialog). We do NOT broadcast the transaction
 * here — only after the user signs via PIN does Circle submit it on-chain.
 *
 * ── SECURITY GATES (all must pass before we ask Circle to prepare a tx) ──
 *  1. Verified Supabase session present (email is verified)
 *  2. Valid dotarc JWT session present (user has completed Circle login)
 *  3. The Supabase email and JWT email match (no cross-account hijack)
 *  4. The wallet truly belongs to this userId per Circle's records
 *  5. Recipient resolves server-side (client cannot lie about the address)
 *  6. Amount > 0, valid decimal, ≤ on-chain balance
 *  7. Not a self-send
 *
 * If any check fails, we never reach the Circle SDK.
 */
export async function POST(req: Request) {
  if (!circleConfigured) {
    return reject("Circle integration not configured on this server.", 503);
  }

  // ── Gate 1+2: dual-auth (Supabase + dotarc session) ──────────────────
  const verifiedEmail = await getVerifiedEmail();
  if (!verifiedEmail) return reject("Email not verified. Sign in first.", 401);

  const session = await getSession();
  if (!session) return reject("No dotarc session. Sign in first.", 401);

  // ── Gate 3: cross-check that both auth tokens agree on identity ──────
  if (session.email.toLowerCase() !== verifiedEmail) {
    console.warn("[send-prepare] session/Supabase email mismatch", {
      sessionEmail: session.email,
      verifiedEmail,
    });
    return reject("Session mismatch. Please sign in again.", 401);
  }

  // Body
  let body: { recipient?: string; amount?: string } = {};
  try {
    body = await req.json();
  } catch {
    return reject("Invalid request body");
  }
  const { recipient, amount } = body;
  if (!recipient || typeof recipient !== "string") return reject("recipient is required");
  if (!amount || typeof amount !== "string") return reject("amount is required");

  // ── Gate 6 (early): validate amount format ───────────────────────────
  // Strict decimal: digits + optional single decimal point + ≤ 6 decimals.
  if (!/^\d+(\.\d{1,6})?$/.test(amount)) {
    return reject("Invalid amount. Use up to 6 decimal places, e.g. 5.00");
  }
  let amountWei: bigint;
  try {
    amountWei = parseUnits(amount, USDC_DECIMALS);
  } catch {
    return reject("Invalid amount");
  }
  if (amountWei <= 0n) return reject("Amount must be greater than zero");

  // ── Gate 5: server-side recipient resolution ─────────────────────────
  const resolution = await resolveRecipientStrict(recipient);
  if (!resolution.ok) return reject(resolution.reason);
  const { address: resolvedAddress, arcName: resolvedName } = resolution;

  // ── Gate 7: not a self-send ──────────────────────────────────────────
  const userId = await resolveCircleUserId(verifiedEmail);
  // We could compare to session.walletAddress directly. We do that AND
  // re-verify with Circle below in gate 4 — defense in depth.
  if (resolvedAddress.toLowerCase() === session.walletAddress.toLowerCase()) {
    return reject("Cannot send to your own wallet");
  }

  // ── Gate 4: confirm sender wallet truly belongs to this userId ───────
  // This is the anti-forgery check: even if someone tampered with the JWT
  // cookie to claim a different wallet, Circle is the source of truth.
  const senderWallet = await getUserWallet(userId);
  if (!senderWallet) return reject("Sender wallet not found", 404);
  if (senderWallet.address.toLowerCase() !== session.walletAddress.toLowerCase()) {
    console.warn("[send-prepare] wallet mismatch (potential forgery)", {
      userId,
      sessionWallet: session.walletAddress,
      circleWallet: senderWallet.address,
    });
    return reject("Wallet ownership check failed. Please sign in again.", 403);
  }

  // ── Gate 6 (full): balance check (cheap pre-flight) ──────────────────
  let balanceWei: bigint;
  try {
    balanceWei = await readUsdcBalanceWei(senderWallet.address, USDC_ADDRESS);
  } catch (err) {
    console.error("[send-prepare] balance read failed:", err);
    return reject("Could not verify your balance. Try again.", 503);
  }
  if (amountWei > balanceWei) {
    return reject("Insufficient USDC balance");
  }

  // ── All gates passed — create the Circle challenge ───────────────────
  try {
    const prepared = await prepareUserSendUsdc({
      userId,
      walletId: senderWallet.id,
      tokenContractAddress: USDC_ADDRESS,
      recipientAddress: resolvedAddress,
      amountDecimal: amount,
    });

    console.log("[send-prepare] OK", {
      from: senderWallet.address,
      to: resolvedAddress,
      via: resolvedName ?? "address",
      amount,
      challengeId: prepared.challengeId,
    });

    // Log to wallet_transactions as PENDING so the activity tab shows
    // manual sends from the main wallet. Best-effort: never block the send
    // if this fails, but log loudly so RLS / column-mismatch issues are
    // visible in Vercel logs.
    try {
      const supabase = await createSupabaseServerClient();
      const { data: { user }, error: authErr } = await supabase.auth.getUser();
      if (authErr || !user?.id) {
        console.error("[send-prepare] activity log skipped: no user", { authErr, hasUser: !!user });
      } else {
        const { error: insertErr } = await supabase.from("wallet_transactions").insert({
          user_id: user.id,
          direction: "SEND",
          counterparty_address: resolvedAddress,
          counterparty_arc_name: resolvedName,
          amount: amount,
          token_symbol: "USDC",
          status: "PENDING",
          // Don't write circle_tx_id here. Circle's webhook arrives with
          // notification.id (a different value than the challengeId we
          // have right now). The webhook's claim-PENDING matcher looks
          // for circle_tx_id IS NULL to claim recently inserted rows.
        });
        if (insertErr) {
          console.error("[send-prepare] activity log insert failed:", insertErr);
        }
      }
    } catch (logErr) {
      console.error("[send-prepare] activity log threw:", logErr);
    }

    return NextResponse.json({
      challengeId: prepared.challengeId,
      userToken: prepared.userToken,
      encryptionKey: prepared.encryptionKey,
      // Echoed back for the UI confirmation step. These values are what the
      // server actually signed for — clients should DISPLAY these (not their
      // own inputs) on the final confirmation screen.
      resolvedAddress,
      resolvedName,
      amount,
    });
  } catch (error: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = error as any;
    console.error("[send-prepare] Circle error", err?.response?.data ?? err);
    const message = err instanceof Error ? err.message : "Send preparation failed";
    return reject(message, 400);
  }
}
