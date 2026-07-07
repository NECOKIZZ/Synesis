/**
 * Synesis / Synesis — Contact Memory (typed behavioral aggregate).
 *
 * The read + write surface for `agent_contact_mem` (migration 0015):
 *   - recordContactInteraction(service, …)  → deterministic post-skill updater
 *   - recallTopContacts(supabase, userId)    → Tier-1 always-inject digest
 *
 * DESIGN CONTRACT
 *   - This is the typed home for anything we do MATH on (counts, USD
 *     volume, rankings). Learned/unstructured facts (preferences, notes,
 *     open loops) live in MemWal; durable always-on personalization will
 *     live in a small user_profile store.
 *   - Counters are NEVER derived from the LLM. recordContactInteraction is
 *     called once per SUCCESSFUL transfer with the skill's real params:
 *     outbound from the executor (confirm-policy), inbound from the Circle
 *     webhook (only on a genuinely new ledger row → idempotent).
 *   - Every write is best-effort. A memory failure must never affect the
 *     user's transaction or response — callers wrap, and the underlying RPC
 *     errors are swallowed here.
 *
 * The aggregate is rebuildable from agent_spend_log, so this module never
 * has to be the source of truth — it's an injection-shaped cache.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordMemOk, recordMemFail } from "./mem-health";

// ── USD valuation (write-time, for the relationship volume rollup) ──────
// NOT a spend gate — a coarse display valuation so "total volume with sara"
// is meaningful across tokens. Mirrors DISPLAY_USD_RATES in lib/agent.ts.
// Single-chain today: USDC ≈ USD. Revisit when a live multi-asset oracle
// feeds the recorder directly.
const DISPLAY_USD_RATES: Record<string, number> = {
  USDC: 1,
  EURC: 1.08,
  CIRBTC: 100_000,
};

function toUsd(amount: number, token: string): number {
  const rate = DISPLAY_USD_RATES[token.toUpperCase()] ?? 0;
  const usd = amount * rate;
  return Number.isFinite(usd) ? Math.round(usd * 1e6) / 1e6 : 0;
}

// ── Recorder (write) ────────────────────────────────────────────────────

export type ContactDirection = "out" | "in";

export type ContactInteraction = {
  /** Counterparty on-chain address (authoritative, post-resolution). */
  address: string;
  /** .arc name / first name if known — a mutable display label. */
  alias?: string | null;
  direction: ContactDirection;
  /** Token symbol moved (USDC / EURC / cirBTC). Defaults to USDC. */
  token?: string | null;
  /** Native token amount moved this interaction. Used to compute USD. */
  amount?: number | null;
  /** The skill that produced this interaction (SEND_USDC / SEND_TOKEN / RECEIVE). */
  skill: string;
};

/**
 * Record one completed transfer into the contact aggregate. Best-effort:
 * resolves USD at write time, then calls the atomic RPC. Swallows its own
 * errors so a memory hiccup never surfaces to the user.
 *
 * Idempotency is the CALLER's responsibility — this must be invoked exactly
 * once per successful transfer (the executor fires once per batch; the
 * webhook fires only on a new ledger row).
 */
export async function recordContactInteraction(
  service: SupabaseClient,
  userId: string,
  info: ContactInteraction,
): Promise<void> {
  const address = (info.address || "").trim();
  if (!address) return;

  const token = (info.token || "USDC").toUpperCase();
  const amount = typeof info.amount === "number" && Number.isFinite(info.amount) ? info.amount : 0;
  const amountUsd = toUsd(amount, token);
  const alias = info.alias?.replace(/\.arc$/i, "").trim() || null;

  const { error } = await service.rpc("record_contact_interaction", {
    p_user_id: userId,
    p_address: address,
    p_alias: alias,
    p_direction: info.direction,
    p_token: token,
    p_amount_usd: amountUsd,
    p_skill: info.skill,
  });

  if (error) {
    recordMemFail("contact", error);
    console.warn(
      `[contact-mem] record_contact_interaction failed (dir=${info.direction} skill=${info.skill}):`,
      error.message,
    );
  } else {
    recordMemOk("contact");
    // Success log so memory writes are visible during testing — confirms the
    // aggregate actually moved on a confirmed transfer.
    const who = alias ? `${alias}.arc` : `${address.slice(0, 8)}…`;
    const amt = amountUsd > 0 ? ` $${amountUsd}` : "";
    console.log(
      `[contact-mem] recorded ${info.direction} ${token}${amt} ${info.direction === "out" ? "→" : "←"} ${who} (skill=${info.skill})`,
    );
  }
}

