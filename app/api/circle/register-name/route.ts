import { NextResponse } from "next/server";
import { circleConfigured, treasuryRegisterName } from "@/lib/circle";
import { isAvailable, normalizeName, reverseLookup } from "@/lib/ans";
import { getSession, signSession, setSessionCookie, type Session } from "@/lib/auth";
import { setArcNameForCurrentUser } from "@/lib/profile";
import { withUserLock } from "@/lib/agent-lock";

export const runtime = "nodejs";

/**
 * POST /api/circle/register-name
 *
 * Treasury auto-pays the 5 USDC fee. Name resolves to the authenticated
 * user's wallet address.
 *
 * Auth: dotarc_session cookie required.
 *
 * KNOWN ISSUE (CRITIQUE §5.2): treasury currently OWNS the registered name
 * on-chain rather than the user. Tracked in DOTARC_WALLET_CRITIQUE.md.
 */
export async function POST(req: Request) {
  if (!circleConfigured) {
    return NextResponse.json(
      { error: "Circle integration not configured on this server." },
      { status: 503 }
    );
  }

  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { name } = body || {};
    if (typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const label = normalizeName(name);

    // Serialize registration per wallet. Without this, two concurrent requests
    // for the same wallet can BOTH pass the reverseLookup guard before either
    // confirms on-chain, and each fires treasuryRegisterName — the treasury
    // pays the 5 USDC fee twice. Same-instance protection (see lib/agent-lock.ts
    // caveat); mirrors the lock confirm-policy already uses for money flows.
    return await withUserLock(session.walletAddress, async () => {
      // Guard 1: this wallet must not already own a primary .arc name on-chain.
      // Source of truth is the registry, not our DB or the cookie.
      const existing = await reverseLookup(session.walletAddress);
      if (existing) {
        return NextResponse.json(
          {
            error: `This wallet already owns ${existing}. One .arc name per wallet.`,
            existing,
          },
          { status: 409 }
        );
      }

      // Guard 2: the requested label must not be taken globally.
      const available = await isAvailable(label);
      if (!available) {
        return NextResponse.json({ error: `${label}.arc is already taken` }, { status: 409 });
      }

      const { txHash, circleTxId } = await treasuryRegisterName(label, session.walletAddress);

      // Persist the name to the profile (DB cache so we don't need on-chain
      // reverseLookup on every page load). Non-fatal if the DB write fails —
      // the on-chain truth has already been written.
      try {
        await setArcNameForCurrentUser({ arcName: label, arcNameTx: txHash });
      } catch (err) {
        console.error("[register-name] DB write failed (non-fatal):", err);
      }

      // Refresh the session cookie with the new arcName
      const newSession: Session = { ...session, arcName: `${label}.arc` };
      const token = await signSession(newSession);
      await setSessionCookie(token);

      return NextResponse.json({
        success: true,
        arcName: `${label}.arc`,
        resolvedTo: session.walletAddress,
        txHash,
        circleTxId,
        explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
      });
    });
  } catch (error: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = error as any;
    const circleData = err?.response?.data;
    const circleStatus = err?.response?.status;
    const message = err instanceof Error ? err.message : "Unknown error";

    // SECURITY: log Circle response details server-side, but never return
    // them to the client. Circle responses can contain sensitive operational
    // metadata that shouldn't cross the trust boundary.
    if (circleData || circleStatus) {
      console.error("[register-name]", { message, circleStatus });
      return NextResponse.json(
        { error: message },
        { status: circleStatus || 400 }
      );
    }

    console.error("[register-name]", message);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
