/**
 * lib/agent-diagnostics.ts — unified interpret-call diagnostics (V3.5)
 *
 * One structured, trace-tagged log block that prints EVERY input the LLM
 * sees on a `/api/agent/interpret` call. The point is demo triage: when an
 * interpretation looks wrong, you want a single glance at "what did the
 * model actually have in front of it?" — not eight scattered log lines you
 * have to correlate by hand.
 *
 * The eight blocks map 1:1 to the injection map in
 * MEMORY_ARCHITECTURE.md §1:
 *
 *   1. IDENTITY      — user .arc name + agent persona (who the model serves)
 *   2. WALLET STATE  — token balances + where they came from (cache vs live)
 *   3. SPEND LIMITS  — per-tx / daily / weekly / monthly caps
 *   4. POLICIES      — active automation rules injected as context
 *   5. HISTORY       — in-session (Layer A) conversation turns
 *   6. TOOL SCHEMA   — the skills the pgvector router injected this call
 *   7. LIVE PRICES   — oracle-fed EURC / cirBTC rates
 *   8. MEMORY        — Layer B (Supabase) + Layer C (Walrus) recall sizes
 *
 * Pure + synchronous: it only formats data the caller already has. It never
 * fetches, never throws on odd input, and has no side effects beyond the
 * string it returns. The caller does the single console.log so the whole
 * block lands as ONE write (no interleaving across concurrent requests).
 */

import type {
  AgentTokenBalance,
  ActivePolicy,
  SpendLimits,
} from "@/lib/agent-types";
import type { LivePrices } from "@/lib/agent-core";
import { memHealthSnapshot } from "@/lib/memory/mem-health";

export type BalanceSource = "cache" | "live" | "unavailable";

export type InterpretDiagnostics = {
  traceId: string;
  instruction: string;

  // 1 — identity
  userArcName?: string;
  identityInjectEnabled: boolean;
  /** Length of the injected user_profile card (0 = none/off). */
  profileChars: number;

  // 2 — wallet state
  balances: AgentTokenBalance[];
  balanceSource: BalanceSource;
  balanceAgeSeconds: number | null;
  balanceCacheEnabled: boolean;

  // 3 — spend limits
  limits: SpendLimits;
  limitsFromDb: boolean;

  // 4 — active policies
  policies: ActivePolicy[];

  // 5 — in-session history (Layer A)
  history: Array<{ role: string; content: string }>;

  // 6 — tool schema injected by the vector router
  router: {
    enabled: boolean;
    selected: string[];
    topCosine: number | null;
    usedFallback: boolean;
    fallbackReason?: string;
  };

  // 7 — live prices (oracle)
  livePrices: LivePrices;

  // 8 — learned memory (MemWal episodic recall)
  memory: {
    factCount: number;
    walrusEnabled: boolean;
  };

  // 9 — intent-gated contact memory (injected only when the router picked a
  // contact-feeding skill). Shows whether/why contact memory fired this call.
  contactMem: {
    enabled: boolean;
    injected: boolean;
    bucket: string | null;
    triggerSkill: string | null;
    count: number;
  };
};

// ── Per-block formatters ───────────────────────────────────────────────

function fmtIdentity(d: InterpretDiagnostics): string {
  const flag = d.identityInjectEnabled ? "on" : "off";
  const who = d.userArcName ? `${d.userArcName}.arc` : "(anonymous — no arc_name)";
  // When the flag is off we never even fetch the name, so say so explicitly
  // rather than implying the user is anonymous.
  const userPart = d.identityInjectEnabled ? who : "(inject off — not fetched)";
  const profile = d.profileChars > 0 ? `profile=${d.profileChars}ch` : "profile=none";
  return `user=${userPart} inject=${flag} ${profile} | agent=Synesis wallet agent (constant persona)`;
}

function fmtWalletState(d: InterpretDiagnostics): string {
  const tokens =
    d.balances.length > 0
      ? d.balances.map((b) => `${b.symbol}=${b.amount}`).join(" ")
      : "(none)";
  const age =
    d.balanceAgeSeconds === null ? "" : ` age=${d.balanceAgeSeconds}s`;
  const cacheFlag = d.balanceCacheEnabled ? "on" : "off";
  return `source=${d.balanceSource}${age} cache_flag=${cacheFlag} | ${tokens}`;
}

function fmtLimits(d: InterpretDiagnostics): string {
  const src = d.limitsFromDb ? "db" : "defaults";
  return (
    `tx=$${d.limits.max_per_transaction_usdc} ` +
    `day=$${d.limits.max_daily_usdc} ` +
    `wk=$${d.limits.max_weekly_usdc} ` +
    `mo=$${d.limits.max_monthly_usdc} (source=${src})`
  );
}

