"use client";

import { useCallback, useState } from "react";

const APP_BASE_URL =
  process.env.NEXT_PUBLIC_APP_URL || "https://wallet.dotarc.my";

interface ReceiveModalProps {
  walletAddress: string;
  arcName: string | null;
  onClose: () => void;
}

export function ReceiveModal({ walletAddress, arcName, onClose }: ReceiveModalProps) {
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const copy = useCallback(async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1800);
    } catch {}
  }, []);

  const shareUrl = arcName
    ? `${APP_BASE_URL}/pay/${arcName.split(".")[0]}`
    : `${APP_BASE_URL}/pay/${walletAddress}`;

  const handleShare = useCallback(async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: arcName ? `Pay ${arcName}` : "Pay me on Synesis",
          text: arcName
            ? `Send USDC to ${arcName} on Arc Testnet`
            : `Send USDC to my Synesis wallet`,
          url: shareUrl,
        });
        return;
      } catch {
        // fallback to copy
      }
    }
    copy(shareUrl, "share");
  }, [shareUrl, arcName, copy]);

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg overflow-hidden rounded-3xl border border-white/10 shadow-2xl"
        style={{ background: "linear-gradient(160deg, #0d1f45 0%, #06122c 100%)" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <h3 className="text-base font-semibold text-white">Receive USDC</h3>
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
          {/* .arc name hero */}
          {arcName ? (
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-center">
              <p className="mb-1 text-[10px] font-medium uppercase tracking-widest text-white/40">
                Your .arc name
              </p>
              <div className="text-2xl font-bold tracking-tight">
                <span className="text-blue-400">{arcName.split(".")[0]}</span>
                <span className="text-white/50">.arc</span>
              </div>
              <p className="mt-1 text-xs text-white/40">
                Anyone can send USDC to this name
              </p>
            </div>
          ) : null}

          {/* Wallet address */}
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] font-medium uppercase tracking-widest text-white/40">
                Wallet address
              </span>
              <button
                onClick={() => copy(walletAddress, "addr")}
                className="rounded-full bg-white/10 px-2.5 py-0.5 text-xs text-white/70 transition hover:bg-white/20 hover:text-white"
              >
                {copiedField === "addr" ? "✓ Copied" : "Copy"}
              </button>
            </div>
            <div className="break-all font-mono text-xs leading-relaxed text-white/60">
              {walletAddress}
            </div>
          </div>

          <p className="text-center text-[11px] text-white/30">
            Send only <span className="font-medium text-white/50">USDC</span> on{" "}
            <span className="font-medium text-white/50">Arc Testnet</span> to this address.
          </p>

          {/* Actions */}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => arcName ? copy(arcName, "name") : copy(walletAddress, "addr2")}
              className="flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/8 py-2.5 text-xs font-medium text-white/80 transition hover:bg-white/15 hover:text-white active:scale-[0.97]"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              {copiedField === "name" || copiedField === "addr2" ? "Copied!" : arcName ? "Copy name" : "Copy addr"}
            </button>

            <button
              onClick={handleShare}
              className="flex items-center justify-center gap-2 rounded-xl bg-blue-600 py-2.5 text-xs font-semibold text-white transition hover:bg-blue-500 active:scale-[0.97]"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13" />
              </svg>
              {copiedField === "share" ? "Link copied!" : "Share link"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
