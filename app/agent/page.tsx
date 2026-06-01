"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useCircleWallet } from "../circle-wallet-context";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  Send, Loader2, ArrowLeft, Check, X, AlertTriangle, RefreshCw,
  Plus, ChevronDown, Sparkles, ArrowUp, List, Zap,
  Wallet as WalletIcon, Shield, Repeat, Coins,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────

type SkillName =
  | "SEND_USDC" | "CHECK_BALANCE" | "SET_LIMIT"
  | "CANCEL_POLICY" | "WITHDRAW" | "CREATE_POLICY" | "LIST_POLICIES" | "UNKNOWN";

type SkillResult = {
  skill: SkillName;
  params: Record<string, unknown>;
  confirmation_message: string;
  requires_confirmation: boolean;
};

type Message = {
  id: string;
  role: "user" | "agent" | "system";
  text: string;
  skillResult?: SkillResult;
  pending?: boolean;
};

type AgentStatus = {
  activated: boolean;
  wallet?: {
    address: string;
    arcName: string | null;
    balanceUsdc: string;
  };
  pinSet?: boolean;
  limits?: {
    max_per_transaction_usdc: number;
    max_daily_usdc: number;
    max_monthly_usdc: number;
  };
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

// ── Suggestion chips (post-activation home state) ────────────────────

type Suggestion = {
  label: string;
  prompt: string;
  Icon: React.ComponentType<{ className?: string; size?: number }>;
};

const SUGGESTIONS: Suggestion[] = [
  { label: "Send USDC",     prompt: "Send 5 USDC to ",                       Icon: Send },
  { label: "Recurring",     prompt: "Pay 10 USDC to alice.arc every Friday", Icon: Repeat },
  { label: "Balance",       prompt: "What's my agent balance?",              Icon: WalletIcon },
  { label: "Set limit",     prompt: "Set my daily limit to 50 USDC",         Icon: Shield },
  { label: "Smart suggest", prompt: "What can you help me automate?",        Icon: Sparkles },
];

function timeGreeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Late night";
  if (h < 12) return "Morning";
  if (h < 17) return "Afternoon";
  if (h < 21) return "Evening";
  return "Late night";
}

// ── Confirmation card (PIN entry inside the chat) ────────────────────

