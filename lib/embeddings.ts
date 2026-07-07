/**
 * lib/embeddings.ts — text embedding helper for the V3.5 skill router.
 *
 * Why a dedicated module
 *   The rest of the app uses OpenRouter (Claude) for chat completions.
 *   OpenRouter now ALSO exposes an OpenAI-compatible embeddings endpoint
 *   (https://openrouter.ai/api/v1/embeddings), so the same OpenRouter key
 *   can power embeddings too — no separate OpenAI account required. Point
 *   OPENAI_API_BASE at openrouter.ai and this module reuses
 *   OPENROUTER_API_KEY automatically (see below). Direct OpenAI, Voyage,
 *   Jina, etc. all work the same way by changing two env vars.
 *
 * Model
 *   `text-embedding-3-small` — 1536 dimensions, $0.02 / 1M tokens, fast.
 *   Cost per embedding of a ~50-token message: ~$0.000001. Negligible.
 *
 * Cache
 *   Tiny in-memory LRU (200 entries) deduplicates identical strings inside
 *   one process. The router embeds the user message on every interpret
 *   call, and users do repeat themselves ("balance", "how much USDC do I
 *   have", etc.) — saves a round-trip when it matters.
 *
 * Failure mode
 *   Throws on any non-2xx response or network error. Callers (the router)
 *   must catch and fall back to injecting the full skill catalog so a
 *   failed embedding NEVER breaks interpret. See MEMORY_ARCHITECTURE.md §9.
 */

import "server-only";
import { withResilience } from "@/lib/resilience";

// NOTE: use `||` (not `??`) throughout — env vars are often present but EMPTY
// ("OPENAI_API_KEY="), and `?? ` only treats null/undefined as absent, so an
// empty string would defeat every fallback. `|| ` correctly treats "" as unset.
const OPENAI_API_BASE = process.env.OPENAI_API_BASE?.trim() || "https://api.openai.com";
// When embeddings are routed through OpenRouter (OPENAI_API_BASE points at
// openrouter.ai), reuse the existing OPENROUTER_API_KEY so no separate OpenAI
// account/key is needed — OpenRouter relays `openai/text-embedding-3-small` to
// OpenAI on its backend, billed to your OpenRouter credits. Direct OpenAI (or
// any other OpenAI-compatible host) still uses OPENAI_API_KEY.
const USING_OPENROUTER = /openrouter\.ai/i.test(OPENAI_API_BASE);
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY?.trim() ||
  (USING_OPENROUTER ? process.env.OPENROUTER_API_KEY?.trim() : undefined);
// OpenRouter requires provider-prefixed model ids ("openai/…"); direct OpenAI
// uses the bare id. Default picks the right one for the configured host.
const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL?.trim() ||
  (USING_OPENROUTER ? "openai/text-embedding-3-small" : "text-embedding-3-small");
const EMBEDDING_DIMENSIONS = 1536;

// ── In-process LRU cache ───────────────────────────────────────────────

const CACHE_MAX = 200;
const cache = new Map<string, number[]>();

function cacheGet(key: string): number[] | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  // Touch: move to most-recently-used by re-inserting.
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cacheSet(key: string, value: number[]): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// ── Cache key (model + text) so a model swap invalidates cleanly ───────

function cacheKey(model: string, text: string): string {
  return `${model}::${text}`;
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Embed a single piece of text. Returns a 1536-dim vector for the default
 * model. Throws on network or API error — callers must handle this and
 * fall back (see lib/skill-router.ts).
 */
export async function embedText(text: string): Promise<number[]> {
  const input = (text ?? "").trim();
  if (!input) throw new Error("embedText: empty input");
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");

  const key = cacheKey(EMBEDDING_MODEL, input);
  const cached = cacheGet(key);
  if (cached) return cached;

  // D5: bounded timeout + one retry + shared "embeddings" breaker. Embedding
  // is on the interactive interpret path (the router embeds every message),
  // so a slow provider must fail fast — the router already falls back to the
  // full catalog when this throws (see lib/skill-router.ts), so a fast throw
  // is strictly better than a hang.
  const vec = await withResilience(
    async () => {
      const res = await fetch(`${OPENAI_API_BASE}/v1/embeddings`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${OPENAI_API_KEY}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          input,
          // Pin dimensions so a future "model returned different size" mistake
          // is caught at the API layer, not at pgvector insert time.
          dimensions: EMBEDDING_DIMENSIONS,
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        // HTTP-prefixed so 5xx counts as retryable/transient, 4xx as terminal.
        throw new Error(`embedText: OpenAI HTTP ${res.status} — ${body.slice(0, 200)}`);
      }

      const json = (await res.json()) as { data?: Array<{ embedding: number[] }> };
      const v = json.data?.[0]?.embedding;
      if (!v || v.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `embedText: malformed embedding (len=${v?.length ?? 0}, expected ${EMBEDDING_DIMENSIONS})`,
        );
      }
      return v;
    },
    {
      label: "embeddings/embedText",
      breakerKey: "embeddings",
      timeoutMs: Number(process.env.EMBEDDING_TIMEOUT_MS ?? 8_000),
      retries: Number(process.env.EMBEDDING_MAX_RETRIES ?? 1),
    },
  );

  cacheSet(key, vec);
  return vec;
}

/**
 * Embed many texts in one API call. Used by the seed script so seeding
 * all ~14 skills is one round-trip, not 14.
 *
 * Returns embeddings in the SAME ORDER as inputs. Skips the cache
 * (deliberate — seed is rare; we want the network fetch to be deterministic).
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const inputs = texts.map((t) => (t ?? "").trim()).filter((t) => t.length > 0);
  if (inputs.length === 0) return [];
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");

  const json = await withResilience(
    async () => {
      const res = await fetch(`${OPENAI_API_BASE}/v1/embeddings`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${OPENAI_API_KEY}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          input: inputs,
          dimensions: EMBEDDING_DIMENSIONS,
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`embedBatch: OpenAI HTTP ${res.status} — ${body.slice(0, 200)}`);
      }
      return (await res.json()) as { data?: Array<{ embedding: number[]; index: number }> };
    },
    {
      label: "embeddings/embedBatch",
      breakerKey: "embeddings",
      timeoutMs: Number(process.env.EMBEDDING_TIMEOUT_MS ?? 15_000),
      retries: Number(process.env.EMBEDDING_MAX_RETRIES ?? 1),
    },
  );

  const data = json.data ?? [];
  if (data.length !== inputs.length) {
    throw new Error(
      `embedBatch: expected ${inputs.length} embeddings, got ${data.length}`,
    );
  }

  // OpenAI returns items in input order, but the schema includes `index`
  // for safety — sort by it just in case.
  const sorted = [...data].sort((a, b) => a.index - b.index);
  return sorted.map((d) => {
    if (!d.embedding || d.embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `embedBatch: malformed embedding at index ${d.index} (len=${d.embedding?.length ?? 0})`,
      );
    }
    return d.embedding;
  });
}

/** Exported for tests/inspection. Reset between test runs if needed. */
export function _clearEmbeddingCache(): void {
  cache.clear();
}

export const EMBEDDING_MODEL_NAME = EMBEDDING_MODEL;
export const EMBEDDING_DIM = EMBEDDING_DIMENSIONS;
