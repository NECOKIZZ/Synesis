"use client";

/**
 * WalletShell — the authenticated dashboard layout (sidebar + main panel).
 *
 * Implements the "Hi <name> / 00.000 USDC" design with:
 *   - Persistent left sidebar on desktop (≥ md): brand, nav, logout
 *   - Bottom nav bar on mobile (< md)
 *   - Hero card with greeting, balance, and a QR avatar tile
 *   - 4 quick actions: Send · Receive · Request · Copy Address
 *   - Assets section listing USDC balance
 *   - Activity tab (recent on-chain + agent activity)
 *
 * State (modals, balance polling, session) is owned by the parent
 * WalletPage. This component only handles layout + navigation tabs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import QRCode from "qrcode";
import { useCircleWallet } from "@/app/circle-wallet-context";
import type { AnyTaskResult } from "@/lib/agent-types";
import {
  Home as HomeIcon,
  Activity as ActivityIcon,
  Bot,
  LogOut,
  Send,
  ArrowDownLeft,
  HandCoins,
  Copy as CopyIcon,
  Check,
  ExternalLink,
  Loader2,
  ArrowUp,
  List,
  AlertTriangle,
  Repeat,
  Shield,
  Zap,
  Coins as CoinsIcon,
  RefreshCw,
  Sparkles,
  X,
  ChevronRight,
  Lock,
} from "lucide-react";

const ARC_EXPLORER = process.env.NEXT_PUBLIC_ARC_EXPLORER_URL || "https://testnet.arcscan.app/tx/";

export type Tab = "home" | "activity" | "agent" | "policies";

export interface ActivityRow {
  id: string;
  kind: "SEND" | "RECEIVE" | "WITHDRAW" | "OTHER";
  counterparty?: string | null;
  counterpartyArcName?: string | null;
  amountUsdc: number;
  status: "PENDING" | "COMPLETE" | "FAILED";
  txHash?: string | null;
  at: string; // ISO
}

export interface TokenBalance {
  symbol: string;
  name: string;
  address: string;
  amount: string;
  decimals: number;
  usdValue: number; // approximate USD value for this token balance
}

export interface WalletShellProps {
  arcName: string | null;
  email: string;
  walletAddress: string;
  balanceUsdc: string;          // formatted decimal, e.g. "12.34"
  balanceLoading: boolean;
  tokenBalances: TokenBalance[];
  totalUsdValue: number;        // total USD across all tokens
  agentActivated: boolean | null;
  activity: ActivityRow[];
  onSend: () => void;
  onReceive: () => void;
  onShowQr: () => void;          // hero QR tile click — opens QR-only modal
  onRequest: () => void;        // opens receive in "request a payment" mode
  onCopyAddress: () => void;
  onActivateAgent: () => void;
  onLogout: () => void;
  copiedAddress: boolean;
  activeTab: Tab;
  onTabChange: (t: Tab) => void;
}

export function WalletShell(props: WalletShellProps) {
  const {
    arcName,
    email,
    walletAddress,
    balanceLoading,
    tokenBalances,
    totalUsdValue,
    activity,
    onSend,
    onReceive,
    onShowQr,
    onRequest,
    onCopyAddress,
    onLogout,
    copiedAddress,
    activeTab: tab,
    onTabChange: setTab,
  } = props;
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  // Friendly first-name extraction: use the .arc label, else the local part
  // of the email, capitalized. "alice.arc" -> "Alice"; "bob@x.com" -> "Bob".
  const displayName = useMemo(() => {
    const base = arcName ? arcName.split(".")[0] : email.split("@")[0];
    if (!base) return "there";
    return base.charAt(0).toUpperCase() + base.slice(1);
  }, [arcName, email]);

  // Hero balance — total USD across all tokens, split into integer + fraction
  const [intPart, fracPart] = useMemo(() => {
    const n = totalUsdValue;
    if (!isFinite(n)) return ["00", "000"];
    const fixed = n.toFixed(3);
    const [i, f] = fixed.split(".");
    return [i.padStart(2, "0"), f];
  }, [totalUsdValue]);

  // Build the QR data URL for the hero card tile. Encodes wallet address.
  useEffect(() => {
    if (!walletAddress) return;
    let cancelled = false;
    QRCode.toDataURL(walletAddress, {
      errorCorrectionLevel: "M",
      width: 220,
      margin: 1,
      color: { dark: "#0a0a0a", light: "#ffffff" },
    })
      .then((url) => { if (!cancelled) setQrDataUrl(url); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [walletAddress]);

  return (
    <div
      className="wallet-page w-full"
      style={{
        // Deep navy base + a wide cool-blue glow blooming up from below the
        // viewport. Single radial keeps paint cost low — no fixed attachment.
        backgroundColor: BRAND_BLUE,
        backgroundImage:
          "radial-gradient(ellipse 90% 60% at 50% 115%, rgba(90, 150, 240, 0.42) 0%, rgba(90, 150, 240, 0.18) 35%, rgba(90, 150, 240, 0) 65%)",
      }}
    >
      {/* Shimmer animation keyframes — injected once for all skeletons */}
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes shimmer-slide {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}} />
      {/* Layout grid: sidebar + main on md+, single column on mobile */}
      <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 p-3 sm:p-5 md:flex-row md:gap-6 md:p-6 lg:p-8">

        {/* ── Sidebar (desktop) ── */}
        {/* `md:sticky` + `md:self-start` keeps the sidebar pinned and stops
            flexbox from stretching it to match a tall main column (which
            was making the sidebar elongate on the activity tab). Height is
            capped to the visible viewport so the sidebar never grows past
            one screen, regardless of how long the activity list is. */}
        <aside
          className="hidden md:sticky md:top-6 md:flex md:h-[calc(100dvh-3rem)] md:w-[200px] md:shrink-0 md:flex-col md:self-start lg:w-[220px]"
          style={{ flexShrink: 0 }}
        >
          <SidebarCard
            tab={tab}
            setTab={setTab}
            onLogout={onLogout}
          />
        </aside>

        {/* ── Main panel ── */}
        <main className="flex min-w-0 flex-1 flex-col gap-4 md:gap-5">
          {/* Mobile top bar (logo + logout) */}
          <div className="flex items-center justify-between md:hidden">
            <Link href="/" className="inline-flex items-center" aria-label=".arc home">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/arc-logo.png"
                alt=".arc"
                className="h-8 w-auto select-none"
                draggable={false}
              />
            </Link>
            <button
              onClick={onLogout}
              className="flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur-sm transition active:bg-white/25"
            >
              <LogOut size={12} />
              Sign out
            </button>
          </div>

          {balanceLoading ? (
            <>
              {tab === "home" && <HomeShimmer />}
              {tab === "activity" && <ActivityShimmer />}
              {tab === "agent" && <AgentShimmer />}
              {tab === "policies" && <PoliciesShimmer />}
            </>
          ) : (
            <>
              {tab === "home" && (
                <HomeTab
                  displayName={displayName}
                  arcName={arcName}
                  intPart={intPart}
                  fracPart={fracPart}
                  balanceLoading={balanceLoading}
                  tokenBalances={tokenBalances}
                  qrDataUrl={qrDataUrl}
                  onReceive={onReceive}
                  onShowQr={onShowQr}
                  onSend={onSend}
                  onRequest={onRequest}
                  onCopyAddress={onCopyAddress}
                  copiedAddress={copiedAddress}
                />
              )}
              {tab === "activity" && <ActivityTab activity={activity} />}
              <div className={tab !== "agent" ? "hidden" : ""}><AgentTab arcName={arcName} /></div>
              <div className={tab !== "policies" ? "hidden" : ""}><PoliciesTab /></div>
            </>
          )}
        </main>
      </div>

      {/* ── Mobile bottom nav ── */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex justify-around border-t border-white/20 bg-[#2c5994]/95 px-1.5 py-1.5 backdrop-blur-md md:hidden"
        style={{ paddingBottom: "max(0.375rem, env(safe-area-inset-bottom))" }}
      >
        <MobileNavBtn
          icon={<HomeIcon size={17} />}
          label="Home"
          active={tab === "home"}
          onClick={() => setTab("home")}
        />
        <MobileNavBtn
          icon={<ActivityIcon size={17} />}
          label="Activity"
          active={tab === "activity"}
          onClick={() => setTab("activity")}
        />
        <MobileNavBtn
          icon={<Bot size={17} />}
          label="Agent"
          active={tab === "agent"}
          onClick={() => setTab("agent")}
        />
        <MobileNavBtn
          icon={<List size={17} />}
          label="Policies"
          active={tab === "policies"}
          onClick={() => setTab("policies")}
        />
      </nav>

      {/* Spacer so content isn't covered by mobile nav */}
      <div className="h-16 md:hidden" />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Sidebar
// ────────────────────────────────────────────────────────────────────

function SidebarCard({
  tab, setTab, onLogout,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  onLogout: () => void;
}) {
  return (
    <div
      // `h-full` fills the aside (which now provides its own height cap).
      // Removing the old `min-h-[calc(100dvh-3rem)]` was the fix — that
      // floor was forcing the sidebar to grow with sibling content.
      className="relative flex h-full flex-col overflow-hidden rounded-3xl p-6"
      style={{
        // Soft top highlight + bottom-corner glow over the brand-blue base.
        backgroundColor: "#4a82c8",
        backgroundImage: [
          "radial-gradient(ellipse at 50% -10%, rgba(255, 255, 255, 0.22) 0%, rgba(255, 255, 255, 0) 55%)",
          "radial-gradient(circle at 0% 100%, rgba(20, 50, 110, 0.35) 0%, rgba(20, 50, 110, 0) 50%)",
        ].join(", "),
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.22)",
      }}
    >
      {/* Brand */}
      <Link
        href="/"
        className="mb-8 inline-flex items-center"
        aria-label=".arc home"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/arc-logo.png"
          alt=".arc"
          className="h-10 w-auto select-none"
          draggable={false}
        />
      </Link>

      {/* Nav */}
      <nav className="flex flex-col gap-1.5">
        <SidebarItem
          icon={<HomeIcon size={16} />}
          label="Home"
          active={tab === "home"}
          onClick={() => setTab("home")}
        />
        <SidebarItem
          icon={<ActivityIcon size={16} />}
          label="Activity"
          active={tab === "activity"}
          onClick={() => setTab("activity")}
        />
        <SidebarItem
          icon={<Bot size={16} />}
          label="Agent"
          active={tab === "agent"}
          onClick={() => setTab("agent")}
        />
        <SidebarItem
          icon={<List size={16} />}
          label="Policies"
          active={tab === "policies"}
          onClick={() => setTab("policies")}
        />
      </nav>

      {/* Spacer */}
      <div className="mt-auto" />

      {/* Logout */}
      <button
        onClick={onLogout}
        className="group inline-flex items-center gap-2 self-start font-clash text-sm font-semibold uppercase tracking-[0.18em] text-white/90 transition hover:text-white"
        style={{ fontFamily: "'Clash Display', sans-serif" }}
      >
        <LogOut
          size={18}
          className="transition group-hover:-translate-x-0.5"
        />
        Log out
      </button>
    </div>
  );
}

function SidebarItem({
  icon, label, active, onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "flex w-full items-center gap-2.5 rounded-full px-3.5 py-2 text-left font-clash text-sm font-semibold transition " +
        (active
          ? "bg-white text-[#2563a6] shadow-sm"
          : "text-white/90 hover:bg-white/10")
      }
      style={{ fontFamily: "'Clash Display', sans-serif" }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function MobileNavBtn({
  icon, label, active, onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "flex flex-1 flex-col items-center gap-0.5 rounded-2xl px-1.5 py-1 transition " +
        (active ? "bg-white text-[#2563a6]" : "text-white/85 hover:text-white")
      }
    >
      {icon}
      <span
        className="font-clash text-[9px] font-semibold uppercase tracking-wide"
        style={{ fontFamily: "'Clash Display', sans-serif" }}
      >
        {label}
      </span>
    </button>
  );
}

// ────────────────────────────────────────────────────────────────────
// AgentAddressStrip
// ────────────────────────────────────────────────────────────────────

function AgentAddressStrip({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  const short = `${address.slice(0, 8)}…${address.slice(-6)}`;
  return (
    <div className="flex items-center justify-between gap-2 border-b border-white/8 bg-white/5 px-5 py-2">
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="text-[11px] text-white/40 shrink-0">Agent wallet</span>
        <span className="font-mono text-[11px] text-white/70 truncate">{short}</span>
      </div>
      <button
        onClick={copy}
        className="flex items-center gap-1 rounded-lg border border-white/15 bg-white/8 px-2.5 py-1 text-[11px] font-medium text-white/70 transition hover:bg-white/15 hover:text-white shrink-0"
      >
        {copied ? <Check size={10} className="text-green-400" /> : <CopyIcon size={10} />}
        {copied ? "Copied" : "Copy to deposit"}
      </button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Home tab
// ────────────────────────────────────────────────────────────────────

function HomeTab(props: {
  displayName: string;
  arcName: string | null;
  intPart: string;
  fracPart: string;
  balanceLoading: boolean;
  tokenBalances: TokenBalance[];
  qrDataUrl: string | null;
  onSend: () => void;
  onReceive: () => void;
  onShowQr: () => void;
  onRequest: () => void;
  onCopyAddress: () => void;
  copiedAddress: boolean;
}) {
  const {
    displayName, arcName, intPart, fracPart, balanceLoading, tokenBalances, qrDataUrl,
    onSend, onReceive, onShowQr, onRequest, onCopyAddress, copiedAddress,
  } = props;

  return (
    <>
      {/* ── Hero balance card ── */}
      <section
        className="relative overflow-hidden rounded-3xl"
        style={{
          // Linear base for the dark card + two stacked radial blooms.
          // The cyan glow anchors the balance; the violet glow softens the
          // opposite corner so the card doesn't read as flat black.
          backgroundColor: "#0a0a0a",
          backgroundImage: [
            "radial-gradient(ellipse at 18% 38%, rgba(56, 130, 255, 0.22) 0%, rgba(56, 130, 255, 0) 55%)",
            "radial-gradient(ellipse at 92% 90%, rgba(140, 90, 255, 0.18) 0%, rgba(140, 90, 255, 0) 60%)",
            "linear-gradient(135deg, #0a0a0a 0%, #131318 60%, #0a0a0a 100%)",
          ].join(", "),
        }}
      >
        {/* Watermark — ".arc" set HUGE in the Clash Display brand face,
            then clipped so only the top half peeks above the card's bottom
            edge. The card's `overflow-hidden` does the actual clipping;
            translateY(50%) pushes the element's own bottom past the card,
            independent of font size at each breakpoint. */}
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-0 right-8 select-none font-clash text-[140px] font-bold leading-none text-white/[0.07] sm:text-[180px] md:text-[230px]"
          style={{
            fontFamily: "'Clash Display', sans-serif",
            transform: "translateY(50%)",
          }}
        >
          .arc
        </div>

        <div className="relative flex flex-col gap-4 p-4 sm:p-6 md:flex-row md:items-start md:justify-between md:gap-6 md:p-7">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-white/80">
              <span
                className="font-clash text-sm font-medium sm:text-base"
                style={{ fontFamily: "'Clash Display', sans-serif" }}
              >
                Hi {displayName},
              </span>
              <CopyNameButton arcName={arcName} />
            </div>

            <div className="mt-3 flex items-baseline gap-2">
              {balanceLoading && !intPart ? (
                <div className="h-10 w-32 animate-pulse rounded-lg bg-white/10 sm:h-12 sm:w-44 md:h-16 md:w-56" />
              ) : (
                <>
                  <span
                    className="font-clash text-4xl font-bold leading-none text-white sm:text-5xl md:text-6xl"
                    style={{
                      fontFamily: "'Clash Display', sans-serif",
                      letterSpacing: "-0.04em",
                    }}
                  >
                    {intPart}
                    <span className="text-white/90">.{fracPart}</span>
                  </span>
                  <span
                    className="font-clash text-lg font-semibold text-white sm:text-xl md:text-2xl"
                    style={{ fontFamily: "'Clash Display', sans-serif" }}
                  >
                    USD
                  </span>
                </>
              )}
            </div>

            {/* The .arc handle is now surfaced as a copy button next to the
                greeting above, so we no longer duplicate it here. */}
          </div>

          {/* QR tile — clickable, opens the dedicated QR-only modal so
              someone can scan the code at full size. The receive modal
              (with copy/share actions) lives behind the Receive button. */}
          <button
            onClick={onShowQr}
            aria-label="Show QR code"
            className="group relative h-20 w-20 shrink-0 self-end overflow-hidden rounded-2xl bg-white/95 p-1.5 transition hover:scale-[1.03] active:scale-100 sm:h-24 sm:w-24 md:h-28 md:w-28 md:self-start"
          >
            {qrDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrDataUrl}
                alt="Wallet address QR"
                className="h-full w-full rounded-xl object-contain"
              />
            ) : (
              <div className="flex h-full w-full animate-pulse items-center justify-center rounded-xl bg-zinc-200" />
            )}
          </button>
        </div>
      </section>

      {/* ── Action buttons row ── */}
      {/* 4 columns at every viewport — all labels are single-word so they
          fit even on a 320px screen without wrapping. */}
      <section className="grid grid-cols-4 gap-2 sm:gap-3">
        <ActionBtn
          icon={<Send size={16} />}
          label="Send"
          onClick={onSend}
        />
        <ActionBtn
          icon={<ArrowDownLeft size={16} />}
          label="Receive"
          onClick={onReceive}
        />
        <ActionBtn
          icon={<HandCoins size={16} />}
          label="Request"
          onClick={onRequest}
        />
        <ActionBtn
          icon={<CopyIcon size={14} />}
          label={copiedAddress ? "Copied" : "Copy"}
          onClick={onCopyAddress}
          highlight={copiedAddress}
        />
      </section>

      {/* ── Assets ── */}
      <section className="rounded-3xl bg-[#0d2147] p-4 sm:p-5">
        <div className="mb-3 flex items-baseline justify-between">
          <h2
            className="font-clash text-lg font-semibold text-white sm:text-xl"
            style={{ fontFamily: "'Clash Display', sans-serif" }}
          >
            Assets
          </h2>
          <span className="text-[11px] uppercase tracking-[0.2em] text-white/70">
            Arc Testnet
          </span>
        </div>

        <div className="flex flex-col gap-2">
          {tokenBalances.length === 0 && balanceLoading ? (
            <div className="h-14 animate-pulse rounded-2xl bg-white/10" />
          ) : (
            tokenBalances.map((t) => (
              <TokenRow key={t.symbol} token={t} />
            ))
          )}
        </div>
      </section>

      {/* Agent entry-point lives in the sidebar (desktop) and in the
          mobile bottom nav, so we no longer surface it here under Assets. */}
    </>
  );
}

// ────────────────────────────────────────────────────────────────────
// Token row (rendered inside Assets section)
// ────────────────────────────────────────────────────────────────────

function TokenRow({ token }: { token: TokenBalance }) {
  const fmt = (n: number, decimals: number) => {
    if (!isFinite(n)) return "0.00";
    const fixed = n.toFixed(decimals);
    return fixed.replace(/\.?0+$/, "");
  };

  const n = parseFloat(token.amount);
  const displayAmount = fmt(n, token.decimals);

  const meta: Record<string, { bg: string; abbr: string }> = {
    USDC: { bg: "#2775CA", abbr: "$" },
    EURC: { bg: "#1A5AFF", abbr: "€" },
    cirBTC: { bg: "#F7931A", abbr: "₿" },
  };
  const m = meta[token.symbol] ?? { bg: "#6b7280", abbr: token.symbol.slice(0, 1) };

  return (
    <div className="flex items-center justify-between rounded-2xl bg-white/10 px-4 py-3.5 backdrop-blur-sm">
      <div className="flex items-center gap-3">
        <div
          className="flex h-10 w-10 items-center justify-center rounded-full font-bold text-white shadow-sm"
          style={{ backgroundColor: m.bg }}
        >
          {m.abbr}
        </div>
        <div>
          <div className="font-clash font-semibold text-white">{token.symbol}</div>
          <div className="text-xs text-white/70">{token.name}</div>
        </div>
      </div>
      <div className="text-right">
        <div className="font-clash text-base font-semibold text-white">{displayAmount}</div>
        <div className="text-xs text-white/70">{token.symbol}</div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Copy-name button (inline, replaces the wave emoji next to the greeting)
// ────────────────────────────────────────────────────────────────────

function CopyNameButton({ arcName }: { arcName: string | null }) {
  const [copied, setCopied] = useState(false);

  if (!arcName) return null;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(arcName!);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — silently no-op */
    }
  }

  return (
    <button
      onClick={handleCopy}
      aria-label={copied ? `${arcName} copied` : `Copy ${arcName}`}
      title={copied ? "Copied!" : `Copy ${arcName}`}
      className="inline-flex h-7 items-center gap-1.5 rounded-full bg-white/10 px-2.5 text-xs font-medium text-white/85 transition hover:bg-white/20 hover:text-white active:scale-[0.97]"
    >
      <span className="font-mono">{arcName}</span>
      {copied ? (
        <Check size={12} className="text-emerald-300" />
      ) : (
        <CopyIcon size={12} className="text-white/70" />
      )}
    </button>
  );
}

function ActionBtn({
  icon, label, onClick, highlight,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  highlight?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "flex flex-col items-center justify-center gap-1 rounded-2xl px-2 py-3 transition active:scale-[0.97] " +
        (highlight
          ? "bg-white text-[#2563a6]"
          : "bg-[#4a82c8] text-white hover:bg-[#5590d4]")
      }
      style={{ boxShadow: "inset 0 1px 0 rgba(255,255,255,0.18)" }}
    >
      <span>{icon}</span>
      <span
        className="font-clash whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide sm:text-xs"
        style={{ fontFamily: "'Clash Display', sans-serif" }}
      >
        {label}
      </span>
    </button>
  );
}

// ────────────────────────────────────────────────────────────────────
// Activity tab
// ────────────────────────────────────────────────────────────────────

function ActivityTab({ activity }: { activity: ActivityRow[] }) {
  return (
    <section className="rounded-3xl bg-[#0d2147] p-5 sm:p-7">
      <div className="mb-5 flex items-baseline justify-between">
        <h2
          className="font-clash text-2xl font-semibold text-white sm:text-3xl"
          style={{ fontFamily: "'Clash Display', sans-serif" }}
        >
          Activity
        </h2>
        <span className="text-[11px] uppercase tracking-[0.2em] text-white/70">
          Recent
        </span>
      </div>

      {activity.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-2xl bg-white/8 px-6 py-12 text-center backdrop-blur-sm">
          <ActivityIcon size={28} className="text-white/60" />
          <p
            className="font-clash text-base font-medium text-white"
            style={{ fontFamily: "'Clash Display', sans-serif" }}
          >
            No activity yet
          </p>
          <p className="max-w-xs text-xs text-white/70">
            Send or receive USDC and your transactions will appear here.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {activity.map((row) => (
            <ActivityRowItem key={row.id} row={row} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ActivityRowItem({ row }: { row: ActivityRow }) {
  const isOut = row.kind === "SEND" || row.kind === "WITHDRAW";

  const directionLabel =
    row.kind === "SEND" ? "Sent" :
    row.kind === "RECEIVE" ? "Received" :
    row.kind === "WITHDRAW" ? "Withdrew" : "Activity";

  const counterpartyDisplay = row.counterpartyArcName
    ? `${row.counterpartyArcName}.arc`
    : row.counterparty
      ? shortenAddr(row.counterparty)
      : null;

  const formattedDate = formatRelative(row.at);

  const shortHash = row.txHash
    ? `${row.txHash.slice(0, 6)}…${row.txHash.slice(-4)}`
    : null;

  const statusBadge =
    row.status === "PENDING" ? "bg-amber-500/15 text-amber-300" :
    row.status === "FAILED"  ? "bg-red-500/15 text-red-300" : null;

  const amountColor = isOut ? "text-red-300" : "text-emerald-300";

  return (
    <li className="rounded-2xl border border-white/8 bg-white/5 px-4 py-3.5 backdrop-blur-sm">
      <div className="flex min-w-0 items-center gap-3">
        {/* Icon */}
        <div
          className={
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full " +
            (isOut ? "bg-red-500/20 text-red-300" : "bg-emerald-500/20 text-emerald-300")
          }
        >
          {isOut ? <Send size={13} /> : <ArrowDownLeft size={13} />}
        </div>

        <div className="min-w-0 flex-1">
          {/* Row 1: direction · amount · arc name */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-semibold text-white">{directionLabel}</span>
            <span className={`text-sm font-semibold ${amountColor}`}>
              {isOut ? "−" : "+"}{row.amountUsdc.toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC
            </span>
            {counterpartyDisplay && (
              <>
                <span className="text-white/30 text-xs">→</span>
                <span className="text-xs font-medium text-blue-300">{counterpartyDisplay}</span>
              </>
            )}
            {statusBadge && (
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${statusBadge}`}>
                {row.status.toLowerCase()}
              </span>
            )}
          </div>
          {/* Row 2: date */}
          <div className="mt-0.5 text-[11px] text-white/40">{formattedDate}</div>
          {/* Row 3: tx hash */}
          {row.txHash && shortHash && (
            <a
              href={`${ARC_EXPLORER}${row.txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-0.5 inline-flex items-center gap-1 font-mono text-[11px] text-white/40 transition hover:text-blue-300"
            >
              {shortHash}
              <ExternalLink size={10} />
            </a>
          )}
        </div>
      </div>
    </li>
  );
}

// ────────────────────────────────────────────────────────────────────
// Constants + helpers
// ────────────────────────────────────────────────────────────────────

// Far darker navy base for the page — the brand-blue cards and accents
// pop against this with a moodier, premium feel. The bottom-of-page
// radial glow (configured inline at the wallet root) lifts this back
// up just enough to keep things from feeling flat.
const BRAND_BLUE = "#06122c";

function shortenAddr(s: string): string {
  if (s.length <= 12) return s;
  if (s.startsWith("0x")) return `${s.slice(0, 6)}…${s.slice(-4)}`;
  return s;
}

// ────────────────────────────────────────────────────────────────────
// Agent Tab — embedded chat UI (dark navy, matches wallet aesthetic)
// ────────────────────────────────────────────────────────────────────

type AgentMessage = {
  id: string;
  role: "user" | "agent" | "system";
  text: string;
  skillResult?: AnyTaskResult;
  pending?: boolean;
};

type AgentStatus = {
  activated: boolean;
  gated?: boolean;
  wallet?: { address: string; arcName: string | null; balanceUsdc: string };
  pinSet?: boolean;
  limits?: { max_per_transaction_usdc: number; max_daily_usdc: number; max_monthly_usdc: number };
  policies?: Array<{
    id: string; active: boolean; summary: string; category: string;
    triggerType: string; actionSkill: string; executionMode: string;
    executionCount: number; totalSpentUsdc: string; nextRun: string | null;
    createdAt: string; pauseReason: string | null;
  }>;
};

type OnboardStep = "landing" | "name" | "pin" | "limits" | "fund" | "done";
const ONBOARD_STEPS: OnboardStep[] = ["name", "pin", "limits", "fund"];
const ONBOARD_LABELS = ["Wallet", "PIN", "Limits", "Fund"];
const FUND_PRESETS = [10, 25, 50, 100];

function AgentTab({ arcName }: { arcName: string | null }) {
  const { executeChallenge } = useCircleWallet();

  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);

  // ── Onboarding state ──────────────────────────────────────────────
  const [onboardStep, setOnboardStep] = useState<OnboardStep>("landing");
  const [obLoading, setObLoading] = useState(false);
  const [obError, setObError] = useState("");
  const [arcNameLabel, setArcNameLabel] = useState("");
  const [skipName, setSkipName] = useState(false);
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [maxPerTx, setMaxPerTx] = useState("50");
  const [maxDaily, setMaxDaily] = useState("100");
  const [maxMonthly, setMaxMonthly] = useState("500");
  const [fundAmount, setFundAmount] = useState("25");

  // ── Chat state ────────────────────────────────────────────────────
  const [messages, setMessages] = useState<AgentMessage[]>([{
    id: "welcome", role: "agent",
    text: "Hi! I'm your DotArc agent. Tell me what to do — send USDC, set up recurring payments, check your balance, or update your limits.",
  }]);
  const [input, setInput] = useState("");
  const [interpreting, setInterpreting] = useState(false);
  const [pendingSkill, setPendingSkill] = useState<{ msgId: string; result: AnyTaskResult } | null>(null);
  const [cancelModal, setCancelModal] = useState<{ policyId: string; summary: string } | null>(null);
  const [cancelPin, setCancelPin] = useState("");
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelError, setCancelError] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const loadStatus = useCallback(async (resume = false) => {
    setStatusLoading(true);
    const res = await fetch("/api/agent/status");
    if (res.ok) {
      const d = await res.json();
      setAgentStatus(d);
      if (resume) {
        // activated = walletCreated + pinSet (server definition)
        if (d.activated) setOnboardStep("done");
        else if (d.walletCreated && d.pinSet && d.limitsSet) setOnboardStep("fund");
        else if (d.walletCreated && d.pinSet) setOnboardStep("limits");
        else if (d.walletCreated) setOnboardStep("pin");
        // else: stays "landing"
      }
    }
    setStatusLoading(false);
  }, []);

  useEffect(() => { loadStatus(true); }, [loadStatus]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  // ── Onboarding handlers ──────────────────────────────────────────
  const obErr = (msg: string) => { setObError(msg); setObLoading(false); };

  async function handleActivate() {
    setObError(""); setObLoading(true);
    const body: Record<string, string> = {};
    if (!skipName && arcNameLabel.trim()) body.arcNameLabel = arcNameLabel.trim();
    const res = await fetch("/api/agent/activate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) return obErr(data.error ?? "Activation failed");
    setObLoading(false); setOnboardStep("pin");
  }

  async function handleSetPin() {
    setObError("");
    if (!/^\d{4,8}$/.test(pin)) return obErr("PIN must be 4–8 digits");
    if (pin !== pinConfirm) return obErr("PINs do not match");
    setObLoading(true);
    const res = await fetch("/api/agent/set-pin", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    const data = await res.json();
    if (!res.ok) return obErr(data.error ?? "Failed to set PIN");
    setObLoading(false); setOnboardStep("limits");
  }

  async function handleSetLimits() {
    setObError("");
    const perTx = parseFloat(maxPerTx), daily = parseFloat(maxDaily), monthly = parseFloat(maxMonthly);
    if ([perTx, daily, monthly].some((v) => isNaN(v) || v <= 0)) return obErr("All limits must be positive numbers");
    setObLoading(true);
    const res = await fetch("/api/agent/set-limits", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin, maxPerTransaction: perTx, maxDaily: daily, maxMonthly: monthly }),
    });
    const data = await res.json();
    if (!res.ok) return obErr(data.error ?? "Failed to save limits");
    setObLoading(false); setOnboardStep("fund");
  }

  async function handleFund() {
    setObError("");
    const amount = parseFloat(fundAmount);
    if (isNaN(amount) || amount <= 0) return obErr("Enter a valid amount");
    setObLoading(true);
    const res = await fetch("/api/agent/fund", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: amount.toFixed(6) }),
    });
    const data = await res.json();
    if (!res.ok) return obErr(data.error ?? "Failed to prepare funding");
    try {
      await executeChallenge(data.challengeId, data.userToken, data.encryptionKey);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      const isNetworkError = /timeout|reset|connect|network|fetch|econnreset/i.test(msg);
      if (isNetworkError) {
        // Circle may have already broadcast the tx before the connection dropped.
        // Wait 3s then check if the balance actually increased.
        setObError("Network hiccup — checking if funds arrived…");
        await new Promise((r) => setTimeout(r, 3000));
        const check = await fetch("/api/agent/status")
          .then((r) => r.ok ? r.json() : null)
          .catch(() => null);
        const newBalance = parseFloat(check?.wallet?.balanceUsdc ?? "0");
        if (newBalance >= amount * 0.99) {
          setObLoading(false); setObError(""); setOnboardStep("done");
          await loadStatus();
          return;
        }
        return obErr("Network error during confirmation. If your agent balance shows funds, you're all set — otherwise retry.");
      }
      return obErr(msg || "Circle challenge failed");
    }
    setObLoading(false); setOnboardStep("done");
    await loadStatus();
  }

  function addMessage(msg: Omit<AgentMessage, "id">) {
    const id = crypto.randomUUID();
    setMessages((prev) => [...prev, { ...msg, id }]);
    return id;
  }
  function updateMessage(id: string, update: Partial<AgentMessage>) {
    setMessages((prev) => prev.map((m) => m.id === id ? { ...m, ...update } : m));
  }

  function extractSkillAmount(sr: AnyTaskResult): number {
    if (sr.task_type === "immediate") {
      if (sr.skill === "SEND_USDC" || sr.skill === "WITHDRAW") {
        const a = Number(sr.params.amount ?? 0);
        if (sr.params.amount === "all") return 0;
        return isFinite(a) ? a : 0;
      }
      if (sr.skill === "SWAP_USDC" || sr.skill === "BRIDGE_USDC") {
        const a = Number(sr.params.amount ?? 0);
        return isFinite(a) ? a : 0;
      }
      if (sr.skill === "SEND_TOKEN") {
        if (sr.params.amount === "all") return 0;
        const a = Number(sr.params.amount ?? 0);
        return isFinite(a) ? a : 0;
      }
      if (sr.skill === "CREATE_POLICY") {
        const action = sr.params.action as Record<string, unknown> | undefined;
        const ap = action?.params as Record<string, unknown> | undefined;
        if (ap?.amount === "all") return 0;
        const a = Number(ap?.amount ?? 0);
        return isFinite(a) ? a : 0;
      }
    }
    if (sr.task_type === "compound") {
      return sr.steps.reduce((sum, step) => {
        if (step.skill === "SEND_TOKEN") return sum;
        const a = Number(step.params.amount ?? 0);
        return sum + (isFinite(a) ? a : 0);
      }, 0);
    }
    return 0;
  }

  async function handleSend() {
    const instruction = input.trim();
    if (!instruction || interpreting) return;
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    addMessage({ role: "user", text: instruction });
    setInterpreting(true);
    const thinkingId = addMessage({ role: "agent", text: "Thinking…", pending: true });
    const res = await fetch("/api/agent/interpret", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction }),
    });
    setInterpreting(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      updateMessage(thinkingId, { text: d.error ?? "Failed to interpret instruction", pending: false });
      return;
    }
    const skillResult: AnyTaskResult = await res.json();
    if (skillResult.task_type === "immediate" && skillResult.skill === "UNKNOWN") {
      updateMessage(thinkingId, { text: String(skillResult.params.explanation ?? "I didn't understand that. Could you rephrase?"), pending: false });
      return;
    }
    if (skillResult.task_type === "immediate" && (skillResult.skill === "CHECK_BALANCE" || skillResult.skill === "LIST_POLICIES")) {
      updateMessage(thinkingId, { text: skillResult.skill === "LIST_POLICIES" ? "Fetching policies…" : "Checking balance…", pending: true });
      await confirmSkill(thinkingId, skillResult, "");
      return;
    }

    // ── Pre-flight balance guard (client-side, before confirm card) ──
    // Use the already-loaded agentStatus balance so the user never
    // reaches the PIN prompt only to be told they can't afford it.
    const knownBalance = parseFloat(agentStatus?.wallet?.balanceUsdc ?? "0");
    const requiredAmount = extractSkillAmount(skillResult);
    if (requiredAmount > 0 && knownBalance < requiredAmount) {
      updateMessage(thinkingId, {
        text: `Insufficient balance. Your agent wallet has ${knownBalance.toFixed(2)} USDC but this action needs ${requiredAmount.toFixed(2)} USDC. Top up from the Fund section.`,
        pending: false,
      });
      return;
    }

    updateMessage(thinkingId, { text: skillResult.confirmation_message, skillResult, pending: false });
    setPendingSkill({ msgId: thinkingId, result: skillResult });
  }

  async function confirmSkill(msgId: string, skillResult: AnyTaskResult, pin: string) {
    let body: Record<string, unknown>;
    if (skillResult.task_type === "compound") {
      body = { pin, task_type: "compound", steps: skillResult.steps };
    } else if (skillResult.task_type === "recurring") {
      body = {
        pin, task_type: "recurring",
        schedule: skillResult.schedule,
        schedule_params: skillResult.schedule_params,
        action: skillResult.action,
        steps: skillResult.steps,
        execution_mode: skillResult.execution_mode,
        stop_conditions: skillResult.stop_conditions,
        confirmation_message: skillResult.confirmation_message,
      };
    } else if (skillResult.task_type === "conditional") {
      body = {
        pin, task_type: "conditional",
        trigger: skillResult.trigger,
        action: skillResult.action,
        steps: skillResult.steps,
        execution_mode: skillResult.execution_mode,
        stop_conditions: skillResult.stop_conditions,
        confirmation_message: skillResult.confirmation_message,
      };
    } else {
      body = { pin, task_type: "immediate", skill: skillResult.skill, params: skillResult.params };
    }
    const res = await fetch("/api/agent/confirm-policy", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    setPendingSkill(null);
    if (!res.ok) { updateMessage(msgId, { skillResult: undefined, text: data.error ?? "Action failed", pending: false }); return; }
    const r = data.result;
    let resultText = "";

    // compound task result
    if (data.task_type === "compound") {
      const planSteps = Array.isArray(data.steps)
        ? data.steps as Array<{ step: number; description: string; ok: boolean; result?: unknown; error?: string }>
        : [];
      resultText = planSteps.map(s => `${s.ok ? "✓" : "✗"} Step ${s.step}: ${s.description}`).join("\n");
    }
    // recurring / conditional policy result
    else if (data.task_type === "recurring" || data.task_type === "conditional") {
      resultText = `✓ Policy created. Next run: ${r?.nextRun ? new Date(r.nextRun).toLocaleDateString() : "N/A"}`;
      await loadStatus();
    }
    // immediate single-skill results
    else if (data.task_type === "immediate") {
      switch (data.skill) {
        case "SEND_USDC": resultText = `✓ Sent ${r.amountUsdc} USDC to ${r.recipientAddress?.slice(0,8)}…${r.recipientAddress?.slice(-4)}`; if (r.txHash) resultText += `\nTx: ${r.txHash.slice(0, 10)}…`; break;
        case "WITHDRAW": resultText = `✓ Withdrew ${r.amountUsdc} USDC to your main wallet`; await loadStatus(); break;
        case "SET_LIMIT": resultText = `✓ Updated ${r.updated} limit to $${r.amount} USDC`; await loadStatus(); break;
        case "CANCEL_POLICY": resultText = `✓ Cancelled ${r.cancelledCount} polic${r.cancelledCount !== 1 ? "ies" : "y"}`; await loadStatus(); break;
        case "CREATE_POLICY": resultText = `✓ Policy created. Next run: ${r.nextRun ? new Date(r.nextRun).toLocaleDateString() : "N/A"}`; await loadStatus(); break;
        case "CHECK_BALANCE": {
          const tokens = Array.isArray(r?.tokens) ? r.tokens as Array<{symbol:string;amount:string;approxUsdValue:number}> : [];
          if (tokens.length > 1) {
            const lines = tokens.map(t => `  ${t.symbol}: ${parseFloat(t.amount).toFixed(t.symbol==="CIRBTC"||t.symbol==="cirBTC"?8:4)} (~$${t.approxUsdValue.toFixed(2)})`);
            const total = (r.totalApproxUsdValue as number | undefined) ?? 0;
            resultText = `Agent wallet:\n${lines.join("\n")}\n  ─────────────\n  Total: ~$${total.toFixed(2)}`;
          } else {
            resultText = `Agent balance: ${r.balanceUsdc} USDC`;
          }
          break;
        }
        case "SEND_TOKEN": resultText = `✓ Sent ${r.amount} ${r.token} to ${String(r.recipientAddress).slice(0,8)}…`; if (r.txHash) resultText += `\nTx: ${String(r.txHash).slice(0,10)}…`; break;
        case "SWAP_USDC": resultText = `✓ Swapped ${r.amountIn} ${r.tokenIn} → ${r.amountOut} ${r.tokenOut}`; if (r.txHash) resultText += `\nTx: ${String(r.txHash).slice(0,10)}…`; break;
        case "BRIDGE_USDC": resultText = `✓ Bridged ${r.amount} USDC from ${r.fromChain} → ${r.toChain}`; if (r.burnTxHash) resultText += `\nTx: ${String(r.burnTxHash).slice(0,10)}…`; break;
        case "PAY_X402": resultText = r.paid ? `✓ Paid ${r.amountUsdc} USDC · data received` + (r.txHash ? `\nTx: ${String(r.txHash).slice(0,10)}…` : "") : `Response: ${JSON.stringify(r.data).slice(0,120)}`; break;
        case "LIST_POLICIES": {
          const active = Array.isArray(r?.active) ? (r.active as Array<Record<string,unknown>>) : [];
          if (active.length === 0) { resultText = "You have no active policies."; break; }
          resultText = `You have ${active.length} active polic${active.length !== 1 ? "ies" : "y"}:\n` +
            active.map((p, i) => `${i + 1}. ${p.summary}${p.nextRun ? " — next run " + new Date(p.nextRun as string).toLocaleDateString() : ""}`).join("\n");
          break;
        }
        default: resultText = r ? JSON.stringify(r) : "Action completed.";
      }
    } else {
      resultText = r ? JSON.stringify(r) : "Action completed.";
    }
    updateMessage(msgId, { skillResult: undefined, text: resultText, pending: false });
  }

  async function doCancel() {
    if (!cancelModal || !/^\d{4,8}$/.test(cancelPin)) { setCancelError("Enter your 4–8 digit agent PIN"); return; }
    setCancelLoading(true); setCancelError("");
    try {
      const res = await fetch("/api/agent/cancel-policy", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: cancelPin, policyId: cancelModal.policyId }),
      });
      const data = await res.json();
      if (!res.ok) { setCancelError(data.error ?? "Cancel failed"); }
      else { setCancelModal(null); setCancelPin(""); await loadStatus(); }
    } catch (e) { setCancelError(e instanceof Error ? e.message : "Network error"); }
    finally { setCancelLoading(false); }
  }

  const firstName = useMemo(() => {
    const base = arcName ? arcName.split(".")[0] : null;
    if (base) return base.charAt(0).toUpperCase() + base.slice(1);
    return "there";
  }, [arcName]);

  const showWelcome = messages.length <= 1 && messages[0]?.id === "welcome";

  if (statusLoading) {
    return (
      <div className="flex flex-1 items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-white/40" />
      </div>
    );
  }

  // Smart Agent is invite-only. Render the waitlist screen instead of
  // the onboarding flow when the user's profile has not been granted access.
  if (agentStatus?.gated) {
    return <AgentGatedScreen />;
  }

  const isActivated = onboardStep === "done";

  return (
    <section className="flex flex-col rounded-3xl overflow-hidden" style={{ background: "linear-gradient(160deg, #0d1f45 0%, #06122c 100%)", minHeight: "calc(100dvh - 8rem)" }}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-violet-500/20">
            <Bot size={14} className="text-violet-300" />
          </div>
          <span className="font-clash text-sm font-semibold text-white">Smart Agent</span>
          {isActivated && agentStatus?.wallet && (
            <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-[11px] font-medium text-white/70">
              {parseFloat(agentStatus.wallet.balanceUsdc).toFixed(2)} USDC
            </span>
          )}
        </div>
        {isActivated && (
          <button onClick={() => loadStatus(false)} className="flex h-7 w-7 items-center justify-center rounded-full text-white/50 transition hover:bg-white/10 hover:text-white" aria-label="Refresh">
            <RefreshCw size={13} />
          </button>
        )}
      </div>

      {/* Agent wallet address strip — deposit target */}
      {isActivated && agentStatus?.wallet?.address && (
        <AgentAddressStrip address={agentStatus.wallet.address} />
      )}

      {/* Chat (activated) */}
      {isActivated && (
        <>
          {showWelcome ? (
            <div className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center gap-6 px-5 py-12">
              <div className="flex items-center gap-3">
                <Sparkles size={22} className="text-violet-400" />
                <h2 className="font-clash text-2xl font-semibold text-white">Good {new Date().getHours() < 12 ? "morning" : new Date().getHours() < 18 ? "afternoon" : "evening"}, {firstName}</h2>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                {[
                  { label: "Send USDC", prompt: "Send 5 USDC to ", Icon: Send },
                  { label: "Swap", prompt: "Swap 10 USDT to USDC", Icon: Repeat },
                  { label: "Bridge", prompt: "Bridge 5 USDC to Base", Icon: ArrowUp },
                  { label: "Pay API", prompt: "Call https://", Icon: Zap },
                  { label: "Balance", prompt: "What's my agent balance?", Icon: CoinsIcon },
                  { label: "Set limit", prompt: "Set my daily limit to 50 USDC", Icon: Shield },
                  { label: "Automate", prompt: "What can you help me automate?", Icon: Sparkles },
                ].map(({ label, prompt, Icon }) => (
                  <button key={label} onClick={() => { setInput(prompt); requestAnimationFrame(() => inputRef.current?.focus()); }}
                    className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/8 px-3.5 py-1.5 text-xs font-medium text-white/80 transition hover:border-white/30 hover:bg-white/15 hover:text-white">
                    <Icon size={12} className="text-white/60" />
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto px-5 py-5 space-y-4" style={{ maxHeight: "calc(100dvh - 18rem)" }}>
              {messages.filter(m => m.id !== "welcome").map((msg) => (
                <div key={msg.id}>
                  {msg.role === "user" && (
                    <div className="flex justify-end">
                      <div className="max-w-[80%] rounded-2xl rounded-br-md bg-white/15 px-4 py-2.5 text-sm text-white backdrop-blur-sm">{msg.text}</div>
                    </div>
                  )}
                  {msg.role === "system" && <p className="text-center text-xs italic text-white/40">{msg.text}</p>}
                  {msg.role === "agent" && (
                    <div className="flex justify-start">
                      <div className="max-w-[90%] space-y-2">
                        {msg.pending ? (
                          <ThinkingDots />
                        ) : msg.text ? (
                          <div className="text-sm leading-relaxed text-white/85">
                            {msg.text}
                          </div>
                        ) : null}
                        {msg.skillResult && pendingSkill?.msgId === msg.id && (
                          <div className="rounded-2xl border border-white/15 bg-white/8 p-4 space-y-3 backdrop-blur-sm">
                            <div className="flex items-center justify-between">
                              <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-500/20 px-2.5 py-1 text-[11px] font-medium text-violet-300">
                                <Zap size={10} />
                                {msg.skillResult.task_type === "immediate" ? msg.skillResult.skill : msg.skillResult.task_type}
                              </span>
                              <button onClick={() => { updateMessage(msg.id, { skillResult: undefined, text: "Cancelled." }); setPendingSkill(null); }} className="text-white/40 hover:text-white/80 transition"><X size={14} /></button>
                            </div>
                            <p className="text-sm text-white/80 leading-relaxed">{msg.skillResult.confirmation_message}</p>
                            {msg.skillResult.task_type === "compound" && (
                              <ol className="space-y-1">
                                {msg.skillResult.steps.map((s, i) => (
                                  <li key={i} className="flex items-start gap-2 text-xs text-white/60">
                                    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-violet-500/20 text-violet-300 font-bold">{i + 1}</span>
                                    {s.description}
                                  </li>
                                ))}
                              </ol>
                            )}
                            <AgentPinInput onConfirm={async (pin) => await confirmSkill(msg.id, msg.skillResult!, pin)} />
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
          )}

          {/* Input bar */}
          <div className="border-t border-white/10 p-4">
            <div className="rounded-2xl border border-white/15 bg-white/8 backdrop-blur-sm">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => { setInput(e.target.value); const el = e.target; el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 160)}px`; }}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!interpreting && !pendingSkill && input.trim()) handleSend(); } }}
                rows={1}
                placeholder="Tell your agent what to do…"
                disabled={interpreting || !!pendingSkill}
                className="block w-full resize-none rounded-t-2xl bg-transparent px-4 pt-3.5 pb-2 text-sm text-white placeholder-white/30 outline-none disabled:opacity-50"
              />
              <div className="flex items-center justify-between px-3 pb-3 pt-1">
                <span className="text-[11px] text-white/30">Actions require your agent PIN</span>
                <button onClick={handleSend} disabled={interpreting || !!pendingSkill || !input.trim()}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-violet-600 text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:bg-white/15 disabled:text-white/30">
                  {interpreting ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={14} />}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Onboarding (not activated) */}
      {!isActivated && <AgentOnboarding
        step={onboardStep} loading={obLoading} error={obError}
        arcNameLabel={arcNameLabel} setArcNameLabel={setArcNameLabel}
        skipName={skipName} setSkipName={setSkipName}
        pin={pin} setPin={setPin} pinConfirm={pinConfirm} setPinConfirm={setPinConfirm}
        maxPerTx={maxPerTx} setMaxPerTx={setMaxPerTx}
        maxDaily={maxDaily} setMaxDaily={setMaxDaily}
        maxMonthly={maxMonthly} setMaxMonthly={setMaxMonthly}
        fundAmount={fundAmount} setFundAmount={setFundAmount}
        onGetStarted={() => setOnboardStep("name")}
        onActivate={handleActivate} onSetPin={handleSetPin}
        onSetLimits={handleSetLimits} onFund={handleFund}
        onSkipFund={() => setOnboardStep("done")}
      />}

      {/* Cancel policy modal */}
      {cancelModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl border border-white/10 p-6 shadow-2xl space-y-4" style={{ background: "linear-gradient(160deg, #0d1f45 0%, #06122c 100%)" }}>
            <div className="flex items-center justify-between">
              <h3 className="font-clash text-sm font-semibold text-white">Cancel policy</h3>
              <button onClick={() => { setCancelModal(null); setCancelPin(""); setCancelError(""); }} className="text-white/40 hover:text-white transition"><X size={16} /></button>
            </div>
            <p className="text-xs text-white/60 leading-relaxed">{cancelModal.summary}</p>
            {cancelError && <p className="text-xs text-red-400">{cancelError}</p>}
            <div className="flex gap-2">
              <input type="password" inputMode="numeric" maxLength={8} value={cancelPin}
                onChange={(e) => setCancelPin(e.target.value.replace(/\D/g, ""))}
                onKeyDown={(e) => e.key === "Enter" && doCancel()}
                placeholder="Agent PIN" autoFocus
                className="flex-1 rounded-xl border border-white/15 bg-[#0a1630] px-3 py-2 text-sm tracking-widest text-white placeholder-white/30 outline-none transition focus:border-white/30" />
              <button onClick={doCancel} disabled={cancelLoading || cancelPin.length < 4}
                className="flex items-center gap-1.5 rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700 disabled:opacity-50">
                {cancelLoading ? <Loader2 size={14} className="animate-spin" /> : "Cancel"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function ThinkingDots() {
  return (
    <div className="flex items-center gap-1 py-1">
      {[0, 0.18, 0.36].map((delay, i) => (
        <span
          key={i}
          className="h-2 w-2 rounded-full bg-white/40 animate-bounce"
          style={{ animationDelay: `${delay}s`, animationDuration: "0.9s" }}
        />
      ))}
    </div>
  );
}

function AgentPinInput({ onConfirm }: { onConfirm: (pin: string) => Promise<void> }) {
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    if (!/^\d{4,8}$/.test(pin)) { setError("Enter your 4–8 digit agent PIN"); return; }
    setLoading(true); setError("");
    try { await onConfirm(pin); }
    catch (e) { setError(e instanceof Error ? e.message : "Confirmation failed"); setLoading(false); }
  }
  return (
    <div className="space-y-2">
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2">
        <input type="password" inputMode="numeric" maxLength={8} value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Agent PIN"
          className="flex-1 rounded-xl border border-white/15 bg-[#0a1630] px-3 py-2 text-sm tracking-widest text-white placeholder-white/30 outline-none transition focus:border-violet-500/60" />
        <button onClick={submit} disabled={loading || pin.length < 4}
          className="flex items-center gap-1.5 rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-violet-500 disabled:opacity-50">
          {loading ? <Loader2 size={14} className="animate-spin" /> : <><Check size={13} />Confirm</>}
        </button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// AgentGatedScreen — invite-only waitlist screen
// ────────────────────────────────────────────────────────────────────

function AgentGatedScreen() {
  return (
    <section
      className="flex flex-col rounded-3xl overflow-hidden"
      style={{
        background: "linear-gradient(160deg, #0d1f45 0%, #06122c 100%)",
        minHeight: "calc(100dvh - 8rem)",
      }}
    >
      <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-violet-500/20">
            <Bot size={14} className="text-violet-300" />
          </div>
          <span className="font-clash text-sm font-semibold text-white">Smart Agent</span>
          <span className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-medium text-amber-200">
            Invite only
          </span>
        </div>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-7 px-6 py-16 text-center">
        <div className="relative">
          <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-violet-500/15">
            <Bot size={36} className="text-violet-400" />
          </div>
          <div className="absolute -bottom-1 -right-1 flex h-8 w-8 items-center justify-center rounded-xl bg-[#06122c] ring-2 ring-amber-400/30">
            <Lock size={14} className="text-amber-300" />
          </div>
        </div>

        <div className="space-y-3 max-w-sm">
          <h2 className="font-clash text-2xl font-semibold text-white">
            Coming soon to your wallet
          </h2>
          <p className="text-sm leading-relaxed text-white/60">
            Smart Agent runs on AI infrastructure that&apos;s expensive to operate.
            We&apos;re rolling it out gradually to invited users while we scale.
          </p>
        </div>

        <div className="w-full max-w-sm space-y-2 rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-4 text-left">
          <p className="text-xs font-semibold uppercase tracking-wide text-white/40">
            What you&apos;ll get
          </p>
          <ul className="space-y-2 text-sm text-white/70">
            <li className="flex items-start gap-2">
              <Sparkles size={14} className="mt-0.5 shrink-0 text-violet-400" />
              <span>Natural-language USDC payments</span>
            </li>
            <li className="flex items-start gap-2">
              <Repeat size={14} className="mt-0.5 shrink-0 text-violet-400" />
              <span>Recurring transfers and subscriptions</span>
            </li>
            <li className="flex items-start gap-2">
              <Shield size={14} className="mt-0.5 shrink-0 text-violet-400" />
              <span>PIN-secured spend limits</span>
            </li>
          </ul>
        </div>

        <p className="text-xs text-white/40">
          Want early access? Reach out at{" "}
          <a
            href="mailto:hello@dotarc.my?subject=Smart%20Agent%20early%20access"
            className="text-violet-300 underline-offset-2 hover:underline"
          >
            hello@dotarc.my
          </a>
        </p>
      </div>
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────
// AgentOnboarding — inline step flow rendered inside AgentTab
// ────────────────────────────────────────────────────────────────────
interface OnboardingProps {
  step: OnboardStep; loading: boolean; error: string;
  arcNameLabel: string; setArcNameLabel: (v: string) => void;
  skipName: boolean; setSkipName: (v: boolean) => void;
  pin: string; setPin: (v: string) => void;
  pinConfirm: string; setPinConfirm: (v: string) => void;
  maxPerTx: string; setMaxPerTx: (v: string) => void;
  maxDaily: string; setMaxDaily: (v: string) => void;
  maxMonthly: string; setMaxMonthly: (v: string) => void;
  fundAmount: string; setFundAmount: (v: string) => void;
  onGetStarted: () => void;
  onActivate: () => void; onSetPin: () => void;
  onSetLimits: () => void; onFund: () => void; onSkipFund: () => void;
}

function AgentOnboarding(p: OnboardingProps) {
  const stepIdx = ONBOARD_STEPS.indexOf(p.step as OnboardStep & typeof ONBOARD_STEPS[number]);

  if (p.step === "landing") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-8 px-6 py-16 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-violet-500/15">
          <Bot size={32} className="text-violet-400" />
        </div>
        <div className="space-y-2">
          <h2 className="font-clash text-2xl font-semibold text-white">Smart Agent</h2>
          <p className="max-w-xs text-sm text-white/60 leading-relaxed">
            Automate USDC payments, set recurring transfers, and manage spending limits — all secured by your own PIN.
          </p>
        </div>
        <div className="flex flex-col items-center gap-2 text-xs text-white/40">
          {["Create your agent wallet", "Set a secure PIN", "Define spend limits", "Fund and go"].map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white/10 text-[10px] font-semibold text-white/60">{i + 1}</span>
              <span>{s}</span>
            </div>
          ))}
        </div>
        <button onClick={p.onGetStarted}
          className="inline-flex items-center gap-2 rounded-2xl bg-violet-600 px-8 py-3 text-sm font-semibold text-white transition hover:bg-violet-500">
          <Sparkles size={15} />Get Started
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col px-5 py-6">
      {/* Progress bar */}
      <div className="mb-6 flex gap-1.5">
        {ONBOARD_LABELS.map((label, i) => (
          <div key={label} className="flex flex-1 flex-col gap-1">
            <div className={`h-1 rounded-full transition-all ${i <= stepIdx ? "bg-violet-500" : "bg-white/10"}`} />
            <span className={`text-[10px] font-medium ${i <= stepIdx ? "text-violet-400" : "text-white/30"}`}>{label}</span>
          </div>
        ))}
      </div>

      {p.error && (
        <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">{p.error}</div>
      )}

      {/* Step: Name / Wallet */}
      {p.step === "name" && (
        <div className="flex flex-1 flex-col gap-5">
          <div>
            <h3 className="font-clash text-lg font-semibold text-white">Name your agent</h3>
            <p className="mt-1 text-sm text-white/50">Optionally register a .arc name for your agent wallet. Costs 5 USDC.</p>
          </div>
          <div className="space-y-3">
            <div className="relative">
              <input disabled={p.skipName} value={p.arcNameLabel}
                onChange={(e) => p.setArcNameLabel(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                placeholder="my-agent"
                className="w-full rounded-2xl border border-white/15 bg-[#0a1630] px-4 py-3 pr-14 text-sm text-white placeholder-white/30 outline-none transition focus:border-violet-500/60 disabled:opacity-40" />
              <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-xs font-semibold text-white/50">.arc</span>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-white/50 select-none">
              <input type="checkbox" checked={p.skipName} onChange={(e) => p.setSkipName(e.target.checked)} className="accent-violet-500" />
              Skip — no .arc name needed
            </label>
          </div>
          <div className="mt-auto">
            <button onClick={p.onActivate} disabled={p.loading || (!p.skipName && !p.arcNameLabel.trim())}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-violet-600 py-3 text-sm font-semibold text-white transition hover:bg-violet-500 disabled:opacity-50">
              {p.loading ? <Loader2 size={15} className="animate-spin" /> : <><ChevronRight size={15} />Create agent wallet</>}
            </button>
          </div>
        </div>
      )}

      {/* Step: PIN */}
      {p.step === "pin" && (
        <div className="flex flex-1 flex-col gap-5">
          <div>
            <h3 className="font-clash text-lg font-semibold text-white">Set your agent PIN</h3>
            <p className="mt-1 text-sm text-white/50">Separate from your main wallet PIN. Used to confirm every agent action.</p>
          </div>
          <div className="space-y-3">
            <input type="password" inputMode="numeric" maxLength={8} value={p.pin}
              onChange={(e) => p.setPin(e.target.value.replace(/\D/g, ""))}
              placeholder="4–8 digits" autoFocus
              className="w-full rounded-2xl border border-white/15 bg-[#0a1630] px-4 py-3 text-sm tracking-widest text-white placeholder-white/30 outline-none transition focus:border-violet-500/60" />
            <input type="password" inputMode="numeric" maxLength={8} value={p.pinConfirm}
              onChange={(e) => p.setPinConfirm(e.target.value.replace(/\D/g, ""))}
              placeholder="Confirm PIN"
              className="w-full rounded-2xl border border-white/15 bg-[#0a1630] px-4 py-3 text-sm tracking-widest text-white placeholder-white/30 outline-none transition focus:border-violet-500/60" />
          </div>
          <div className="mt-auto">
            <button onClick={p.onSetPin} disabled={p.loading || p.pin.length < 4}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-violet-600 py-3 text-sm font-semibold text-white transition hover:bg-violet-500 disabled:opacity-50">
              {p.loading ? <Loader2 size={15} className="animate-spin" /> : <><ChevronRight size={15} />Set PIN</>}
            </button>
          </div>
        </div>
      )}

      {/* Step: Limits */}
      {p.step === "limits" && (
        <div className="flex flex-1 flex-col gap-5">
          <div>
            <h3 className="font-clash text-lg font-semibold text-white">Spending guardrails</h3>
            <p className="mt-1 text-sm text-white/50">Hard limits your agent can never exceed. Change anytime with your PIN.</p>
          </div>
          <div className="space-y-3">
            {([
              { label: "Max per transaction (USDC)", value: p.maxPerTx, set: p.setMaxPerTx },
              { label: "Max per day (USDC)", value: p.maxDaily, set: p.setMaxDaily },
              { label: "Max per month (USDC)", value: p.maxMonthly, set: p.setMaxMonthly },
            ] as { label: string; value: string; set: (v: string) => void }[]).map(({ label, value, set }) => (
              <div key={label}>
                <label className="mb-1 block text-xs text-white/50">{label}</label>
                <input type="number" min="1" value={value} onChange={(e) => set(e.target.value)}
                  className="w-full rounded-2xl border border-white/15 bg-[#0a1630] px-4 py-2.5 text-sm text-white outline-none transition focus:border-violet-500/60" />
              </div>
            ))}
          </div>
          <div className="mt-auto">
            <button onClick={p.onSetLimits} disabled={p.loading}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-violet-600 py-3 text-sm font-semibold text-white transition hover:bg-violet-500 disabled:opacity-50">
              {p.loading ? <Loader2 size={15} className="animate-spin" /> : <><ChevronRight size={15} />Save limits</>}
            </button>
          </div>
        </div>
      )}

      {/* Step: Fund */}
      {p.step === "fund" && (
        <div className="flex flex-1 flex-col gap-5">
          <div>
            <h3 className="font-clash text-lg font-semibold text-white">Fund your agent</h3>
            <p className="mt-1 text-sm text-white/50">Transfer USDC from your main wallet. You&apos;ll need your main wallet PIN. Top up anytime later.</p>
          </div>
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {FUND_PRESETS.map((preset) => (
                <button key={preset} onClick={() => p.setFundAmount(String(preset))}
                  className={`rounded-xl px-4 py-2 text-sm font-medium transition ${p.fundAmount === String(preset) ? "bg-violet-600 text-white" : "border border-white/15 bg-white/8 text-white/70 hover:bg-white/15"}`}>
                  ${preset}
                </button>
              ))}
            </div>
            <input type="number" min="1" value={p.fundAmount} onChange={(e) => p.setFundAmount(e.target.value)}
              className="w-full rounded-2xl border border-white/15 bg-[#0a1630] px-4 py-2.5 text-sm text-white outline-none transition focus:border-violet-500/60" />
          </div>
          <div className="mt-auto flex gap-2">
            <button onClick={p.onSkipFund}
              className="flex-1 rounded-2xl border border-white/15 py-3 text-sm font-medium text-white/60 transition hover:bg-white/8">
              Skip for now
            </button>
            <button onClick={p.onFund} disabled={p.loading}
              className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-violet-600 py-3 text-sm font-semibold text-white transition hover:bg-violet-500 disabled:opacity-50">
              {p.loading ? <Loader2 size={15} className="animate-spin" /> : <><CoinsIcon size={14} />Fund &amp; finish</>}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// PoliciesTab — standalone policies & limits management view
// ────────────────────────────────────────────────────────────────────
function PoliciesTab() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [cancelModal, setCancelModal] = useState<{ policyId: string; summary: string } | null>(null);
  const [cancelPin, setCancelPin] = useState("");
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelError, setCancelError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/agent/status");
    if (res.ok) setStatus(await res.json());
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function doCancel() {
    if (!cancelModal || !/^\d{4,8}$/.test(cancelPin)) { setCancelError("Enter your 4–8 digit agent PIN"); return; }
    setCancelLoading(true); setCancelError("");
    try {
      const res = await fetch("/api/agent/cancel-policy", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: cancelPin, policyId: cancelModal.policyId }),
      });
      const data = await res.json();
      if (!res.ok) { setCancelError(data.error ?? "Cancel failed"); }
      else { setCancelModal(null); setCancelPin(""); await load(); }
    } catch (e) { setCancelError(e instanceof Error ? e.message : "Network error"); }
    finally { setCancelLoading(false); }
  }

  return (
    <section className="flex flex-col rounded-3xl overflow-hidden" style={{ background: "linear-gradient(160deg, #0d1f45 0%, #06122c 100%)", minHeight: "calc(100dvh - 8rem)" }}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-violet-500/20">
            <List size={14} className="text-violet-300" />
          </div>
          <span className="font-clash text-sm font-semibold text-white">Policies</span>
          {status?.policies?.length ? (
            <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-white/60">{status.policies.length} active</span>
          ) : null}
        </div>
        <button onClick={load} className="flex h-7 w-7 items-center justify-center rounded-full text-white/50 transition hover:bg-white/10 hover:text-white" aria-label="Refresh">
          <RefreshCw size={13} />
        </button>
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-white/40" /></div>
      ) : status?.gated ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
          <div className="relative">
            <div className="rounded-full bg-violet-500/15 p-4"><Bot size={22} className="text-violet-400" /></div>
            <div className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-[#06122c] ring-2 ring-amber-400/30">
              <Lock size={11} className="text-amber-300" />
            </div>
          </div>
          <p className="text-sm font-medium text-white/70">Smart Agent is invite-only</p>
          <p className="max-w-xs text-xs text-white/40">Policies will appear here once you have early access.</p>
        </div>
      ) : !status?.activated ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
          <div className="rounded-full bg-white/8 p-4"><Shield size={22} className="text-white/30" /></div>
          <p className="text-sm font-medium text-white/70">Agent not activated</p>
          <p className="text-xs text-white/40">Activate your Smart Agent first, then your policies will appear here.</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-3">
          {/* Spend limits card */}
          {status?.limits && (
            <div className="rounded-2xl border border-white/10 bg-white/5 px-5 py-4 space-y-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-white/50">
                <AlertTriangle size={11} />Spend limits
              </p>
              <div className="grid grid-cols-3 gap-3">
                {([
                  { label: "Per tx", value: status.limits.max_per_transaction_usdc },
                  { label: "Daily", value: status.limits.max_daily_usdc },
                  { label: "Monthly", value: status.limits.max_monthly_usdc },
                ] as { label: string; value: number }[]).map(({ label, value }) => (
                  <div key={label} className="rounded-xl bg-white/5 px-3 py-2.5">
                    <p className="text-[10px] text-white/40">{label}</p>
                    <p className="text-sm font-semibold text-white">${value}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Policy list */}
          {!status?.policies?.length ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <div className="rounded-full bg-white/8 p-4"><List size={24} className="text-white/30" /></div>
              <p className="text-sm font-medium text-white/70">No active policies</p>
              <p className="max-w-xs text-xs text-white/40">Set up recurring payments in the Agent chat tab.</p>
            </div>
          ) : (
            status.policies.map((pol) => (
              <div key={pol.id} className="rounded-2xl border border-white/10 bg-white/5 p-4 space-y-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-mono font-semibold text-violet-300">{pol.actionSkill}</span>
                    <span className="rounded-full bg-white/8 px-2 py-0.5 text-[10px] text-white/50">{pol.executionMode}</span>
                    <span className="rounded-full bg-white/8 px-2 py-0.5 text-[10px] text-white/50">{pol.triggerType}</span>
                  </div>
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs text-emerald-400">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />Active
                  </span>
                </div>
                <p className="text-sm text-white/85 leading-snug">{pol.summary}</p>
                <div className="flex items-center justify-between pt-1">
                  <div className="flex items-center gap-4 text-xs text-white/40">
                    {pol.nextRun && <span>Next: {new Date(pol.nextRun).toLocaleDateString()}</span>}
                    {pol.executionCount > 0 && <span>{pol.executionCount} runs · ${parseFloat(pol.totalSpentUsdc).toFixed(2)} spent</span>}
                  </div>
                  <button onClick={() => { setCancelModal({ policyId: pol.id, summary: pol.summary }); setCancelPin(""); setCancelError(""); }}
                    className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs text-red-400 transition hover:bg-red-500/10 hover:text-red-300">
                    <X size={11} />Cancel
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Cancel confirmation */}
      {cancelModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl border border-white/10 p-6 shadow-2xl space-y-4"
            style={{ background: "linear-gradient(160deg, #0d1f45 0%, #06122c 100%)" }}>
            <div className="flex items-center justify-between">
              <h3 className="font-clash text-sm font-semibold text-white">Cancel policy</h3>
              <button onClick={() => { setCancelModal(null); setCancelPin(""); setCancelError(""); }} className="text-white/40 hover:text-white transition"><X size={16} /></button>
            </div>
            <p className="text-xs text-white/60 leading-relaxed">{cancelModal.summary}</p>
            {cancelError && <p className="text-xs text-red-400">{cancelError}</p>}
            <div className="flex gap-2">
              <input type="password" inputMode="numeric" maxLength={8} value={cancelPin}
                onChange={(e) => setCancelPin(e.target.value.replace(/\D/g, ""))}
                onKeyDown={(e) => e.key === "Enter" && doCancel()}
                placeholder="Agent PIN" autoFocus
                className="flex-1 rounded-xl border border-white/15 bg-[#0a1630] px-3 py-2 text-sm tracking-widest text-white placeholder-white/30 outline-none transition focus:border-white/30" />
              <button onClick={doCancel} disabled={cancelLoading || cancelPin.length < 4}
                className="flex items-center gap-1.5 rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700 disabled:opacity-50">
                {cancelLoading ? <Loader2 size={14} className="animate-spin" /> : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

// ═══════════════════════════════════════════════════════════════════
// Shimmer loading skeletons — match the layout of each tab so users
// can anticipate content before it arrives.
// ═══════════════════════════════════════════════════════════════════

function ShimmerBlock({ className = "" }: { className?: string }) {
  return (
    <div
      className={`bg-gradient-to-r from-white/[0.06] via-white/[0.14] to-white/[0.06] ${className}`}
      style={{
        backgroundSize: "200% 100%",
        animation: "shimmer-slide 1.4s infinite linear",
      }}
    />
  );
}

function HomeShimmer() {
  return (
    <>
      {/* Hero card skeleton */}
      <section className="relative overflow-hidden rounded-3xl" style={{ backgroundColor: "#0a0a0a" }}>
        <div className="relative flex flex-col gap-5 p-5 sm:p-7 md:flex-row md:items-start md:justify-between md:gap-8 md:p-9">
          <div className="min-w-0 flex-1 space-y-4">
            <ShimmerBlock className="h-5 w-32 rounded-md" />
            <ShimmerBlock className="h-14 w-48 rounded-xl sm:h-16 sm:w-56 md:h-20 md:w-72" />
          </div>
          <ShimmerBlock className="h-24 w-24 shrink-0 self-end rounded-2xl sm:h-28 sm:w-28 md:h-32 md:w-32 md:self-start" />
        </div>
      </section>

      {/* Action buttons skeleton */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <ShimmerBlock className="h-20 rounded-2xl" />
        <ShimmerBlock className="h-20 rounded-2xl" />
        <ShimmerBlock className="h-20 rounded-2xl" />
        <ShimmerBlock className="h-20 rounded-2xl" />
      </section>

      {/* Assets skeleton */}
      <section className="rounded-3xl bg-[#0d2147] p-5 sm:p-6">
        <div className="mb-4 flex items-baseline justify-between">
          <ShimmerBlock className="h-7 w-24 rounded-md" />
          <ShimmerBlock className="h-4 w-20 rounded-md" />
        </div>
        <div className="flex flex-col gap-2">
          <ShimmerBlock className="h-14 rounded-2xl" />
          <ShimmerBlock className="h-14 rounded-2xl" />
          <ShimmerBlock className="h-14 rounded-2xl" />
        </div>
      </section>
    </>
  );
}

function ActivityShimmer() {
  return (
    <section className="rounded-3xl bg-[#0d2147] p-5 sm:p-7">
      <div className="mb-5 flex items-baseline justify-between">
        <ShimmerBlock className="h-8 w-32 rounded-md" />
        <ShimmerBlock className="h-4 w-16 rounded-md" />
      </div>
      <div className="flex flex-col gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 rounded-2xl border border-white/8 bg-white/5 px-4 py-3.5">
            <ShimmerBlock className="h-8 w-8 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <ShimmerBlock className="h-4 w-16 rounded-md" />
                <ShimmerBlock className="h-4 w-20 rounded-md" />
              </div>
              <ShimmerBlock className="h-3 w-24 rounded-md" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function AgentShimmer() {
  return (
    <section className="flex h-[calc(100vh-180px)] flex-col rounded-3xl bg-[#0d2147] p-5 sm:p-7">
      {/* Chat area */}
      <div className="mb-4 flex-1 space-y-4 overflow-hidden">
        {/* Agent message */}
        <div className="flex items-start gap-3">
          <ShimmerBlock className="h-8 w-8 rounded-full" />
          <ShimmerBlock className="h-16 w-[70%] rounded-2xl rounded-tl-none" />
        </div>
        {/* User message */}
        <div className="flex items-start justify-end gap-3">
          <ShimmerBlock className="h-12 w-[55%] rounded-2xl rounded-tr-none" />
          <ShimmerBlock className="h-8 w-8 rounded-full" />
        </div>
        {/* Agent message */}
        <div className="flex items-start gap-3">
          <ShimmerBlock className="h-8 w-8 rounded-full" />
          <ShimmerBlock className="h-20 w-[65%] rounded-2xl rounded-tl-none" />
        </div>
      </div>
      {/* Input area */}
      <div className="mt-auto flex items-center gap-3">
        <ShimmerBlock className="h-12 flex-1 rounded-2xl" />
        <ShimmerBlock className="h-12 w-12 rounded-2xl" />
      </div>
    </section>
  );
}

function PoliciesShimmer() {
  return (
    <section className="space-y-5">
      {/* Header */}
      <div className="rounded-3xl bg-[#0d2147] p-5 sm:p-7">
        <div className="mb-5 flex items-baseline justify-between">
          <ShimmerBlock className="h-8 w-40 rounded-md" />
          <ShimmerBlock className="h-4 w-16 rounded-md" />
        </div>
        <div className="space-y-3">
          <ShimmerBlock className="h-14 rounded-2xl" />
          <ShimmerBlock className="h-14 rounded-2xl" />
        </div>
      </div>
      {/* Policy cards */}
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-2xl border border-white/10 bg-white/5 p-4 space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div className="flex gap-1.5">
                <ShimmerBlock className="h-5 w-16 rounded-full" />
                <ShimmerBlock className="h-5 w-20 rounded-full" />
              </div>
              <ShimmerBlock className="h-4 w-14 rounded-md" />
            </div>
            <ShimmerBlock className="h-4 w-full rounded-md" />
            <div className="flex items-center justify-between pt-1">
              <ShimmerBlock className="h-3 w-32 rounded-md" />
              <ShimmerBlock className="h-6 w-16 rounded-lg" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
