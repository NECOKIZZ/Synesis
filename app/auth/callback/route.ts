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
import { friendlyError } from "@/lib/friendly-errors";

export const runtime = "nodejs";

// Convert any auth-callback failure into a user-friendly string, then encode
// for redirect. AuthGate reads `?auth_error=...` and renders it verbatim, so
// the friendly translation must happen here, not on the client.
function redirectWithFriendlyError(origin: string, raw: unknown, fallback: string) {
  const friendly = friendlyError(raw, fallback);
  return NextResponse.redirect(
    new URL(`/wallet?auth_error=${encodeURIComponent(friendly)}`, origin),
  );
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const errorDescription = url.searchParams.get("error_description");
  const next = url.searchParams.get("next") || "/wallet";

  if (errorDescription) {
    return redirectWithFriendlyError(
      url.origin,
      errorDescription,
      "Sign-in didn't complete. Please try again.",
    );
  }

  if (!code) {
    return redirectWithFriendlyError(
      url.origin,
      "missing_code",
      "Sign-in was interrupted. Please try again.",
    );
  }

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
      // RECOVERY PATH: the most common "errors" from this endpoint are not
      // actually fatal — they're symptoms of a flow that already succeeded.
      //   - "state already used" / "code already exchanged" → the user
      //     refreshed /auth/callback or a prefetcher hit it twice. The
      //     first call set the session cookie; the second one fails.
      //   - "PKCE code verifier not found in storage" → the verifier was
      //     either never set (different browser) OR was already consumed
      //     and the cookie cleared, but a session might still exist.
      // In both cases, if the user already has a Supabase session on this
      // request, they're authenticated — just send them to /wallet instead
      // of showing a scary "Sign-in didn't complete" error.
      const msg = error.message ?? "";
      const looksRecoverable =
        /state.*already.*used|code.*already.*exchanged|code.*verifier|pkce|invalid.*flow.*state/i.test(msg);
      if (looksRecoverable) {
        const { data } = await supabase.auth.getUser();
        if (data?.user?.email) {
          console.log("[auth/callback] recovered from", msg, "— session already valid for", data.user.email);
          return NextResponse.redirect(new URL(next, url.origin));
        }
      }

      console.warn("[auth/callback] exchange failed:", msg);
      return redirectWithFriendlyError(
        url.origin,
        msg,
        "Sign-in didn't complete. Please try again.",
      );
    }
    return NextResponse.redirect(new URL(next, url.origin));
  } catch (err) {
    console.error("[auth/callback] unexpected error:", err);
    return redirectWithFriendlyError(
      url.origin,
      err,
      "Sign-in didn't complete. Please try again.",
    );
  }
}
