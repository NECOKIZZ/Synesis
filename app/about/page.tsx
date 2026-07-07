/**
 * About — placeholder marketing page.
 *
 * Replaces the wallet-shell-style copy with a simple intro to Synesis.
 * Visual language matches the landing hero (light backdrop + Clash Display).
 */

import Link from "next/link";

export const metadata = {
  title: "About — Synesis",
  description: "Synesis is your name on the chain. Programmable USDC payments built on Arc Network.",
};

export default function AboutPage() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        background:
          "radial-gradient(ellipse at 50% 0%, rgba(39, 117, 202, 0.12), transparent 60%), #fafaf7",
        color: "#1a1a1a",
        fontFamily: "'Geist', system-ui, sans-serif",
      }}
    >
      <div
        style={{
          maxWidth: "720px",
          margin: "0 auto",
          padding: "clamp(48px, 10vw, 96px) clamp(20px, 5vw, 40px)",
        }}
      >
        <Link
          href="/"
          style={{
            fontFamily: "'Clash Display', sans-serif",
            fontSize: "12px",
            fontWeight: 500,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "rgba(26,26,26,0.55)",
            textDecoration: "none",
          }}
        >
          ← Home
        </Link>

        <h1
          style={{
            fontFamily: "'Clash Display', sans-serif",
            fontSize: "clamp(40px, 7vw, 72px)",
            fontWeight: 600,
            lineHeight: 0.95,
            letterSpacing: "-0.02em",
            margin: "32px 0 24px",
          }}
        >
          ABOUT <span style={{ color: "#2775CA" }}>DOTARC</span>
        </h1>

        <p
          style={{
            fontSize: "clamp(16px, 2.2vw, 19px)",
            lineHeight: 1.6,
            color: "rgba(26,26,26,0.78)",
            marginBottom: "20px",
          }}
        >
          Synesis turns your name into your wallet. No seed phrases, no 0x
          addresses to memorize — just a human-readable handle on the Arc
          Network where USDC is native gas and finality is sub-second.
        </p>

        <p
          style={{
            fontSize: "clamp(16px, 2.2vw, 19px)",
            lineHeight: 1.6,
            color: "rgba(26,26,26,0.78)",
            marginBottom: "20px",
          }}
        >
          Built on Circle&apos;s programmable wallet stack with a Smart Agent
          layer that handles recurring transfers, spend limits, and natural-
          language payments — all secured by your own PIN.
        </p>

        <p
          style={{
            fontSize: "14px",
            color: "rgba(26,26,26,0.5)",
            marginTop: "48px",
          }}
        >
          Full product page coming soon. For early access or partnership
          enquiries, reach us at{" "}
          <a
            href="mailto:hello@dotarc.my"
            style={{ color: "#2775CA", textDecoration: "none" }}
          >
            hello@dotarc.my
          </a>
          .
        </p>
      </div>
    </main>
  );
}
