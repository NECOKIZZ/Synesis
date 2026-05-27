/**
 * Server-side Supabase client (App Router).
 *
 * Reads the auth cookie from the incoming request via next/headers, so the
 * server can identify the signed-in Supabase user. Used in route handlers and
 * server components to enforce "only proceed if email is verified".
 *
 * Pattern follows the official @supabase/ssr Next.js App Router guide.
 */

import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createSupabaseServerClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "Supabase env vars missing. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local."
    );
  }

  const cookieStore = await cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // setAll throws when called from a Server Component. That is fine —
          // session refresh will be handled by the next request that goes
          // through middleware or a route handler.
        }
      },
    },
  });
}

/**
 * Returns the verified email of the signed-in Supabase user, or null.
 * "Verified" = the user proved ownership via OTP or OAuth.
 */
export async function getVerifiedEmail(): Promise<string | null> {
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) return null;
    const email = data.user.email;
    if (!email) return null;
    // For email/OAuth providers, Supabase only returns a session after the
    // email has been confirmed (OTP entered, or OAuth provider returned it).
    return email.toLowerCase();
  } catch {
    return null;
  }
}

export function isSupabaseServerConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}