function fmtPolicies(d: InterpretDiagnostics): string {
  if (d.policies.length === 0) return "active=0 (none)";
  const shown = d.policies
    .slice(0, 3)
    .map((p) => `#${String(p.id).slice(0, 8)} "${truncate(p.summary, 48)}"`)
    .join(", ");
  const more = d.policies.length > 3 ? ` …+${d.policies.length - 3} more` : "";
  return `active=${d.policies.length} | ${shown}${more}`;
}

function fmtHistory(d: InterpretDiagnostics): string {
  if (d.history.length === 0) return "turns=0 (fresh conversation)";
  const seq = d.history.map((t) => t.role[0]).join(",");
  return `turns=${d.history.length} roles=[${seq}]`;
}

function fmtToolSchema(d: InterpretDiagnostics): string {
  if (!d.router.enabled) {
    return "router=off → full hardcoded catalog injected";
  }
  const top =
    d.router.topCosine === null ? "n/a" : d.router.topCosine.toFixed(3);
  const fb = d.router.usedFallback
    ? `yes${d.router.fallbackReason ? `(${d.router.fallbackReason})` : ""}`
    : "no";
  const skills =
    d.router.selected.length > 0 ? d.router.selected.join(",") : "(none)";
  return `router=on top=${top} fallback=${fb} count=${d.router.selected.length} | [${skills}]`;
}

function fmtPrices(d: InterpretDiagnostics): string {
  return `EURC=${d.livePrices.eurcUsdc} cirBTC=${d.livePrices.cirBtcUsdc} (oracle)`;
}

function fmtMemory(d: InterpretDiagnostics): string {
  if (!d.memory.walrusEnabled) return "memwal off";
  return `memwal on, recalled=${d.memory.factCount} fact(s)`;
}

/**
 * Memory-write health (D4). Reads the process-local counters directly — a
 * synchronous, never-throw, side-effect-free snapshot, so it keeps this
 * module's "no I/O, no fetch" contract while giving swallowed memory-write
 * failures a heartbeat. A layer silently dying (the F-4 failure mode) shows
 * here as a climbing fail count instead of looking like "no memory yet".
 */
function fmtMemHealth(): string {
  const h = memHealthSnapshot();
  const cell = (name: string, c: { ok: number; fail: number; lastError?: string }) => {
    const base = `${name}=${c.ok}✓/${c.fail}✗`;
    // Only surface the last error when there IS one, and keep it short.
    return c.fail > 0 && c.lastError ? `${base}(${truncate(c.lastError, 40)})` : base;
  };
  return [
    cell("profile", h.profile),
    cell("memwal", h.memwal),
    cell("contact", h.contact),
  ].join(" ");
}

function fmtContactMem(d: InterpretDiagnostics): string {
  const cm = d.contactMem;
  if (!cm.enabled) return "inject off";
  if (!cm.injected) {
    // Distinguish "wrong intent for contacts" from "right intent, no data yet".
    if (cm.bucket) return `injected=no (intent=${cm.triggerSkill}, no data in ${cm.bucket} bucket yet)`;
    return "injected=no (intent not transactional)";
  }
  return `injected=yes bucket=${cm.bucket} trigger=${cm.triggerSkill} count=${cm.count}`;
}

// ── Public formatter ────────────────────────────────────────────────────

/**
 * Render the full 8-block diagnostic as a single multi-line string. The
 * caller passes it straight to console.log so the whole block is one write.
 */
export function formatInterpretDiagnostics(d: InterpretDiagnostics): string {
  const t = d.traceId;
  const rows: Array<[string, string]> = [
    ["1 IDENTITY", fmtIdentity(d)],
    ["2 WALLET STATE", fmtWalletState(d)],
    ["3 SPEND LIMITS", fmtLimits(d)],
    ["4 POLICIES", fmtPolicies(d)],
    ["5 HISTORY", fmtHistory(d)],
    ["6 TOOL SCHEMA", fmtToolSchema(d)],
    ["7 LIVE PRICES", fmtPrices(d)],
    ["8 MEMORY", fmtMemory(d)],
    ["9 CONTACT MEM", fmtContactMem(d)],
    ["10 MEM WRITES", fmtMemHealth()],
  ];

  const label = (s: string) => s.padEnd(15, " ");
  const lines = rows.map(([k, v]) => `  │ ${label(k)} ${v}`);

  return [
    `┌─ INTERPRET DIAGNOSTICS trace=${t} ──────────────────────────────`,
    `  │ instruction: "${truncate(d.instruction, 120)}"`,
    ...lines,
    `  └────────────────────────────────────────────────────────────────`,
  ].join("\n");
}

// ── Helpers ──────────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  if (typeof s !== "string") return "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