function ConfirmCard({
  result,
  onConfirm,
  onDismiss,
}: {
  result: SkillResult;
  onConfirm: (pin: string) => void;
  onDismiss: () => void;
}) {
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if (!/^\d{4,8}$/.test(pin)) {
      setError("Enter your 4–8 digit agent PIN");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await onConfirm(pin);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Confirmation failed");
      setLoading(false);
    }
  }

  const skillTone: Record<string, string> = {
    SEND_USDC: "text-emerald-700 bg-emerald-50",
    WITHDRAW: "text-amber-700 bg-amber-50",
    SET_LIMIT: "text-blue-700 bg-blue-50",
    CANCEL_POLICY: "text-red-700 bg-red-50",
    CREATE_POLICY: "text-cyan-700 bg-cyan-50",
    CHECK_BALANCE: "text-stone-700 bg-stone-100",
  };

  return (
    <div className="max-w-md space-y-3 rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-mono font-medium ${
            skillTone[result.skill] ?? "text-stone-700 bg-stone-100"
          }`}
        >
          <Zap className="h-3 w-3" />
          {result.skill}
        </span>
        <button
          onClick={onDismiss}
          className="text-stone-400 transition hover:text-stone-700"
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <p className="text-sm leading-relaxed text-stone-800">{result.confirmation_message}</p>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex items-center gap-2">
        <input
          type="password"
          inputMode="numeric"
          maxLength={8}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Agent PIN"
          className="flex-1 rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm tracking-widest text-stone-900 placeholder-stone-400 outline-none transition focus:border-stone-400 focus:bg-white"
        />
        <button
          onClick={submit}
          disabled={loading || pin.length < 4}
          className="inline-flex items-center gap-1.5 rounded-xl bg-stone-900 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-stone-800 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : (<><Check className="h-4 w-4" /> Confirm</>)}
        </button>
      </div>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────

export default function AgentPage() {
  const router = useRouter();
  const { session } = useCircleWallet();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      role: "agent",
      text: "Hi! I'm your DotArc agent. Tell me what to do — send USDC, set up recurring payments, check your balance, or update your limits.",
    },
  ]);
  const [input, setInput] = useState("");
  const [interpreting, setInterpreting] = useState(false);
  const [pendingSkill, setPendingSkill] = useState<{ msgId: string; result: SkillResult } | null>(null);
  const [tab, setTab] = useState<"chat" | "policies">("chat");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    loadStatus();
  }, []);

  // Realtime: webhooks update `agent_spend_log` and `agent_wallets` rows.
  // Re-pull /api/agent/status on any change so balance + recent activity
  // tick over without a manual reload.
  useEffect(() => {
    if (!session?.userId) return;
    const supabase = createSupabaseBrowserClient();
    const channel = supabase
      .channel(`agent-live-${session.userId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "agent_spend_log",
          filter: `user_id=eq.${session.userId}`,
        },
        () => { loadStatus(); }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "agent_wallets",
          filter: `user_id=eq.${session.userId}`,
        },
        () => { loadStatus(); }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.userId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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

  async function handleSend() {
    const instruction = input.trim();
    if (!instruction || interpreting) return;
    setInput("");
    // Reset textarea height after submit.
    if (inputRef.current) inputRef.current.style.height = "auto";
    addMessage({ role: "user", text: instruction });

    setInterpreting(true);
    const thinkingId = addMessage({ role: "agent", text: "Thinking…", pending: true });

    const res = await fetch("/api/agent/interpret", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction }),
    });

    setInterpreting(false);

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      updateMessage(thinkingId, { text: data.error ?? "Failed to interpret instruction", pending: false });
      return;
    }

    const skillResult: SkillResult = await res.json();
    console.log("[interpret] skillResult:", JSON.stringify(skillResult, null, 2));

    if (skillResult.skill === "UNKNOWN") {
      updateMessage(thinkingId, {
        text: String(skillResult.params.explanation ?? "I didn't understand that. Could you rephrase?"),
        pending: false,
      });
      return;
    }

    if (skillResult.skill === "CHECK_BALANCE") {
      await confirmSkill(thinkingId, skillResult, "");
      return;
    }

    // Show confirmation card
    updateMessage(thinkingId, {
      text: skillResult.confirmation_message,
      skillResult,
      pending: false,
    });
    setPendingSkill({ msgId: thinkingId, result: skillResult });
  }

  async function confirmSkill(msgId: string, skillResult: SkillResult, pin: string) {
    const res = await fetch("/api/agent/confirm-policy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin, skill: skillResult.skill, params: skillResult.params }),
    });

    const data = await res.json();
    setPendingSkill(null);

    if (!res.ok) {
      updateMessage(msgId, {
        skillResult: undefined,
        text: data.error ?? "Action failed",
        pending: false,
      });
      return;
    }

    const r = data.result;
    let resultText = "";

    switch (skillResult.skill) {
      case "SEND_USDC":
        resultText = `✓ Sent ${r.amountUsdc} USDC to ${r.recipientAddress.slice(0, 8)}…${r.recipientAddress.slice(-4)}`;
        if (r.txHash) resultText += `\nTx: ${r.txHash.slice(0, 10)}…`;
        break;
      case "WITHDRAW":
        resultText = `✓ Withdrew ${r.amountUsdc} USDC to your main wallet`;
        await loadStatus();
        break;
      case "SET_LIMIT":
        resultText = `✓ Updated ${r.updated} limit to $${r.amount} USDC`;
        await loadStatus();
        break;
      case "CANCEL_POLICY":
        resultText = `✓ Cancelled ${r.cancelledCount} polic${r.cancelledCount !== 1 ? "ies" : "y"}`;
        await loadStatus();
        break;
      case "CREATE_POLICY":
        resultText = `✓ Policy created. Next run: ${r.nextRun ? new Date(r.nextRun).toLocaleDateString() : "N/A"}`;
        await loadStatus();
        break;
      case "CHECK_BALANCE":
        console.log("[CHECK_BALANCE] data.result:", JSON.stringify(r, null, 2));
        resultText = `Agent balance: ${r.balanceUsdc} USDC`;
        break;
      default:
        resultText = "Done.";
    }

    updateMessage(msgId, { skillResult: undefined, text: resultText, pending: false });
  }

  async function handleConfirm(pin: string) {
    if (!pendingSkill) return;
    await confirmSkill(pendingSkill.msgId, pendingSkill.result, pin);
  }

  // ── Cancel policy ─────────────────────────────────────────────────
  const [cancelModal, setCancelModal] = useState<{
    policyId: string;
    summary: string;
  } | null>(null);
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
      const data = await res.json();
      if (!res.ok) {
        setCancelError(data.error ?? "Cancel failed");
      } else {
        setCancelModal(null);
        setCancelPin("");
        await loadStatus();
      }
    } catch (e) {
      setCancelError(e instanceof Error ? e.message : "Network error");
    } finally {
      setCancelLoading(false);
    }
  }

  // Display name from .arc label → "alice.arc" → "Alice". Fallback "there".
  const firstName = useMemo(() => {
    const arc = status?.wallet?.arcName;
    if (arc) {
      const base = arc.split(".")[0];
      if (base) return base.charAt(0).toUpperCase() + base.slice(1);
    }
    return "there";
  }, [status?.wallet?.arcName]);

  // Empty home state: only the welcome message present and we're on chat tab.
  const showHome =
    tab === "chat" && messages.length <= 1 && messages[0]?.id === "welcome";

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
                tab === t
                  ? "bg-white text-stone-900 shadow-sm"
                  : "text-stone-500 hover:text-stone-800"
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
            <HomeGreeting
              greeting={timeGreeting()}
              firstName={firstName}
              onPick={pickSuggestion}
            />
          ) : (
            <div className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-4 py-6 sm:px-6">
              <div className="space-y-5">
                {messages
                  .filter((m) => m.id !== "welcome")
                  .map((msg) => (
                    <MessageRow
                      key={msg.id}
                      msg={msg}
                      isPending={pendingSkill?.msgId === msg.id}
                      onConfirm={handleConfirm}
                      onDismiss={() => {
                        updateMessage(msg.id, { skillResult: undefined, text: "Cancelled." });
                        setPendingSkill(null);
                      }}
                    />
                  ))}
                <div ref={bottomRef} />
              </div>
            </div>
          )}

          {/* Input bar (always pinned at the bottom of the chat tab) */}
          <div className="sticky bottom-0 z-20 bg-gradient-to-t from-[#faf9f7] via-[#faf9f7] to-transparent px-4 pb-5 pt-3 sm:px-6 sm:pb-7">
            <div className="mx-auto w-full max-w-3xl">
              <ChatInput
                inputRef={inputRef}
                value={input}
                onChange={setInput}
                onSend={handleSend}
                disabled={interpreting || !!pendingSkill}
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
                <div
                  key={p.id}
                  className="space-y-2 rounded-2xl border border-stone-200 bg-white p-4"
                >
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

