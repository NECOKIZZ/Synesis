import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { reverseLookup } from "@/lib/ans";
import { getMyProfile } from "@/lib/profile";

export const runtime = "nodejs";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Source of truth, in order:
  //   1. profiles.arc_name in our DB (fast)
  //   2. on-chain reverseLookup (authoritative; covers the rare case where
  //      the name was registered without our DB knowing)
  //   3. cookie's value (best-effort fallback)
  let arcName: string | null = null;
  try {
    const profile = await getMyProfile();
    if (profile?.arcName) arcName = `${profile.arcName}.arc`;
  } catch {
    // ignore
  }

  if (!arcName) {
    try {
      const onchain = await reverseLookup(session.walletAddress);
      if (onchain) arcName = onchain;
    } catch {
      // ignore
    }
  }

  return NextResponse.json({
    ...session,
    arcName: arcName ?? session.arcName ?? null,
  });
}
