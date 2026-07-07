/**
 * Synesis / Synesis — User Profile (durable always-on personalization).
 *
 * The read + write surface for `user_profile` (migration 0018): ONE curated
 * card per user holding communication style + standing preferences. Injected
 * on every interpret call (after the identity line) — the always-on layer
 * MemWal's semantic recall can't guarantee.
 *
 * Read  (getProfileCard)    — used by the interpret route for injection.
 * Write (upsertProfileCard) — used by the session-end merge (service role).
 *
 * Both are best-effort: a profile failure must never affect interpret or the
 * user's response. The card is curated in place (one row, updated) — the
 * merge logic that decides WHAT goes in lives in the session-end route next
 * to the other LLM calls; this module is just the typed store accessor.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordMemOk, recordMemFail } from "./mem-health";

// Hard cap so a runaway merge can never bloat the always-injected prompt.
export const PROFILE_CARD_MAX_CHARS = 600;

/**
 * Read the user's profile card for injection. Returns "" when absent or on
 * any error (new user, RLS, etc.) so the caller can omit the block entirely.
 * Works with either the RLS-bound client (interpret) or a service client.
 */
export async function getProfileCard(
  client: SupabaseClient,
  userId: string,
): Promise<string> {
  try {
    const { data, error } = await client
      .from("user_profile")
      .select("profile_card")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return "";
    return (data.profile_card ?? "").trim();
  } catch {
    return "";
  }
}

/**
 * Upsert the curated card (one row per user). Truncates to the hard cap.
 * Service-role only — there is no insert/update RLS policy by design.
 * Best-effort: swallows its own error.
 */
export async function upsertProfileCard(
  service: SupabaseClient,
  userId: string,
  card: string,
): Promise<void> {
  const text = (card || "").trim().slice(0, PROFILE_CARD_MAX_CHARS);
  if (!text) return;
  const { error } = await service
    .from("user_profile")
    .upsert(
      { user_id: userId, profile_card: text, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
  if (error) {
    recordMemFail("profile", error);
    console.warn(`[user-profile] upsert failed:`, error.message);
  } else {
    recordMemOk("profile");
  }
}
