/**
 * lib/oracle/coingecko.ts — raw CoinGecko fetcher.
 *
 * Single source for live USD prices. Free public API, no key required
 * (rate limit ~30 req/min on the free tier — the index module's cache
 * keeps us comfortably under that).
 *
 * Why CoinGecko-only (vs. Band on-chain hybrid):
 *   - Wider asset coverage. Band on Arc currently exposes only USDC/USD;
 *     CoinGecko has every Arc-listed token plus everything we'd ever
 *     want to quote in a `GET_PRICE` skill (BTC, ETH, etc.).
 *   - One source = one cache + one failure mode. No source-switching.
 *   - cirBTC (Circle's wrapped BTC) tracks 1:1 — pricing it as BTC is
 *     correct until/unless it depegs, at which point we'll add a
 *     dedicated CoinGecko id.
 *
 * Public surface:
 *   - fetchCoinGeckoPriceUSD(symbol) — single-asset
 *   - fetchCoinGeckoPricesUSD(symbols) — batched (one HTTP call)
 *   - SYMBOL_TO_COINGECKO_ID — exported so the index module can prevalidate
 *
 * Failure semantics:
 *   - Throws on HTTP error or unknown symbol. The caller (oracle/index)
 *     catches and either falls back to a cached value or surfaces the
 *     error — never silently returns a wrong number.
 */

import "server-only";

/**
 * Map our internal symbol vocabulary to CoinGecko's ID slugs.
 * cirBTC → bitcoin: it's a wrapped BTC, tracks 1:1.
 * Add new entries here as Arc lists more assets.
 */
export const SYMBOL_TO_COINGECKO_ID: Record<string, string> = {
  BTC: "bitcoin",
  CIRBTC: "bitcoin",
  ETH: "ethereum",
  USDC: "usd-coin",
  EURC: "euro-coin",
};

const COINGECKO_BASE = "https://api.coingecko.com/api/v3/simple/price";
const FETCH_TIMEOUT_MS = 6_000;

export class UnknownSymbolError extends Error {
  constructor(symbol: string) {
    super(`Unknown asset symbol: ${symbol}`);
    this.name = "UnknownSymbolError";
  }
}

/**
 * Resolve our internal symbol to its CoinGecko id, or throw.
 * Case-insensitive — callers can pass "btc", "BTC", "cirBTC", etc.
 */
export function symbolToCoinGeckoId(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  const id = SYMBOL_TO_COINGECKO_ID[upper];
  if (!id) throw new UnknownSymbolError(symbol);
  return id;
}

/**
 * Fetch a SINGLE asset's USD price from CoinGecko. Prefer the batched
 * version when querying more than one symbol — one HTTP call vs N.
 */
export async function fetchCoinGeckoPriceUSD(symbol: string): Promise<number> {
  const map = await fetchCoinGeckoPricesUSD([symbol]);
  const price = map[symbol.trim().toUpperCase()];
  if (typeof price !== "number") {
    throw new Error(`CoinGecko returned no price for ${symbol}`);
  }
  return price;
}

/**
 * Batched fetch — returns a uppercase-symbol → USD-price map.
 *
 * - De-duplicates CoinGecko ids so cirBTC + BTC share a single lookup.
 * - 6s timeout via AbortController so a slow response can't hang a cron
 *   tick or a user's chat message.
 * - Throws on non-200 or malformed payload (no "0" returned silently).
 */
export async function fetchCoinGeckoPricesUSD(
  symbols: string[],
): Promise<Record<string, number>> {
  if (symbols.length === 0) return {};

  // Dedupe CoinGecko ids so cirBTC + BTC don't double-bill the call.
  const idsBySymbol = new Map<string, string>();
  for (const s of symbols) {
    const upper = s.trim().toUpperCase();
    if (!upper) continue;
    idsBySymbol.set(upper, symbolToCoinGeckoId(upper));
  }
  const uniqueIds = Array.from(new Set(idsBySymbol.values()));

  const url = `${COINGECKO_BASE}?ids=${uniqueIds.join(",")}&vs_currencies=usd`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
      // Disable Next's data cache — we run our own TTL cache in
      // oracle/index.ts and don't want surprise stale reads.
      cache: "no-store",
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    throw new Error(`CoinGecko HTTP ${res.status}: ${await res.text().catch(() => "")}`.slice(0, 300));
  }

  const data = (await res.json()) as Record<string, { usd?: number }>;
  const result: Record<string, number> = {};

  for (const [upper, id] of idsBySymbol) {
    const usd = data[id]?.usd;
    if (typeof usd === "number" && isFinite(usd) && usd >= 0) {
      result[upper] = usd;
    }
  }

  if (Object.keys(result).length === 0) {
    throw new Error(`CoinGecko returned no usable prices for ${symbols.join(",")}`);
  }

  return result;
}
