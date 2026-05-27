import { NextResponse } from "next/server";
import { isAddress } from "ethers";
import { circleConfigured, getUserWallet, resolveCircleUserId } from "@/lib/circle";
import { signSession, setSessionCookie, type Session } from "@/lib/auth";
import { getVerifiedEmail } from "@/lib/supabase/server";
import { upsertProfileForCurrentUser } from "@/lib/profile";

export const runtime = "nodejs";

/**
 * POST /api/circle/session
 *
 * Promotes a Circle-verified user to an authenticated dotarc session.
 * Re-confirms the wallet belongs to the userId (anti-forgery), then
 * issues the JWT cookie.
 */
export async function POST(req: Request) {
  if (!circleConfigured) {
    return NextResponse.json(
      { error: "Circle integration not configured on this server." },
      { status: 503 }
    );
  }

  // Email and userId come from the verified Supabase session, NOT from the
  // client. The client may only assert its wallet address.
  const verifiedEmail = await getVerifiedEmail();
  if (!verifiedEmail) {
    return NextResponse.json(
      { error: "Email not verified. Sign in with Google or email OTP first." },
      { status: 401 }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { walletAddress, arcName } = body || {};

    if (!walletAddress) {
      return NextResponse.json({ error: "walletAddress is required" }, { status: 400 });
    }
    if (!isAddress(walletAddress)) {
      return NextResponse.json({ error: "Invalid walletAddress" }, { status: 400 });
    }

    const userId = await resolveCircleUserId(verifiedEmail);

    // Run the two independent slow operations in parallel:
    //   - Circle: getUserWallet (anti-forgery check; ~1-2s)
    //   - Supabase: upsertProfile (idempotent persist; ~200-500ms)
    // Total wall time becomes max(circle, supabase) instead of their sum.
    const [wallet, profile] = await Promise.all([
      getUserWallet(userId),
      upsertProfileForCurrentUser({
        email: verifiedEmail,
        circleUserId: userId,
        walletAddress,
      }),
    ]);

    // Anti-forgery: verify the wallet truly belongs to this userId.
    if (!wallet || wallet.address.toLowerCase() !== walletAddress.toLowerCase()) {
      return NextResponse.json({ error: "Wallet does not match userId" }, { status: 403 });
    }

    // The upsert returns the existing row if present (with its arc_name) or
    // the new row (arc_name NULL). That IS the source of truth.
    const finalArcName = profile?.arcName ? `${profile.arcName}.arc` : (arcName ?? null);

    const session: Session = {
      userId,
      email: verifiedEmail,
      walletAddress,
      arcName: finalArcName,
    };
    const token = await signSession(session);
    await setSessionCookie(token);

    return NextResponse.json({ ok: true, session });
  } catch (error: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = error as any;
    console.error("[circle/session]", err?.response?.data ?? err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
