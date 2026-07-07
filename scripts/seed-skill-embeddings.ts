/**
 * scripts/seed-skill-embeddings.ts — V3.5 Track 4 setup
 *
 * Embeds every entry in lib/skills/catalog.ts via OpenAI's
 * text-embedding-3-small model and upserts the result into the
 * `skill_embeddings` table (created in migration 0014).
 *
 * Run after applying migration 0014:
 *   npx tsx scripts/seed-skill-embeddings.ts
 *   # or: pnpm tsx scripts/seed-skill-embeddings.ts
 *
 * Idempotent: re-running upserts on `skill_name` PK. Safe to invoke any
 * time a skill description changes; the next interpret call will use the
 * fresh vector.
 *
 * Env required:
 *   OPENAI_API_KEY                       — embedding API
 *   NEXT_PUBLIC_SUPABASE_URL             — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY            — service role (writes bypass RLS)
 *
 * Skills gated by feature flags (e.g. RETRIEVE_TRANSACTIONS_ENABLED) are
 * only seeded when the flag is on, matching the registry gating so the
 * router can never surface a skill the executor doesn't recognise.
 */

import "./_env"; // MUST be first — loads .env.local before lib/* reads env
import { createClient } from "@supabase/supabase-js";
import { embedBatch, EMBEDDING_MODEL_NAME, EMBEDDING_DIM } from "../lib/embeddings";
import { getActiveCatalog, type SkillCatalogEntry } from "../lib/skills/catalog";

// ── Env validation ─────────────────────────────────────────────────────

function envOrDie(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`✗ Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const SUPABASE_URL = envOrDie("NEXT_PUBLIC_SUPABASE_URL");
const SUPABASE_SERVICE_KEY = envOrDie("SUPABASE_SERVICE_ROLE_KEY");
// Embeddings key: OPENAI_API_KEY for direct OpenAI, OR reuse OPENROUTER_API_KEY
// when routing through OpenRouter (OPENAI_API_BASE points at openrouter.ai) —
// mirrors the fallback in lib/embeddings.ts so the seed and the app agree.
{
  const usingOpenRouter = /openrouter\.ai/i.test(process.env.OPENAI_API_BASE ?? "");
  const hasKey = !!process.env.OPENAI_API_KEY || (usingOpenRouter && !!process.env.OPENROUTER_API_KEY);
  if (!hasKey) {
    console.error(
      "✗ Missing embeddings key. Either set OPENAI_API_KEY, or set " +
        "OPENAI_API_BASE=https://openrouter.ai/api with OPENROUTER_API_KEY.",
    );
    process.exit(1);
  }
}

// ── pgvector literal encoding ──────────────────────────────────────────
// Supabase JS will JSON-encode an array, which Postgres treats as a JSON
// string and fails to coerce into the `vector` column. The canonical
// way is to send a "[0.1,0.2,...]" text literal which pgvector parses
// natively. Bonus: explicit precision so we don't get scientific notation.

function toPgVector(vec: number[]): string {
  return `[${vec.map((n) => n.toString()).join(",")}]`;
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const catalog: SkillCatalogEntry[] = getActiveCatalog();
  if (catalog.length === 0) {
    console.error("✗ Catalog is empty — nothing to seed.");
    process.exit(1);
  }

  console.log(
    `→ Seeding ${catalog.length} skills with ${EMBEDDING_MODEL_NAME} (${EMBEDDING_DIM} dim)…`,
  );
  console.log(`  skills: ${catalog.map((e) => e.skill_name).join(", ")}`);

  // 1. Embed in one batch call.
  const t0 = Date.now();
  const vectors = await embedBatch(catalog.map((e) => e.description));
  if (vectors.length !== catalog.length) {
    console.error(
      `✗ Embedding count mismatch: catalog=${catalog.length} vectors=${vectors.length}`,
    );
    process.exit(1);
  }
  console.log(`  embedded in ${Date.now() - t0}ms`);

  // 2. Upsert each row. We do one upsert per row (not a bulk insert) so a
  //    bad vector for one skill doesn't tank the whole seed. ~13 rows; the
  //    extra round-trips are immaterial and the error surface is cleaner.
  let okCount = 0;
  for (let i = 0; i < catalog.length; i++) {
    const entry = catalog[i];
    const embedding = toPgVector(vectors[i]);

    const { error } = await supabase
      .from("skill_embeddings")
      .upsert(
        {
          skill_name: entry.skill_name,
          description: entry.description,
          category: entry.category,
          affects_funds: entry.affects_funds,
          embedding,
          active: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "skill_name" },
      );

    if (error) {
      console.error(`  ✗ ${entry.skill_name}: ${error.message}`);
      continue;
    }
    okCount += 1;
    console.log(`  ✓ ${entry.skill_name}`);
  }

  // 3. Optional cleanup — mark any DB rows missing from the current
  //    catalog as inactive. Keeps history for debugging but excludes them
  //    from router results.
  const currentNames = new Set<string>(catalog.map((e) => e.skill_name));
  const { data: existing } = await supabase
    .from("skill_embeddings")
    .select("skill_name");
  const stale = (existing ?? [])
    .map((r) => r.skill_name as string)
    .filter((n) => !currentNames.has(n));
  if (stale.length > 0) {
    const { error } = await supabase
      .from("skill_embeddings")
      .update({ active: false, updated_at: new Date().toISOString() })
      .in("skill_name", stale);
    if (error) {
      console.warn(`  ! Failed to mark stale rows inactive: ${error.message}`);
    } else {
      console.log(`  ↓ marked ${stale.length} stale row(s) inactive: ${stale.join(", ")}`);
    }
  }

  console.log(`✓ Seeded ${okCount}/${catalog.length} skills.`);
  process.exit(okCount === catalog.length ? 0 : 1);
}

main().catch((err) => {
  console.error("✗ Seed failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
