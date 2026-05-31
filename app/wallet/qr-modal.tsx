"use client";

/**
 * QrModal — full-screen QR code preview.
 *
 * Opened from the hero card's QR tile so the user can show the code to
 * someone scanning it. The receive modal stays separate (it lists the
 * address, .arc name, and share actions).
 *
 * Renders a large (~280px) QR with bright contrast on a white card so the
 * camera locks onto it instantly even at arm's length under bad lighting.
 */

import { useEffect, useState } from "react";
import QRCode from "qrcode";

interface QrModalProps {
  walletAddress: string;
  arcName: string | null;
  onClose: () => void;
}

export function QrModal({ walletAddress, arcName, onClose }: QrModalProps) {
  const [largeQr, setLargeQr] = useState<string | null>(null);

  // Re-render the QR at a higher resolution than the hero tile so it
  // stays crisp when scaled up to ~280px on a phone screen.
  useEffect(() => {
    if (!walletAddress) return;
    let cancelled = false;
    QRCode.toDataURL(walletAddress, {
      errorCorrectionLevel: "M",
      width: 560, // 2x the displayed size for retina
      margin: 1,
      color: { dark: "#0a0a0a", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) setLargeQr(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [walletAddress]);

  // Close on Escape key — a basic accessibility expectation for any
  // overlay that traps the user's attention.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-sm overflow-hidden rounded-3xl border border-white/10 shadow-2xl"
        style={{ background: "linear-gradient(160deg, #0d1f45 0%, #06122c 100%)" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
          <h3 className="text-sm font-semibold text-white">Scan to pay</h3>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-white/60 transition hover:bg-white/20 hover:text-white"
            aria-label="Close"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="flex flex-col items-center gap-4 p-6">
          {/* QR card */}
          <div className="rounded-2xl bg-white p-4 shadow-lg">
            {largeQr ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={largeQr}
                alt="Wallet address QR"
                className="h-64 w-64 select-none"
                draggable={false}
              />
            ) : (
              <div className="flex h-64 w-64 animate-pulse items-center justify-center rounded-xl bg-zinc-200" />
            )}
          </div>

          {/* Caption — .arc name first if available, else short addr. */}
          {arcName ? (
            <div className="text-center">
              <p className="text-[10px] font-medium uppercase tracking-widest text-white/40">
                Pay
              </p>
              <p className="mt-0.5 text-xl font-bold tracking-tight">
                <span className="text-blue-400">{arcName.split(".")[0]}</span>
                <span className="text-white/50">.arc</span>
              </p>
            </div>
          ) : (
            <p className="break-all text-center font-mono text-xs text-white/60">
              {walletAddress}
            </p>
          )}

          <p className="text-center text-[11px] text-white/30">
            USDC · Arc Testnet only
          </p>
        </div>
      </div>
    </div>
  );
}
