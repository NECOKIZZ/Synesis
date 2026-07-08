/**
 * lib/oracle/index.ts — public price-oracle surface.
 *
 * One module to rule them all:
 *   - getPriceUSD(symbol)           → live (or cached) USD price
 *   - getPricesUSD(symbols)         → batched live (or cached) USD prices
 *   - getLivePrices()               → BACK-COMPAT shape consumed by the V3
 *                                     prompt builder ({ eurcUsdc, cirBtcUsdc })
 *
 * Caching strategy:
 *   - In-process Map keyed by uppercase symbol.
 *   - PRICE_CACHE_TTL_MS keeps us well under CoinGecko's free-tier limit
 *     (~30 req/min). Cron ticks every minute and the agent rarely asks
 *     for more than 2-3 distinct assets per tick.
 *   - Stale-while-error: if CoinGecko fails BUT we have a cached value
 *     of any age, we return it tagged `source: "stale-cache"`. Fresh
 *     fetches only when the cache is missing entirely.
 *
 * Why a single shared cache:
 *   - Cron + GET_PRICE skill + LLM prompt context all read the same
 *     prices. Sharing one cache means a price-triggered policy and a
 *     user's "what's BTC at?" question both warm the same entry.
 *
 * NOT cached: anything else. No leaking unrelated data through this
 * module, no negative-result caching (so an UnknownSymbolError doesn't
 * stick around if we add the symbol mid-process).
 */

import "server-only";
import {
  fetchCoinGeckoPricesUSD,
  UnknownSymbolError,
  SYMBOL_TO_COINGECKO_ID,
} from "./coingecko";

// ── Cache ────────────────────────────────────────────────────────────

const PRICE_CACHE_TTL_MS = 30_000;

type CacheEntry = { price: number; fetchedAt: number };
const priceCache = new Map<string, CacheEntry>();

/** Test/debug-only escape hatch. Production code never calls this. */
export function __resetOracleCache(): void {
  priceCache.clear();
}

// ── Public API ───────────────────────────────────────────────────────

export type PriceResult = {
  symbol: string;
  price: number;
  source: "live" | "cache" | "stale-cache";
  ageSeconds: number;
  fetchedAt: number;
};

/**
 * Get the USD price for a single asset. Throws on unknown symbols and
 * when CoinGecko fails AND nothing is cached.
 */
export async function getPriceUSD(symbol: string): Promise<PriceResult> {
  const upper = symbol.trim().toUpperCase();
  if (!SYMBOL_TO_COINGECKO_ID[upper]) {
    throw new UnknownSymbolError(symbol);
  }

  const cached = priceCache.get(upper);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < PRICE_CACHE_TTL_MS) {
    return makeResult(upper, cached.price, cached.fetchedAt, "cache", now);
  }

  try {
    const map = await fetchCoinGeckoPricesUSD([upper]);
    const price = map[upper];
    if (typeof price !== "number") {
      // CoinGecko responded but didn't include this symbol — fall through
      // to the stale-cache path.
      throw new Error(`CoinGecko did not return a price for ${upper}`);
    }
    priceCache.set(upper, { price, fetchedAt: now });
    return makeResult(upper, price, now, "live", now);
  } catch (err) {
    if (cached) {
      console.warn(`[oracle] live fetch failed for ${upper}, serving stale:`, err instanceof Error ? err.message : String(err));
      return makeResult(upper, cached.price, cached.fetchedAt, "stale-cache", now);
    }
    throw err;
  }
}

/**
 * Batched variant — single HTTP call to CoinGecko regardless of how
 * many symbols you pass (provided none are cache-fresh). Useful for
 * the V3 prompt builder which always asks for at least 2 assets.
 */
export async function getPricesUSD(symbols: string[]): Promise<Record<string, PriceResult>> {
  const out: Record<string, PriceResult> = {};
  const now = Date.now();
  const toFetch: string[] = [];

  for (const s of symbols) {
    const upper = s.trim().toUpperCase();
    if (!upper || out[upper]) continue;
    if (!SYMBOL_TO_COINGECKO_ID[upper]) {
      // Surface unknown symbols loudly. The cron evaluator already
      // catches this and pauses the offending policy, so we don't
      // silently swallow.
      throw new UnknownSymbolError(s);
    }
    const cached = priceCache.get(upper);
    if (cached && now - cached.fetchedAt < PRICE_CACHE_TTL_MS) {
      out[upper] = makeResult(upper, cached.price, cached.fetchedAt, "cache", now);
    } else {
      toFetch.push(upper);
    }
  }

  if (toFetch.length === 0) return out;

  try {
    const map = await fetchCoinGeckoPricesUSD(toFetch);
    for (const upper of toFetch) {
      const price = map[upper];
      if (typeof price === "number") {
        priceCache.set(upper, { price, fetchedAt: now });
        out[upper] = makeResult(upper, price, now, "live", now);
      } else {
        // Symbol omitted from response — try stale fallback.
        const cached = priceCache.get(upper);
        if (cached) out[upper] = makeResult(upper, cached.price, cached.fetchedAt, "stale-cache", now);
      }
    }
  } catch (err) {
    console.warn(`[oracle] batched fetch failed, attempting per-symbol stale fallback:`, err instanceof Error ? err.message : String(err));
    for (const upper of toFetch) {
      if (out[upper]) continue;
      const cached = priceCache.get(upper);
      if (cached) out[upper] = makeResult(upper, cached.price, cached.fetchedAt, "stale-cache", now);
    }
    // If we got NOTHING — not even stale — re-raise so callers can react.
    if (Object.keys(out).length === 0) throw err;
  }

  return out;
}

function makeResult(
  symbol: string,
  price: number,
  fetchedAt: number,
  source: PriceResult["source"],
  now: number,
): PriceResult {
  return {
    symbol,
    price,
    source,
    ageSeconds: Math.max(0, Math.floor((now - fetchedAt) / 1000)),
    fetchedAt,
  };
}

// ── Back-compat for the V3 prompt builder ────────────────────────────
//
// `agent-core.ts` exports `getLivePrices()` returning a small struct
// the prompt builder injects as "approximate prices for reasoning". We
// keep the same shape but feed it real numbers. If the oracle is down
// AND we have nothing cached, we fall back to the same hardcoded
// constants the prompt has historically used — better to have the
// prompt build than 500 the user's interpret call.

export type LivePrices = { eurcUsdc: number; cirBtcUsdc: number };

const FALLBACK_LIVE_PRICES: LivePrices = { eurcUsdc: 1.08, cirBtcUsdc: 100_000 };

export async function getLivePrices(): Promise<LivePrices> {
  try {
    const map = await getPricesUSD(["EURC", "CIRBTC"]);
    return {
      eurcUsdc: map.EURC?.price ?? FALLBACK_LIVE_PRICES.eurcUsdc,
      cirBtcUsdc: map.CIRBTC?.price ?? FALLBACK_LIVE_PRICES.cirBtcUsdc,
    };
  } catch (err) {
    console.warn("[oracle] getLivePrices fallback to constants:", err instanceof Error ? err.message : String(err));
    return FALLBACK_LIVE_PRICES;
  }
}
