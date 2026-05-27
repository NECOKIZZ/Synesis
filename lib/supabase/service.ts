/**
 * Supabase service-role client (server-only).
 *
 * Bypasses RLS — ONLY use in:
 *   - Cron jobs that need cross-user reads (e.g. agent policy executor)
 *   - Admin/internal routes that have been separately authenticated
 *
 * NEVER use this in user-facing routes. Those should use
 * createSupabaseServerClient() which is scoped to the signed-in user via RLS.
 */

import "server-only";
import { createClient } from "@supabase/supabase-js";

export function createSupabaseServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase service role not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
