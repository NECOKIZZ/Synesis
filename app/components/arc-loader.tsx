/**
 * ArcLoader — branded loading state with animated .arc mark + optional fun facts.
 *
 * Three sizes:
 *   "full"   — full-screen centered (auth gate, page loading)
 *   "card"   — centered inside a modal card (send modal signing step)
 *   "inline" — small inline for buttons / compact spaces
 *
 * Fun facts rotate every 5s. Pass `facts` to override the default set,
 * or omit `showFacts` to keep it clean.
 */

"use client";

import { useEffect, useState } from "react";

const DEFAULT_FACTS = [
  "Arc Testnet settles in under 1 second.",
  "USDC on Arc uses gas — but it's stable and cheap.",
  ".arc names are yours forever after first renewal.",
  "Your agent can pay bills while you sleep.",
  "All agent policies are HMAC-signed server-side.",
  "The treasury pays your first .arc registration fee.",
  "No seed phrase. Your keys live in secure enclaves.",
  "Circle's CCTP can bridge USDC to 10+ chains.",
  "Smart agents use OpenRouter + Claude for reasoning.",
  "Arc is Circle's own chain — USDC is native gas.",
];

interface ArcLoaderProps {
  size?: "full" | "card" | "inline";
  label?: string;
  showFacts?: boolean;
  facts?: string[];
  className?: string;
}

export function ArcLoader({
  size = "card",
  label,
  showFacts = true,
  facts = DEFAULT_FACTS,
  className = "",
}: ArcLoaderProps) {
  // Start at index 0 so server and client render the same first fact —
  // randomizing in the initializer would cause a hydration mismatch
  // (React #418), which nukes the whole tree on mount.
  const [factIndex, setFactIndex] = useState(0);
  const [fade, setFade] = useState(true);
  const factsVisible = showFacts && size === "full";

  // Pick a random starting fact AFTER mount (client-only).
  useEffect(() => {
    if (!factsVisible || facts.length <= 1) return;
    setFactIndex(Math.floor(Math.random() * facts.length));
  }, [factsVisible, facts.length]);

  useEffect(() => {
    if (!factsVisible || facts.length <= 1) return;
    const interval = setInterval(() => {
      setFade(false);
      setTimeout(() => {
        setFactIndex((i) => (i + 1) % facts.length);
        setFade(true);
      }, 400);
    }, 5000);
    return () => clearInterval(interval);
  }, [factsVisible, facts.length]);

  const factText = facts[factIndex] ?? "";

  if (size === "inline") {
    return (
      <span className={`inline-flex items-center gap-2 ${className}`}>
        <span className="arc-pulse-dot inline-block h-2.5 w-2.5 rounded-full bg-white/80" />
        {label && (
          <span className="text-xs font-medium text-white/70">{label}</span>
        )}
      </span>
    );
  }

  const isFull = size === "full";

  return (
    <div
      className={`flex flex-col items-center justify-center gap-5 ${
        isFull ? "min-h-screen" : "py-8"
      } ${className}`}
    >
      {/* Animated .arc mark — bare wordmark, no tile, with concentric
          glow rings that pulse outward. The wordmark itself breathes so
          there's still a clear focal point. */}
      <div className="relative inline-flex items-center justify-center">
        <span
          aria-hidden
          className="absolute inset-0 -m-4 rounded-full border border-white/15"
          style={{
            animation: "arc-glow-ping 2.4s ease-in-out infinite",
          }}
        />
        <span
          aria-hidden
          className="absolute inset-0 -m-8 rounded-full border border-white/8"
          style={{
            animation: "arc-glow-ping 2.4s ease-in-out infinite 0.8s",
          }}
        />

        <span
          className="relative font-clash text-3xl font-semibold tracking-tight text-white sm:text-4xl"
          style={{
            fontFamily: "'Clash Display', sans-serif",
            animation: "arc-breathe 2s ease-in-out infinite",
          }}
        >
          .arc
        </span>
      </div>

      {/* Label */}
      {label && (
        <p
          className="font-clash text-xs uppercase tracking-[0.25em] text-white/80"
          style={{ fontFamily: "'Clash Display', sans-serif" }}
        >
          {label}
        </p>
      )}

      {/* Fun fact rotator — full-screen only */}
      {factsVisible && (
        <div className="max-w-xs text-center">
          <p
            className={`text-xs text-white/50 transition-opacity duration-300 ${
              fade ? "opacity-100" : "opacity-0"
            }`}
          >
            {factText}
          </p>
        </div>
      )}

      {/* Keyframes — injected once per instance (safe for SSR) */}
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes arc-breathe {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.06); opacity: 0.92; }
        }
        @keyframes arc-glow-ping {
          0%, 100% { transform: scale(1); opacity: 0.3; }
          50% { transform: scale(1.25); opacity: 0.08; }
        }
      `}} />
    </div>
  );
}
