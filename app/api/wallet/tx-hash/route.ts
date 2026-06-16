/**
 * GET /api/wallet/tx-hash?id=<wallet_transactions.id>
 *
 * Returns the current tx_hash + status for a wallet_transactions row owned
 * by the signed-in user. Used by the Send modal to poll for the tx_hash
 * that Circle's webhook populates ~2-3s after a successful send (Circle's
 * W3S browser SDK does not consistently return the hash in its onComplete
 * callback on Arc Testnet — see Issue #17).
 *
 * Auth: requires a valid Supabase session. The row is RLS-scoped to the
 * caller via `user_id` so a user can never read another user's row, even
 * if they guess the UUID.
 */

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  // Basic UUID shape check to short-circuit bad input. We don't enforce
  // strictly — RLS catches the rest.
  if (!/^[0-9a-f-]{8,}$/i.test(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("wallet_transactions")
    .select("tx_hash, status")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    console.error("[wallet/tx-hash] lookup error:", error);
    return NextResponse.json({ error: "Lookup failed" }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    txHash: (data.tx_hash as string | null) ?? null,
    status: (data.status as string | null) ?? "PENDING",
  });
}
