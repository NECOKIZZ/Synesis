/**
 * Synesis Agent Memory — Layer C: Walrus Memory adapter.
 *
 * Hard isolation rules (do not break these):
 *   1. NO other file in the repo imports `@mysten-incubation/memwal`.
 *      All Walrus calls go through this adapter. If we ever need to
 *      remove or replace Walrus, only this one file changes.
 *   2. The SDK is loaded via a hidden dynamic import so the project
 *      type-checks and builds even when the package is not installed.
 *      The user installs `@mysten-incubation/memwal` and sets the
 *      env vars only when they're ready to turn this on.
 *   3. Every public function is non-throwing and returns a safe default
 *      on any failure (missing env, SDK not installed, network error).
 *      A Walrus outage MUST NEVER block an interpret or confirm call.
 *   4. Gated by `MEMWAL_ENABLED=1` AND all three `MEMWAL_*` env vars
 *      being set. Either condition false → adapter is a no-op.
 *
 * Public surface:
 *   - walrusEnabled()                           → boolean (cheap gate check)
 *   - walrusRemember(userId, text)              → write a fact
 *   - walrusRecall(userId, query, limit?)       → string[] of recalled facts
 *   - walrusSummarizeAndStore(userId, history)  → session-end summary write
 *
 * Per-user isolation:
 *   Every read/write uses a per-user namespace `dotarc-wallet:${userId}`
 *   so memories never bleed between users. We share one MemWal client per
 *   process (cached singleton) but rotate the namespace per call.
 */

import "server-only";
import { recordMemOk, recordMemFail } from "./mem-health";

// ── Env gates ─────────────────────────────────────────────────────────

/**
 * Single source of truth for "is Walrus configured?". Cheap — call it
 * everywhere instead of duplicating env checks.
 */
export function walrusEnabled(): boolean {
  if (process.env.MEMWAL_ENABLED !== "1") return false;
  if (!process.env.MEMWAL_PRIVATE_KEY) return false;
  if (!process.env.MEMWAL_ACCOUNT_ID) return false;
  if (!process.env.MEMWAL_SERVER_URL) return false;
  return true;
}

// ── Local SDK type shims ─────────────────────────────────────────────
// We model just the surface we use. Keeping these LOCAL (not imported
// from the package) is how this file stays compilable when the package
// isn't installed yet.

type MemWalRememberJob = { job_id: string };
type MemWalRecallResult = { results: Array<{ text: string; score?: number }> };

type MemWalInstance = {
  remember: (text: string) => Promise<MemWalRememberJob>;
  waitForRememberJob: (jobId: string) => Promise<unknown>;
  recall: (query: string | { query: string; limit?: number }) => Promise<MemWalRecallResult>;
};

type MemWalCtor = {
  create: (opts: {
    key: string;
    accountId: string;
    serverUrl: string;
    namespace?: string;
  }) => MemWalInstance;
};

// ── Dynamic loader (hidden from static analysis) ──────────────────────

let cachedSdk: MemWalCtor | null | undefined;

/**
 * Load `@mysten-incubation/memwal` at runtime via an indirect import so
 * neither TypeScript nor the bundler tries to resolve the package at
 * build time. Returns null if the package isn't installed.
 *
 * The `Function("m", "return import(m)")` trick produces a real dynamic
 * import that is opaque to webpack's static dependency scanner — exactly
 * what we want for an optional dependency.
 */
async function loadSdk(): Promise<MemWalCtor | null> {
  if (cachedSdk !== undefined) return cachedSdk;
  try {
    const dyn = Function("m", "return import(m)") as (m: string) => Promise<unknown>;
    const mod = await dyn("@mysten-incubation/memwal");
    const MemWal = (mod as { MemWal?: MemWalCtor }).MemWal ?? null;
    cachedSdk = MemWal;
    return MemWal;
  } catch (err) {
    console.warn("[walrus] SDK load failed (is @mysten-incubation/memwal installed?):", err instanceof Error ? err.message : String(err));
    cachedSdk = null;
    return null;
  }
}

// ── Per-process client cache (one per namespace) ─────────────────────

const clientCache = new Map<string, MemWalInstance>();

