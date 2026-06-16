/**
 * DotArc Agent Memory — shared types.
 *
 * Memory is layered and each layer is intentionally isolated:
 *   - Layer A (in-session)  : client-side conversation history, never stored.
 *   - Layer B (habits)      : THIS module — structured Supabase facts.
 *   - Layer C (long-term)   : Walrus semantic store, added later behind its
 *                             own adapter so it can be removed with a flag.
 *
 * Keeping the types here lets the route + recorder + (future) Walrus
 * adapter share one vocabulary without importing each other.
 */

export type MemoryKind =
  | "contact"           // someone the user sends to (subject = address)
  | "spending_pattern"  // recurring send behaviour (subject = address)
  | "token_pref"        // token the user tends to use (subject = symbol)
  | "preference"        // explicitly stated preference (subject = slug)
  | "note";             // freeform "remember this" (subject = null)

/**
 * Structured payload stored in `user_memory.content`. Every field is
 * optional — the recall formatter reads whatever is present and builds a
 * human sentence at query time (so hit_count stays accurate without
 * rewriting the fact on every event).
 */
export type MemoryContent = {
  label?: string;              // human label (arc name / first name / token)
  arcName?: string;            // recipient .arc name if known
  address?: string;            // recipient address
  token?: string;              // token symbol
  lastAmountUsdc?: number;     // most recent amount moved
  note?: string;               // freeform note text
  [k: string]: unknown;        // forward-compatible
};

export type MemoryRow = {
  id: string;
  kind: MemoryKind;
  subject: string | null;
  content: MemoryContent;
  hit_count: number;
  last_seen_at: string;
};

/** Tunables for recall — bounded so we never blow the prompt budget. */
export const MEMORY_RECALL_LIMIT = 8;
export const MEMORY_FACT_MAX_CHARS = 160;