// ── Recall (read) — Tier-1 always-inject digest ─────────────────────────

type ContactRow = {
  counterparty_address: string;
  counterparty_alias: string | null;
  send_count: number;
  receive_count: number;
  total_sent_usd: number | string;
  total_received_usd: number | string;
  by_token: Record<string, { sent?: number; recv?: number; count?: number }> | null;
  last_interacted_at: string | null;
};

export type ContactDigestOptions = {
  /** Max contacts to surface. Kept small to protect the prompt budget. */
  limit?: number;
};

const DEFAULT_DIGEST_LIMIT = 6;

/**
 * Build the compact "who you pay" block injected into the system prompt.
 * Ranked by recency (a payments wallet cares most about who you've dealt
 * with lately). Returns "" when the user has no contacts yet, so the caller
 * can omit the section entirely.
 *
 * Example output:
 *   sara.arc — 12 sends, $340 total, usually USDC, last 3d ago
 *   david.arc — 9 sends, $1,450 total, last 22 Jun
 */
export async function recallTopContacts(
  supabase: SupabaseClient,
  userId: string,
  options: ContactDigestOptions = {},
): Promise<string> {
  const limit = options.limit ?? DEFAULT_DIGEST_LIMIT;

  const { data, error } = await supabase
    .from("agent_contact_mem")
    .select(
      "counterparty_address, counterparty_alias, send_count, receive_count, total_sent_usd, total_received_usd, by_token, last_interacted_at",
    )
    .eq("user_id", userId)
    .order("last_interacted_at", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error || !data || data.length === 0) return "";

  return (data as ContactRow[]).map(formatContactLine).filter(Boolean).join("\n");
}

/** One human line per contact, built from the row at read time. */
function formatContactLine(row: ContactRow): string {
  const label = row.counterparty_alias
    ? `${row.counterparty_alias}.arc`
    : shortAddr(row.counterparty_address);

  const parts: string[] = [];
  if (row.send_count > 0) parts.push(`${row.send_count} send${row.send_count === 1 ? "" : "s"}`);
  if (row.receive_count > 0) parts.push(`${row.receive_count} received`);

  const sent = Number(row.total_sent_usd) || 0;
  if (sent > 0) parts.push(`$${fmtMoney(sent)} total`);

  const fav = favoriteToken(row.by_token);
  if (fav && fav !== "USDC") parts.push(`usually ${fav}`);

  const last = row.last_interacted_at ? `last ${relativeDate(row.last_interacted_at)}` : null;
  if (last) parts.push(last);

  return `${label} — ${parts.join(", ")}`;
}

/** Most-used token by interaction count from the by_token bucket. */
function favoriteToken(byToken: ContactRow["by_token"]): string | null {
  if (!byToken || typeof byToken !== "object") return null;
  let best: string | null = null;
  let bestCount = -1;
  for (const [token, stats] of Object.entries(byToken)) {
    const count = typeof stats?.count === "number" ? stats.count : 0;
    if (count > bestCount) {
      bestCount = count;
      best = token;
    }
  }
  return best;
}

// ── Formatting helpers ──────────────────────────────────────────────────

function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function fmtMoney(n: number): string {
  // Whole dollars for readability in the prompt; cents add noise.
  return Math.round(n).toLocaleString("en-US");
}

/**
 * Compact relative date for the prompt: "3d ago", "5h ago", or an absolute
 * "22 Jun" once it's older than a week. Avoids Date.now-style churn in the
 * prompt while staying human.
 */
function relativeDate(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "recently";
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const d = new Date(then);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}
