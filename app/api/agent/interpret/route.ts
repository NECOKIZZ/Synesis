/**
 * POST /api/agent/interpret   (V3 — multi-task)
 *
 * Pass a plain-English instruction through OpenRouter (Claude) and
 * return a V3 InterpretResult: { tasks: Task[], combined_confirmation_message,
 * unknown_reason? }. This route NEVER executes — it interprets and
 * pre-resolves recipients so the UI can render confirmation cards
 * without surprises.
 *
 * Body: { instruction: string }
 *
 * Returns: InterpretResult
 *   - tasks.length === 0 → user message was unintelligible; client shows unknown_reason
 *   - tasks.length >= 1  → client renders confirmation cards, one PIN unlocks the batch
 */

import { NextResponse } from "next/server";
import { requireAgentSession, enforceAgentGate, getAgentAllBalances } from "@/lib/agent";
import { interpretInstructionV3 } from "@/lib/agent-core-v3";
import type { AgentTokenBalance, InterpretResult } from "@/lib/agent-types";
import { resolveRecipient } from "@/lib/ans";
import { batchRequiresPin } from "@/lib/skills/pin-policy";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { recallUserMemory, rememberNote } from "@/lib/memory";
import { walrusEnabled, walrusRecall, walrusRemember } from "@/lib/memory/walrus-adapter";
import { checkRateLimit } from "@/lib/rate-limit";
import crypto from "node:crypto";

export const runtime = "nodejs";

// ── In-session history (Layer A) ──────────────────────────────────────
// The client forwards a trimmed, role-mapped transcript so the model can
// resolve follow-ups. We re-validate + re-clamp it server-side: never
// trust client-supplied array length or content size.
const HISTORY_MAX_TURNS = 12;
const HISTORY_TURN_MAX_CHARS = 1000;

type ChatTurn = { role: "user" | "assistant"; content: string };

function sanitizeHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatTurn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") continue;
    const trimmed = content.trim();
    if (!trimmed) continue;
    out.push({ role, content: trimmed.slice(0, HISTORY_TURN_MAX_CHARS) });
  }
  return out.slice(-HISTORY_MAX_TURNS);
}

