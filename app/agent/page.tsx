"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useCircleWallet } from "../circle-wallet-context";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { friendlyError, friendlyApiError } from "@/lib/friendly-errors";
import { buildConversationHistory } from "@/lib/agent-history";
import { formatRetrieveTransactions } from "@/lib/format-transactions";
import { useSessionEndSummary } from "@/lib/memory/use-session-end-summary";
import { MicButton } from "@/components/voice/MicButton";
import { SpeakButton } from "@/components/voice/SpeakButton";
import {
  Send,
  Loader2,
  ArrowLeft,
  Check,
  X,
  AlertTriangle,
  RefreshCw,
  Plus,
  ChevronDown,
  Sparkles,
  ArrowUp,
  List,
  Zap,
  Wallet as WalletIcon,
  Shield,
  Repeat,
  Coins,
  Clock,
  TrendingUp,
} from "lucide-react";

// ── V3 Types (mirror lib/agent-types.ts) ──────────────────────────────

type PlanStep = {
  skill: string;
  params: Record<string, unknown>;
  description: string;
};

type Trigger =
  | { type: "now" }
  | {
      type: "time";
      schedule: "daily" | "weekly" | "monthly";
      day_of_week?: number;
      day_of_month?: number;
      last_day_of_month?: boolean;
    }
  | { type: "price"; asset: "BTC" | "ETH" | "USDC"; direction: "above" | "below"; threshold: number }
  | { type: "balance_above"; threshold_usdc: number }
  | { type: "and"; conditions: Array<Exclude<Trigger, { type: "now" } | { type: "and" }>> };

type Task = {
  trigger: Trigger;
  steps: PlanStep[];
  execution_mode: "once" | "repeat";
  stop_conditions?: Array<Record<string, unknown>>;
  confirmation_message: string;
};

type InterpretResult = {
  tasks: Task[];
  combined_confirmation_message: string;
  unknown_reason?: string;
  // Whether the batch needs a PIN — decided server-side by batchRequiresPin.
  // false for reads / config / swap / self-withdraw / self-bridge.
  requires_pin?: boolean;
  // Server-computed upfront USDC across "now" tasks (requiresBalanceCheck skills).
  upfront_usdc?: number;
  // Server-computed — batch needs no PIN and can auto-execute without a card (F-8).
  auto_confirm?: boolean;
};

type StepResult = {
  step: number;
  description: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
};

type TaskResultResponse =
  | { ok: true; kind: "executed" | "policy"; task_index: number; result: Record<string, unknown>; steps?: StepResult[] }
  | { ok: false; kind: "executed" | "policy"; task_index: number; error: string; steps?: StepResult[] };

type ConfirmResponse = {
  results: TaskResultResponse[];
  ok: boolean;
  successCount: number;
  totalCount: number;
};

type Message = {
  id: string;
  role: "user" | "agent" | "system";
  text: string;
  pending?: boolean;
  interpret?: InterpretResult;
};

type AgentStatus = {
  activated: boolean;
  wallet?: { address: string; arcName: string | null; balanceUsdc: string };
  pinSet?: boolean;
  limits?: { max_per_transaction_usdc: number; max_daily_usdc: number; max_monthly_usdc: number };
  policies?: Array<{
    id: string;
    active: boolean;
    summary: string;
    category: string;
    triggerType: string;
    actionSkill: string;
    executionMode: string;
    executionCount: number;
    totalSpentUsdc: string;
    nextRun: string | null;
    createdAt: string;
    pauseReason: string | null;
  }>;
};

type Suggestion = {
  label: string;
  prompt: string;
  Icon: React.ComponentType<{ className?: string; size?: number }>;
};

const SUGGESTIONS: Suggestion[] = [
  { label: "Send USDC", prompt: "Send 5 USDC to ", Icon: Send },
  { label: "Recurring", prompt: "Pay 10 USDC to alice.arc every Friday", Icon: Repeat },
  { label: "Balance", prompt: "What's my agent balance?", Icon: WalletIcon },
  { label: "Set limit", prompt: "Set my daily limit to 50 USDC", Icon: Shield },
  { label: "Multi-task", prompt: "Send 5 USDC to maya.arc and pay 2 USDC to bob.arc every Friday", Icon: Sparkles },
];

function timeGreeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Late night";
  if (h < 12) return "Morning";
  if (h < 17) return "Afternoon";
  if (h < 21) return "Evening";
  return "Late night";
}

// ── Trigger summary helpers ───────────────────────────────────────────

function triggerLabel(t: Trigger): string {
  if (t.type === "now") return "Run now";
  if (t.type === "time") {
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    if (t.schedule === "daily") return "Every day";
    if (t.schedule === "weekly") return `Every ${dayNames[t.day_of_week ?? 1]}`;
    if (t.schedule === "monthly") {
      if (t.last_day_of_month) return "Last day of every month";
      return `Day ${t.day_of_month ?? 1} of every month`;
    }
    return t.schedule;
  }
  if (t.type === "price") return `When ${t.asset} ${t.direction} $${t.threshold}`;
  if (t.type === "balance_above") return `When balance > $${t.threshold_usdc}`;
  return t.conditions.map((c) => triggerLabel(c as Trigger)).join(" + ");
}

function triggerIconFor(t: Trigger) {
  if (t.type === "now") return Zap;
  if (t.type === "time" || t.type === "and") return Clock;
  if (t.type === "price") return TrendingUp;
  return AlertTriangle;
}

// ── Single task summary row inside the ConfirmCard ────────────────────

function TaskRow({ task, index, total }: { task: Task; index: number; total: number }) {
  const Icon = triggerIconFor(task.trigger);
  return (
    <div className="rounded-xl border border-stone-150 bg-stone-50/60 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-stone-600">
          <Icon className="h-3 w-3" />
          <span>{triggerLabel(task.trigger)}</span>
          {task.execution_mode === "repeat" && (
            <span className="rounded-full bg-stone-100 px-1.5 py-0.5 text-[10px] text-stone-500">
              repeats
            </span>
          )}
        </div>
        {total > 1 && (
          <span className="text-[10px] font-mono text-stone-400">{index + 1}/{total}</span>
        )}
      </div>
      <p className="mt-1 text-sm leading-snug text-stone-800">{task.confirmation_message}</p>
      {task.steps.length > 1 && (
        <ol className="mt-2 space-y-0.5 text-[11px] text-stone-500">
          {task.steps.map((s, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="font-mono text-stone-400">{i + 1}.</span>
              <span>{s.description}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ── ConfirmCard — one card, N task rows, single PIN ───────────────────

function ConfirmCard({
  interpret,
  onConfirm,
  onDismiss,
}: {
  interpret: InterpretResult;
  onConfirm: (pin: string) => void;
  onDismiss: () => void;
}) {
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Batches that need no PIN (reads, config, and same-user money moves —
  // withdraw-to-self, swap-in-place, self-bridge) skip the confirm card and
  // auto-execute. The decision is server-computed (auto_confirm) from the
  // shared pin-policy SSOT, so this surface no longer keeps its own read-only
  // allowlist (F-8 — a plain withdraw used to wrongly show a card).
  const autoConfirm = interpret.auto_confirm === true;

  // Whether this batch actually needs a PIN is decided server-side (batchRequiresPin):
  // only outward third-party sends do. Swap / withdraw / self-bridge / set-limit
  // need no PIN — and now skip the card entirely via autoConfirm above.
  const needsPin = interpret.requires_pin !== false;

  useEffect(() => {
    if (autoConfirm) void onConfirm("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit() {
    if (needsPin && !/^\d{4,8}$/.test(pin)) {
      setError("Enter your 4–8 digit agent PIN");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await onConfirm(needsPin ? pin : "");
    } catch (e) {
      setError(friendlyError(e, "Confirmation failed. Please try again."));
      setLoading(false);
    }
  }

  if (autoConfirm) return null;

  return (
    <div className="max-w-lg space-y-3 rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wider text-stone-500">
          {interpret.tasks.length === 1 ? "Confirm action" : `Confirm ${interpret.tasks.length} actions`}
        </p>
        <button
          onClick={onDismiss}
          className="text-stone-400 transition hover:text-stone-700"
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <p className="text-sm leading-relaxed text-stone-800">
        {interpret.combined_confirmation_message}
      </p>

      <div className="space-y-2">
        {interpret.tasks.map((task, i) => (
          <TaskRow key={i} task={task} index={i} total={interpret.tasks.length} />
        ))}
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      <div className="flex items-center gap-2 pt-1">
        {needsPin && (
          <input
            type="password"
            inputMode="numeric"
            maxLength={8}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Agent PIN"
            className="flex-1 rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm tracking-widest text-stone-900 placeholder-stone-400 outline-none transition focus:border-stone-400 focus:bg-white"
            autoFocus
          />
        )}
        <button
          onClick={submit}
          disabled={loading || (needsPin && pin.length < 4)}
          className={`inline-flex items-center gap-1.5 rounded-xl bg-stone-900 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-stone-800 disabled:opacity-50 ${needsPin ? "" : "flex-1 justify-center"}`}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <>
              <Check className="h-4 w-4" />
              Confirm{interpret.tasks.length > 1 ? " all" : ""}
            </>
          )}
        </button>
      </div>
    </div>
  );
}

// ── Result formatting per task ────────────────────────────────────────

/**
 * Render a friendly post-execution / post-policy-creation string for a
 * single task's response. Errors and successes both flow through here so
 * the chat reads consistently.
 */
function formatTaskResult(task: Task, r: TaskResultResponse): string {
  if (!r.ok) return `✗ ${friendlyError(r.error, "That step couldn't be completed.")}`;

  // Policy-create path
  if (r.kind === "policy") {
    const nextRun = r.result.nextRun as string | undefined;
    const compound = r.result.compound === true;
    const tail = nextRun
      ? ` Next run: ${new Date(nextRun).toLocaleDateString()}.`
      : "";
    return `✓ ${compound ? "Compound " : ""}policy created.${tail}`;
  }

  // Run-now path
  if (task.steps.length === 1) {
    const single = task.steps[0];
    const res = r.result;
    switch (single.skill) {
      case "SEND_USDC": {
        const addr = String(res.recipientAddress ?? "");
        const short = addr ? `${addr.slice(0, 8)}…${addr.slice(-4)}` : "recipient";
        let line = `✓ Sent ${res.amountUsdc} USDC to ${short}`;
        if (res.txHash) line += `\nTx: ${String(res.txHash).slice(0, 10)}…`;
        return line;
      }
      case "WITHDRAW":
        return `✓ Withdrew ${res.amountUsdc} USDC to your main wallet`;
      case "SET_LIMIT":
        return `✓ Updated ${res.updated} limit to $${res.amount} USDC`;
      case "CANCEL_POLICY":
        return `✓ Cancelled ${res.cancelledCount} polic${res.cancelledCount !== 1 ? "ies" : "y"}`;
      case "CHECK_BALANCE":
        return `Agent balance: ${res.balanceUsdc} USDC`;
      case "SWAP_USDC":
        return `✓ Swapped ${res.amountIn ?? res.amount} ${res.tokenIn ?? "USDC"} → ${res.amountOut ?? "?"} ${res.tokenOut ?? "?"}`;
      case "SEND_TOKEN":
        return `✓ Sent ${res.amount} ${res.tokenSymbol ?? "tokens"}`;
      case "BRIDGE_USDC":
        return `✓ Bridged ${res.amount} USDC`;
      case "PAY_X402":
        return `✓ Paid ${res.amount} USDC for ${res.label ?? "API call"}`;
      case "GET_PRICE": {
        const price = Number(res.priceUsd ?? 0);
        const age = Number(res.ageSeconds ?? 0);
        return `Current price of ${res.symbol}: $${price.toFixed(2)} (source: ${res.source}, ${age}s old)`;
      }
      case "IKNOW": {
        const verdict = String(res?.verdict ?? "");
        const stage = String(res?.stage ?? "");
        const belief = String(res?.belief ?? "");
        const market = res?.market as Record<string, unknown> | undefined;

        // Show the market whenever the oracle found a match, even if
        // success === false (e.g. critic unavailable).  The market
        // data is still valid.
        if (verdict === "MATCH" && market) {
          const title = String(market.title ?? "");
          const yesOdds = Number(market.yesOdds ?? 0);
          const noOdds = Number(market.noOdds ?? 0);
          const side = String(market.side ?? "");
          const url = String(market.url ?? "");
          const verdictReason = String(res?.verdictReason ?? "");
          let msg = `You can make money off that opinion — check out this market:\n\n"${title}"`;
          msg += `\nYes: ${yesOdds.toFixed(2)}  |  No: ${noOdds.toFixed(2)}`;
          if (side) msg += `\nYour side: ${side.toUpperCase()}`;
          if (verdictReason) msg += `\nWhy: ${verdictReason}`;
          if (url) msg += `\n\n${url}`;
          return msg;
        }

        if (stage === "broad_summary") {
          const suggestions = Array.isArray(res?.suggestions)
            ? (res.suggestions as Array<Record<string, unknown>>)
            : [];
          const lines = suggestions.map((s, i) =>
            `${i + 1}. ${s.title} — Yes: ${Number(s.yesOdds ?? 0).toFixed(2)}, No: ${Number(s.noOdds ?? 0).toFixed(2)}`
          );
          return `That's a broad belief! Here are some related markets:\n${lines.join("\n")}\n\nReply with a number to pick one.`;
        }

        const success = res?.success === true;
        if (!success) {
          const suggestions = Array.isArray(res?.suggestions)
            ? (res.suggestions as Array<Record<string, unknown>>)
            : [];
          if (suggestions.length > 0) {
            const lines = suggestions.map((s, i) =>
              `${i + 1}. ${s.title} — Yes: ${Number(s.yesOdds ?? 0).toFixed(2)}, No: ${Number(s.noOdds ?? 0).toFixed(2)}`
            );
            return `Hmm, I couldn't find an exact match for "${belief}". Here are the closest markets:\n${lines.join("\n")}\n\nReply with a number to pick one.`;
          }
          return `I couldn't find a prediction market for "${belief}". Try rephrasing with a clearer event.`;
        }
        return `Found a match for "${belief}" but market details were incomplete.`;
      }
      case "RETRIEVE_TRANSACTIONS":
        return formatRetrieveTransactions(res);
      default:
        return "✓ Done.";
    }
  }

  // Compound task — one line per step
  const steps = r.steps ?? [];
  const lines = steps.map((s) =>
    s.ok
      ? `  ✓ ${s.description}`
      : `  ✗ ${s.description}: ${friendlyError(s.error, "step failed")}`,
  );
  return `✓ Compound task complete:\n${lines.join("\n")}`;
}

// ── Main page ─────────────────────────────────────────────────────────

export default function AgentPage() {
  const router = useRouter();
  const { session } = useCircleWallet();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      role: "agent",
      text: "Hi! I'm your Synesis agent. Tell me what to do — and I can handle multiple things at once.",
    },
  ]);
  const [input, setInput] = useState("");
  const [interpreting, setInterpreting] = useState(false);
  /** When non-null, the chat has an open confirmation card the user must address. */
  const [pendingConfirm, setPendingConfirm] = useState<{ msgId: string; interpret: InterpretResult } | null>(null);
  const [tab, setTab] = useState<"chat" | "policies">("chat");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    loadStatus();
  }, []);

  // Realtime: balance + recent activity refresh when webhooks update
  // agent_spend_log or agent_wallets.
  useEffect(() => {
    if (!session?.userId) return;
    const supabase = createSupabaseBrowserClient();
    const channel = supabase
      .channel(`agent-live-${session.userId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "agent_spend_log", filter: `user_id=eq.${session.userId}` },
        () => loadStatus(),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "agent_wallets", filter: `user_id=eq.${session.userId}` },
        () => loadStatus(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.userId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Layer C — fire a session-end summary on tab close / 10-min idle.
  // Server-side gates on MEMWAL_ENABLED so this is safe to leave on.
  useSessionEndSummary(messages);

  async function loadStatus() {
    setStatusLoading(true);
    const res = await fetch("/api/agent/status");
    if (res.ok) {
      const data = await res.json();
      setStatus(data);
      if (!data.activated) router.replace("/wallet");
    } else {
      router.replace("/wallet");
    }
    setStatusLoading(false);
  }

  function addMessage(msg: Omit<Message, "id">) {
    const id = crypto.randomUUID();
    setMessages((prev) => [...prev, { ...msg, id }]);
    return id;
  }

  function updateMessage(id: string, update: Partial<Message>) {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...update } : m)));
  }

  // ── Send instruction → interpret → render confirm card ─────────────
  async function handleSend() {
    const instruction = input.trim();
    if (!instruction || interpreting) return;
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    // Layer A — capture prior turns BEFORE appending this one (setState is
    // async, so `messages` here still excludes the new user message).
    const history = buildConversationHistory(messages);
    addMessage({ role: "user", text: instruction });

    setInterpreting(true);
    const thinkingId = addMessage({ role: "agent", text: "Thinking…", pending: true });

    const res = await fetch("/api/agent/interpret", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction, history }),
    });
    setInterpreting(false);

    if (!res.ok) {
      const friendly = await friendlyApiError(
        res,
        "I couldn't reach the assistant. Please try again.",
      );
      updateMessage(thinkingId, {
        text: friendly,
        pending: false,
      });
      return;
    }

    const interpret: InterpretResult = await res.json();
    console.log("[interpret] result:", interpret);

    if (interpret.tasks.length === 0) {
      updateMessage(thinkingId, {
        text: interpret.unknown_reason ?? "I didn't understand that. Could you rephrase?",
        pending: false,
      });
      return;
    }

    // Stash the result with the thinking message and open the ConfirmCard.
    updateMessage(thinkingId, {
      text: interpret.combined_confirmation_message,
      interpret,
      pending: false,
    });
    setPendingConfirm({ msgId: thinkingId, interpret });
  }

  // ── PIN entered → POST batch to confirm-policy ─────────────────────
  async function handleConfirm(pin: string) {
    if (!pendingConfirm) return;
    const { msgId, interpret } = pendingConfirm;

    const res = await fetch("/api/agent/confirm-policy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin, tasks: interpret.tasks }),
    });

    setPendingConfirm(null);

    let data: ConfirmResponse | { error?: string };
    try {
      data = await res.json();
    } catch {
      updateMessage(msgId, {
        interpret: undefined,
        text: "The server returned an unexpected response. Please try again.",
        pending: false,
      });
      return;
    }

    // Hard error (no per-task results) — e.g. PIN failure, bad request.
    if (!("results" in data)) {
      updateMessage(msgId, {
        interpret: undefined,
        text: friendlyError(data.error, "That action couldn't be completed."),
        pending: false,
      });
      return;
    }

    // Per-task results: render each as its own line so partial-success
    // states are readable.
    const summary = data.results
      .map((r) => formatTaskResult(interpret.tasks[r.task_index], r))
      .join("\n\n");

    updateMessage(msgId, { interpret: undefined, text: summary, pending: false });

    // Refresh status if anything affected the user's policies / balance.
    if (data.results.some((r) => r.ok)) {
      await loadStatus();
    }
  }

  function handleDismiss(msgId: string) {
    updateMessage(msgId, { interpret: undefined, text: "Cancelled." });
    setPendingConfirm(null);
  }

  // ── Cancel policy modal ───────────────────────────────────────────
  const [cancelModal, setCancelModal] = useState<{ policyId: string; summary: string } | null>(null);
  const [cancelPin, setCancelPin] = useState("");
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelError, setCancelError] = useState("");

  async function doCancel() {
    if (!cancelModal || !/^\d{4,8}$/.test(cancelPin)) {
      setCancelError("Enter your 4–8 digit agent PIN");
      return;
    }
    setCancelLoading(true);
    setCancelError("");
    try {
      const res = await fetch("/api/agent/cancel-policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: cancelPin, policyId: cancelModal.policyId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCancelError(
          friendlyError(data?.error, "Couldn't cancel that automation. Please try again."),
        );
      } else {
        setCancelModal(null);
        setCancelPin("");
        await loadStatus();
      }
    } catch (e) {
      setCancelError(friendlyError(e, "Network hiccup — check your connection and try again."));
    } finally {
      setCancelLoading(false);
    }
  }

  const firstName = useMemo(() => {
    const arc = status?.wallet?.arcName;
    if (arc) {
      const base = arc.split(".")[0];
      if (base) return base.charAt(0).toUpperCase() + base.slice(1);
    }
    return "there";
  }, [status?.wallet?.arcName]);

  const showHome = tab === "chat" && messages.length <= 1 && messages[0]?.id === "welcome";

  function pickSuggestion(prompt: string) {
    setInput(prompt);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  if (statusLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#faf9f7]">
        <Loader2 className="h-6 w-6 animate-spin text-stone-400" />
      </div>
    );
  }

  return (
    <div className="flex min-h-[100dvh] flex-col bg-[#faf9f7] text-stone-900">
      {/* ── Top bar ── */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-stone-200/70 bg-[#faf9f7]/85 px-4 py-3 backdrop-blur-md sm:px-6">
        <button
          onClick={() => router.push("/wallet")}
          aria-label="Back to wallet"
          className="inline-flex h-9 w-9 items-center justify-center rounded-full text-stone-600 transition hover:bg-stone-200/70"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>

        <Link href="/" aria-label=".arc home" className="inline-flex items-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/arc-logo.png" alt=".arc" className="h-6 w-auto select-none" draggable={false} />
        </Link>

        <div className="flex items-center gap-2">
          {status?.wallet && (
            <span className="hidden items-center gap-1.5 rounded-full bg-stone-100 px-3 py-1.5 text-xs font-medium text-stone-700 sm:inline-flex">
              <Coins className="h-3.5 w-3.5 text-stone-500" />
              {parseFloat(status.wallet.balanceUsdc).toFixed(2)} USDC
            </span>
          )}
          <button
            onClick={loadStatus}
            aria-label="Refresh"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-stone-500 transition hover:bg-stone-200/70"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* ── Tab toggle ── */}
      <div className="flex justify-center px-4 pt-3 sm:pt-5">
        <div className="inline-flex rounded-full bg-stone-100 p-1">
          {(["chat", "policies"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-medium transition ${
                tab === t ? "bg-white text-stone-900 shadow-sm" : "text-stone-500 hover:text-stone-800"
              }`}
            >
              {t === "chat" ? <Send className="h-3 w-3" /> : <List className="h-3 w-3" />}
              {t === "chat"
                ? "Chat"
                : `Policies${status?.policies?.length ? ` · ${status.policies.length}` : ""}`}
            </button>
          ))}
        </div>
      </div>

      {/* ── Chat tab ── */}
      {tab === "chat" && (
        <>
          {showHome ? (
            <HomeGreeting greeting={timeGreeting()} firstName={firstName} onPick={pickSuggestion} />
          ) : (
            <div className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-4 py-6 sm:px-6">
              <div className="space-y-5">
                {messages
                  .filter((m) => m.id !== "welcome")
                  .map((msg) => (
                    <MessageRow
                      key={msg.id}
                      msg={msg}
                      isPending={pendingConfirm?.msgId === msg.id}
                      onConfirm={handleConfirm}
                      onDismiss={() => handleDismiss(msg.id)}
                    />
                  ))}
                <div ref={bottomRef} />
              </div>
            </div>
          )}

          {/* Input bar */}
          <div className="sticky bottom-0 z-20 bg-gradient-to-t from-[#faf9f7] via-[#faf9f7] to-transparent px-4 pb-5 pt-3 sm:px-6 sm:pb-7">
            <div className="mx-auto w-full max-w-3xl">
              <ChatInput
                inputRef={inputRef}
                value={input}
                onChange={setInput}
                onSend={handleSend}
                disabled={interpreting || !!pendingConfirm}
                interpreting={interpreting}
              />
              <p className="mt-2 text-center text-[11px] text-stone-400">
                Powered by OpenRouter · actions require your agent PIN
              </p>
            </div>
          </div>
        </>
      )}

      {/* ── Policies tab ── */}
      {tab === "policies" && (
        <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 sm:px-6">
          {!status?.policies?.length ? (
            <div className="flex flex-col items-center gap-3 py-20 text-center">
              <div className="rounded-full bg-stone-100 p-4">
                <List className="h-7 w-7 text-stone-400" />
              </div>
              <p className="text-sm font-medium text-stone-700">No active policies yet</p>
              <p className="max-w-xs text-xs text-stone-500">
                Set up recurring payments or limits in chat. They&apos;ll appear here once active.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {status.policies.map((p) => (
                <div key={p.id} className="space-y-2 rounded-2xl border border-stone-200 bg-white p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-mono font-medium text-stone-700">
                        {p.actionSkill}
                      </span>
                      <span className="rounded-full bg-stone-50 px-2 py-0.5 text-[10px] text-stone-500">
                        {p.executionMode}
                      </span>
                      <span className="rounded-full bg-stone-50 px-2 py-0.5 text-[10px] text-stone-500">
                        {p.triggerType}
                      </span>
                    </div>
                    <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                      Active
                    </span>
                  </div>
                  <p className="text-sm font-medium leading-snug text-stone-900">{p.summary}</p>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 text-xs text-stone-500">
                      {p.nextRun && <span>Next: {new Date(p.nextRun).toLocaleDateString()}</span>}
                      {p.executionCount > 0 && (
                        <span>
                          Ran {p.executionCount}× · ${parseFloat(p.totalSpentUsdc).toFixed(2)}
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => {
                        setCancelModal({ policyId: p.id, summary: p.summary });
                        setCancelPin("");
                        setCancelError("");
                      }}
                      className="inline-flex items-center gap-1 text-xs text-red-600 transition hover:text-red-700"
                    >
                      <X className="h-3 w-3" />
                      Cancel
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {status?.limits && (
            <div className="mt-4 space-y-1 rounded-2xl border border-stone-200 bg-stone-50/50 px-4 py-3">
              <p className="flex items-center gap-1.5 text-xs font-medium text-stone-600">
                <AlertTriangle className="h-3 w-3" /> Spend limits
              </p>
              <p className="text-xs text-stone-500">Per tx: ${status.limits.max_per_transaction_usdc}</p>
              <p className="text-xs text-stone-500">Daily: ${status.limits.max_daily_usdc}</p>
              <p className="text-xs text-stone-500">Monthly: ${status.limits.max_monthly_usdc}</p>
            </div>
          )}
        </div>
      )}

      {/* ── Cancel PIN modal ── */}
      {cancelModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm">
          <div className="w-full max-w-sm space-y-3 rounded-2xl border border-stone-200 bg-white p-5 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-stone-900">Cancel policy</h3>
              <button
                onClick={() => {
                  setCancelModal(null);
                  setCancelPin("");
                  setCancelError("");
                }}
                className="text-stone-400 transition hover:text-stone-700"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-xs leading-relaxed text-stone-500">{cancelModal.summary}</p>
            {cancelError && <p className="text-xs text-red-600">{cancelError}</p>}
            <div className="flex items-center gap-2">
              <input
                type="password"
                inputMode="numeric"
                maxLength={8}
                value={cancelPin}
                onChange={(e) => setCancelPin(e.target.value.replace(/\D/g, ""))}
                onKeyDown={(e) => e.key === "Enter" && doCancel()}
                placeholder="Agent PIN"
                className="flex-1 rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm tracking-widest text-stone-900 placeholder-stone-400 outline-none transition focus:border-stone-400 focus:bg-white"
                autoFocus
              />
              <button
                onClick={doCancel}
                disabled={cancelLoading || cancelPin.length < 4}
                className="inline-flex items-center gap-1.5 rounded-xl bg-red-600 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
              >
                {cancelLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Cancel"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Greeting + suggestion chips ───────────────────────────────────────

function HomeGreeting({
  greeting,
  firstName,
  onPick,
}: {
  greeting: string;
  firstName: string;
  onPick: (prompt: string) => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center px-4 py-10 sm:py-16">
      <div className="flex items-center gap-3">
        <Sparkles className="h-7 w-7 sm:h-8 sm:w-8" style={{ color: "#c25b3f" }} aria-hidden />
        <h1
          suppressHydrationWarning
          className="text-3xl font-medium tracking-tight text-stone-800 sm:text-[2.5rem]"
          style={{ fontFamily: "ui-serif, Georgia, Cambria, 'Times New Roman', Times, serif" }}
        >
          {greeting}, {firstName}
        </h1>
      </div>
      <div className="mt-10 flex flex-wrap items-center justify-center gap-2 sm:mt-12">
        {SUGGESTIONS.map(({ label, prompt, Icon }) => (
          <button
            key={label}
            onClick={() => onPick(prompt)}
            className="inline-flex items-center gap-1.5 rounded-full border border-stone-200 bg-white px-3.5 py-1.5 text-xs font-medium text-stone-700 transition hover:border-stone-300 hover:bg-stone-50 active:scale-[0.98]"
          >
            <Icon className="h-3.5 w-3.5 text-stone-500" />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Chat input ────────────────────────────────────────────────────────

function ChatInput({
  inputRef,
  value,
  onChange,
  onSend,
  disabled,
  interpreting,
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled: boolean;
  interpreting: boolean;
}) {
  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    onChange(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }

  // Voice input: append the final transcript to whatever's already in the
  // textarea. Leading space preserves the user's existing text if they
  // dictated mid-sentence. After receiving text we resize the textarea
  // and refocus so Enter still works.
  function handleVoiceTranscript(text: string) {
    const next = value.trim() ? `${value.trimEnd()} ${text}` : text;
    onChange(next);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
      el.focus();
    });
  }

  return (
    <div className="rounded-[28px] border border-stone-200 bg-white shadow-[0_4px_24px_-8px_rgba(0,0,0,0.08)]">
      <textarea
        ref={inputRef}
        value={value}
        onChange={handleInput}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (!disabled && value.trim()) onSend();
          }
        }}
        rows={1}
        placeholder="How can I help you today?"
        disabled={disabled}
        className="block w-full resize-none rounded-t-[28px] bg-transparent px-5 pt-4 pb-2 text-[15px] text-stone-900 placeholder-stone-400 outline-none disabled:opacity-60"
      />
      <div className="flex items-center justify-between px-3 pb-3 pt-1">
        <button
          type="button"
          aria-label="Add"
          className="inline-flex h-9 w-9 items-center justify-center rounded-full text-stone-500 transition hover:bg-stone-100"
        >
          <Plus className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-stone-500 transition hover:bg-stone-100"
          >
            Synesis Agent
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <MicButton
            onTranscript={handleVoiceTranscript}
            disabled={disabled}
            sizeClass="h-9 w-9"
          />
          <button
            type="button"
            onClick={onSend}
            disabled={disabled || !value.trim()}
            aria-label="Send"
            className="ml-1 inline-flex h-9 w-9 items-center justify-center rounded-full bg-stone-900 text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-300"
          >
            {interpreting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Single chat row ───────────────────────────────────────────────────

function MessageRow({
  msg,
  isPending,
  onConfirm,
  onDismiss,
}: {
  msg: Message;
  isPending: boolean;
  onConfirm: (pin: string) => void;
  onDismiss: () => void;
}) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-stone-900 px-4 py-2.5 text-sm leading-relaxed text-white">
          {msg.text}
        </div>
      </div>
    );
  }
  if (msg.role === "system") {
    return <p className="text-center text-xs italic text-stone-400">{msg.text}</p>;
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] space-y-2">
        {msg.text && (
          <div
            className={`whitespace-pre-wrap text-[15px] leading-relaxed ${
              msg.pending ? "italic text-stone-400" : "text-stone-800"
            }`}
          >
            {msg.pending && <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" />}
            {msg.text}
          </div>
        )}
        {!msg.pending && msg.text && (
          <div className="flex items-center gap-1">
            <SpeakButton text={msg.text} sizeClass="h-6 w-6" iconClass="h-3 w-3" />
          </div>
        )}
        {msg.interpret && isPending && (
          <ConfirmCard interpret={msg.interpret} onConfirm={onConfirm} onDismiss={onDismiss} />
        )}
      </div>
    </div>
  );
}
