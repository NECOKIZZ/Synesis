/**
 * lib/agent-idempotency.ts
 *
 * Short-window dedupe for PIN-confirmed skill calls.
 *
 * Why:
 *   A double-clicked confirm dialog (or a flaky network retry) can submit
 *   the same money-moving intent twice. Without dedupe, both calls hit
 *   Circle and the user pays twice. Within a TTL window we want the
 *   second call to receive the SAME result as the first — replay, not
 *   re-execute.
 *
 * How:
 *   - Skill declares an `idempotencyKey(params)` (see lib/skills/types.ts).
 *   - confirm-policy combines `${skill}:${key}` and calls claimIdempotency().
 *   - If we win the claim → execute, then finalizeIdempotency().
 *   - If a fresh row already exists:
 *       COMPLETE → replay cached result + http status
 *       PENDING  → 409: another request is in flight
 *       FAILED   → 409 (rare race only — see below)
 *   - If an EXPIRED row exists → atomically overwrite and proceed.
 *
 *   FAILED rows are expired immediately by finalizeIdempotency(), so a
 *   legitimate retry after a failure proceeds instead of being blocked.
 *   The "recent_failure" branch now only triggers in the narrow race where
 *   a row is FAILED but finalize hasn't written the expiry yet.
 *
 * Storage: public.agent_idempotency (service-role writes only).
 *
 * Note: this is best-effort dedupe, not distributed consensus. A perfect
 * race between two requests both seeing "no row" can still result in two
 * INSERTs (Postgres unique constraint catches that — only one wins).
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export type IdempotencyClaim =
  | { kind: "claimed" }                                       // proceed to execute
  | { kind: "replay";    httpStatus: number; result: unknown } // return cached
  | { kind: "in_flight" }                                     // 409
  | { kind: "recent_failure" };                               // 409

/**
 * Try to claim an idempotency key. Returns one of:
 *   - claimed         → caller proceeds to execute + must call finalize()
 *   - replay          → caller returns the cached result
 *   - in_flight       → caller returns 409 (duplicate in progress)
 *   - recent_failure  → caller returns 409 (recent failure, don't retry yet)
 */
export async function claimIdempotency(args: {
  service: SupabaseClient;
  userId: string;
  skill: string;
  key: string;        // skill.idempotencyKey(params)
  ttlSeconds: number; // typically 60 for affectsFunds, 30 otherwise
}): Promise<IdempotencyClaim> {
  const { service, userId, skill, key, ttlSeconds } = args;
  const fullKey = `${skill}:${key}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

  // Attempt 1: optimistic insert (the common case).
  const { error: insertErr } = await service
    .from("agent_idempotency")
    .insert({
      user_id: userId,
      idempotency_key: fullKey,
      skill,
      status: "PENDING",
      expires_at: expiresAt,
    });

  if (!insertErr) return { kind: "claimed" };

  // Conflict: a row exists. Read it.
  const { data: existing } = await service
    .from("agent_idempotency")
    .select("status, result_json, http_status, expires_at")
    .eq("user_id", userId)
    .eq("idempotency_key", fullKey)
    .maybeSingle();

  if (!existing) {
    // Weird race: insert failed but row gone. Treat as claimed and retry-safe.
    return { kind: "claimed" };
  }

  const stillFresh = new Date(existing.expires_at) > now;
  if (stillFresh) {
    if (existing.status === "COMPLETE") {
      return {
        kind: "replay",
        httpStatus: existing.http_status ?? 200,
        result: existing.result_json,
      };
    }
    if (existing.status === "PENDING")  return { kind: "in_flight" };
    return { kind: "recent_failure" };
  }

  // Stale row: try to take it over atomically. The where-clause guards
  // against another request having just refreshed it under us.
  const { data: stolen } = await service
    .from("agent_idempotency")
    .update({
      status: "PENDING",
      result_json: null,
      http_status: null,
      created_at: now.toISOString(),
      expires_at: expiresAt,
    })
    .eq("user_id", userId)
    .eq("idempotency_key", fullKey)
    .lt("expires_at", now.toISOString())
    .select("user_id");

  if (stolen && stolen.length > 0) return { kind: "claimed" };

  // Someone else just refreshed the row. Re-read.
  const { data: refreshed } = await service
    .from("agent_idempotency")
    .select("status, result_json, http_status, expires_at")
    .eq("user_id", userId)
    .eq("idempotency_key", fullKey)
    .maybeSingle();

  if (refreshed && new Date(refreshed.expires_at) > now) {
    if (refreshed.status === "COMPLETE") {
      return {
        kind: "replay",
        httpStatus: refreshed.http_status ?? 200,
        result: refreshed.result_json,
      };
    }
    if (refreshed.status === "PENDING") return { kind: "in_flight" };
    return { kind: "recent_failure" };
  }

  // Truly nobody owns it now. Safe to proceed.
  return { kind: "claimed" };
}

/**
 * Write the final outcome of an idempotent execution so subsequent calls
 * within the window can replay it. Non-fatal on failure — the request
 * itself already succeeded or failed; this is only for dedupe.
 */
export async function finalizeIdempotency(args: {
  service: SupabaseClient;
  userId: string;
  skill: string;
  key: string;
  ok: boolean;
  httpStatus: number;
  resultJson: unknown;
}): Promise<void> {
  const { service, userId, skill, key, ok, httpStatus, resultJson } = args;
  const fullKey = `${skill}:${key}`;

  // On FAILURE, expire the row immediately so a legitimate retry isn't
  // blocked by the "recent_failure" 409. A failed task moved no money
  // (or, for self-withdraw, only to the user's own wallet), the per-skill
  // balance/limit checks re-run on retry, and the Circle circuit breaker
  // already prevents hammering a down provider. On SUCCESS we keep the
  // existing TTL so genuine double-submits replay the cached result.
  const failedExpiry = new Date().toISOString();

  const { error } = await service
    .from("agent_idempotency")
    .update({
      status: ok ? "COMPLETE" : "FAILED",
      result_json: ok ? resultJson : null,
      http_status: httpStatus,
      ...(ok ? {} : { expires_at: failedExpiry }),
    })
    .eq("user_id", userId)
    .eq("idempotency_key", fullKey);

  if (error) {
    console.error("[agent-idempotency] finalize failed (non-fatal)", {
      skill,
      code: error.code,
    });
  }
}
