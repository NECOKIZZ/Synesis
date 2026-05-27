import { NextResponse } from "next/server";
import { isAddress } from "ethers";
import { normalizeName, resolveName } from "@/lib/ans";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * GET /api/circle/resolve-recipient?q=maya.arc
 *
 * UI preview helper. Resolves a .arc name (or echoes back a 0x address) so
 * the Send form can show "maya.arc → 0x848f..." as the user types.
 *
 * IMPORTANT: This endpoint is DISPLAY-ONLY. The send-prepare endpoint
 * re-resolves the recipient at submit time and uses ITS resolution as the
 * signed value. Do not skip the server-side re-resolve based on what this
 * endpoint returned — that would be a homograph-style attack vector.
 *
 * Requires a valid dotarc session (rate-limits abuse, prevents random
 * scrapers using us as an ANS resolver).
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, reason: "Sign in first" }, { status: 401 });
  }

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) {
    return NextResponse.json({ ok: false, reason: "Missing query" }, { status: 400 });
  }

  // 0x address path
  if (q.startsWith("0x")) {
    if (!isAddress(q)) {
      return NextResponse.json({ ok: false, reason: "Invalid wallet address" });
    }
    if (q.toLowerCase() === session.walletAddress.toLowerCase()) {
      return NextResponse.json({ ok: false, reason: "That's your own wallet" });
    }
    return NextResponse.json({ ok: true, address: q, arcName: null });
  }

  // .arc name path
  const label = normalizeName(q);
  if (!/^[a-z0-9-]{3,32}$/.test(label)) {
    return NextResponse.json({ ok: false, reason: "Names must be 3-32 chars, a-z 0-9 -" });
  }

  const address = await resolveName(label);
  if (!address) {
    return NextResponse.json({ ok: false, reason: `${label}.arc is not registered` });
  }
  if (address.toLowerCase() === session.walletAddress.toLowerCase()) {
    return NextResponse.json({ ok: false, reason: "That's your own .arc name" });
  }

  return NextResponse.json({ ok: true, address, arcName: `${label}.arc` });
}
