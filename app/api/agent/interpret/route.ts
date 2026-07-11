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
import { requireAgentSession, enforceAgentGate, getAgentAllBalances, readBalanceCache } from "@/lib/agent";
import { interpretInstructionV3 } from "@/lib/agent-core-v3";
import { getLivePrices } from "@/lib/agent-core";
import { selectSkills } from "@/lib/skill-router";
import { formatInterpretDiagnostics, type BalanceSource } from "@/lib/agent-diagnostics";
import type { SkillCatalogEntry } from "@/lib/skills/catalog";
import type { AgentTokenBalance, InterpretResult } from "@/lib/agent-types";
import { resolveRecipient } from "@/lib/ans";
import { toAppError } from "@/lib/errors";
import { batchRequiresPin, totalUpfrontUsdc, batchAutoConfirm } from "@/lib/skills/pin-policy";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { selectIntentMemory, getProfileCard } from "@/lib/memory";
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

/**
 * Validate a client-supplied IANA timezone (e.g. "Africa/Lagos"). Returns
 * undefined for anything missing or not recognised by the runtime — the
 * interpreter then falls back to UTC (the cross-platform default). We verify
 * against Intl so a junk string can't reach the schedule math.
 */
function sanitizeTimezone(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const tz = raw.trim();
  if (!tz || tz.length > 64) return undefined;
  try {
    // Throws RangeError for an unknown/invalid identifier.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
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
  let timezone: string | undefined;
  try {
    const body = await req.json();
    instruction = String(body.instruction ?? "").trim();
    history = sanitizeHistory(body.history);
    timezone = sanitizeTimezone(body.timezone);
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
  // Returns the user's stored facts as a friendly list, recalled from
  // MemWal (the single learned-memory store). Rendered via the chat
  // unknown_reason channel — no LLM round-trip, the data IS the answer.
  if (isMemoryIntrospectionRequest(instruction)) {
    const facts = walrusEnabled()
      ? await walrusRecall(
          supabaseUserId,
          "user habits preferences contacts notes facts communication style",
          15,
        ).catch(() => [] as string[])
      : [];
    const lines = renderMemoryListing(facts);
    const reply: InterpretResult = {
      tasks: [],
      combined_confirmation_message: "",
      unknown_reason: lines
        ? `Here's what I remember about you:\n\n${lines}`
        : "I don't have any memories about you yet. Use the wallet a few times, or tell me \"remember…\" to teach me something explicit.",
    };
    return NextResponse.json({ ...reply, requires_pin: false });
  }

  // ── Explicit "remember this" fast-path ────────────────────────────
  // When the user explicitly tells the agent to remember something, skip
  // the LLM round-trip and persist it to MemWal (the single learned-memory
  // store) as a dated [note] fact. Best-effort — a write failure must not
  // block the reply.
  const rememberMatch = instruction.match(
    /^\s*(?:please\s+)?remember(?:\s+(?:that|this(?:\s*[:,-])?))?\s+(.+)$/i,
  );
  if (rememberMatch) {
    const note = rememberMatch[1].trim();
    if (note.length >= 3) {
      const today = new Date().toISOString().slice(0, 10);
      if (walrusEnabled()) {
        await walrusRemember(supabaseUserId, `[note] (${today}) ${note}`).catch((err) =>
          console.warn(`[agent/interpret] trace=${traceId} memwal remember failed:`, err),
        );
      }
      console.log(`[agent/interpret] trace=${traceId} remembered note (memwal=${walrusEnabled() ? "yes" : "no"})`);
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
    .select("circle_wallet_id, balance_cache, balance_cache_at")
    .eq("user_id", supabaseUserId)
    .maybeSingle();
  if (!wallet) {
    return NextResponse.json({ error: "Agent wallet not activated" }, { status: 400 });
  }

  // ── Balance + limits context for the LLM ──────────────────────────
  // V3.5 Track 1: prefer the webhook-maintained balance cache (a fast DB
  // read we already have in hand) over a live Circle round-trip — the
  // dominant latency cost in the pre-LLM path. The cache is eventually
  // consistent and feeds the LLM's first-filter ONLY; spend-time gates
  // still read Circle live. Fall back to live when the flag is off, or
  // when the cache is missing / empty / stale (>10 min).
  const BALANCE_CACHE_ENABLED = process.env.BALANCE_CACHE_ENABLED === "true";
  const BALANCE_CACHE_MAX_AGE_S = 600;

  let agentBalanceUsdc = "0";
  let allBalances: AgentTokenBalance[] = [];
  let balanceServed = false;
  // Diagnostics: which path served the balance, and how stale it was. Fed
  // into the unified interpret-diagnostics block below (block #2).
  let balanceSource: BalanceSource = "unavailable";
  let balanceAgeSeconds: number | null = null;

  if (BALANCE_CACHE_ENABLED) {
    const cached = readBalanceCache(wallet.balance_cache, wallet.balance_cache_at);
    if (cached && cached.ageSeconds <= BALANCE_CACHE_MAX_AGE_S) {
      allBalances = cached.balances;
      agentBalanceUsdc = allBalances.find((b) => b.symbol === "USDC")?.amount ?? "0";
      balanceServed = true;
      balanceSource = "cache";
      balanceAgeSeconds = cached.ageSeconds;
    }
  }

  if (!balanceServed) {
    try {
      allBalances = await getAgentAllBalances(wallet.circle_wallet_id);
      agentBalanceUsdc = allBalances.find((b) => b.symbol === "USDC")?.amount ?? "0";
      balanceSource = "live";
    } catch {
      // non-fatal — Claude will see "0" and pick safe defaults; source
      // stays "unavailable" so the diagnostics block flags the gap.
    }
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
  // Diagnostics flag: did these come from a user_spend_limits row, or are we
  // showing the model the hardcoded defaults? (block #3)
  const limitsFromDb = !!limitsRow;

  // ── User identity (V3.5 Track 3) ──────────────────────────────────
  // Tell the model which .arc user it's serving so it can personalise
  // wording and resolve first-person references. Behind a flag — when off,
  // no fetch happens and the prompt stays byte-identical to V3. A freshly
  // registered user with a null arc_name simply yields undefined (no line).
  const IDENTITY_INJECT_ENABLED = process.env.AGENT_IDENTITY_INJECT === "true";
  let userArcName: string | undefined;
  if (IDENTITY_INJECT_ENABLED) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("arc_name")
      .eq("id", supabaseUserId)
      .maybeSingle();
    userArcName = profile?.arc_name ?? undefined;
  }

  // ── User profile (durable always-on personalization, migration 0018) ──
  // The curated card (communication style + standing prefs), injected on
  // every call right after the identity line — the always-on layer MemWal's
  // semantic recall can't guarantee. Behind a flag; best-effort (a miss
  // yields "" and the block is simply omitted).
  const USER_PROFILE_ENABLED = process.env.USER_PROFILE_ENABLED === "true";
  let userProfile = "";
  if (USER_PROFILE_ENABLED) {
    userProfile = await getProfileCard(supabase, supabaseUserId);
    console.log(
      `[agent/interpret] trace=${traceId} [profile] ${userProfile ? `injected ${userProfile.length}ch` : "no card yet"}`,
    );
  }

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

  // ── MemWal episodic recall (learned facts: prefs / open loops / notes) ──
  // Non-fatal: a memory failure must never block interpretation. Semantic
  // search over the user's MemWal namespace, queried with the live
  // instruction so the model gets contextually-relevant facts. Rendered as
  // a delimited block; the prompt treats memory as untrusted background data.
  let memoryContext = "";
  // Diagnostics: how many facts MemWal contributed this call (block #8).
  let memFactCount = 0;
  if (walrusEnabled()) {
    try {
      const facts = await walrusRecall(supabaseUserId, instruction, 3).catch((err) => {
        console.warn(`[agent/interpret] trace=${traceId} memwal recall failed:`, err);
        return [] as string[];
      });
      memFactCount = facts.length;
      memoryContext = facts.length
        ? facts.map((f) => `- ${stripMemoryTag(f)}`).join("\n")
        : "";
    } catch (err) {
      console.warn(`[agent/interpret] trace=${traceId} memory recall failed:`, err);
    }
  }

  // ── Skill router (V3.5 Track 4) ───────────────────────────────────
  // Embed the instruction and pull the top-K most relevant skills so the
  // prompt carries only the catalog entries that matter for this message.
  // Behind a flag — when off, skillsToInject stays undefined and the prompt
  // builder renders its hardcoded full catalog (byte-identical to V3). The
  // router never throws (it self-falls-back to the full catalog on any
  // failure); the extra try/catch is belt-and-braces so a router outage can
  // never break interpret.
  const SKILL_ROUTER_ENABLED = process.env.SKILL_ROUTER_ENABLED === "true";
  let skillsToInject: SkillCatalogEntry[] | undefined;
  // Diagnostics: exactly what the vector router injected this call (block #6).
  const routerDiag = {
    enabled: SKILL_ROUTER_ENABLED,
    selected: [] as string[],
    topCosine: null as number | null,
    usedFallback: false,
    fallbackReason: undefined as string | undefined,
  };
  if (SKILL_ROUTER_ENABLED) {
    try {
      // Service client: the router reads admin-curated skill data (not user-
      // scoped) AND logs low-confidence misses to skill_router_misses, which
      // is service-role-only by design. The RLS-bound user client can't insert
      // there, so the router runs on the service client.
      const selected = await selectSkills(createSupabaseServiceClient(), instruction, {
        userId: supabaseUserId,
        traceId,
      });
      skillsToInject = selected.skills;
      routerDiag.selected = selected.skills.map((s) => s.skill_name);
      routerDiag.topCosine = selected.topCosine;
      routerDiag.usedFallback = selected.usedFallback;
      routerDiag.fallbackReason = selected.fallbackReason;
    } catch (err) {
      // Leave skillsToInject undefined → prompt builder uses full catalog.
      routerDiag.usedFallback = true;
      routerDiag.fallbackReason = "route_exception";
      console.warn(`[agent/interpret] trace=${traceId} [router] unexpected failure — using full catalog:`, err);
    }
  }

  // ── Intent-gated contact memory (V3.5+) ───────────────────────────
  // Drive memory injection off the router's CONFIDENT output: if it selected
  // a contact-feeding skill (SEND_USDC / SEND_TOKEN), inject the contact
  // digest; otherwise inject nothing. This is why "hello" gets no contact
  // memory and "send sara 5" does — same embedding, no second classifier.
  //
  // CRITICAL: when the router FELL BACK to the full catalog (low confidence /
  // error), it has NOT identified an intent — it injected everything as
  // insurance. Treating that as "user wants to send" would fire the contact
  // bucket on ANY ambiguous message (e.g. "hi" → full catalog includes
  // SEND_USDC → contact digest). So on fallback we pass an EMPTY selection:
  // no confident intent → no intent-specific memory.
  // Behind a flag; best-effort (a memory miss never breaks interpret).
  const CONTACT_MEM_INJECT = process.env.CONTACT_MEM_INJECT === "true";
  let contactMemory = "";
  const contactMemDiag = {
    enabled: CONTACT_MEM_INJECT,
    injected: false,
    bucket: null as string | null,
    triggerSkill: null as string | null,
    count: 0,
  };
  if (CONTACT_MEM_INJECT) {
    try {
      const intentSkills = routerDiag.usedFallback ? [] : routerDiag.selected;
      const im = await selectIntentMemory(supabase, supabaseUserId, intentSkills);
      contactMemory = im.block;
      contactMemDiag.injected = !!im.block;
      contactMemDiag.bucket = im.bucket;
      contactMemDiag.triggerSkill = im.triggerSkill;
      contactMemDiag.count = im.count;
    } catch (err) {
      console.warn(`[agent/interpret] trace=${traceId} contact-mem inject failed:`, err);
    }
  }

  // ── Live prices (oracle) ──────────────────────────────────────────
  // Fetch here (rather than letting interpretInstructionV3 fetch lazily) so
  // the diagnostics block can report them AND we avoid a second oracle call.
  // getLivePrices has its own fallback; the catch is belt-and-braces.
  const livePrices = await getLivePrices().catch(() => ({
    eurcUsdc: 1.08,
    cirBtcUsdc: 100_000,
  }));

  // ── Unified interpret diagnostics (all 8 LLM inputs, one block) ────
  // Single console.log so the whole block lands as one write and never
  // interleaves with concurrent requests. This is the demo-triage view:
  // "what did the model actually see?" at a glance.
  console.log(
    formatInterpretDiagnostics({
      traceId,
      instruction,
      userArcName,
      identityInjectEnabled: IDENTITY_INJECT_ENABLED,
      profileChars: userProfile.length,
      balances: allBalances,
      balanceSource,
      balanceAgeSeconds,
      balanceCacheEnabled: BALANCE_CACHE_ENABLED,
      limits,
      limitsFromDb,
      policies: formattedPolicies,
      history,
      router: routerDiag,
      livePrices,
      memory: {
        factCount: memFactCount,
        walrusEnabled: walrusEnabled(),
      },
      contactMem: contactMemDiag,
    }),
  );

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
        contactMemory,
        userArcName,
        userProfile,
        skillsToInject,
        livePrices,
        timezone,
      },
    });
    console.log(
      `[agent/interpret] trace=${traceId} tasks=${result.tasks.length} triggers=${result.tasks.map((t) => t.trigger.type).join(",") || "none"} unknown=${result.unknown_reason ? "yes" : "no"} tz=${timezone ?? "UTC"}`,
    );
    // Logs-only troubleshooting block: the model's own reasoning + the context
    // it cited, correlated by traceId. Stripped from the client response below.
    console.log(
      `[agent/interpret] trace=${traceId} [reasoning] ${result.reasoning ?? "(none)"}` +
        (result.citations?.length ? `\n[agent/interpret] trace=${traceId} [citations] ${result.citations.join(" | ")}` : ""),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // `fetch failed` from undici is a generic wrapper — the ACTUAL reason
    // (UND_ERR_CONNECT_TIMEOUT, ECONNRESET, ENOTFOUND, cert error, abort)
    // lives on err.cause, which the old handler threw away. Surface it so a
    // transport failure is diagnosable instead of opaque.
    const cause = err && typeof err === "object" && "cause" in err ? (err as { cause?: unknown }).cause : undefined;
    const causeCode =
      cause && typeof cause === "object" && "code" in cause ? (cause as { code?: unknown }).code : undefined;
    console.error(
      `[agent/interpret] trace=${traceId} OpenRouter error: ${msg}` +
        `${causeCode ? ` cause_code=${String(causeCode)}` : ""}`,
      cause ?? "",
    );
    // Real, detailed cause stays in the server logs. The client only ever sees
    // the friendly copy mapped from "AI interpretation failed" in
    // lib/friendly-errors.ts — never the internal OPENROUTER_API_KEY hint.
    return NextResponse.json(
      { error: "AI interpretation failed" },
      { status: 502 },
    );
  }

  // ── Pre-resolve recipient .arc names across every step ────────────
  // Only resolve names; addresses and $prev refs are left alone.
  for (const name of extractRecipientNames(result)) {
    try {
      await resolveRecipient(name);
    } catch (err) {
      const appErr = toAppError(err);
      const msg = appErr.message || `Cannot resolve "${name}"`;
      console.warn(
        `[agent/interpret] trace=${traceId} recipient_fail="${name}" code=${appErr.code} retryable=${appErr.retryable} msg="${msg}"`,
      );
      // Don't throw — degrade the result to an "unknown" outcome so the chat
      // shows a clean error instead of a 500. On a TRANSIENT lookup failure
      // (F-17) the name may be perfectly valid — surface the "try again"
      // message as-is and do NOT tell the user to check the name. Only a
      // terminal RECIPIENT_NOT_FOUND warrants "check the .arc name".
      const degraded: InterpretResult = {
        tasks: [],
        combined_confirmation_message: msg,
        unknown_reason: appErr.retryable
          ? msg
          : `${msg}. Please check the .arc name or wallet address and try again.`,
      };
      return NextResponse.json({ ...degraded, requires_pin: false }, { status: 200 });
    }
  }

  // Ship the server-computed gating authority so the client renders decisions
  // instead of re-deriving them (D2 fix — kills the F-7 client balance denylist
  // and the F-8 client auto-confirm allowlist). All three come from the shared
  // pin-policy SSOT:
  //   requires_pin  — show the PIN input? (outward third-party sends only)
  //   upfront_usdc  — USDC drawn up front across "now" tasks; the client fast-
  //                   fails on insufficient balance using THIS, not its own sum
  //   auto_confirm  — skip the confirm card entirely (no-PIN batches: reads,
  //                   config, same-user withdraw/swap/self-bridge)
  const walletAddress = agentSession.session.walletAddress;
  const requiresPin = batchRequiresPin(result.tasks, walletAddress);
  // Strip the internal-only diagnostics (reasoning + citations) — they are for
  // server logs and must never reach the client.
  const clientResult: InterpretResult = { ...result };
  delete clientResult.reasoning;
  delete clientResult.citations;
  return NextResponse.json({
    ...clientResult,
    requires_pin: requiresPin,
    upfront_usdc: totalUpfrontUsdc(result.tasks),
    auto_confirm: batchAutoConfirm(result.tasks, walletAddress),
  });
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
function renderMemoryListing(facts: string[]): string {
  const seen = new Set<string>();
  const items: string[] = [];

  for (const fact of facts) {
    const cleaned = stripMemoryTag(fact).replace(/^\s*[-•]\s*/, "").trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(cleaned);
  }

  if (items.length === 0) return "";
  return items.map((s, i) => `${i + 1}. ${s}`).join("\n");
}

/**
 * Strip a leading MemWal storage tag (`[session-summary]`, `[note]`, …)
 * from a recalled fact while preserving any `(YYYY-MM-DD)` date that
 * follows it, so the model still sees when the fact was recorded.
 */
function stripMemoryTag(fact: string): string {
  return fact.replace(/^\s*\[[^\]]+\]\s*/, "").trim();
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
