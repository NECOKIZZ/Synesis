/**
 * POST /api/agent/memory/session-end
 *
 * Layer C — auto session-end summarization.
 *
 * The client fires this when the user closes the tab (via sendBeacon)
 * or has been idle long enough that the conversation is "done." We ask
 * the LLM for a tight 2-3 sentence summary of durable facts ("user
 * prefers Base for cheap bridges, mostly pays maya.arc, asked twice
 * about staking") and persist it to Walrus via the adapter.
 *
 * Hard rules:
 *   - This route NEVER blocks the user. It returns 204 immediately on
 *     any path the client does not need to wait on.
 *   - If Walrus is disabled (MEMWAL_ENABLED unset) → 204, no work.
 *   - If history is too short (<2 user turns) → 204, not worth a summary.
 *   - LLM and Walrus failures are swallowed (logged) — best-effort only.
 *
 * Body: { history: Array<{ role: "user"|"assistant", content: string }> }
 */

import { NextResponse } from "next/server";
import { requireAgentSession, enforceAgentGate } from "@/lib/agent";
import { walrusEnabled, walrusSummarizeAndStore } from "@/lib/memory/walrus-adapter";
import crypto from "node:crypto";

export const runtime = "nodejs";

// Same caps as interpret route — re-validate here, never trust client.
const HISTORY_MAX_TURNS = 24;
const HISTORY_TURN_MAX_CHARS = 1000;
const MIN_USER_TURNS_FOR_SUMMARY = 2;

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

  // Walrus off → nothing to do. Return 204 BEFORE auth so a sendBeacon
  // call from a logged-out tab is also a no-op (no error noise in logs).
  if (!walrusEnabled()) {
    return new NextResponse(null, { status: 204 });
  }

  let session: Awaited<ReturnType<typeof requireAgentSession>>;
  try {
    session = await requireAgentSession();
    await enforceAgentGate(session.supabaseUserId);
  } catch {
    // sendBeacon doesn't surface response status to the client; we
    // simply 204 on auth fail rather than 401 to keep the unload path
    // quiet. The session-end write is a passive nicety, not security.
    return new NextResponse(null, { status: 204 });
  }

  const { supabaseUserId } = session;

  // ── Body ──────────────────────────────────────────────────────────
  let history: ChatTurn[] = [];
  try {
    const body = await req.json();
    history = sanitizeHistory(body?.history);
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  const userTurns = history.filter((t) => t.role === "user").length;
  if (userTurns < MIN_USER_TURNS_FOR_SUMMARY) {
    return new NextResponse(null, { status: 204 });
  }

  // Fire-and-forget the LLM + Walrus work so the response returns
  // immediately. The browser's keepalive/sendBeacon doesn't care about
  // the body — we just need the request accepted.
  void summarizeAndStore(supabaseUserId, history, traceId).catch((err) => {
    console.warn(`[memory/session-end] trace=${traceId} background failed:`, err);
  });

  return new NextResponse(null, { status: 204 });
}

/**
 * Background work: ask the LLM for a tight summary, then hand it to
 * the Walrus adapter. Both calls are catch-wrapped so a failure can't
 * surface anywhere user-visible.
 */
async function summarizeAndStore(userId: string, history: ChatTurn[], traceId: string): Promise<void> {
  const summary = await summarizeWithLLM(history, traceId);
  if (!summary) {
    console.log(`[memory/session-end] trace=${traceId} no summary produced (skipped)`);
    return;
  }
  const ok = await walrusSummarizeAndStore(userId, summary);
  console.log(
    `[memory/session-end] trace=${traceId} stored=${ok} length=${summary.length} preview="${summary.slice(0, 80)}"`,
  );
}

/**
 * Ask the LLM for a 1–3 sentence summary of durable facts only —
 * preferences, recurring patterns, contacts mentioned, intent themes.
 * Explicitly NOT a play-by-play of the conversation.
 *
 * Returns "" if the model declines (e.g. trivial chat) or anything
 * fails. Never throws.
 */
async function summarizeWithLLM(history: ChatTurn[], traceId: string): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return "";
  const model = process.env.OPENROUTER_MODEL ?? "anthropic/claude-3.5-sonnet";
  const referer = process.env.NEXT_PUBLIC_APP_URL ?? "https://wallet.dotarc.my";

  const transcript = history
    .map((t) => `${t.role === "user" ? "USER" : "AGENT"}: ${t.content}`)
    .join("\n");

  const systemPrompt = `You are a memory summarizer for a crypto wallet agent.

Read the transcript below and write 1 to 3 short sentences capturing ONLY
durable facts about the user worth remembering across sessions:
  - preferences ("prefers Base for bridging", "likes EURC over USDC")
  - recurring contacts/patterns ("often pays maya.arc")
  - intent themes ("repeatedly asked about staking risk")
  - one-off facts the user explicitly stated about themselves

DO NOT include:
  - the conversation flow ("user asked X, agent said Y")
  - transient questions answered fully in-session
  - balances, prices, or specific amounts unless the user named them as a rule
  - greetings, smalltalk, or apologies

If nothing in the transcript meets the bar above, output the literal
string: NONE

Output the summary as plain prose. No bullet points, no JSON, no quotes.`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12_000);

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": referer,
        "X-Title": "DotArc Smart Wallet — Memory",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: transcript },
        ],
        max_tokens: 200,
        temperature: 0.2,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[memory/session-end] trace=${traceId} LLM ${res.status}`);
      return "";
    }
    const data = await res.json();
    const content: string = data?.choices?.[0]?.message?.content ?? "";
    const cleaned = content.replace(/^["'`]+|["'`]+$/g, "").trim();
    if (!cleaned || /^none$/i.test(cleaned)) return "";
    // Hard cap so we never ship anything pathological to Walrus.
    return cleaned.slice(0, 600);
  } catch (err) {
    console.warn(`[memory/session-end] trace=${traceId} LLM error:`, err instanceof Error ? err.message : String(err));
    return "";
  } finally {
    clearTimeout(timeoutId);
  }
}
