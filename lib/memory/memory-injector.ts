/**
 * Synesis / Synesis — Intent-gated memory injector.
 *
 * Answers ONE question per interpret call: "given what the user is trying to
 * do, which memory bucket(s) belong in the prompt — and which don't?"
 *
 * THE EFFICIENT MECHANISM (why this isn't a second router)
 *   The V3.5 skill router already embeds the user message and returns the
 *   top-K skills. The winning skill IS the intent. So memory selection rides
 *   that same embedding for free — we just map skill → bucket. No parallel
 *   keyword classifier, no second vector pass.
 *
 *     "hello"              → router picks conversational     → no bucket  → nothing
 *     "send usdc to sara"  → router picks SEND_USDC          → contact     → contact digest
 *     "my yield on solana" → router picks YIELD_* (future)   → yield       → yield slice
 *
 *   Intent (which bucket) is semantic → the model handles it. Any finer
 *   slice (which chain / which token) is a CLOSED set → cheap keyword match
 *   on the raw message. That hybrid is the whole design: embeddings for the
 *   brittle part, regex only where it's reliable.
 *
 * EXTENDING IT
 *   When a new memory-feeding skill ships, add one line to BUCKET_BY_SKILL
 *   and one recall branch below. The router already knows how to surface the
 *   skill; injection inherits it. Nothing else changes.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recallTopContacts } from "./contact-mem";

// ── Skill → bucket map ──────────────────────────────────────────────────
// Only skills that actually FEED a memory table appear here. Read skills
// (CHECK_BALANCE, GET_PRICE, LIST_POLICIES, RETRIEVE_TRANSACTIONS) and
// conversation map to nothing → no memory injected, which is exactly the
// "don't shoot contact memory into 'hello'" behaviour.
export type MemoryBucket = "contact"; // grows: | "swap" | "yield" | "bridge" | "pred"

const BUCKET_BY_SKILL: Record<string, MemoryBucket> = {
  SEND_USDC: "contact",
  SEND_TOKEN: "contact",
  // SWAP_USDC:  "swap",   ← add when swap-analytics memory exists
  // YIELD_*:    "yield",  ← add when a yield skill ships
  // BRIDGE_USDC:"bridge",
  // IKNOW:      "pred",
};

// ── Result ──────────────────────────────────────────────────────────────

export type IntentMemory = {
  /** The formatted block to inject into the prompt, or "" when nothing applies. */
  block: string;
  /** Which bucket fired (for diagnostics), or null. */
  bucket: MemoryBucket | null;
  /** Which selected skill triggered the bucket (for diagnostics), or null. */
  triggerSkill: string | null;
  /** Row count in the injected block (for diagnostics). */
  count: number;
};

const EMPTY: IntentMemory = { block: "", bucket: null, triggerSkill: null, count: 0 };

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Decide and fetch the memory to inject for this turn, based on the skills
 * the router selected. Best-effort: any failure yields EMPTY (no memory)
 * rather than throwing — a memory hiccup must never break interpret.
 *
 * `selectedSkillNames` is the router's output (routerDiag.selected in the
 * route). The first selected skill that maps to a bucket wins; we inject
 * that one bucket. (Today there's only `contact`; when multiple buckets
 * exist we can inject several, but one-intent-one-bucket keeps prompts lean.)
 */
export async function selectIntentMemory(
  supabase: SupabaseClient,
  userId: string,
  selectedSkillNames: string[],
): Promise<IntentMemory> {
  // Find the first selected skill that feeds a bucket. The router returns
  // skills best-match-first, so this respects ranking.
  let triggerSkill: string | null = null;
  let bucket: MemoryBucket | null = null;
  for (const name of selectedSkillNames) {
    const b = BUCKET_BY_SKILL[name];
    if (b) {
      triggerSkill = name;
      bucket = b;
      break;
    }
  }
  if (!bucket) return EMPTY;

  switch (bucket) {
    case "contact": {
      const block = await recallTopContacts(supabase, userId).catch(() => "");
      if (!block) {
        // Intent WAS transactional, just no data yet. Report the trigger so
        // diagnostics can distinguish "no contacts" from "not a contact intent".
        console.log(`[mem-inject] bucket=contact trigger=${triggerSkill} → no contacts yet (nothing injected)`);
        return { block: "", bucket, triggerSkill, count: 0 };
      }
      const count = block.split("\n").filter(Boolean).length;
      console.log(`[mem-inject] bucket=contact trigger=${triggerSkill} → injected ${count} contact(s)`);
      return { block, bucket, triggerSkill, count };
    }
    default:
      return EMPTY;
  }
}
