/**
 * Skill: RETRIEVE_TRANSACTIONS  (V3.5 — Track 2)
 *
 * Read-only skill that answers history questions about the agent wallet:
 *   "what did I send last week?"     → { since: "last_week", direction: "out" }
 *   "how much have I tipped sara?"   → { recipient: "sara.arc", direction: "out" }
 *   "how much BTC came in?"          → { token: "cirBTC", direction: "in" }
 *
 * Data source: `agent_spend_log` (agent-scoped via `wallet_type='agent'`).
 * Inbound rows are written by the Circle webhook with `skill='RECEIVE'`;
 * everything else is outbound (SEND_USDC, SEND_TOKEN, SWAP_USDC, …).
 *
 * Token note: all current rows are USDC (the table predates multi-token
 * tracking). Filters for EURC/cirBTC/BTC honestly return empty until the
 * spend log carries a token symbol column — this matches the failure mode
 * §9 in the V3.5 memory doc: "let the LLM say you have no matching txs".
 *
 * Limit: hard cap of 50 rows returned. Aggregates run over the FULL
 * filtered window (not the limit slice) so totals stay correct for
 * "how much" questions even when the row list is truncated.
 */

import "server-only";
import type { SkillHandler, SkillContext, SkillOutput } from "./types";

// ── Constants ──────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const AGGREGATE_HARD_CAP = 2000; // safety against pathological full-table scans

// Tokens we acknowledge in the aggregate shape even when zero. Mirrors
// SUPPORTED_BALANCE_SYMBOLS in lib/agent.ts so the LLM sees a consistent
// portfolio shape across CHECK_BALANCE and RETRIEVE_TRANSACTIONS.
const KNOWN_TOKENS = ["USDC", "EURC", "cirBTC"] as const;

// ── Types ──────────────────────────────────────────────────────────────

type Direction = "in" | "out" | "both";

type RawRow = {
  id: string;
  executed_at: string;
  skill: string;
  recipient_address: string | null;
  recipient_arc_name: string | null;
  amount_usdc: number | string;
  status: string;
  tx_hash: string | null;
  policy_id: string | null;
};

type AggregateRow = {
  skill: string;
  amount_usdc: number | string;
};

type TokenBuckets = Record<string, { in: number; out: number }>;

// ── Param parsing helpers ──────────────────────────────────────────────

/** "yesterday" | "last_week" | "last_month" | ISO date → Date (UTC). */
function parseSince(raw: unknown): Date | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const v = raw.trim().toLowerCase();
  const now = new Date();

  if (v === "yesterday") {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - 1);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  if (v === "last_week" || v === "last week" || v === "past_week") {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - 7);
    return d;
  }
  if (v === "last_month" || v === "last month" || v === "past_month") {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - 30);
    return d;
  }
  // Fall through to ISO parse.
  const parsed = new Date(raw);
  return isNaN(parsed.getTime()) ? null : parsed;
}

/** ISO date (or undefined). */
function parseUntil(raw: unknown): Date | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const parsed = new Date(raw);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function parseDirection(raw: unknown): Direction {
  if (raw === "in" || raw === "out" || raw === "both") return raw;
  return "both";
}

function parseLimit(raw: unknown): number {
  const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/**
 * Normalize the recipient param so we can match against either the stored
 * address (`recipient_address`, lower-cased 0x...) or the bare .arc name
 * (`recipient_arc_name`, stored WITHOUT the ".arc" suffix per migration 0005).
 *
 * Returns the filter we'll apply, or null if the param is unusable.
 */
function parseRecipient(raw: unknown):
  | { kind: "address"; value: string }
  | { kind: "arcName"; value: string }
  | { kind: "any"; value: string }
  | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (v.startsWith("0x") && v.length >= 6) return { kind: "address", value: v };
  // Strip ".arc" so "sara.arc" → "sara" matches recipient_arc_name.
  const bare = v.endsWith(".arc") ? v.slice(0, -4) : v;
  if (!bare) return null;
  // No address prefix and not obviously an address-looking blob — treat as
  // an arc-name candidate but also try matching against address (cheap).
  return { kind: "arcName", value: bare };
}

// ── Aggregate computation ──────────────────────────────────────────────

