"use client";

import { useCallback, useMemo, useState } from "react";
import { HandCoins, Copy, Check, Share2, Link2 } from "lucide-react";

interface RequestModalProps {
  walletAddress: string;
  arcName: string | null;
  onClose: () => void;
}

export function RequestModal({ walletAddress, arcName, onClose }: RequestModalProps) {
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [copied, setCopied] = useState(false);
  const [shared, setShared] = useState(false);

  const amountNum = parseFloat(amount);
  const hasAmount = !isNaN(amountNum) && amountNum > 0;

  const generatedUrl = useMemo(() => {
    const params = new URLSearchParams();
    params.set("e", walletAddress);
    params.set("n", "arc");
    params.set("a", amount || "0");
    const m = memo.trim() || (arcName ? `Payment to ${arcName.split(".")[0]}.arc on Synesis` : "Payment request");
    params.set("m", m);
    return `https://hashpaylink.com/pay?${params.toString()}`;
  }, [walletAddress, amount, memo, arcName]);

  const shortUrl = useMemo(() => {
    if (generatedUrl.length <= 60) return generatedUrl;
    return generatedUrl.slice(0, 57) + "…";
  }, [generatedUrl]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(generatedUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  }, [generatedUrl]);

  const share = useCallback(async () => {
    if (!hasAmount) return;
    const name = arcName ? arcName.split(".")[0] : "me";
    const title = `Pay ${name}.arc on Synesis`;
    const text = `Send ${amount} USDC to ${name}.arc on Arc Testnet`;

    if (navigator.share) {
      try {
        await navigator.share({ title, text, url: generatedUrl });
        return;
      } catch {
        // fallback to copy
      }
    }
    copy();
    setShared(true);
    setTimeout(() => setShared(false), 1800);
  }, [generatedUrl, arcName, amount, copy]);

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md overflow-hidden rounded-3xl border border-white/10 shadow-2xl"
        style={{ background: "linear-gradient(160deg, #0d1f45 0%, #06122c 100%)" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div className="flex items-center gap-2">
            <HandCoins size={18} className="text-violet-400" />
            <h3 className="text-base font-semibold text-white">Request Payment</h3>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-white/60 transition hover:bg-white/20 hover:text-white"
            aria-label="Close"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Recipient preview */}
          <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
            <p className="text-[10px] font-medium uppercase tracking-widest text-white/40">Requesting as</p>
            <p className="mt-0.5 text-sm font-semibold text-white">
              {arcName ? (
                <>
                  <span className="text-blue-400">{arcName.split(".")[0]}</span>
                  <span className="text-white/50">.arc</span>
                </>
              ) : (
                <span className="font-mono text-xs text-white/60">{walletAddress.slice(0, 10)}…{walletAddress.slice(-8)}</span>
              )}
            </p>
          </div>

          {/* Amount */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-white/70">Amount (USDC)</label>
            <div className="relative">
              <input
                type="number"
                inputMode="decimal"
                min="0.01"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="25.00"
                className="w-full rounded-2xl border-2 border-white/10 bg-white/5 px-4 py-3 pr-14 font-geist text-base text-white placeholder-white/30 outline-none transition focus:border-violet-500/50 focus:bg-white/8"
                autoFocus
              />
              <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-xs font-medium text-white/40">
                USDC
              </span>
            </div>
          </div>

          {/* Memo */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-white/70">Memo (optional)</label>
            <input
              type="text"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="Invoice #042, Coffee, etc."
              maxLength={60}
              className="w-full rounded-2xl border-2 border-white/10 bg-white/5 px-4 py-3 font-geist text-sm text-white placeholder-white/30 outline-none transition focus:border-violet-500/50 focus:bg-white/8"
            />
          </div>

          {/* Generated link preview */}
          {hasAmount && (
            <div className="rounded-2xl border border-white/10 bg-white/5 p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-widest text-white/40">
                <Link2 size={10} />
                Generated link
              </div>
              <div className="break-all font-mono text-[10px] leading-relaxed text-white/50">
                {shortUrl}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="grid grid-cols-2 gap-2 pt-1">
            <button
              onClick={copy}
              disabled={!hasAmount}
              className="flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/8 py-3 text-xs font-medium text-white/80 transition hover:bg-white/15 hover:text-white active:scale-[0.97] disabled:opacity-30 disabled:pointer-events-none"
            >
              {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
              {copied ? "Copied!" : "Copy link"}
            </button>
            <button
              onClick={share}
              disabled={!hasAmount}
              className="flex items-center justify-center gap-2 rounded-xl bg-violet-600 py-3 text-xs font-semibold text-white transition hover:bg-violet-500 active:scale-[0.97] disabled:opacity-30 disabled:pointer-events-none"
            >
              <Share2 size={14} />
              {shared ? "Link copied!" : "Share"}
            </button>
          </div>
          {!hasAmount && (
            <p className="text-center text-[10px] text-white/30">
              Enter an amount to generate the payment link.
            </p>
          )}

          <p className="text-center text-[10px] text-white/30">
            Anyone with this link can pay you USDC on Arc Testnet via HashPayLink.
          </p>
        </div>
      </div>
    </div>
  );
}
