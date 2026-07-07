/**
 * Profile helpers — Synesis's own user record, persisted in Supabase Postgres.
 *
 * One row per user, linked to auth.users.id. Stores:
 *   - email (verified)
 *   - circle_user_id    (dotarc-<sha256(email)>)
 *   - wallet_address    (Circle-issued ARC-TESTNET wallet)
 *   - arc_name          (NULL until the user registers their .arc name)
 *   - arc_name_tx       (on-chain registration tx hash)
 *
 * RLS is enabled, so callers must use a Supabase server client that carries
 * the user's auth cookie (created via createSupabaseServerClient).
 */

import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type Profile = {
  id: string;
  email: string;
  arcName: string | null;
  arcNameTx: string | null;
  circleUserId: string;
  walletAddress: string;
  createdAt: string;
  updatedAt: string;
};

type ProfileRow = {
  id: string;
  email: string;
  arc_name: string | null;
  arc_name_tx: string | null;
  circle_user_id: string;
  wallet_address: string;
  created_at: string;
  updated_at: string;
};

function rowToProfile(row: ProfileRow): Profile {
  return {
    id: row.id,
    email: row.email,
    arcName: row.arc_name,
    arcNameTx: row.arc_name_tx,
    circleUserId: row.circle_user_id,
    walletAddress: row.wallet_address,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Get the profile of the currently signed-in Supabase user.
 * Returns null if no profile row exists yet (first-time signup, mid-flow).
 */
export async function getMyProfile(): Promise<Profile | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) return null;

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  if (error) {
    console.error("[profile.getMyProfile]", error);
    return null;
  }
  return data ? rowToProfile(data as ProfileRow) : null;
}

/**
 * Idempotent: insert the profile if missing, otherwise update circle_user_id /
 * wallet_address (in case Circle ever returns a different wallet for an
 * existing email — shouldn't happen, but we don't want stale data).
 *
 * Does NOT touch arc_name. Name registration is a separate step.
 */
export async function upsertProfileForCurrentUser(args: {
  email: string;
  circleUserId: string;
  walletAddress: string;
}): Promise<Profile | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) return null;

  const { data, error } = await supabase
    .from("profiles")
    .upsert(
      {
        id: user.id,
        email: args.email,
        circle_user_id: args.circleUserId,
        wallet_address: args.walletAddress,
      },
      { onConflict: "id" }
    )
    .select("*")
    .single();

  if (error) {
    console.error("[profile.upsertProfileForCurrentUser]", error);
    return null;
  }
  return rowToProfile(data as ProfileRow);
}

/**
 * Save the .arc name + registration tx hash on the current user's profile.
 * Returns null if the user is not signed in or the row doesn't exist yet.
 */
export async function setArcNameForCurrentUser(args: {
  arcName: string; // label without .arc suffix
  arcNameTx: string;
}): Promise<Profile | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) return null;

  const { data, error } = await supabase
    .from("profiles")
    .update({
      arc_name: args.arcName.toLowerCase(),
      arc_name_tx: args.arcNameTx,
    })
    .eq("id", user.id)
    .select("*")
    .single();

  if (error) {
    console.error("[profile.setArcNameForCurrentUser]", error);
    return null;
  }
  return rowToProfile(data as ProfileRow);
}