export async function POST(req: Request) {
  const traceId = crypto.randomUUID();

  let agentSession: Awaited<ReturnType<typeof requireAgentSession>>;
  try {
    agentSession = await requireAgentSession();
    await enforceAgentGate(agentSession.supabaseUserId);
  } catch (res) {
    return res as Response;
  }

  const { supabaseUserId } = agentSession;

  // ── Rate limit ────────────────────────────────────────────────────
  // Each interpret hits OpenRouter (costs money), so cap per-user volume.
  // Fail-open: a limiter outage never blocks a legit user (see lib/rate-limit).
  const rl = await checkRateLimit(supabaseUserId, "interpret", { max: 10, windowSeconds: 60 });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `You're sending requests too quickly. Try again in ${rl.retryAfterSeconds}s.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  // ── Body ──────────────────────────────────────────────────────────
  let instruction: string;
  let history: ChatTurn[] = [];
  try {
    const body = await req.json();
    instruction = String(body.instruction ?? "").trim();
    history = sanitizeHistory(body.history);
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!instruction) {
    return NextResponse.json({ error: "instruction is required" }, { status: 400 });
  }
  if (instruction.length > 500) {
    return NextResponse.json({ error: "Instruction too long (max 500 chars)" }, { status: 400 });
  }

  console.log(`[agent/interpret] trace=${traceId} instruction="${instruction}" user=${supabaseUserId}`);

  // ── Memory introspection fast-path: "what do you remember…" ──────
  // Returns the user's stored facts as a friendly list. Pulls from
  // BOTH Layer B (Supabase, structured) and Layer C (Walrus, semantic),
  // dedupes, and renders via the chat unknown_reason channel. No LLM
  // round-trip — the data IS the answer.
  if (isMemoryIntrospectionRequest(instruction)) {
    const supabaseRO = await createSupabaseServerClient();
    const [layerB, layerC] = await Promise.all([
      recallUserMemory(supabaseRO, supabaseUserId, 20).catch(() => ""),
      walrusEnabled()
        ? walrusRecall(supabaseUserId, "user habits preferences contacts notes facts", 10).catch(
            () => [] as string[],
          )
        : Promise.resolve([] as string[]),
    ]);
    const lines = renderMemoryListing(layerB, layerC);
    const reply: InterpretResult = {
      tasks: [],
      combined_confirmation_message: "",
      unknown_reason: lines
        ? `Here's what I remember about you:\n\n${lines}`
        : "I don't have any memories about you yet. Send to a contact a few times, or tell me \"remember…\" to teach me something explicit.",
    };
    return NextResponse.json({ ...reply, requires_pin: false });
  }

  // ── Layer C: explicit "remember this" fast-path ───────────────────
  // When the user explicitly tells the agent to remember something,
  // skip the LLM round-trip entirely. Persist to BOTH Layer B (Supabase
  // note row, RLS-bound, durable) and Layer C (Walrus, semantic, only
  // if MEMWAL_ENABLED). Either failing must NOT block the reply.
  const rememberMatch = instruction.match(
    /^\s*(?:please\s+)?remember(?:\s+(?:that|this(?:\s*[:,-])?))?\s+(.+)$/i,
  );
  if (rememberMatch) {
    const note = rememberMatch[1].trim();
    if (note.length >= 3) {
      const service = createSupabaseServiceClient();
      const writes: Promise<unknown>[] = [
        rememberNote(service, supabaseUserId, note).catch((err) =>
          console.warn(`[agent/interpret] trace=${traceId} layer-B remember failed:`, err),
        ),
      ];
      if (walrusEnabled()) {
        writes.push(
          walrusRemember(supabaseUserId, note).catch((err) =>
            console.warn(`[agent/interpret] trace=${traceId} layer-C remember failed:`, err),
          ),
        );
      }
      await Promise.allSettled(writes);
      console.log(`[agent/interpret] trace=${traceId} remembered note (walrus=${walrusEnabled() ? "yes" : "no"})`);
      const reply: InterpretResult = {
        tasks: [],
        combined_confirmation_message: "",
        unknown_reason: "Got it — I'll remember that.",
      };
      return NextResponse.json({ ...reply, requires_pin: false });
    }
  }

  const supabase = await createSupabaseServerClient();

  // ── Agent wallet ──────────────────────────────────────────────────
  const { data: wallet } = await supabase
    .from("agent_wallets")
    .select("circle_wallet_id")
    .eq("user_id", supabaseUserId)
    .maybeSingle();
  if (!wallet) {
    return NextResponse.json({ error: "Agent wallet not activated" }, { status: 400 });
  }

  // ── Balance + limits context for the LLM ──────────────────────────
  let agentBalanceUsdc = "0";
  let allBalances: AgentTokenBalance[] = [];
  try {
    allBalances = await getAgentAllBalances(wallet.circle_wallet_id);
    agentBalanceUsdc = allBalances.find((b) => b.symbol === "USDC")?.amount ?? "0";
  } catch {
    // non-fatal — Claude will see "0" and pick safe defaults
  }

  const { data: limitsRow } = await supabase
    .from("user_spend_limits")
    .select("max_per_transaction_usdc, max_daily_usdc, max_weekly_usdc, max_monthly_usdc")
    .eq("user_id", supabaseUserId)
    .maybeSingle();

  const limits = {
    max_per_transaction_usdc: Number(limitsRow?.max_per_transaction_usdc ?? 50),
    max_daily_usdc: Number(limitsRow?.max_daily_usdc ?? 100),
    max_weekly_usdc: Number(limitsRow?.max_weekly_usdc ?? 300),
    max_monthly_usdc: Number(limitsRow?.max_monthly_usdc ?? 500),
  };

  // ── Active policies (interpreter context) ─────────────────────────
  const { data: activePolicies } = await supabase
    .from("agent_policies")
    .select("id, policy_summary, policy_category, trigger_type, action_skill, execution_mode")
    .eq("user_id", supabaseUserId)
    .eq("active", true)
    .order("created_at", { ascending: false });

  const formattedPolicies = (activePolicies ?? []).map((p) => ({
    id: p.id,
    summary: p.policy_summary ?? "Untitled policy",
    category: p.policy_category,
    trigger: p.trigger_type,
    action: p.action_skill,
    mode: p.execution_mode,
  }));

  // ── Layer B + C memory recall (habits/preferences/notes) ──────────
  // Non-fatal: a memory failure must never block interpretation. Layer B
  // (Supabase) is RLS-scoped via the server client. Layer C (Walrus) is
  // a semantic search over the user's namespace, queried with the live
  // instruction so the model gets contextually-relevant facts. Both
  // sources are merged into ONE delimited block; the prompt already
  // tells the model to treat memory as untrusted background data.
  let memoryContext = "";
  try {
    const [layerB, layerC] = await Promise.all([
      recallUserMemory(supabase, supabaseUserId).catch((err) => {
        console.warn(`[agent/interpret] trace=${traceId} layer-B recall failed:`, err);
        return "";
      }),
      walrusEnabled()
        ? walrusRecall(supabaseUserId, instruction, 3).catch((err) => {
            console.warn(`[agent/interpret] trace=${traceId} layer-C recall failed:`, err);
            return [] as string[];
          })
        : Promise.resolve([] as string[]),
    ]);
    const layerCBlock = layerC.length
      ? layerC.map((f) => `- ${f.replace(/^\[session-summary\]\s*/i, "")}`).join("\n")
      : "";
    memoryContext = [layerB, layerCBlock].filter(Boolean).join("\n");
    if (layerC.length) {
      console.log(`[agent/interpret] trace=${traceId} layer-C recalled ${layerC.length} fact(s)`);
    }
  } catch (err) {
    console.warn(`[agent/interpret] trace=${traceId} memory recall failed:`, err);
  }

  // ── OpenRouter call (V3 prompt + validator) ───────────────────────
  let result: InterpretResult;
  try {
    result = await interpretInstructionV3({
      instruction,
      history,
      context: {
        limits,
        agentBalanceUsdc,
        activePolicies: formattedPolicies,
        allBalances,
        memoryContext,
      },
    });
    console.log(
      `[agent/interpret] trace=${traceId} tasks=${result.tasks.length} triggers=${result.tasks.map((t) => t.trigger.type).join(",") || "none"} unknown=${result.unknown_reason ? "yes" : "no"}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[agent/interpret] trace=${traceId} OpenRouter error: ${msg}`);
    return NextResponse.json(
      { error: "AI interpretation failed. Check OPENROUTER_API_KEY." },
      { status: 502 },
    );
  }

  // ── Pre-resolve recipient .arc names across every step ────────────
  // Only resolve names; addresses and $prev refs are left alone.
  for (const name of extractRecipientNames(result)) {
    try {
      await resolveRecipient(name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : `Cannot resolve "${name}"`;
      console.warn(`[agent/interpret] trace=${traceId} recipient_fail="${name}" msg="${msg}"`);
      // Don't throw — degrade the result to an "unknown" outcome so the
      // chat shows the user a clean error instead of a 500.
      const degraded: InterpretResult = {
        tasks: [],
        combined_confirmation_message: msg,
        unknown_reason: `${msg}. Please check the .arc name or wallet address and try again.`,
      };
      return NextResponse.json({ ...degraded, requires_pin: false }, { status: 200 });
    }
  }

  // Tell the client whether the PIN input should appear on the
  // confirmation card. Read-only batches (CHECK_BALANCE, LIST_POLICIES,
  // SET_LIMIT, SWAP_USDC, etc.) skip the PIN UX entirely.
  const requiresPin = batchRequiresPin(result.tasks, agentSession.session.walletAddress);
  return NextResponse.json({ ...result, requires_pin: requiresPin });
}

