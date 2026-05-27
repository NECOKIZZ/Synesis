"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import HeroCoin from "./HeroCoin";
import HeroHands from "./HeroHands";

export default function HeroSection() {
  // Warm the auth/session check on hover so the click-to-wallet feels
  // instant. Side-effect-free GET to /api/circle/me; we discard the body.
  // Browser-cached as `same-origin` and only fired once per session.
  const warmedRef = useRef(false);
  const warmSession = useCallback(() => {
    if (warmedRef.current) return;
    warmedRef.current = true;
    fetch("/api/circle/me", {
      credentials: "include",
      // prevent showing in DevTools as a long-pending request
      cache: "no-store",
    }).catch(() => {
      /* ignore — pure prefetch */
    });
  }, []);

  // ── OAuth error toast ──
  // Supabase bounces failed OAuth callbacks back here with
  // `?error=...&error_code=...&error_description=...`. Catch it, show a
  // friendly toast, and clean the URL so a refresh doesn't re-trigger.
  const [oauthError, setOauthError] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("error_code");
    const desc = params.get("error_description");
    if (!code && !desc) return;
    if (code === "bad_oauth_state") {
      setOauthError(
        "Sign-in timed out. Please try again — close any extra tabs and don't switch between localhost and 127.0.0.1."
      );
    } else if (desc) {
      setOauthError(decodeURIComponent(desc.replace(/\+/g, " ")));
    } else {
      setOauthError("Sign-in failed. Please try again.");
    }
    // Strip the error params so a refresh doesn't show this again.
    const url = new URL(window.location.href);
    ["error", "error_code", "error_description"].forEach((k) => url.searchParams.delete(k));
    window.history.replaceState({}, "", url.pathname + (url.search ? `?${url.searchParams}` : ""));
  }, []);

  return (
    <section
      id="hero"
      style={{
        position: "relative",
        width: "100vw",
        // dvh = dynamic viewport height — avoids iOS Safari bottom bar bug
        // where 100vh overshoots the visible area.
        height: "100dvh",
        minHeight: "100vh",
        overflow: "hidden",
      }}
    >
      {/* ── OAuth error toast ── */}
      {oauthError && (
        <div
          role="alert"
          style={{
            position: "fixed",
            top: "88px",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 100,
            maxWidth: "min(92vw, 480px)",
            padding: "14px 18px",
            background: "rgba(220, 38, 38, 0.95)",
            color: "#fff",
            borderRadius: "14px",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            boxShadow: "0 12px 32px rgba(0,0,0,0.2)",
            fontFamily: "'Geist', system-ui, sans-serif",
            fontSize: "14px",
            lineHeight: 1.4,
            display: "flex",
            alignItems: "flex-start",
            gap: "12px",
          }}
        >
          <span style={{ flex: 1 }}>{oauthError}</span>
          <button
            onClick={() => setOauthError(null)}
            aria-label="Dismiss"
            style={{
              background: "transparent",
              border: 0,
              color: "rgba(255,255,255,0.8)",
              cursor: "pointer",
              fontSize: "20px",
              lineHeight: 1,
              padding: 0,
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* ── Background image ── */}
      <Image
        src="/background.png"
        alt="Background"
        fill
        priority
        style={{
          objectFit: "cover",
          objectPosition: "center",
          zIndex: 0,
        }}
        sizes="100vw"
      />

      {/* ── Nav Island ── */}
      <div style={{
        position: "absolute",
        top: "24px",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "10px 16px",
        background: "rgba(255,255,255,0.25)",
        backdropFilter: "blur(20px) saturate(180%)",
        WebkitBackdropFilter: "blur(20px) saturate(180%)",
        borderRadius: "50px",
        border: "1px solid rgba(255,255,255,0.35)",
        boxShadow: "0 8px 32px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.4)",
      }}>
        <Link href="/wallet" prefetch style={{
          padding: "8px 14px",
          borderRadius: "50px",
          color: "#1a1a1a",
          fontFamily: "'Clash Display', sans-serif",
          fontSize: "14px",
          fontWeight: 500,
          textDecoration: "none",
          transition: "all 0.3s ease",
        }} onMouseEnter={(e) => {
          e.currentTarget.style.background = "rgba(255,255,255,0.5)";
          warmSession();
        }} onFocus={warmSession} onTouchStart={warmSession} onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}>
          Wallet
        </Link>
        <Link href="/agent" style={{
          padding: "8px 14px",
          borderRadius: "50px",
          color: "#1a1a1a",
          fontFamily: "'Clash Display', sans-serif",
          fontSize: "14px",
          fontWeight: 500,
          textDecoration: "none",
          transition: "all 0.3s ease",
        }} onMouseEnter={(e) => {
          e.currentTarget.style.background = "rgba(255,255,255,0.5)";
        }} onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}>
          Agent
        </Link>
      </div>

      {/* ── Main centered headline — mobile only, above coin ── */}
      <div className="lg:hidden" style={{
        position: "absolute",
        top: "130px",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 35,
        textAlign: "center",
        pointerEvents: "none",
      }}>
        <h1 style={{
          fontFamily: "'Clash Display', sans-serif",
          fontSize: "clamp(48px, 8vw, 84px)",
          fontWeight: 600,
          lineHeight: 0.9,
          color: "#1a1a1a",
          margin: 0,
          letterSpacing: "-0.02em",
          whiteSpace: "nowrap",
        }}>
          YOUR <span style={{ color: "#2775CA" }}>WALLET</span><br />
          NEVER SLEEPS
        </h1>
      </div>

      {/* ── Solid text BEHIND hands ── */}
      <div className="hidden lg:block" style={{
        position: "absolute",
        top: "50%",
        left: "120px",
        transform: "translateY(-50%)",
        zIndex: 15,
        maxWidth: "500px",
        pointerEvents: "none",
      }}>
        <h1 style={{
          fontFamily: "'Clash Display', sans-serif",
          fontSize: "clamp(72px, 9vw, 126px)",
          fontWeight: 600,
          lineHeight: 0.85,
          color: "#1a1a1a",
          margin: 0,
          letterSpacing: "-0.02em",
        }}>
          <span style={{ fontSize: "0.65em", fontWeight: 400 }}>Your</span> <span style={{ color: "#2775CA" }}>WALLET</span>
        </h1>
      </div>

      <div className="hidden lg:block" style={{
        position: "absolute",
        top: "50%",
        right: "120px",
        transform: "translateY(-50%)",
        zIndex: 15,
        maxWidth: "500px",
        pointerEvents: "none",
      }}>
        <h1 style={{
          fontFamily: "'Clash Display', sans-serif",
          fontSize: "clamp(72px, 9vw, 126px)",
          fontWeight: 600,
          lineHeight: 0.85,
          color: "#1a1a1a",
          margin: 0,
          letterSpacing: "-0.02em",
          textAlign: "right",
        }}>
          <span style={{ fontSize: "0.65em", fontWeight: 400 }}>never</span> SLEEPS
        </h1>
      </div>

      {/* ── Hands ── */}
      <HeroHands />

      {/* ── Outline text IN FRONT of hands ── */}
      <div className="hidden lg:block" style={{
        position: "absolute",
        top: "50%",
        left: "120px",
        transform: "translateY(-50%)",
        zIndex: 25,
        maxWidth: "500px",
        pointerEvents: "none",
      }}>
        <h1 style={{
          fontFamily: "'Clash Display', sans-serif",
          fontSize: "clamp(72px, 9vw, 126px)",
          fontWeight: 600,
          lineHeight: 0.85,
          color: "transparent",
          WebkitTextStroke: "2px #1a1a1a",
          margin: 0,
          letterSpacing: "-0.02em",
        }}>
          <span style={{ fontSize: "0.65em", fontWeight: 400 }}>Your</span> <span style={{ WebkitTextStroke: "2px #2775CA" }}>WALLET</span>
        </h1>
      </div>

      <div className="hidden lg:block" style={{
        position: "absolute",
        top: "50%",
        right: "120px",
        transform: "translateY(-50%)",
        zIndex: 25,
        maxWidth: "500px",
        pointerEvents: "none",
      }}>
        <h1 style={{
          fontFamily: "'Clash Display', sans-serif",
          fontSize: "clamp(72px, 9vw, 126px)",
          fontWeight: 600,
          lineHeight: 0.85,
          color: "transparent",
          WebkitTextStroke: "2px #1a1a1a",
          margin: 0,
          letterSpacing: "-0.02em",
          textAlign: "right",
        }}>
          <span style={{ fontSize: "0.65em", fontWeight: 400 }}>never</span> SLEEPS
        </h1>
      </div>

      {/* ── 3D Coin ── */}
      <HeroCoin />

      {/* ── Subtext under coin ── */}
      <div style={{
        position: "absolute",
        top: "74%",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 35,
        maxWidth: "clamp(300px, 90vw, 700px)",
        textAlign: "center",
        pointerEvents: "none",
        padding: "0 20px",
      }}>
        <p style={{
          fontFamily: "'Clash Display', sans-serif",
          fontSize: "clamp(11px, 2.2vw, 22px)",
          fontWeight: 400,
          lineHeight: 1.5,
          color: "rgba(26,26,26,0.85)",
          margin: 0,
          letterSpacing: "-0.01em",
        }}>
          Your name is your wallet. No seed phrases, no 0x addresses. Just programmable money that schedules, sends, and acts on your terms. Built on Arc Network.
        </p>
      </div>

      {/* ── Logo — top left ── */}
      <div style={{
        position: "absolute",
        top: "24px",
        left: "clamp(16px, 4vw, 50px)",
        zIndex: 50,
      }}>
        <div style={{
          position: "relative",
          width: "clamp(90px, 20vw, 140px)",
          height: "clamp(27px, 6vw, 42px)",
        }}>
          <Image
            src="/dotarc.png"
            alt="DotArc"
            fill
            sizes="140px"
            style={{
              objectFit: "contain",
              filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.1))",
            }}
          />
        </div>
      </div>

      {/* ── CTA Button — top right ── */}
      <div className="hidden lg:block" style={{
        position: "absolute",
        top: "24px",
        right: "40px",
        zIndex: 50,
      }}>
        <Link
          href="/wallet"
          id="hero-cta"
          prefetch
          onFocus={warmSession}
          onTouchStart={warmSession}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "10px",
            padding: "14px 32px",
            background: "#1a1a1a",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: "50px",
            color: "#ffffff",
            fontFamily: "'Clash Display', sans-serif",
            fontSize: "14px",
            fontWeight: 600,
            letterSpacing: "2px",
            textTransform: "uppercase",
            textDecoration: "none",
            backdropFilter: "blur(10px)",
            transition: "all 0.4s cubic-bezier(0.16, 1, 0.3, 1)",
            cursor: "pointer",
            boxShadow: "0 0 20px rgba(201,169,110,0.1), inset 0 0 20px rgba(201,169,110,0.05)",
          }}
          onMouseEnter={(e) => {
            warmSession();
            const el = e.currentTarget;
            el.style.background = "#2a2a2a";
            el.style.borderColor = "rgba(255,255,255,0.3)";
            el.style.boxShadow = "0 0 30px rgba(0,0,0,0.3), inset 0 0 25px rgba(255,255,255,0.05)";
            el.style.transform = "translateY(-2px)";
          }}
          onMouseLeave={(e) => {
            const el = e.currentTarget;
            el.style.background = "#1a1a1a";
            el.style.borderColor = "rgba(255,255,255,0.15)";
            el.style.boxShadow = "0 0 20px rgba(0,0,0,0.2), inset 0 0 20px rgba(255,255,255,0.05)";
            el.style.transform = "translateY(0)";
          }}
        >
          Enter Wallet
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </Link>
      </div>

      {/* ── CTA Button — mobile, below subtext ── */}
      <div className="lg:hidden" style={{
        position: "absolute",
        top: "88%",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 50,
      }}>
        <Link
          href="/wallet"
          id="hero-cta-mobile"
          prefetch
          onTouchStart={warmSession}
          onFocus={warmSession}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "10px",
            padding: "14px 32px",
            background: "#1a1a1a",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: "50px",
            color: "#ffffff",
            fontFamily: "'Clash Display', sans-serif",
            fontSize: "14px",
            fontWeight: 600,
            letterSpacing: "2px",
            textTransform: "uppercase",
            textDecoration: "none",
            cursor: "pointer",
            boxShadow: "0 0 20px rgba(0,0,0,0.2)",
          }}
        >
          Enter Wallet
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </Link>
      </div>
    </section>
  );
}
