"use client";

/**
 * Auth gate — prove email ownership before any Circle wallet code runs.
 *
 * Renders the "Continue with Google" + "Continue with email (OTP)" screen.
 * On success, calls `onVerified(email)` so the parent can kick off Circle
 * signup/sign-in with a TRUSTED email.
 *
 * Uses Supabase Auth under the hood — Supabase sends the OTP, handles Google,
 * and exposes the verified email via its session cookie.
 */

import { useEffect, useRef, useState } from "react";
import { createSupabaseBrowserClient, isSupabaseConfigured } from "@/lib/supabase/client";

type Mode = "choose" | "email-input" | "code-input" | "google-redirecting";

export function AuthGate({
  onVerified,
  initialError,
}: {
  onVerified: (email: string) => void;
  initialError?: string | null;
}) {
  const [mode, setMode] = useState<Mode>("choose");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [info, setInfo] = useState<string | null>(null);

  // On mount: if Supabase already has a verified session, skip the gate entirely.
  // Guarded by a ref so we fire onVerified AT MOST ONCE per page-lifetime —
  // prevents an infinite remount loop when startCircleFlow fails and parent
  // transitions back to AuthGate.
  //
  // PERF: prefer getClaims() (validates JWT locally, no network) and only
  // fall back to getUser() (Supabase round-trip) if claims aren't available.
  // Cuts the click->wallet latency by ~200-800ms in the common case.
  const firedRef = useRef(false);
  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    if (firedRef.current) return;

    const supabase = createSupabaseBrowserClient();
    let cancelled = false;

    (async () => {
      try {
        const { data, error } = await supabase.auth.getClaims();
        if (!cancelled && !error) {
          const claimEmail =
            (data?.claims as { email?: unknown } | null)?.email;
          if (typeof claimEmail === "string" && claimEmail && !firedRef.current) {
            firedRef.current = true;
            onVerified(claimEmail.toLowerCase());
            return;
          }
        }
      } catch {
        // fall through to getUser fallback
      }

      // Fallback for older Supabase JS or when claims are missing.
      const { data } = await supabase.auth.getUser();
      if (cancelled) return;
      const verified = data?.user?.email;
      if (verified && !firedRef.current) {
        firedRef.current = true;
        onVerified(verified.toLowerCase());
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!isSupabaseConfigured()) {
    return (
      <Shell>
        <h1 className="font-clash text-3xl font-bold uppercase tracking-tight text-white">
          Auth not configured
        </h1>
        <p className="mt-3 max-w-md text-sm text-white/75">
          Add <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-white">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
          <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-white">NEXT_PUBLIC_SUPABASE_ANON_KEY</code>{" "}
          to <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-white">.env.local</code> and restart the dev server.
        </p>
      </Shell>
    );
  }

  const onGoogle = async () => {
    setError(null);
    setBusy(true);
    setMode("google-redirecting");
    try {
      const supabase = createSupabaseBrowserClient();
      const { error: err } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/auth/callback?next=/wallet` },
      });
      if (err) throw err;
      // Browser will redirect away. If it doesn't, fall back.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Google sign-in failed");
      setMode("choose");
      setBusy(false);
    }
  };

  const onSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error: err } = await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true },
      });
      if (err) throw err;
      setInfo(`We sent a 6-digit code to ${email}. Check your inbox.`);
      setMode("code-input");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send code");
    } finally {
      setBusy(false);
    }
  };

  const onVerifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code || !email) return;
    setError(null);
    setBusy(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { data, error: err } = await supabase.auth.verifyOtp({
        email,
        token: code,
        type: "email",
      });
      if (err) throw err;
      const verified = data?.user?.email;
      if (!verified) throw new Error("No email returned from verification");
      onVerified(verified.toLowerCase());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid or expired code");
    } finally {
      setBusy(false);
    }
  };

  if (mode === "google-redirecting") {
    return (
      <Shell>
        <Spinner />
        <p className="mt-6 font-clash text-sm uppercase tracking-[0.25em] text-white/80">
          Redirecting to Google
        </p>
      </Shell>
    );
  }

  if (mode === "code-input") {
    return (
      <Shell>
        <Headline>
          CHECK YOUR<br />EMAIL
        </Headline>
        {info && (
          <p className="mt-4 max-w-sm text-center text-sm text-white/85">{info}</p>
        )}
        {error && <ErrorBox onDismiss={() => setError(null)}>{error}</ErrorBox>}
        <form onSubmit={onVerifyCode} className="mt-8 flex w-full max-w-sm flex-col items-center gap-4">
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="000000"
            maxLength={6}
            aria-label="6-digit code"
            className="w-full rounded-full border border-white/25 bg-white/10 px-6 py-4 text-center font-mono text-2xl tracking-[0.5em] text-white placeholder-white/40 outline-none backdrop-blur-sm transition focus:border-white/60 focus:bg-white/15"
            disabled={busy}
            autoFocus
          />
          <PrimaryButton type="submit" disabled={busy || code.length !== 6}>
            {busy ? "Verifying…" : "Verify and continue"}
          </PrimaryButton>
          <button
            type="button"
            onClick={() => {
              setMode("email-input");
              setCode("");
              setInfo(null);
            }}
            className="font-clash text-xs uppercase tracking-[0.2em] text-white/70 transition hover:text-white"
          >
            Use a different email
          </button>
        </form>
      </Shell>
    );
  }

  if (mode === "email-input") {
    return (
      <Shell>
        <Headline>
          ENTER YOUR<br />EMAIL
        </Headline>
        <p className="mt-4 max-w-sm text-center text-sm text-white/75">
          We&apos;ll send a 6-digit code to confirm it&apos;s really you.
        </p>
        {error && <ErrorBox onDismiss={() => setError(null)}>{error}</ErrorBox>}
        <form onSubmit={onSendCode} className="mt-8 flex w-full max-w-sm flex-col items-center gap-4">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            aria-label="Email"
            className="w-full rounded-full border border-white/25 bg-white/10 px-6 py-4 text-center text-base text-white placeholder-white/40 outline-none backdrop-blur-sm transition focus:border-white/60 focus:bg-white/15"
            disabled={busy}
            autoFocus
          />
          <PrimaryButton type="submit" disabled={busy || !email}>
            {busy ? "Sending…" : "Send code"}
          </PrimaryButton>
          <button
            type="button"
            onClick={() => setMode("choose")}
            className="font-clash text-xs uppercase tracking-[0.2em] text-white/70 transition hover:text-white"
          >
            Back
          </button>
        </form>
      </Shell>
    );
  }

  // mode === "choose"
  return (
    <Shell>
      <Headline>
        YOUR WALLET<br />NEVER SLEEPS
      </Headline>
      {error && <ErrorBox onDismiss={() => setError(null)}>{error}</ErrorBox>}
      <div className="mt-10 flex w-full max-w-md flex-col items-center gap-3 sm:flex-row sm:justify-center">
        <button
          onClick={onGoogle}
          disabled={busy}
          className="font-clash inline-flex w-full items-center justify-center gap-3 rounded-full bg-white px-6 py-3.5 text-sm font-semibold uppercase tracking-[0.12em] text-[#1e3a8a] shadow-lg shadow-blue-950/20 transition hover:bg-white/95 active:scale-[0.98] disabled:opacity-50 sm:w-auto sm:flex-1"
        >
          <GoogleIcon />
          <span>Google</span>
        </button>
        <button
          onClick={() => {
            setMode("email-input");
            setError(null);
          }}
          disabled={busy}
          className="font-clash inline-flex w-full items-center justify-center gap-2 rounded-full border border-white/30 bg-white/15 px-6 py-3.5 text-sm font-semibold uppercase tracking-[0.12em] text-white backdrop-blur-sm transition hover:bg-white/25 active:scale-[0.98] disabled:opacity-50 sm:w-auto sm:flex-1"
        >
          <MailIcon />
          <span>Email</span>
        </button>
      </div>
      <p className="mt-8 max-w-md text-center text-xs text-white/70">
        No seed phrase. We pay the registration fee.
      </p>
    </Shell>
  );
}

/**
 * Full-screen blue shell — `.arc` mark up top, content vertically centered.
 * The parent in app/wallet/page.tsx already paints the blue gradient,
 * so Shell only handles the inner layout.
 */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen w-full flex-col items-center justify-center px-6 py-16">
      {/* .arc logo — pinned near the top */}
      <div className="absolute left-1/2 top-20 -translate-x-1/2 sm:top-24">
        {/* Plain <img> over next/image: intrinsic dimensions of the asset
            are unknown, and we only need a small rendered size. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/arc-logo.png"
          alt=".arc"
          className="h-14 w-auto select-none sm:h-16"
          draggable={false}
        />
      </div>
      <div className="flex w-full flex-col items-center">{children}</div>
    </div>
  );
}

/** Big uppercase Clash Display headline used on every mode. */
function Headline({ children }: { children: React.ReactNode }) {
  return (
    <h1
      className="text-center font-clash font-bold uppercase leading-[0.95] text-white"
      style={{
        fontFamily: "'Clash Display', sans-serif",
        fontSize: "clamp(40px, 8vw, 76px)",
        letterSpacing: "-0.02em",
      }}
    >
      {children}
    </h1>
  );
}

/** Solid white pill — primary CTA used on email/code submit. */
function PrimaryButton({
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className="font-clash inline-flex w-full items-center justify-center rounded-full bg-white px-6 py-3.5 text-sm font-semibold uppercase tracking-[0.12em] text-[#1e3a8a] shadow-lg shadow-blue-950/20 transition hover:bg-white/95 active:scale-[0.98] disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** Tiny indeterminate spinner for the redirecting state. */
function Spinner() {
  return (
    <div
      aria-hidden
      className="h-8 w-8 animate-spin rounded-full border-2 border-white/30 border-t-white"
    />
  );
}

function ErrorBox({
  children,
  onDismiss,
}: {
  children: React.ReactNode;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      className="mt-6 flex w-full max-w-sm items-start gap-3 rounded-2xl border border-red-300/40 bg-red-500/15 px-4 py-3 text-sm text-red-50 backdrop-blur-sm"
    >
      <span className="flex-1">{children}</span>
      <button
        onClick={onDismiss}
        className="-mr-1 text-lg leading-none text-red-50/70 transition hover:text-red-50"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

function MailIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.26c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
      />
    </svg>
  );
}