function emptyAggregate(): {
  count: number;
  total_in_usdc: number;
  total_out_usdc: number;
  // Largest SINGLE transfer per direction — lets the agent answer superlative
  // questions ("what was the largest amount I sent to X?", F-12) that totals
  // and counts can't. 0 when there are no rows in that direction.
  largest_in_usdc: number;
  largest_out_usdc: number;
  by_token: TokenBuckets;
} {
  const by_token: TokenBuckets = {};
  for (const t of KNOWN_TOKENS) by_token[t] = { in: 0, out: 0 };
  return { count: 0, total_in_usdc: 0, total_out_usdc: 0, largest_in_usdc: 0, largest_out_usdc: 0, by_token };
}

function isInboundSkill(skill: string): boolean {
  // The webhook tags inbound deposits with skill='RECEIVE'. Anything else
  // (SEND_USDC, SEND_TOKEN, SWAP_USDC, WITHDRAW, BRIDGE_USDC, PAY_X402) is
  // outbound from the agent wallet's perspective.
  return skill === "RECEIVE";
}

function buildAggregate(rows: AggregateRow[]) {
  const agg = emptyAggregate();
  for (const r of rows) {
    const amt = typeof r.amount_usdc === "number"
      ? r.amount_usdc
      : parseFloat(String(r.amount_usdc ?? "0"));
    if (!Number.isFinite(amt)) continue;
    agg.count += 1;
    if (isInboundSkill(r.skill)) {
      agg.total_in_usdc += amt;
      agg.by_token.USDC.in += amt;
      if (amt > agg.largest_in_usdc) agg.largest_in_usdc = amt;
    } else {
      agg.total_out_usdc += amt;
      agg.by_token.USDC.out += amt;
      if (amt > agg.largest_out_usdc) agg.largest_out_usdc = amt;
    }
  }
  // Round to 6 decimals (USDC native precision) to avoid float drift in
  // the prompt.
  agg.total_in_usdc = Math.round(agg.total_in_usdc * 1e6) / 1e6;
  agg.total_out_usdc = Math.round(agg.total_out_usdc * 1e6) / 1e6;
  agg.largest_in_usdc = Math.round(agg.largest_in_usdc * 1e6) / 1e6;
  agg.largest_out_usdc = Math.round(agg.largest_out_usdc * 1e6) / 1e6;
  for (const t of KNOWN_TOKENS) {
    agg.by_token[t].in = Math.round(agg.by_token[t].in * 1e6) / 1e6;
    agg.by_token[t].out = Math.round(agg.by_token[t].out * 1e6) / 1e6;
  }
  return agg;
}

// ── Row shaping ────────────────────────────────────────────────────────

function shapeRow(r: RawRow) {
  const inbound = isInboundSkill(r.skill);
  const amt = typeof r.amount_usdc === "number"
    ? r.amount_usdc
    : parseFloat(String(r.amount_usdc ?? "0"));
  return {
    id: r.id,
    executed_at: r.executed_at,
    direction: inbound ? "in" : "out",
    skill: r.skill,
    amount_usdc: Number.isFinite(amt) ? amt : 0,
    recipient_arc_name: r.recipient_arc_name ?? null,
    recipient_address: r.recipient_address ?? null,
    tx_hash: r.tx_hash ?? null,
    from_policy: Boolean(r.policy_id),
  };
}

// ── The skill ──────────────────────────────────────────────────────────