async function getClient(userId: string): Promise<MemWalInstance | null> {
  if (!walrusEnabled()) return null;
  const namespace = `dotarc-wallet:${userId}`;
  const cached = clientCache.get(namespace);
  if (cached) return cached;

  const Sdk = await loadSdk();
  if (!Sdk) return null;

  try {
    const client = Sdk.create({
      key: process.env.MEMWAL_PRIVATE_KEY!,
      accountId: process.env.MEMWAL_ACCOUNT_ID!,
      serverUrl: process.env.MEMWAL_SERVER_URL!,
      namespace,
    });
    clientCache.set(namespace, client);
    return client;
  } catch (err) {
    console.warn("[walrus] client create failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Persist a single fact to Walrus for this user. Fire-and-forget shape
 * is fine for callers — we await the underlying `remember` so the job
 * id is captured, but DO NOT await `waitForRememberJob` here (that would
 * delay the user response). The job continues in the background.
 *
 * Returns true if the write was accepted by the relayer, false otherwise.
 * Never throws.
 */
export async function walrusRemember(userId: string, text: string): Promise<boolean> {
  if (!walrusEnabled()) return false;
  const fact = (text || "").trim();
  if (!fact) return false;

  try {
    const client = await getClient(userId);
    if (!client) return false;
    const job = await client.remember(fact);
    // Intentionally NOT awaited — relayer takes ~seconds to settle.
    if (job?.job_id) {
      console.log(
        `[memwal] remember accepted job=${job.job_id} chars=${fact.length} preview="${fact.slice(0, 90).replace(/\s+/g, " ")}"`,
      );
      void client.waitForRememberJob(job.job_id)
        .then(() => {
          recordMemOk("memwal");
          console.log(`[memwal] remember settled job=${job.job_id}`);
        })
        .catch((err) => {
          // The write was accepted but never SETTLED — count it as a fail so a
          // relayer that silently drops jobs is visible in diagnostics (D4).
          recordMemFail("memwal", err);
          console.warn(`[walrus] background job ${job.job_id} failed:`, err instanceof Error ? err.message : String(err));
        });
    }
    return true;
  } catch (err) {
    recordMemFail("memwal", err);
    console.warn("[walrus] remember failed:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * Semantic-search recall. Returns the top-K fact strings (already
 * scoped to this user's namespace) or [] on any failure.
 *
 * Bounded results — callers should pass a limit appropriate to their
 * prompt budget (default 5).
 */
export async function walrusRecall(
  userId: string,
  query: string,
  limit: number = 5,
): Promise<string[]> {
  if (!walrusEnabled()) return [];
  const q = (query || "").trim();
  if (!q) return [];

  try {
    const client = await getClient(userId);
    if (!client) return [];
    const result = await client.recall({ query: q, limit });
    const items = result?.results ?? [];
    const texts = items
      .map((r) => (typeof r?.text === "string" ? r.text.trim() : ""))
      .filter((s) => s.length > 0)
      .slice(0, limit);
    // Diagnostics: what the semantic recall actually returned and how
    // confident it was — so a bad/empty recall is visible, not silent.
    const scores = items
      .slice(0, limit)
      .map((r) => (typeof r?.score === "number" ? r.score.toFixed(3) : "?"))
      .join(",");
    console.log(
      `[memwal] recall q="${q.slice(0, 60).replace(/\s+/g, " ")}" hits=${texts.length}/${limit} scores=[${scores}]`,
    );
    return texts;
  } catch (err) {
    console.warn("[walrus] recall failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

/**
 * Session-end summarisation hook. Receives the human-readable transcript
 * of a session and writes ONE summary fact to Walrus. The summarisation
 * itself happens upstream (the route that owns the model call); this
 * adapter just persists whatever string the caller built.
 *
 * Keeping the LLM call OUT of this file maintains the isolation rule —
 * the adapter is purely "store and fetch", nothing else.
 */
export async function walrusSummarizeAndStore(
  userId: string,
  summary: string,
): Promise<boolean> {
  if (!walrusEnabled()) return false;
  const text = (summary || "").trim();
  if (!text) return false;
  // Tag the summary so a later recall can distinguish session summaries
  // from atomic "remember this" notes if we ever want to.
  return walrusRemember(userId, `[session-summary] ${text}`);
}

// ── Test/debug-only escape hatch ──────────────────────────────────────

/**
 * Reset the in-process caches. Only for tests / hot-reload — production
 * code should never call this.
 */
export function __resetWalrusCachesForTests(): void {
  clientCache.clear();
  cachedSdk = undefined;
}
