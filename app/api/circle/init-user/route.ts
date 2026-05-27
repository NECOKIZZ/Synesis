import { NextResponse } from "next/server";
import { circleConfigured, initCircleUser } from "@/lib/circle";
import { getVerifiedEmail } from "@/lib/supabase/server";
import { upsertProfileForCurrentUser } from "@/lib/profile";
import { signSession, setSessionCookie, type Session } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * POST /api/circle/init-user
 *
 * Auth: a verified Supabase session is REQUIRED. The email is taken from the
 * Supabase user, NOT from the request body. This is the fix for the previous
 * bug where anyone who knew an email could log into that wallet.
 *
 * Performance optimization: when the user is ALREADY onboarded (returning
 * user), this route ALSO creates the dotarc session JWT and upserts the
 * profile, inline, in the same response. This eliminates two separate
 * round-trips (/api/circle/wallet + /api/circle/session) that the client
 * would otherwise have to make. Result: returning-user signin goes from
 * 3 server round-trips down to 1.
 */
export async function POST() {
  if (!circleConfigured) {
    return NextResponse.json(
      { error: "Circle integration not configured on this server." },
      { status: 503 }
    );
  }

  const email = await getVerifiedEmail();
  if (!email) {
    return NextResponse.json(
      { error: "Email not verified. Sign in with Google or email OTP first." },
      { status: 401 }
    );
  }

  try {
    const result = await initCircleUser(email);
    console.log("[init-user] result", {
      userId: result.userId,
      alreadyOnboarded: result.alreadyOnboarded,
      hasWalletAddress: !!result.walletAddress,
      hasChallengeId: !!result.challengeId,
    });

    // Returning user with a known wallet: finalize the session right here.
    if (result.alreadyOnboarded && result.walletAddress) {
      console.log("[init-user] FAST PATH engaged for", email);
      const profile = await upsertProfileForCurrentUser({
        email,
        circleUserId: result.userId,
        walletAddress: result.walletAddress,
      });

      const session: Session = {
        userId: result.userId,
        email,
        walletAddress: result.walletAddress,
        arcName: profile?.arcName ? `${profile.arcName}.arc` : null,
      };
      const token = await signSession(session);
      await setSessionCookie(token);

      return NextResponse.json({
        ...result,
        email,
        session, // ← client sees this and skips the /wallet + /session calls
      });
    }

    // New user: client still needs to run the PIN challenge before we can
    // finalize the session.
    return NextResponse.json({ ...result, email });
  } catch (error: unknown) {
    return errorResponse(error);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function errorResponse(err: any) {
  const circleData = err?.response?.data;
  const circleStatus = err?.response?.status;
  const message = err instanceof Error ? err.message : "Unknown error";

  // SECURITY: log Circle response details server-side, but never echo
  // them to the client. Circle responses can contain operational metadata
  // (internal codes, IDs, field names) that shouldn't cross the trust
  // boundary. Mirrors the policy in register-name.
  if (circleData || circleStatus) {
    console.error("[init-user]", { message, circleStatus, circleData });
    return NextResponse.json(
      { error: message },
      { status: circleStatus || 400 }
    );
  }

  console.error("[init-user]", err);
  return NextResponse.json({ error: message }, { status: 400 });
}
