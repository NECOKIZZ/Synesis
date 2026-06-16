/**
 * Skill: IKNOW
 *
 * Read-only. Queries a prediction-market oracle with the user's belief
 * statement and returns the best-matching Polymarket market.
 *
 * Trigger examples:
 *   "I know Arsenal will win the UCL"
 *   "I think Bitcoin hits 100k before December"
 *   "I believe Trump wins 2028"
 *
 * The skill takes the raw user statement as the `belief` param and passes
 * it to the oracle. The oracle handles intent extraction and fuzzy matching.
 *
 * PIN: not required — pure read, no funds move.
 */

import "server-only";
import type { SkillHandler, SkillContext, SkillOutput } from "./types";

const ORACLE_BASE = process.env.POLYMARKET_ORACLE_URL ?? "http://localhost:3456";

export const IKnow: SkillHandler = {
  category: "READ",
  version: 1,
  affectsFunds: false,
  requiresPin: false,

  validate(params: Record<string, unknown>) {
    const raw = params.belief;
    if (typeof raw !== "string" || !raw.trim()) {
      throw new Error("IKNOW requires a non-empty `belief` string");
    }
    return { ...params, belief: raw.trim() };
  },

  async execute({ params }: SkillContext): Promise<SkillOutput> {
    const belief = String(params.belief ?? "").trim();
    if (!belief) {
      return { ok: false, error: "IKNOW requires `belief`", status: 400 };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    try {
      const res = await fetch(
        `${ORACLE_BASE}/query?belief=${encodeURIComponent(belief)}`,
        { signal: controller.signal },
      );
      clearTimeout(timeout);

      if (!res.ok) {
        return {
          ok: false,
          error: `Oracle query failed (${res.status}). Try again in a moment.`,
          status: res.status,
        };
      }

      const body = (await res.json()) as Record<string, unknown>;
      return {
        ok: true,
        result: body,
      };
    } catch (err) {
      clearTimeout(timeout);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("aborted")) {
        return {
          ok: false,
          error: "Oracle query timed out. The prediction-market service may be busy.",
          status: 504,
        };
      }
      return {
        ok: false,
        error: `Oracle unreachable: ${msg}`,
        status: 502,
      };
    }
  },
};
