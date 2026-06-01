"use client";

import { useCallback, useEffect, useState } from "react";
import { Contract, JsonRpcProvider, formatUnits } from "ethers";
import { useCircleWallet } from "../circle-wallet-context";
import { AuthGate } from "../auth-gate";
import { SendModal } from "./send-modal";
import { ReceiveModal } from "./receive-modal";
import { QrModal } from "./qr-modal";
import { RequestModal } from "./request-modal";
import { WalletShell, type ActivityRow, type Tab, type TokenBalance } from "./wallet-shell";
import WalletLoading from "./loading";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

const ARC_EXPLORER = process.env.NEXT_PUBLIC_ARC_EXPLORER_URL || "https://testnet.arcscan.app/tx/";
const ARC_RPC_URL = process.env.NEXT_PUBLIC_ARC_RPC_URL || "https://rpc.testnet.arc.network";
const USDC_ADDRESS = process.env.NEXT_PUBLIC_USDC_TOKEN_ADDRESS || "0x3600000000000000000000000000000000000000";
const EURC_ADDRESS = process.env.NEXT_PUBLIC_EURC_TOKEN_ADDRESS || "";
const CIRBTC_ADDRESS = process.env.NEXT_PUBLIC_CIRBTC_TOKEN_ADDRESS || "";

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

// Approximate USD rates for total balance display (display only, not for math)
const TOKEN_USD_RATES: Record<string, number> = {
  USDC: 1.0,
  EURC: 1.08,
  cirBTC: 100_000,
};

