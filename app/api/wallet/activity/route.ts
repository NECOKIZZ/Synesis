/**
 * GET /api/wallet/activity
 *
 * Unified activity feed for the Activity tab.
 *
 * Merges two sources into one chronological list:
 *   - `wallet_transactions` (main user-controlled wallet)
 *   - `agent_spend_log`     (agent dev-controlled wallet, when invited)
 *
 * Each row carries a `source` flag ("wallet" | "agent") so the UI can
 * badge it. This is intentionally NOT routed through `/api/agent/status`
 * because that endpoint is invite-gated — non-invited users would never
 * see their main wallet activity.
 */

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Hard cap so a malicious or misbehaving client can't ask for the entire
// audit trail in one shot.
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

interface UnifiedRow {
  id: string;
  source: "wallet" | "agent";
  // Direction relative to the user's wallet.
  kind: "SEND" | "RECEIVE" | "WITHDRAW" | "OTHER";
  counterpartyAddress: string | null;
  counterpartyArcName: string | null;
  amount: number;
  tokenSymbol: string;
  txHash: string | null;
  status: "PENDING" | "COMPLETE" | "FAILED";
  // Optional metadata from agent_spend_log (skill name) so the UI can
  // disambiguate e.g. SWAP / BRIDGE rows that don't fit SEND/RECEIVE.
  agentSkill?: string | null;
  executedAt: string;
}

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Pagination ─────────────────────────────────────────────────────
  const url = new URL(req.url);
  const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(requested) && requested > 0
    ? Math.min(requested, MAX_LIMIT)
    : DEFAULT_LIMIT;

  // ── Pull both tables in parallel ───────────────────────────────────
  // We over-fetch from each (limit*2) so the merge can still produce
  // `limit` truly-most-recent rows even if all of them happen to come
  // from one side.
  const fetchSize = Math.min(limit * 2, MAX_LIMIT);

  const [walletRes, agentRes] = await Promise.all([
    supabase
      .from("wallet_transactions")
      .select("id, direction, counterparty_address, counterparty_arc_name, amount, token_symbol, tx_hash, status, executed_at")
      .eq("user_id", user.id)
      .order("executed_at", { ascending: false })
      .limit(fetchSize),
    supabase
      .from("agent_spend_log")
      .select("id, skill, recipient_address, recipient_arc_name, amount_usdc, tx_hash, status, executed_at, wallet_type")
      .eq("user_id", user.id)
      .eq("wallet_type", "agent") // only agent rows here; main rows live in wallet_transactions
      .order("executed_at", { ascending: false })
      .limit(fetchSize),
  ]);

  if (walletRes.error) {
    console.error("[wallet/activity] wallet_transactions error:", walletRes.error);
  }
  if (agentRes.error) {
    console.error("[wallet/activity] agent_spend_log error:", agentRes.error);
  }

  // ── Normalize rows from both shapes into UnifiedRow ────────────────
  const walletRows: UnifiedRow[] = (walletRes.data ?? []).map((r) => ({
    id: r.id,
    source: "wallet",
    kind: (r.direction as UnifiedRow["kind"]) ?? "OTHER",
    counterpartyAddress: r.counterparty_address ?? null,
    counterpartyArcName: r.counterparty_arc_name ?? null,
    amount: Number(r.amount) || 0,
    tokenSymbol: r.token_symbol ?? "USDC",
    txHash: r.tx_hash ?? null,
    status: normalizeStatus(r.status),
    executedAt: r.executed_at,
  }));

  const agentRows: UnifiedRow[] = (agentRes.data ?? []).map((r) => ({
    id: r.id,
    source: "agent",
    kind: skillToKind(r.skill),
    counterpartyAddress: r.recipient_address ?? null,
    counterpartyArcName: r.recipient_arc_name ?? null,
    amount: Number(r.amount_usdc) || 0,
    tokenSymbol: "USDC",
    txHash: r.tx_hash ?? null,
    status: normalizeStatus(r.status),
    agentSkill: r.skill ?? null,
    executedAt: r.executed_at,
  }));

  // Merge + sort by executedAt desc, then trim to `limit`.
  const merged = [...walletRows, ...agentRows]
    .sort((a, b) => (a.executedAt < b.executedAt ? 1 : -1))
    .slice(0, limit);

  return NextResponse.json({ activity: merged });
}

// ── Helpers ──────────────────────────────────────────────────────────

function normalizeStatus(raw: unknown): UnifiedRow["status"] {
  if (raw === "PENDING" || raw === "COMPLETE" || raw === "FAILED") return raw;
  return "COMPLETE";
}

/**
 * Map an agent skill identifier onto the SEND/RECEIVE/WITHDRAW/OTHER
 * vocabulary the Activity tab understands.
 */
function skillToKind(skill: string | null | undefined): UnifiedRow["kind"] {
  if (!skill) return "OTHER";
  if (skill === "RECEIVE") return "RECEIVE";
  if (skill === "WITHDRAW") return "WITHDRAW";
  if (skill === "SEND_USDC" || skill === "AGENT_SEND") return "SEND";
  return "OTHER";
}
