/**
 * lib/agent-audit.ts
 *
 * Structured audit logging for every skill execution.
 *
 * Records: user, skill, category, affectsFunds, sanitized params, outcome,
 * http status, duration, and whether the call was a replay from the
 * idempotency cache.
 *
 * Storage: public.agent_audit_log (service-role writes; users SELECT own
 * rows via RLS for the dashboard).
 *
 * Failures here MUST NOT block the response. We swallow + console.error
 * the DB error so a logging outage cannot stop the agent from working.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SkillCategory } from "@/lib/skills";

// Any params key matching this pattern is dropped before persistence.
// Belt-and-suspenders — `pin` is supposed to live at the request-body top
// level, not inside params, but we defensively strip anything sensitive
// in case a future interpreter version passes it through.
const SENSITIVE_KEY_PATTERN = /pin|password|secret|token|api[_-]?key/i;

// Max chars per stringified field — keeps audit rows from blowing up if
// a future skill receives huge blobs. The full data is still available
// in agent_spend_log for TRANSFER skills.
const MAX_FIELD_CHARS = 256;

export function sanitizeParams(
  params: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!params || typeof params !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (SENSITIVE_KEY_PATTERN.test(k)) continue;
    if (v === null || v === undefined) continue;
    if (typeof v === "string") {
      out[k] = v.length > MAX_FIELD_CHARS ? `${v.slice(0, MAX_FIELD_CHARS)}…` : v;
    } else if (typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else {
      // Stringify objects/arrays so the audit log column has a stable shape.
      const s = JSON.stringify(v);
      out[k] = s.length > MAX_FIELD_CHARS ? `${s.slice(0, MAX_FIELD_CHARS)}…` : s;
    }
  }
  return out;
}

export async function logSkillExecution(args: {
  service: SupabaseClient;
  userId: string;
  skill: string;
  category: SkillCategory;
  affectsFunds: boolean;
  params: Record<string, unknown>;
  ok: boolean;
  httpStatus: number;
  error?: string | null;
  durationMs: number;
  replayed?: boolean;
}): Promise<void> {
  const {
    service, userId, skill, category, affectsFunds,
    params, ok, httpStatus, error, durationMs, replayed = false,
  } = args;

  try {
    const { error: insertErr } = await service
      .from("agent_audit_log")
      .insert({
        user_id: userId,
        skill,
        category,
        affects_funds: affectsFunds,
        params: sanitizeParams(params),
        ok,
        http_status: httpStatus,
        error: ok ? null : (error ?? null),
        duration_ms: durationMs,
        replayed,
      });

    if (insertErr) {
      console.error("[agent-audit] insert failed (non-fatal)", {
        skill,
        code: insertErr.code,
        message: insertErr.message,
      });
    }
  } catch (err) {
    console.error("[agent-audit] unexpected error (non-fatal)", err);
  }
}
