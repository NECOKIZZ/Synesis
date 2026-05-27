import { NextResponse } from "next/server";
import { circleConfigured, getUserWallet, resolveCircleUserId } from "@/lib/circle";
import { getVerifiedEmail } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/circle/wallet
 *
 * Returns the Circle wallet of the currently signed-in user.
 *
 * SECURITY: userId is ALWAYS derived server-side from the verified Supabase
 * email — never accepted from query params. This prevents wallet-mapping
 * enumeration of other users by guessing dotarc-* IDs.
 */
export async function GET() {
  if (!circleConfigured) {
    return NextResponse.json(
      { error: "Circle integration not configured on this server." },
      { status: 503 }
    );
  }

  const verifiedEmail = await getVerifiedEmail();
  if (!verifiedEmail) {
    return NextResponse.json(
      { error: "Email not verified. Sign in first." },
      { status: 401 }
    );
  }

  const userId = await resolveCircleUserId(verifiedEmail);

  try {
    const wallet = await getUserWallet(userId);
    if (!wallet) {
      return NextResponse.json(
        { error: "Wallet not found (challenge may still be processing)" },
        { status: 404 }
      );
    }
    return NextResponse.json(wallet);
  } catch (error: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = error as any;
    // Log status only — never echo Circle response data to the client or
    // into general logs (may contain sensitive operational metadata).
    console.error("[circle/wallet]", {
      status: err?.response?.status,
      message: err instanceof Error ? err.message : "Unknown error",
    });
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