/**
 * True if the user's message is asking the agent to enumerate what it
 * has stored about them. Kept tight on purpose — we'd rather miss a
 * paraphrase and route through the LLM than misfire on a real send.
 */
function isMemoryIntrospectionRequest(instruction: string): boolean {
  const s = instruction.trim().toLowerCase().replace(/[?!.]+$/g, "");
  return (
    /^what (do|have) you (remember|know|stored|saved)/.test(s) ||
    /^what do you know about me\b/.test(s) ||
    /^(show|list|tell me) (my|your|all|the) (memor|note|fact|stored)/.test(s) ||
    /^what'?s in your memory\b/.test(s) ||
    /^(do you )?remember (me|anything (about me)?|us)$/.test(s)
  );
}

/**
 * Render Layer B (already a "- foo\n- bar" block) + Layer C (string
 * array) into a single deduped, numbered listing. Walrus session-summary
 * tags are stripped so the user sees clean prose.
 */
function renderMemoryListing(layerB: string, layerC: string[]): string {
  const seen = new Set<string>();
  const items: string[] = [];

  const pushUnique = (raw: string) => {
    const cleaned = raw.replace(/^\s*[-•]\s*/, "").replace(/^\[session-summary\]\s*/i, "").trim();
    if (!cleaned) return;
    const key = cleaned.toLowerCase().slice(0, 80);
    if (seen.has(key)) return;
    seen.add(key);
    items.push(cleaned);
  };

  for (const line of layerB.split("\n")) pushUnique(line);
  for (const fact of layerC) pushUnique(fact);

  if (items.length === 0) return "";
  return items.map((s, i) => `${i + 1}. ${s}`).join("\n");
}

/**
 * Walk every step in every task and yield recipient names that need
 * ANS resolution (skipping raw 0x addresses and $prev references).
 */
function extractRecipientNames(result: InterpretResult): string[] {
  const out: string[] = [];
  for (const task of result.tasks) {
    for (const step of task.steps) {
      if (step.skill !== "SEND_USDC" && step.skill !== "SEND_TOKEN") continue;
      const r = String(step.params.recipient ?? "").trim();
      if (!r || r.startsWith("0x") || r.startsWith("$prev")) continue;
      out.push(r);
    }
  }
  return out;
}
