/**
 * Skill: GET_PRICE
 *
 * Read-only. Returns the current USD price of a supported asset by
 * calling the shared price oracle (CoinGecko-backed, in-process cache).
 *
 * Why a skill (not a route):
 *   - Lives in the same dispatch graph as CHECK_BALANCE and
 *     LIST_POLICIES so the LLM can compose it into multi-step plans
 *     ("if BTC > 80k, swap 50 USDC to cirBTC" — though that's better
 *     done as a price-triggered policy; this skill is for ad-hoc
 *     "what's BTC right now?" questions).
 *   - Uses the SAME oracle module the cron evaluator uses, so a
 *     warmed cache benefits both surfaces.
 *
 * Params (validated below):
 *   { symbol: string }   one of "BTC" | "cirBTC" | "ETH" | "USDC" | "EURC"
 *
 * PIN: not required — pure read.
 */

import "server-only";
import type { SkillHandler, SkillContext, SkillOutput } from "./types";
import { getPriceUSD } from "@/lib/oracle";
import { SYMBOL_TO_COINGECKO_ID, UnknownSymbolError } from "@/lib/oracle/coingecko";

export const GetPrice: SkillHandler = {
  category: "READ",
  version: 1,
  affectsFunds: false,
  requiresPin: false,

  validate(params: Record<string, unknown>) {
    const raw = params.symbol;
    if (typeof raw !== "string" || !raw.trim()) {
      throw new Error("GET_PRICE requires a non-empty `symbol` string");
    }
    const upper = raw.trim().toUpperCase();
    if (!SYMBOL_TO_COINGECKO_ID[upper]) {
      const supported = Object.keys(SYMBOL_TO_COINGECKO_ID)
        .filter((k) => k !== "CIRBTC")
        .concat(["cirBTC"]) // restore the casing the user expects
        .join(", ");
      throw new Error(`Unsupported asset "${raw}". Try: ${supported}`);
    }
    return { ...params, symbol: upper };
  },

  async execute({ params }: SkillContext): Promise<SkillOutput> {
    const symbol = String(params.symbol ?? "").trim().toUpperCase();
    if (!symbol) {
      return { ok: false, error: "GET_PRICE requires `symbol`", status: 400 };
    }
    try {
      const result = await getPriceUSD(symbol);
      return {
        ok: true,
        result: {
          symbol: result.symbol,
          priceUsd: result.price,
          source: result.source,
          ageSeconds: result.ageSeconds,
        },
      };
    } catch (err) {
      if (err instanceof UnknownSymbolError) {
        return { ok: false, error: err.message, status: 400 };
      }
      const msg = err instanceof Error ? err.message : String(err);
      // No cached value AND CoinGecko down → surface a friendly error
      // rather than a stale or invented number.
      return {
        ok: false,
        error: `Price feed unavailable for ${symbol}. Try again in a moment.`,
        status: 502,
      };
    }
  },
};
