/**
 * Docs — placeholder docs landing page.
 *
 * Will eventually link to integrator docs (.arc name registration,
 * pay-link API, agent webhook contract, etc.). For now: a holding
 * page that mirrors /about's visual language.
 */

import Link from "next/link";

export const metadata = {
  title: "Docs — Synesis",
  description: "Developer documentation for Synesis — .arc names, payments, and agent integrations.",
};

export default function DocsPage() {
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
          DOCS
        </h1>

        <p
          style={{
            fontSize: "clamp(16px, 2.2vw, 19px)",
            lineHeight: 1.6,
            color: "rgba(26,26,26,0.78)",
            marginBottom: "20px",
          }}
        >
          Developer documentation is on its way. Soon you&apos;ll find guides
          for resolving <code style={{ background: "rgba(0,0,0,0.05)", padding: "2px 6px", borderRadius: "4px", fontFamily: "'Geist Mono', monospace" }}>.arc</code> names,
          accepting USDC payments via the pay-link, and integrating Smart
          Agent skills.
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: "12px",
            marginTop: "32px",
          }}
        >
          {[
            { label: "Resolve a .arc name", desc: "Look up the address behind any Synesis handle." },
            { label: "Accept USDC", desc: "Generate a pay-link or QR for any wallet." },
            { label: "Smart Agent API", desc: "Drive payments and policies from your own service." },
          ].map((card) => (
            <div
              key={card.label}
              style={{
                background: "rgba(255,255,255,0.7)",
                border: "1px solid rgba(26,26,26,0.08)",
                borderRadius: "16px",
                padding: "16px 18px",
                backdropFilter: "blur(8px)",
              }}
            >
              <p
                style={{
                  fontFamily: "'Clash Display', sans-serif",
                  fontWeight: 600,
                  fontSize: "14px",
                  margin: "0 0 6px",
                  color: "#1a1a1a",
                }}
              >
                {card.label}
              </p>
              <p style={{ fontSize: "13px", color: "rgba(26,26,26,0.6)", margin: 0, lineHeight: 1.5 }}>
                {card.desc}
              </p>
              <p
                style={{
                  fontFamily: "'Clash Display', sans-serif",
                  fontSize: "10px",
                  fontWeight: 600,
                  letterSpacing: "0.18em",
                  textTransform: "uppercase",
                  color: "rgba(39,117,202,0.7)",
                  marginTop: "10px",
                  marginBottom: 0,
                }}
              >
                Coming soon
              </p>
            </div>
          ))}
        </div>

        <p
          style={{
            fontSize: "14px",
            color: "rgba(26,26,26,0.5)",
            marginTop: "48px",
          }}
        >
          Want early API access?{" "}
          <a
            href="mailto:hello@dotarc.my?subject=Docs%20early%20access"
            style={{ color: "#2775CA", textDecoration: "none" }}
          >
            hello@dotarc.my
          </a>
        </p>
      </div>
    </main>
  );
}
