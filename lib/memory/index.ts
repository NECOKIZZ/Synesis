/**
 * DotArc Agent Memory — Layer B (Supabase habits & preferences).
 *
 * Public surface:
 *   - recallUserMemory(supabase, userId)        → prompt-ready memory block
 *   - recordSendHabit(service, userId, info)    → upsert contact + pattern
 *   - recordTokenPref(service, userId, symbol)  → upsert token preference
 *   - rememberNote(service, userId, text)       → explicit "remember this"
 *
 * Design notes:
 *   - Reads use the RLS-bound server client (scoped to auth.uid()).
 *   - Writes use the service client + the `record_user_memory` rpc, which
 *     upserts-with-increment atomically.
 *   - Every write is best-effort and MUST be wrapped by the caller so a
 *     memory failure never breaks a transaction or an interpret call.
 *   - This module never imports Walrus. Layer C will be a sibling adapter.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MEMORY_RECALL_LIMIT,
  MEMORY_FACT_MAX_CHARS,
  type MemoryRow,
  type MemoryContent,
  type MemoryKind,
} from "./types";

// ── Recall ─────────────────────────────────────────────────────────────

/**
 * Fetch the user's top memory rows and render them into a compact,
 * prompt-injectable block. Returns "" when there's nothing to say (new
 * user) so the caller can omit the section entirely.
 *
 * Ordering: most-reinforced (hit_count) then most-recent. Bounded by
 * MEMORY_RECALL_LIMIT to protect the prompt budget.
 */
export async function recallUserMemory(
  supabase: SupabaseClient,
  userId: string,
  limit: number = MEMORY_RECALL_LIMIT,
): Promise<string> {
  const { data, error } = await supabase
    .from("user_memory")
    .select("id, kind, subject, content, hit_count, last_seen_at")
    .eq("user_id", userId)
    .order("hit_count", { ascending: false })
    .order("last_seen_at", { ascending: false })
    .limit(limit);

  if (error || !data || data.length === 0) return "";

  const facts = (data as MemoryRow[])
    .map(formatFact)
    .filter((f): f is string => !!f)
    .map((f) => (f.length > MEMORY_FACT_MAX_CHARS ? f.slice(0, MEMORY_FACT_MAX_CHARS - 1) + "…" : f));

  return facts.length ? facts.map((f) => `- ${f}`).join("\n") : "";
}

/** Build a human sentence for one memory row from its structured content. */
function formatFact(row: MemoryRow): string | null {
  const c = row.content ?? {};
  const label = c.label || c.arcName || (c.address ? shortAddr(c.address) : null);
  const times = row.hit_count > 1 ? ` (${row.hit_count}×)` : "";

  switch (row.kind) {
    case "contact":
      return label ? `Sends to ${label}${times}` : null;
    case "spending_pattern": {
      const amt = typeof c.lastAmountUsdc === "number" ? `, recently ${c.lastAmountUsdc} USDC` : "";
      const tok = c.token && c.token !== "USDC" ? ` in ${c.token}` : "";
      return label ? `Often pays ${label}${tok}${times}${amt}` : null;
    }
    case "token_pref":
      return c.token ? `Tends to use ${c.token}${times}` : null;
    case "preference":
      return c.note || (c.label ? `Prefers: ${c.label}` : null);
    case "note":
      return c.note ? `Remembered: ${c.note}` : null;
    default:
      return null;
  }
}

// ── Record (writes) ──────────────────────────────────────────────────

/**
 * Record a completed send. Writes two facts: the contact and the
 * spending pattern. Best-effort — callers should not await-block on this
 * in a way that delays the user response, and must catch errors.
 */
export async function recordSendHabit(
  service: SupabaseClient,
  userId: string,
  info: { address: string; arcName?: string | null; token?: string; amountUsdc?: number },
): Promise<void> {
  const address = (info.address || "").trim();
  if (!address) return;
  const label = info.arcName?.replace(/\.arc$/i, "") || shortAddr(address);

  const contact: MemoryContent = { address, label, arcName: info.arcName ?? undefined };
  const pattern: MemoryContent = {
    address,
    label,
    arcName: info.arcName ?? undefined,
    token: info.token ?? "USDC",
    lastAmountUsdc: typeof info.amountUsdc === "number" ? info.amountUsdc : undefined,
  };

  await Promise.allSettled([
    writeMemory(service, userId, "contact", address, contact),
    writeMemory(service, userId, "spending_pattern", address, pattern),
    info.token ? writeMemory(service, userId, "token_pref", info.token.toUpperCase(), { token: info.token.toUpperCase() }) : Promise.resolve(),
  ]);
}

/** Record an explicit user-stated preference. */
export async function recordPreference(
  service: SupabaseClient,
  userId: string,
  slug: string,
  note: string,
): Promise<void> {
  await writeMemory(service, userId, "preference", slug, { note });
}

/** Record a freeform "remember this" note (append-only). */
export async function rememberNote(
  service: SupabaseClient,
  userId: string,
  text: string,
): Promise<void> {
  const note = text.trim().slice(0, 500);
  if (!note) return;
  await writeMemory(service, userId, "note", null, { note });
}

/** Low-level upsert via the atomic rpc. */
async function writeMemory(
  service: SupabaseClient,
  userId: string,
  kind: MemoryKind,
  subject: string | null,
  content: MemoryContent,
): Promise<void> {
  const { error } = await service.rpc("record_user_memory", {
    p_user_id: userId,
    p_kind: kind,
    p_subject: subject,
    p_content: content,
  });
  if (error) {
    console.warn(`[memory] record_user_memory failed kind=${kind} subject=${subject}:`, error.message);
  }
}

// ── helpers ──────────────────────────────────────────────────────────

function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