// ── Greeting + suggestion chips (empty home state) ───────────────────

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
        <Sparkles
          className="h-7 w-7 sm:h-8 sm:w-8"
          style={{ color: "#c25b3f" }}
          aria-hidden
        />
        {/* suppressHydrationWarning: greeting is timezone-dependent and
            differs between server (UTC) and client. Without this we trip
            React #418 and the whole tree is regenerated on mount. */}
        <h1
          suppressHydrationWarning
          className="text-3xl font-medium tracking-tight text-stone-800 sm:text-[2.5rem]"
          style={{
            fontFamily:
              "ui-serif, Georgia, Cambria, 'Times New Roman', Times, serif",
          }}
        >
          {greeting}, {firstName}
        </h1>
      </div>

      {/* Suggestion chips */}
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

// ── Chat input (large rounded box) ───────────────────────────────────

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
  // Auto-grow textarea up to ~6 lines.
  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    onChange(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
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
            DotArc Agent
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onSend}
            disabled={disabled || !value.trim()}
            aria-label="Send"
            className="ml-1 inline-flex h-9 w-9 items-center justify-center rounded-full bg-stone-900 text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-300"
          >
            {interpreting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Single chat message row ──────────────────────────────────────────

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
    return (
      <p className="text-center text-xs italic text-stone-400">{msg.text}</p>
    );
  }
  // agent
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
        {msg.skillResult && isPending && (
          <ConfirmCard result={msg.skillResult} onConfirm={onConfirm} onDismiss={onDismiss} />
        )}
      </div>
    </div>
  );
}