export const RetrieveTransactions: SkillHandler = {
  category: "READ",
  version: 1,
  affectsFunds: false,
  requiresPin: false,

  async execute({ supabase, supabaseUserId, params }: SkillContext): Promise<SkillOutput> {
    // ── Parse params ────────────────────────────────────────────────
    const since = parseSince(params.since);
    const until = parseUntil(params.until);
    const direction = parseDirection(params.direction);
    const limit = parseLimit(params.limit);
    const recipient = parseRecipient(params.recipient);
    const token = typeof params.token === "string" ? params.token.trim() : "";

    // Token filter: the spend log only carries USDC today. If the caller
    // asks for a non-USDC token, return an honest empty result so the LLM
    // can say "you have no matching transactions" rather than us silently
    // returning all-USDC rows that don't match the question.
    const tokenIsNonUsdc =
      token !== "" && token.toUpperCase() !== "USDC";

    // ── Build the shared filter (used for both rows and aggregate) ──
    // We construct two queries from the same filter so the aggregate
    // covers the FULL window even when rows is truncated to `limit`.
    function applyFilters<T>(q: T): T {
      let qq = q as unknown as Record<string, unknown> & {
        eq: (k: string, v: unknown) => unknown;
        neq: (k: string, v: unknown) => unknown;
        gte: (k: string, v: unknown) => unknown;
        lte: (k: string, v: unknown) => unknown;
        or: (s: string) => unknown;
      };
      qq = qq.eq("user_id", supabaseUserId) as typeof qq;
      qq = qq.eq("wallet_type", "agent") as typeof qq;
      qq = qq.eq("status", "COMPLETE") as typeof qq;
      if (since) qq = qq.gte("executed_at", since.toISOString()) as typeof qq;
      if (until) qq = qq.lte("executed_at", until.toISOString()) as typeof qq;
      if (direction === "in")  qq = qq.eq("skill", "RECEIVE") as typeof qq;
      if (direction === "out") qq = qq.neq("skill", "RECEIVE") as typeof qq;
      if (recipient) {
        // Match address OR arc-name. ilike for case-insensitive parity
        // with how findWalletOwner() normalises addresses (lower-case).
        if (recipient.kind === "address") {
          qq = qq.or(
            `recipient_address.ilike.${recipient.value},recipient_arc_name.ilike.${recipient.value}`,
          ) as typeof qq;
        } else {
          qq = qq.or(
            `recipient_arc_name.ilike.${recipient.value},recipient_address.ilike.${recipient.value}`,
          ) as typeof qq;
        }
      }
      return qq as unknown as T;
    }

    if (tokenIsNonUsdc) {
      return {
        ok: true,
        result: {
          transactions: [],
          aggregate: emptyAggregate(),
          filter_summary: summarizeFilter({ since, until, direction, recipient, token, limit }),
          note: `No ${token.toUpperCase()} transactions found — the agent's spend log currently tracks USDC only.`,
        },
      };
    }

    // ── Query 1: row list (newest first, capped) ────────────────────
    let rowsQuery = supabase
      .from("agent_spend_log")
      .select(
        "id, executed_at, skill, recipient_address, recipient_arc_name, amount_usdc, status, tx_hash, policy_id",
      );
    rowsQuery = applyFilters(rowsQuery);
    const { data: rows, error: rowsErr } = await (rowsQuery as unknown as {
      order: (k: string, o: { ascending: boolean }) => {
        limit: (n: number) => Promise<{ data: RawRow[] | null; error: unknown }>;
      };
    })
      .order("executed_at", { ascending: false })
      .limit(limit);

    if (rowsErr) {
      console.error("[retrieve-transactions] rows query failed:", rowsErr);
      return { ok: false, error: "Failed to load transactions", status: 500 };
    }

    // ── Query 2: aggregate over the full filtered window ────────────
    // Project only the columns we sum so the response is cheap. Hard cap
    // at AGGREGATE_HARD_CAP rows so a pathological window can't burn the
    // route — beyond that we mark the aggregate as "approximate".
    let aggQuery = supabase
      .from("agent_spend_log")
      .select("skill, amount_usdc");
    aggQuery = applyFilters(aggQuery);
    const { data: aggRows, error: aggErr } = await (aggQuery as unknown as {
      limit: (n: number) => Promise<{ data: AggregateRow[] | null; error: unknown }>;
    }).limit(AGGREGATE_HARD_CAP);

    if (aggErr) {
      console.error("[retrieve-transactions] aggregate query failed:", aggErr);
      return { ok: false, error: "Failed to compute totals", status: 500 };
    }

    const aggregate = buildAggregate(aggRows ?? []);
    const aggregateTruncated = (aggRows?.length ?? 0) >= AGGREGATE_HARD_CAP;

    return {
      ok: true,
      result: {
        transactions: (rows ?? []).map(shapeRow),
        aggregate,
        aggregate_truncated: aggregateTruncated,
        rows_truncated: (rows?.length ?? 0) >= limit,
        filter_summary: summarizeFilter({ since, until, direction, recipient, token, limit }),
      },
    };
  },
};

// ── Filter summary (for LLM context + debug logs) ──────────────────────

function summarizeFilter(args: {
  since: Date | null;
  until: Date | null;
  direction: Direction;
  recipient:
    | { kind: "address" | "arcName" | "any"; value: string }
    | null;
  token: string;
  limit: number;
}): Record<string, unknown> {
  return {
    since: args.since?.toISOString() ?? null,
    until: args.until?.toISOString() ?? null,
    direction: args.direction,
    recipient: args.recipient
      ? { kind: args.recipient.kind, value: args.recipient.value }
      : null,
    token: args.token || null,
    limit: args.limit,
  };
}
