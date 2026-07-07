/**
 * lib/skill-router.ts — V3.5 Track 4
 *
 * Picks the top-K most semantically-relevant skills for a user message
 * by embedding the message and running cosine similarity against the
 * `skill_embeddings` table (see migration 0014).
 *
 * Contract — never blocks interpret:
 *   - Happy path: returns K entries (default 6) with the message's top
 *     cosine similarity score for diagnostics.
 *   - Low-confidence path: if the best match scores below
 *     SKILL_ROUTER_MIN_COSINE, we log to `skill_router_misses` (for
 *     tuning + catalog-gap discovery) AND return the FULL active catalog
 *     so the LLM never goes hungry on an ambiguous message.
 *   - Hard-error path: if embedding fails, the RPC fails, or anything
 *     else explodes, we catch it and return the FULL catalog with
 *     `usedFallback=true`. A skill-router outage MUST NOT break interpret.
 *
 * The full catalog acts as a graceful-degradation safety net rather than
 * a hand-picked "always include" floor — matching the V3.5 design intent
 * of "pure semantic routing, no preconfigured allow-list".
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { embedText } from "@/lib/embeddings";
import {
  getActiveCatalog,
  findSkillEntry,
  type SkillCatalogEntry,
} from "@/lib/skills/catalog";

// ── Tunables (env-driven) ──────────────────────────────────────────────

const DEFAULT_K = parseIntEnv("SKILL_ROUTER_K", 6);
const MIN_COSINE = parseFloatEnv("SKILL_ROUTER_MIN_COSINE", 0.4);

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function parseFloatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

// ── Types ──────────────────────────────────────────────────────────────

export type SelectedSkills = {
  /** The skill entries to inject into the prompt's catalog block. */
  skills: SkillCatalogEntry[];
  /**
   * True when the router fell back to the full catalog — either because
   * the top match was below threshold, or because something errored.
   * Logged + surfaced for verification (smoke test 4.7 / 4.8).
   */
  usedFallback: boolean;
  /** Top cosine similarity for the message, or null on error. */
  topCosine: number | null;
  /** Reason the fallback was used, if any. For trace logs. */
  fallbackReason?: "below_threshold" | "embedding_error" | "rpc_error" | "no_active_skills";
};

type MatchSkillRow = {
  skill_name: string;
  description: string;
  category: string;
  affects_funds: boolean;
  similarity: number;
};

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Select the skills to inject for a single interpret call.
 *
 * Side effects:
 *   - May insert into `skill_router_misses` when the top match is below
 *     threshold (best-effort; insert failures are swallowed). The caller
 *     stays unaware — this is ops telemetry, not user-facing.
 *
 * The supabase client passed here can be either the RLS-bound user client
 * (route handlers already authenticate before reaching the router) or a
 * service-role client. The RPC is `stable` and works under either, and
 * the misses-log INSERT is RLS-exempt because the table has no policies.
 */
export async function selectSkills(
  supabase: SupabaseClient,
  userMessage: string,
  options: { userId?: string; k?: number; traceId?: string } = {},
): Promise<SelectedSkills> {
  const k = options.k ?? DEFAULT_K;
  const trace = options.traceId ? ` trace=${options.traceId}` : "";

  // ── Embed ─────────────────────────────────────────────────────────
  let queryVec: number[];
  try {
    queryVec = await embedText(userMessage);
  } catch (err) {
    console.warn(
      `[skill-router]${trace} embedding failed — falling back to full catalog:`,
      err instanceof Error ? err.message : err,
    );
    return fullCatalogFallback("embedding_error");
  }

  // ── RPC: top-K by cosine similarity ───────────────────────────────
  let rows: MatchSkillRow[] = [];
  try {
    const { data, error } = await supabase.rpc("match_skills", {
      query_embedding: queryVec as unknown as string, // pgvector accepts both
      match_count: k,
    });
    if (error) throw error;
    rows = (data ?? []) as MatchSkillRow[];
  } catch (err) {
    console.warn(
      `[skill-router]${trace} match_skills RPC failed — falling back to full catalog:`,
      err instanceof Error ? err.message : err,
    );
    return fullCatalogFallback("rpc_error");
  }

  if (rows.length === 0) {
    console.warn(
      `[skill-router]${trace} no rows returned (skill_embeddings unseeded?) — falling back to full catalog`,
    );
    return fullCatalogFallback("no_active_skills");
  }

  const topSimilarity = rows[0].similarity;

  // ── Threshold check ───────────────────────────────────────────────
  if (topSimilarity < MIN_COSINE) {
    // Record the miss so we can tune MIN_COSINE and discover catalog gaps.
    // Best-effort: insert failures must not break the route.
    void supabase
      .from("skill_router_misses")
      .insert({
        user_id: options.userId ?? null,
        message: userMessage.slice(0, 500), // truncate paranoia
        top_cosine: topSimilarity,
        fallback_used: true,
      })
      .then(({ error }) => {
        if (error) {
          console.warn(
            `[skill-router]${trace} miss log insert failed: ${error.message}`,
          );
        }
      });

    console.log(
      `[skill-router]${trace} low-confidence top=${topSimilarity.toFixed(3)} < ${MIN_COSINE} — full catalog injected`,
    );
    return {
      skills: getActiveCatalog(),
      usedFallback: true,
      topCosine: topSimilarity,
      fallbackReason: "below_threshold",
    };
  }

  // ── Happy path: hydrate from local catalog so we ship the exact
  //    description text the seed used (DB has it too, but rendering from
  //    the local catalog keeps the prompt deterministic if the DB has
  //    drifted from `lib/skills/catalog.ts`). Drop any DB row whose
  //    skill_name has no local entry (seed/catalog skew).
  const selected: SkillCatalogEntry[] = [];
  for (const row of rows) {
    const local = findSkillEntry(row.skill_name);
    if (local) selected.push(local);
  }

  if (selected.length === 0) {
    console.warn(
      `[skill-router]${trace} all matched skills missing from local catalog — falling back`,
    );
    return fullCatalogFallback("no_active_skills");
  }

  console.log(
    `[skill-router]${trace} top=${topSimilarity.toFixed(3)} selected=[${selected.map((s) => s.skill_name).join(",")}]`,
  );

  return {
    skills: selected,
    usedFallback: false,
    topCosine: topSimilarity,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function fullCatalogFallback(
  reason: SelectedSkills["fallbackReason"],
): SelectedSkills {
  return {
    skills: getActiveCatalog(),
    usedFallback: true,
    topCosine: null,
    fallbackReason: reason,
  };
}
