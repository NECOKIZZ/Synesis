import { NextResponse } from "next/server";
import { circleConfigured, treasuryRegisterName } from "@/lib/circle";
import { normalizeName } from "@/lib/ans";
import { getSession, signSession, setSessionCookie, type Session } from "@/lib/auth";
import { getMyProfile, setArcNameForCurrentUser } from "@/lib/profile";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { withUserLock } from "@/lib/agent-lock";

export const runtime = "nodejs";

// 3–32 chars, lowercase letters / digits / hyphen. Mirrors the resolver guard
// in lib/ans.ts. Validating up-front is what kills the old opaque 400: a short
// or invalid label used to revert the on-chain isAvailable() call and surface
// as a meaningless "400 Unknown error".
const LABEL_RE = /^[a-z0-9-]{3,32}$/;

/**
 * POST /api/circle/register-name
 *
 * Registers a .arc name for the authenticated user.
 *
 * SOURCE OF TRUTH IS THE DATABASE (profiles.arc_name), not the chain. The
 * on-chain ANS registry is currently unreliable, so we:
 *   1. Validate the label (clean 400 on bad input).
 *   2. Enforce one-name-per-user + global uniqueness via the DB.
 *   3. Persist name→address to the DB — this is what resolution reads.
 *   4. Attempt on-chain registration BEST-EFFORT — a failure here is logged
 *      and swallowed so it can never block signup.
 *
 * Auth: dotarc_session cookie required.
 */
export async function POST(req: Request) {
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
    if (!LABEL_RE.test(label)) {
      return NextResponse.json(
        {
          error:
            "Name must be 3–32 characters, using only lowercase letters, numbers, or hyphens.",
        },
        { status: 400 }
      );
    }

    // Serialize per wallet so two concurrent requests can't both pass the
    // uniqueness guard and double-write / double-pay the treasury fee.
    return await withUserLock(session.walletAddress, async () => {
      // Guard 1: one .arc name per account (DB is source of truth).
      const profile = await getMyProfile();
      if (profile?.arcName) {
        return NextResponse.json(
          {
            error: `You already own ${profile.arcName}.arc. One .arc name per account.`,
            existing: `${profile.arcName}.arc`,
          },
          { status: 409 }
        );
      }

      // Guard 2: the label must be globally unique. Service client bypasses RLS
      // so we can see names owned by OTHER users.
      const svc = createSupabaseServiceClient();
      const { data: taken } = await svc
        .from("profiles")
        .select("id")
        .eq("arc_name", label)
        .maybeSingle();
      if (taken) {
        return NextResponse.json({ error: `${label}.arc is already taken` }, { status: 409 });
      }

      // Best-effort on-chain registration — nice-to-have provenance, but MUST
      // NOT block signup if the Arc registry reverts or the RPC is down.
      let txHash: string | null = null;
      let circleTxId: string | null = null;
      if (circleConfigured) {
        try {
          const res = await treasuryRegisterName(label, session.walletAddress);
          txHash = res.txHash;
          circleTxId = res.circleTxId;
        } catch (err) {
          console.error(
            "[register-name] on-chain registration failed (non-fatal, DB is SSOT):",
            err instanceof Error ? err.message : err
          );
        }
      }

      // Persist to the DB — THIS is what name resolution reads. If this write
      // fails, the registration genuinely failed, so surface a 500.
      const saved = await setArcNameForCurrentUser({ arcName: label, arcNameTx: txHash });
      if (!saved) {
        return NextResponse.json(
          { error: "Could not save your name. Please try again." },
          { status: 500 }
        );
      }

      // Refresh the session cookie with the new arcName.
      const newSession: Session = { ...session, arcName: `${label}.arc` };
      const token = await signSession(newSession);
      await setSessionCookie(token);

      return NextResponse.json({
        success: true,
        arcName: `${label}.arc`,
        resolvedTo: session.walletAddress,
        txHash,
        circleTxId,
        onchain: Boolean(txHash),
        explorerUrl: txHash ? `https://testnet.arcscan.app/tx/${txHash}` : null,
      });
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[register-name]", message);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
