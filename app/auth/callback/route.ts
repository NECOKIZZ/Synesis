/**
 * Supabase OAuth callback handler.
 *
 * After Google (or any future OAuth provider) finishes, the user is redirected
 * here with a `code` query param. We exchange it for a session, which sets the
 * Supabase auth cookie. Then we send the user to /wallet where the rest of the
 * Circle flow takes over.
 */

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const errorDescription = url.searchParams.get("error_description");
  const next = url.searchParams.get("next") || "/wallet";

  if (errorDescription) {
    return NextResponse.redirect(
      new URL(`/wallet?auth_error=${encodeURIComponent(errorDescription)}`, url.origin)
    );
  }

  if (!code) {
    return NextResponse.redirect(new URL("/wallet?auth_error=missing_code", url.origin));
  }

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return NextResponse.redirect(
        new URL(`/wallet?auth_error=${encodeURIComponent(error.message)}`, url.origin)
      );
    }
    return NextResponse.redirect(new URL(next, url.origin));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "callback_failed";
    return NextResponse.redirect(
      new URL(`/wallet?auth_error=${encodeURIComponent(msg)}`, url.origin)
    );
  }
}
