/**
 * POST /api/agent/memory/session-end
 *
 * Layer C — auto session-end summarization.
 *
 * The client fires this when the user closes the tab (via sendBeacon)
 * or has been idle long enough that the conversation is "done." We ask
 * the LLM for a structured 3-section episodic summary — PREFERENCES /
 * OPEN LOOPS / TONE — capturing ONLY what the structured DB can't hold,
 * and persist it to Walrus via the adapter. Completed actions are NEVER
 * summarized here (they live in agent_spend_log + agent_contact_mem), so
 * Walrus never duplicates — or hallucinates — a fact a table already owns.
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
import { getProfileCard, upsertProfileCard } from "@/lib/memory";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
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

  // Both memory layers off → nothing to do. Return 204 BEFORE auth so a
  // sendBeacon from a logged-out tab is also a no-op (no error noise).
  const profileEnabled = process.env.USER_PROFILE_ENABLED === "true";
  if (!walrusEnabled() && !profileEnabled) {
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

  // Fire-and-forget both memory layers so the response returns immediately.
  // The browser's keepalive/sendBeacon doesn't care about the body — we just
  // need the request accepted. The two layers are independent:
  //   - MemWal episodic summary (semantic recall layer)
  //   - user_profile card merge  (durable always-on layer)
  if (walrusEnabled()) {
    void summarizeAndStore(supabaseUserId, history, traceId).catch((err) => {
      console.warn(`[memory/session-end] trace=${traceId} memwal background failed:`, err);
    });
  }
  if (profileEnabled) {
    void mergeAndStoreProfile(supabaseUserId, history, traceId).catch((err) => {
      console.warn(`[memory/session-end] trace=${traceId} profile background failed:`, err);
    });
  }

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
  // Stamp the session date so recalled summaries carry temporal context
  // ("3 weeks ago you said…") — the model can weigh recency and resolve
  // open loops against when they were raised.
  const today = new Date().toISOString().slice(0, 10);
  const dated = `(${today}) ${summary}`;
  const ok = await walrusSummarizeAndStore(userId, dated);
  console.log(
    `[memory/session-end] trace=${traceId} stored=${ok} date=${today} length=${summary.length} preview="${summary.slice(0, 80)}"`,
  );
}

/**
 * Ask the LLM for a structured, 3-section episodic summary capturing ONLY
 * what the structured database cannot hold — PREFERENCES, OPEN LOOPS, TONE.
 * Deliberately excludes completed ACTIONS (those live in agent_spend_log +
 * agent_contact_mem, recorded deterministically) so Walrus never duplicates
 * — and never hallucinates — facts a table already holds accurately.
 *
 * The output is stored PERMANENTLY and recalled in future sessions, so the
 * prompt is built to fail closed: omit-when-unsure, never invent.
 *
 * Returns "" if nothing meets the bar (model outputs NONE) or anything
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
Your output is stored PERMANENTLY and injected into FUTURE sessions, so
accuracy matters more than completeness — a single invented fact silently
corrupts every session that follows.

Capture ONLY durable, episodic facts that a structured database CANNOT hold,
under these three headings:

PREFERENCES — rules/likes/dislikes the user STATED or clearly demonstrated
  ("prefers EURC over USDC", "always skips the confirmation step", "hates
  high bridge fees").
OPEN LOOPS — things the user raised but did NOT finish ("asked about the
  cirBTC price but didn't buy", "said they'd pay maya later this week").
TONE — one short clause on communication style ("terse, wants execution not
  explanation").

NEVER include:
  - completed actions (sends, swaps, bridges, balances, prices, amounts) —
    those are recorded elsewhere; restating them here is forbidden.
  - the conversation play-by-play, greetings, or smalltalk.
  - ANYTHING the user did not explicitly say or clearly demonstrate. Do NOT
    infer a preference from one action. When unsure, leave it out.

Format: one line per heading, "HEADING: <content>". Include a heading ONLY if
it has real content — omit empty ones entirely. If NOTHING across all three
meets the bar, output exactly: NONE`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12_000);

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": referer,
        "X-Title": "Synesis Smart Wallet - Memory",
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

// ── user_profile: durable always-on card merge ─────────────────────────

/**
 * Update the user's profile card from this session. Fetches the existing
 * card, asks the LLM to MERGE in any new durable style/preference (curate,
 * don't append — dedupe, drop stale), and upserts the result. Skips the
 * write when nothing changed. Fully best-effort; never throws to the caller.
 */
async function mergeAndStoreProfile(userId: string, history: ChatTurn[], traceId: string): Promise<void> {
  const service = createSupabaseServiceClient();
  const existing = await getProfileCard(service, userId);
  const updated = await mergeProfileCardLLM(existing, history, traceId);
  if (!updated || updated.trim() === existing.trim()) {
    console.log(`[memory/session-end] trace=${traceId} profile unchanged`);
    return;
  }
  await upsertProfileCard(service, userId, updated);
  console.log(
    `[memory/session-end] trace=${traceId} profile updated length=${updated.length} preview="${updated.slice(0, 80).replace(/\s+/g, " ")}"`,
  );
}

/**
 * Ask the LLM to produce the UPDATED profile card from (existing card +
 * session). Durable communication style + standing preferences ONLY —
 * never actions, amounts, or one-off requests, and never invented. Returns
 * "" on NONE / failure (caller then skips the write).
 */
async function mergeProfileCardLLM(existing: string, history: ChatTurn[], traceId: string): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return "";
  const model = process.env.OPENROUTER_MODEL ?? "anthropic/claude-3.5-sonnet";
  const referer = process.env.NEXT_PUBLIC_APP_URL ?? "https://wallet.dotarc.my";

  const transcript = history
    .map((t) => `${t.role === "user" ? "USER" : "AGENT"}: ${t.content}`)
    .join("\n");

  const systemPrompt = `You maintain a SMALL, durable profile card for a wallet
user — ONLY their communication style and STANDING preferences (defaults/rules
that persist across sessions). The card is injected into EVERY future session,
so it must stay short, high-signal, and accurate. A wrong card silently skews
every future response.

You are given the CURRENT card (may be empty) and a new session transcript.
Output the UPDATED card:
  - Integrate any new durable style/preference the user clearly demonstrated or
    stated ("terse, wants execution not explanation", "defaults to EURC").
  - Keep existing facts that still hold; drop any the session contradicts.
  - Merge duplicates. Keep it to a few short lines, under ~400 characters.

NEVER include: completed actions, balances, amounts, prices, one-off requests,
open loops, or anything not clearly durable. Do NOT infer a standing rule from
a single action. When unsure, leave it out.

If there is nothing durable to record and the current card is empty, output
exactly: NONE
Output ONLY the card text — no preamble, no quotes.`;

  const userContent = `CURRENT CARD:\n${existing || "(empty)"}\n\nSESSION TRANSCRIPT:\n${transcript}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12_000);

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": referer,
        "X-Title": "Synesis Smart Wallet - Profile",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        max_tokens: 200,
        temperature: 0.2,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[memory/session-end] trace=${traceId} profile LLM ${res.status}`);
      return "";
    }
    const data = await res.json();
    const content: string = data?.choices?.[0]?.message?.content ?? "";
    const cleaned = content.replace(/^["'`]+|["'`]+$/g, "").trim();
    if (!cleaned || /^none$/i.test(cleaned)) return "";
    return cleaned.slice(0, 600);
  } catch (err) {
    console.warn(`[memory/session-end] trace=${traceId} profile LLM error:`, err instanceof Error ? err.message : String(err));
    return "";
  } finally {
    clearTimeout(timeoutId);
  }
}