export default function WalletPage() {
  const { status, session, error, clearError, startCircleFlow, registerName, logout } = useCircleWallet();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState<{ arcName: string; txHash: string } | null>(null);

  const [balance, setBalance] = useState<string | null>(null);
  const [tokenBalances, setTokenBalances] = useState<TokenBalance[]>([]);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [copiedAddress, setCopiedAddress] = useState(false);
  const [showReceive, setShowReceive] = useState(false);
  const [showSend, setShowSend] = useState(false);
  const [showRequest, setShowRequest] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [agentActivated, setAgentActivated] = useState<boolean | null>(null);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>("home");

  // Reusable loader — pulls the unified activity feed (main wallet +
  // agent wallet, merged) AND the agent activation flag. Called on mount
  // and whenever a realtime row change comes in.
  const loadAgentStatus = useCallback(async () => {
    // Activity feed — runs even for non-invited (non-agent) users so the
    // main wallet's sends/receives still surface. Endpoint is dedicated
    // to the Activity tab and not gated by the Smart Agent invite system.
    try {
      const r = await fetch("/api/wallet/activity");
      if (r.ok) {
        const d = await r.json();
        const rows: ActivityRow[] = Array.isArray(d.activity)
          ? d.activity.map((row: {
              id: string;
              source: "wallet" | "agent";
              kind: ActivityRow["kind"];
              counterpartyAddress: string | null;
              counterpartyArcName: string | null;
              amount: number | string;
              tokenSymbol: string;
              txHash: string | null;
              status: string;
              executedAt: string;
            }) => ({
              id: row.id,
              source: row.source,
              kind: row.kind,
              counterparty: row.counterpartyAddress ?? null,
              counterpartyArcName: row.counterpartyArcName ?? null,
              amountUsdc: Number(row.amount) || 0,
              status:
                row.status === "COMPLETE" || row.status === "PENDING" || row.status === "FAILED"
                  ? (row.status as ActivityRow["status"])
                  : "COMPLETE",
              txHash: row.txHash ?? null,
              at: row.executedAt,
            }))
          : [];
        setActivity(rows);
      }
    } catch {
      // Network / parsing failures: keep whatever activity was already
      // rendered so the UI doesn't blink to empty on transient errors.
    }

    // Agent activation flag — separate concern; this endpoint is gated.
    try {
      const r = await fetch("/api/agent/status");
      if (r.ok) {
        const d = await r.json();
        setAgentActivated(d.activated ?? false);
      } else {
        setAgentActivated((prev) => prev ?? false);
      }
    } catch {
      setAgentActivated((prev) => prev ?? false);
    }
  }, []);

  // Initial load once the user is authenticated.
  useEffect(() => {
    if (status !== "authenticated") return;
    loadAgentStatus();
  }, [status, loadAgentStatus]);

  // Realtime: when the Circle webhook writes/updates a spend-log row OR the
  // balance cache on `profiles`, refresh the activity feed and trigger a
  // balance refetch so the UI moves without the user reloading.
  useEffect(() => {
    if (status !== "authenticated" || !session?.userId) return;
    const supabase = createSupabaseBrowserClient();

    const channel = supabase
      .channel(`wallet-live-${session.userId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "wallet_transactions",
          filter: `user_id=eq.${session.userId}`,
        },
        () => { loadAgentStatus(); }
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "agent_spend_log",
          filter: `user_id=eq.${session.userId}`,
        },
        () => { loadAgentStatus(); }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "profiles",
          filter: `id=eq.${session.userId}`,
        },
        (payload) => {
          // The webhook writes balance_cache_usdc directly; mirror it into
          // the displayed balance immediately so we don't wait the 15s
          // polling cycle.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const next = (payload.new as any)?.balance_cache_usdc;
          if (typeof next === "string") setBalance(next);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [status, session?.userId, loadAgentStatus]);

  useEffect(() => {
    if (!session?.walletAddress) return;
    let cancelled = false;

    const TOKEN_CONFIG: { symbol: string; name: string; address: string }[] = [
      { symbol: "USDC", name: "USD Coin", address: USDC_ADDRESS },
      ...(EURC_ADDRESS ? [{ symbol: "EURC", name: "Euro Coin", address: EURC_ADDRESS }] : []),
      ...(CIRBTC_ADDRESS ? [{ symbol: "cirBTC", name: "Circle BTC", address: CIRBTC_ADDRESS }] : []),
    ];

    const fetchBalances = async () => {
      setBalanceLoading(true);
      try {
        const provider = new JsonRpcProvider(ARC_RPC_URL);
        const results: TokenBalance[] = [];

        await Promise.all(
          TOKEN_CONFIG.map(async (cfg) => {
            try {
              const contract = new Contract(cfg.address, ERC20_ABI, provider);
              const [raw, decimals] = await Promise.all([
                contract.balanceOf(session.walletAddress) as Promise<bigint>,
                contract.decimals() as Promise<bigint>,
              ]);
              const amount = formatUnits(raw, decimals);
              const rate = TOKEN_USD_RATES[cfg.symbol] ?? 0;
              results.push({
                symbol: cfg.symbol,
                name: cfg.name,
                address: cfg.address,
                amount,
                decimals: Number(decimals),
                usdValue: parseFloat(amount) * rate,
              });
              if (cfg.symbol === "USDC" && !cancelled) {
                setBalance(amount);
              }
            } catch {
              results.push({
                symbol: cfg.symbol,
                name: cfg.name,
                address: cfg.address,
                amount: "0",
                decimals: 6,
                usdValue: 0,
              });
              if (cfg.symbol === "USDC" && !cancelled) setBalance("0");
            }
          })
        );

        if (!cancelled) setTokenBalances(results);
      } catch {
        if (!cancelled) setBalance("0");
      } finally {
        if (!cancelled) setBalanceLoading(false);
      }
    };

    fetchBalances();
    const interval = setInterval(fetchBalances, 15_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [session?.walletAddress]);

  const copyAddress = useCallback(async () => {
    if (!session?.walletAddress) return;
    try {
      await navigator.clipboard.writeText(session.walletAddress);
      setCopiedAddress(true);
      setTimeout(() => setCopiedAddress(false), 1800);
    } catch {}
  }, [session?.walletAddress]);

  const handleRequest = useCallback(() => {
    if (!session?.walletAddress) return;
    setShowRequest(true);
  }, [session?.walletAddress]);

  const onRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name) return;
    setBusy(true);
    try {
      const r = await registerName(name);
      setSuccess(r);
      setName("");
    } catch {} finally { setBusy(false); }
  };

  if (status === "loading") {
    return <WalletLoading />;
  }

  if (status === "anonymous") {
    return (
      <div
        className="flex min-h-screen items-stretch justify-stretch"
        style={{
          // Darker top-left → lighter bottom-right, matching the design ref.
          background:
            "linear-gradient(135deg, #1e3a8a 0%, #2456b8 55%, #3b82f6 100%)",
        }}
      >
        <AuthGate
          initialError={error}
          onVerified={async (verifiedEmail) => {
            clearError();
            console.log("[wallet] email verified, domain:", verifiedEmail.split("@")[1]);
            await startCircleFlow();
          }}
        />
      </div>
    );
  }

  if (status === "error") {
    return (
      <div
        className="flex min-h-screen items-center justify-center p-4"
        style={{ background: "#3a6fb8" }}
      >
        <div className="w-full max-w-md rounded-3xl bg-[#4a82c8] p-7 sm:p-8">
          <h2 className="font-clash text-xl font-semibold uppercase tracking-tight text-white sm:text-2xl">
            Something went wrong
          </h2>
          <p className="mt-3 font-geist text-sm text-white/80">
            {error ?? "We hit a snag setting up your wallet."}
          </p>
          <div className="mt-6 flex flex-col gap-3">
            <button
              onClick={() => { clearError(); startCircleFlow(); }}
              className="font-clash w-full rounded-2xl bg-white px-6 py-3 text-sm font-semibold uppercase tracking-wider text-[#2563a6] transition hover:bg-white/90"
            >
              Try again
            </button>
            <button
              onClick={logout}
              className="font-geist w-full text-xs text-white/70 hover:text-white transition"
            >
              Sign out and start over
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (status === "signing-in") {
    return (
      <div
        className="flex min-h-screen items-center justify-center p-4"
        style={{ background: "#3a6fb8" }}
      >
        <div className="w-full max-w-md rounded-3xl bg-[#4a82c8] p-8 text-center">
          <div className="mx-auto mb-4 h-7 w-7 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          <h2 className="font-clash text-xl font-semibold uppercase tracking-tight text-white">
            Welcome back
          </h2>
          <p className="mt-3 font-geist text-sm text-white/80">Signing you in…</p>
        </div>
      </div>
    );
  }

  if (status === "challenging" || status === "wallet-ready") {
    return (
      <div
        className="flex min-h-screen items-center justify-center p-4"
        style={{ background: "#3a6fb8" }}
      >
        <div className="w-full max-w-md rounded-3xl bg-[#4a82c8] p-8 text-center">
          <div className="mx-auto mb-4 h-7 w-7 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          <h2 className="font-clash text-xl font-semibold uppercase tracking-tight text-white">
            Setting up your wallet…
          </h2>
          <p className="mt-3 font-geist text-sm text-white/80">
            {status === "challenging"
              ? "Complete the PIN setup in the Circle dialog."
              : "Almost there — securing your session…"}
          </p>
        </div>
      </div>
    );
  }

  if (status === "needs-name" || status === "registering-name") {
    return (
      <div
        className="flex min-h-screen items-center justify-center p-4"
        style={{ background: "#3a6fb8" }}
      >
        <div className="w-full max-w-md rounded-3xl bg-[#4a82c8] p-7 sm:p-8">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1">
            <span className="font-clash text-[10px] font-semibold uppercase tracking-widest text-white">
              Final step
            </span>
          </div>
          <h1 className="font-clash text-2xl font-semibold uppercase tracking-tight text-white sm:text-3xl">
            Pick your <span className="text-white/80">.arc</span> name
          </h1>
          <p className="mt-3 font-geist text-sm text-white/80">
            This is how friends will send you USDC. We pay the 5 USDC registration fee.
            Your name resolves to your wallet on Arc Testnet.
          </p>

          {error && (
            <div className="mt-5 rounded-2xl bg-red-500/15 p-4 ring-1 ring-red-500/40">
              <p className="font-geist text-sm text-red-100">{error}</p>
              <button
                onClick={clearError}
                className="float-right -mt-6 text-lg leading-none text-red-200 opacity-60 hover:opacity-100"
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          )}

          <form onSubmit={onRegister} className="mt-6 space-y-4">
            <div className="relative">
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                placeholder="alice"
                className="w-full rounded-2xl border-2 border-white/20 bg-white/10 px-4 py-3 pr-16 font-geist text-base text-white placeholder-white/40 outline-none transition focus:border-white/60 focus:bg-white/15"
                disabled={busy || status === "registering-name"}
                minLength={3}
                maxLength={32}
                autoFocus
              />
              <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 font-clash text-sm font-semibold text-white/70">
                .arc
              </span>
            </div>
            <p className="font-geist text-xs text-white/70">
              3–32 characters. Lowercase letters, numbers, and hyphens only.
            </p>
            <button
              type="submit"
              disabled={busy || name.length < 3 || status === "registering-name"}
              className="font-clash w-full rounded-2xl bg-white px-6 py-3 text-sm font-semibold uppercase tracking-wider text-[#2563a6] transition hover:bg-white/90 disabled:opacity-40"
            >
              {status === "registering-name" ? "Registering on-chain…" : `Claim ${name || "name"}.arc`}
            </button>
          </form>

          <button
            onClick={logout}
            className="mt-5 font-geist w-full text-xs text-white/70 hover:text-white transition"
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  // ── Authenticated dashboard ──
  // WalletShell is the new sidebar+main layout from the design.
  // All state (modals, balance polling, session) is owned by this page.

  if (!session) {
    // Defensive: shouldn't happen since `status === authenticated` implies a session,
    // but the type system doesn't know that. Fall through to the loading skeleton.
    return (
      <div
        className="flex min-h-screen items-center justify-center"
        style={{ background: "#3a6fb8" }}
      >
        <div className="h-7 w-7 animate-spin rounded-full border-2 border-white/30 border-t-white" />
      </div>
    );
  }

  const balanceForShell = balance ?? "0";
  const totalUsdValue = tokenBalances.reduce((sum, t) => sum + (t.usdValue ?? 0), 0);

  return (
    <>
      <WalletShell
        arcName={session.arcName}
        email={session.email}
        walletAddress={session.walletAddress}
        balanceUsdc={balanceForShell}
        balanceLoading={balanceLoading && balance === null}
        tokenBalances={tokenBalances}
        totalUsdValue={totalUsdValue}
        agentActivated={agentActivated}
        activity={activity}
        onSend={() => setShowSend(true)}
        onReceive={() => setShowReceive(true)}
        onShowQr={() => setShowQr(true)}
        onRequest={handleRequest}
        onCopyAddress={copyAddress}
        onActivateAgent={() => setActiveTab("agent")}
        onLogout={logout}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        copiedAddress={copiedAddress}
      />

      {/* Success banner — overlay-style, dismissable */}
      {success && (
        <div
          className="fixed inset-x-3 top-4 z-50 mx-auto max-w-md rounded-2xl bg-emerald-500/95 p-4 shadow-xl backdrop-blur-md sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2"
        >
          <p className="font-geist text-sm text-white">
            <span className="mr-1">🎉</span>
            <strong className="font-clash uppercase tracking-wide">{success.arcName}</strong>{" "}
            is yours.{" "}
            <a
              href={`${ARC_EXPLORER}${success.txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-white/80"
            >
              View on explorer →
            </a>
            <button
              onClick={() => setSuccess(null)}
              className="float-right -mt-5 text-lg leading-none text-white/80 hover:text-white"
              aria-label="Dismiss"
            >
              ×
            </button>
          </p>
        </div>
      )}

      {/* Modals — unchanged behavior */}
      {showSend && (
        <SendModal
          onClose={() => setShowSend(false)}
          onSent={async () => {
            // Don't close the modal here — the user needs to see the
            // "Transaction submitted!" screen and click "Done". We just
            // refresh the balance in the background.
            if (session?.walletAddress) {
              try {
                const provider = new JsonRpcProvider(ARC_RPC_URL);
                const usdc = new Contract(USDC_ADDRESS, ERC20_ABI, provider);
                const [raw, decimals] = await Promise.all([
                  usdc.balanceOf(session.walletAddress) as Promise<bigint>,
                  usdc.decimals() as Promise<bigint>,
                ]);
                setBalance(formatUnits(raw, decimals));
              } catch {}
            }
          }}
        />
      )}

      {showReceive && (
        <ReceiveModal
          walletAddress={session.walletAddress}
          arcName={session.arcName}
          onClose={() => setShowReceive(false)}
        />
      )}

      {showQr && (
        <QrModal
          walletAddress={session.walletAddress}
          arcName={session.arcName}
          onClose={() => setShowQr(false)}
        />
      )}

      {showRequest && (
        <RequestModal
          walletAddress={session.walletAddress}
          arcName={session.arcName}
          onClose={() => setShowRequest(false)}
        />
      )}

    </>
  );
}
