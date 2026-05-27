/**
 * Skill: CHECK_BALANCE
 *
 * Read-only. Returns the SMART AGENT wallet's current USDC balance.
 *
 * The agent only knows about its own smart wallet. The user's main wallet
 * is a separate, independent entity and is never reported here.
 *
 * Resolution order:
 *   1. Fresh cache hit (≤ FRESH_CACHE_TTL_MS) → return cached, no Circle call
 *   2. Circle live fetch, up to LIVE_ATTEMPTS attempts with backoff
 *      → on success, refresh DB cache and return live
 *   3. Stale cache fallback (any age) → returned with source="stale-cache"
 *   4. Friendly error (money pun + reassurance)
 *
 * PIN not required — no funds move, no state changes.
 *
 * Trigger examples:
 *   "what's my agent balance"
 *   "how much USDC do I have"
 *   "check balance"
 */

import "server-only";
import { getAgentBalance, getAgentAllBalances } from "@/lib/agent";
import type { AgentTokenBalance } from "@/lib/agent";
import type { SkillHandler, SkillContext, SkillOutput } from "./types";

// Rapid-fire window: identical CHECK_BALANCE calls within this many ms
// return the same cached number without touching Circle.
const FRESH_CACHE_TTL_MS = 5_000;

// Number of times to try Circle before falling back to stale cache.
// User asked for "tried twice before failing".
const LIVE_ATTEMPTS = 2;

// Backoff between Circle attempts. Short — this is a read path, not a
// transfer, so we don't want users staring at a spinner.
const RETRY_BACKOFF_MS = 400;

// User-facing message when Circle is down AND we have no cache. Pun +
// reassurance, per product direction.
const FRIENDLY_OUTAGE_MESSAGE =
  "My bean counter is taking a quick coffee break — couldn't fetch your USDC right now. " +
  "Your funds are safe; please try again in a moment.";

type NormalizedBalance = {
  balanceUsdc: string;
  balanceUsdcNumber: number;
  tokens?: AgentTokenBalance[];
  totalApproxUsdValue?: number;
};

/**
 * Coerce whatever Circle (or the cache) gave us into a clean shape.
 *   - rejects null / undefined
 *   - rejects non-numeric strings
 *   - rejects NaN, Infinity, negative numbers
 *   - emits balanceUsdc as a fixed 6-decimal string for stable display
 *   - emits balanceUsdcNumber as a number for math
 */
function normalizeBalance(raw: unknown): NormalizedBalance | null {
  if (raw === null || raw === undefined) return null;
  const str = typeof raw === "string" ? raw.trim() : String(raw);
  if (!str) return null;
  const num = Number(str);
  if (!isFinite(num) || num < 0) return null;
  return { balanceUsdc: num.toFixed(6), balanceUsdcNumber: num };
}

export const CheckBalance: SkillHandler = {
  category: "READ",
  version: 1,
  affectsFunds: false,
  requiresPin: false,

  async execute({ supabase, supabaseUserId, agentWallet }: SkillContext): Promise<SkillOutput> {
    const walletAddress = agentWallet.circle_wallet_address;
    const now = Date.now();
    const cacheAt = agentWallet.balance_cache_at
      ? new Date(agentWallet.balance_cache_at).getTime()
      : 0;
    const cacheAgeMs = cacheAt ? now - cacheAt : Infinity;

    // ── 1. Fresh-cache hit (rapid-fire dedupe) ──────────────────────
    if (cacheAgeMs < FRESH_CACHE_TTL_MS) {
      const cached = normalizeBalance(agentWallet.balance_cache_usdc);
      if (cached) {
        console.log("[check-balance] fresh-cache hit", {
          userId: supabaseUserId,
          balanceUsdc: cached.balanceUsdc,
          cacheAgeMs,
        });
        return {
          ok: true,
          result: {
            ...cached,
            walletAddress,
            source: "fresh-cache",
            cacheAgeSeconds: Math.floor(cacheAgeMs / 1000),
          },
        };
      }
    }

    // ── 2. Try Circle with bounded retries ──────────────────────────
    let lastError: string | null = null;
    for (let attempt = 1; attempt <= LIVE_ATTEMPTS; attempt++) {
      try {
        const raw = await getAgentBalance(agentWallet.circle_wallet_id);
        const normalized = normalizeBalance(raw);

        if (!normalized) {
          // Circle responded but the payload was garbage. Don't trust it.
          lastError = `Circle returned non-numeric balance: ${JSON.stringify(raw)}`;
          console.warn("[check-balance] invalid Circle payload", {
            userId: supabaseUserId,
            attempt,
            raw,
          });
        } else {
          // Live success. Refresh cache for future calls.
          console.log("[check-balance] Circle OK", {
            userId: supabaseUserId,
            attempt,
            balanceUsdc: normalized.balanceUsdc,
          });

          // Best-effort cache refresh. RLS allows user-self UPDATE.
          // Failure here is non-fatal — we still return the live value.
          const { error: cacheErr } = await supabase
            .from("agent_wallets")
            .update({
              balance_cache_usdc: normalized.balanceUsdc,
              balance_cache_at: new Date(now).toISOString(),
            })
            .eq("user_id", supabaseUserId);

          if (cacheErr) {
            console.warn("[check-balance] cache refresh failed (non-fatal)", {
              userId: supabaseUserId,
              code: cacheErr.code,
            });
          }

          // Fetch all token balances (best-effort — don't fail if this errors)
          let tokens: AgentTokenBalance[] = [];
          let totalApproxUsdValue = normalized.balanceUsdcNumber;
          try {
            tokens = await getAgentAllBalances(agentWallet.circle_wallet_id);
            totalApproxUsdValue = tokens.reduce((sum, t) => sum + t.approxUsdValue, 0);
          } catch {
            // Non-fatal — USDC balance still returned correctly
          }

          return {
            ok: true,
            result: {
              ...normalized,
              walletAddress,
              source: "live",
              tokens,
              totalApproxUsdValue,
            },
          };
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : "Circle balance fetch failed";
        console.warn("[check-balance] Circle attempt failed", {
          userId: supabaseUserId,
          attempt,
          error: lastError,
        });
      }

      // Brief backoff before the next attempt (skip after last).
      if (attempt < LIVE_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
      }
    }

    // ── 3. Stale-cache fallback ─────────────────────────────────────
    const stale = normalizeBalance(agentWallet.balance_cache_usdc);
    if (stale) {
      console.warn("[check-balance] Circle down, serving stale cache", {
        userId: supabaseUserId,
        balanceUsdc: stale.balanceUsdc,
        cacheAgeMs: isFinite(cacheAgeMs) ? cacheAgeMs : null,
        lastError,
      });
      return {
        ok: true,
        result: {
          ...stale,
          walletAddress,
          source: "stale-cache",
          cacheAgeSeconds: isFinite(cacheAgeMs) ? Math.floor(cacheAgeMs / 1000) : null,
        },
      };
    }

    // ── 4. No live, no cache. Friendly error. ───────────────────────
    console.error("[check-balance] no live balance and no cache", {
      userId: supabaseUserId,
      lastError,
    });
    return {
      ok: false,
      error: FRIENDLY_OUTAGE_MESSAGE,
      status: 502,
    };
  },
};
