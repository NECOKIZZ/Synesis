/**
 * lib/rate-limit.ts
 *
 * Per-user fixed-window rate limiting, backed by the `rate_limits` table +
 * `consume_rate_limit` RPC (migration 0011). The increment is atomic inside
 * one Postgres call, so concurrent serverless invocations cannot race past
 * the cap.
 *
 * FAIL-OPEN by design: if the limiter infrastructure errors (RPC missing,
 * Supabase down), we allow the request and log a warning. A rate-limit outage
 * must never lock a legitimate user out of interpreting or moving their own
 * money — the limiter is abuse protection, not a security control. The real
 * money-safety controls (PIN, idempotency, per-user lock) live elsewhere.
 */

import "server-only";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

export type RateLimitResult = {
  allowed: boolean;
  /** Seconds until the window resets. 0 when allowed. */
  retryAfterSeconds: number;
};

type ConsumeRow = { allowed?: unknown; retry_after_seconds?: unknown };

/**
 * Consume one unit from the (action, user) bucket.
 *
 * @param userId  Server-derived Supabase user id (never client-supplied).
 * @param action  Logical bucket name, e.g. "interpret" / "confirm-policy".
 * @param opts    max requests per windowSeconds window.
 */
export async function checkRateLimit(
  userId: string,
  action: string,
  opts: { max: number; windowSeconds: number },
): Promise<RateLimitResult> {
  const key = `${action}:${userId}`;
  try {
    const service = createSupabaseServiceClient();
    const { data, error } = await service.rpc("consume_rate_limit", {
      p_key: key,
      p_max: opts.max,
      p_window_seconds: opts.windowSeconds,
    });
    if (error) {
      console.warn(`[rate-limit] ${action} RPC error (fail-open):`, error.message);
      return { allowed: true, retryAfterSeconds: 0 };
    }
    const row = (Array.isArray(data) ? data[0] : data) as ConsumeRow | null;
    if (!row || typeof row.allowed !== "boolean") {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return {
      allowed: row.allowed,
      retryAfterSeconds: Number(row.retry_after_seconds ?? 0) || 0,
    };
  } catch (err) {
    console.warn(
      `[rate-limit] ${action} threw (fail-open):`,
      err instanceof Error ? err.message : String(err),
    );
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
