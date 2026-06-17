"use client";

/**
 * Circle wallet context — manages the user's Circle session and signup/signin flow.
 *
 * In this standalone wallet project, the API lives at /api/circle/* (Next.js
 * route handlers in this same app). No CORS. No separate API base URL.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { friendlyError } from "@/lib/friendly-errors";
import { createSupabaseBrowserClient, isSupabaseConfigured } from "@/lib/supabase/client";

const CIRCLE_APP_ID = process.env.NEXT_PUBLIC_CIRCLE_APP_ID || "";

export type CircleSession = {
  userId: string;
  email: string;
  walletAddress: string;
  arcName: string | null;
};

export type CircleStatus =
  | "loading"
  | "anonymous"
  | "signing-in"     // returning user fast-path — no PIN dialog, just finalizing
  | "challenging"    // new user — Circle PIN setup dialog is open
  | "wallet-ready"   // new user — PIN done, polling for wallet
  | "needs-name"     // wallet exists but no .arc name yet — mandatory next step
  | "authenticated"  // wallet exists AND has a .arc name
  | "registering-name"
  | "error";

interface CircleWalletState {
  status: CircleStatus;
  session: CircleSession | null;
  error: string | null;
  /** Kick off Circle wallet creation/lookup. Email comes from the verified Supabase session on the server. */
  startCircleFlow: () => Promise<void>;
  registerName: (name: string) => Promise<{ arcName: string; txHash: string }>;
  /**
   * Execute a Circle challenge (e.g. a send transaction) via the browser SDK
   * (PIN dialog). Resolves with `{ txHash }` on COMPLETE — `txHash` is null
   * for sign-only challenges that don't broadcast a transaction.
   */
  executeChallenge: (challengeId: string, userToken: string, encryptionKey: string) => Promise<{ txHash: string | null }>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  clearError: () => void;
}

const CircleWalletContext = createContext<CircleWalletState>({
  status: "loading",
  session: null,
  error: null,
  startCircleFlow: async () => {},
  registerName: async () => ({ arcName: "", txHash: "" }),
  executeChallenge: async () => ({ txHash: null }),
  logout: async () => {},
  refresh: async () => {},
  clearError: () => {},
});

export function useCircleWallet() {
  return useContext(CircleWalletContext);
}

export function CircleWalletProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<CircleStatus>("loading");
  const [session, setSession] = useState<CircleSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdkRef = useRef<any>(null);

  const clearError = useCallback(() => setError(null), []);

  const refresh = useCallback(async () => {
    // Clear any stale error before re-deriving state. Without this, an error
    // from a previous failed attempt survives a page revisit and gets handed
    // to AuthGate as `initialError` on an otherwise-fresh login screen.
    setError(null);
    try {
      const res = await fetch("/api/circle/me", { credentials: "include" });
      if (res.ok) {
        const data = (await res.json()) as CircleSession;
        setSession(data);
        // Branch on whether the user has finished signup (picked a .arc name).
        setStatus(data.arcName ? "authenticated" : "needs-name");
      } else {
        setSession(null);
        setStatus("anonymous");
      }
    } catch {
      setSession(null);
      setStatus("anonymous");
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  /**
   * Build a Circle W3S SDK instance.
   *
   * `fresh=true` forces a brand-new instance. We need this for every
   * `executeChallenge` call because the SDK's internal iframe state goes
   * stale after a `COMPLETE` challenge — re-using the same SDK for a
   * second challenge causes the PIN dialog to silently never open
   * (the user sees "Opening secure PIN entry…" forever).
   *
   * The cached instance is fine for the very first onboarding challenge,
   * which is the only place we use `fresh=false`.
   */
  const getSdk = useCallback(async (fresh = false) => {
    if (!fresh && sdkRef.current) return sdkRef.current;
    if (!CIRCLE_APP_ID) throw new Error("NEXT_PUBLIC_CIRCLE_APP_ID is not configured");
    const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
    const sdk = new W3SSdk({ appSettings: { appId: CIRCLE_APP_ID } });
    sdkRef.current = sdk;
    return sdk;
  }, []);

  async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 30_000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * fetchJsonWithRetry — resilient JSON fetch for the signup flow.
   *
   * Retries on **transient** failures only:
   *   - network errors (fetch threw, AbortError, TypeError)
   *   - 5xx responses
   *
   * Does NOT retry on:
   *   - 4xx responses (the request is malformed or the user isn't allowed —
   *     hammering the server won't help)
   *
   * Backoff doubles on each attempt, capped at 3s. With retries=3 and a
   * starting delay of 400ms the worst-case extra latency before giving up
   * is 400 + 800 + 1600 ≈ 2.8s, which is invisible to a happy-path user
   * but rescues most flaky-Wi-Fi signups without bouncing them to the
   * error screen.
   */
  async function fetchJsonWithRetry<T>(
    url: string,
    init: RequestInit,
    options: { retries?: number; timeoutMs?: number; label: string },
  ): Promise<T> {
    const { retries = 3, timeoutMs = 30_000, label } = options;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetchWithTimeout(url, init, timeoutMs);
        if (res.ok) {
          return (await res.json()) as T;
        }
        const body: { error?: string } = await res.json().catch(() => ({}));
        const message = body?.error || `${label} returned ${res.status}`;
        if (res.status >= 400 && res.status < 500) {
          // Permanent — surface immediately. Tag the error so the catch
          // below knows to re-throw instead of treating it as transient.
          const permanent = new Error(message) as Error & { _permanent?: true };
          permanent._permanent = true;
          throw permanent;
        }
        // 5xx — record and retry.
        lastErr = new Error(message);
      } catch (err) {
        // 4xx errors thrown above carry the _permanent tag — bail
        // immediately instead of retrying.
        if (err && typeof err === "object" && (err as { _permanent?: boolean })._permanent) {
          throw err;
        }
        // Anything else (TypeError, AbortError, our own 5xx Error,
        // body parse failures) is transient — retry.
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[circle] ${label} attempt ${attempt + 1} failed:`, msg);
      }
      if (attempt < retries) {
        await sleep(Math.min(400 * 2 ** attempt, 3000));
      }
    }
    throw lastErr ?? new Error(`${label} failed after ${retries + 1} attempts`);
  }

  // Single source of truth for turning any caught error into a user-facing
  // string. Routes through the central pattern map in lib/friendly-errors.ts
  // so we never leak stack traces, Circle internals, or "[object Object]".
  function describeFetchError(err: unknown): string {
    return friendlyError(err, "Couldn't reach the server. Please try again.");
  }

  // Shape returned by /api/circle/init-user. Pulled out so we can call
  // init-user from two places: the initial entry, and the recovery path
  // when wallet polling exhausts (init-user's FAST PATH lights up once
  // Circle's backend has propagated the new wallet).
  type InitUserResponse = {
    userId: string;
    userToken: string;
    encryptionKey: string;
    email: string;
    challengeId?: string;
    alreadyOnboarded: boolean;
    walletAddress?: string;
    session?: {
      userId: string;
      email: string;
      walletAddress: string;
      arcName: string | null;
    };
  };

  type SessionResponse = {
    session: {
      userId: string;
      email: string;
      walletAddress: string;
      arcName: string | null;
    };
  };

  const startCircleFlow = useCallback(async () => {
    setError(null);
    // Don't commit to "challenging" yet — that text says "complete the PIN
    // setup", which is wrong for returning users. We use "signing-in" as a
    // neutral interim state and only escalate to "challenging" once we know
    // a PIN dialog is actually about to open.
    setStatus("signing-in");
    console.log("[circle] startCircleFlow");

    // ── Apply an inline session (FAST PATH from init-user) ───────────────
    const applyInlineSession = (s: NonNullable<InitUserResponse["session"]>) => {
      const cleanSession: CircleSession = {
        userId: s.userId,
        email: s.email,
        walletAddress: s.walletAddress,
        arcName: s.arcName ?? null,
      };
      setSession(cleanSession);
      setStatus(cleanSession.arcName ? "authenticated" : "needs-name");
    };

    // ── Step 1: init-user (with retry on transient errors) ──────────────
    let initBody: InitUserResponse;
    try {
      initBody = await fetchJsonWithRetry<InitUserResponse>(
        `/api/circle/init-user`,
        {
          method: "POST",
          // Content-Type is required even for empty-body POSTs: our CSRF
          // middleware blocks any mutating request that isn't application/json.
          headers: { "Content-Type": "application/json" },
          credentials: "include",
        },
        { label: "init-user", retries: 3 },
      );
      console.log("[circle] init-user ok", {
        userId: initBody.userId,
        email: initBody.email,
        alreadyOnboarded: initBody.alreadyOnboarded,
        hasChallenge: !!initBody.challengeId,
        hasInlineSession: !!initBody.session,
      });
    } catch (err) {
      console.error("[circle] init-user failed:", err);
      setError(describeFetchError(err));
      setStatus("error");
      return;
    }

    // ── Returning-user fast path ────────────────────────────────────────
    // The server has already finalized the session and set the cookie.
    // Skip /wallet polling AND /session — we're done in 1 round-trip.
    if (initBody.session) {
      applyInlineSession(initBody.session);
      return;
    }

    // ── New-user path: PIN dialog + wallet polling + session create ─────
    if (!initBody.alreadyOnboarded && initBody.challengeId) {
      setStatus("challenging"); // now we KNOW a PIN dialog is about to show
      try {
        const sdk = await getSdk();
        sdk.setAuthentication({
          userToken: initBody.userToken,
          encryptionKey: initBody.encryptionKey,
        });
        await new Promise<void>((resolve, reject) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          sdk.execute(initBody.challengeId!, (error: any, result: any) => {
            console.log("[circle] execute callback fired:", { error, result });
            if (error) {
              reject(new Error(error.message || error.code || "Wallet creation cancelled"));
              return;
            }
            if (result?.status === "COMPLETE") resolve();
            else if (result?.status === "FAILED" || result?.status === "ERROR")
              reject(new Error(`Challenge ${result.status}`));
            else {
              console.warn("[circle] unrecognized challenge status:", result?.status, result);
              reject(new Error(`Unexpected status: ${result?.status || "unknown"}`));
            }
          });
        });
      } catch (err) {
        // The Circle SDK callback is unreliable: its hardcoded 10s iframe
        // timeout surfaces a spurious "Network error", and a user cancel or a
        // stale-iframe hiccup also lands here — yet the wallet may well have
        // been created (the webhook + Supabase Realtime below are the real
        // completion signal). So we deliberately do NOT escalate to the
        // full-screen "error" state. We log and fall through to the polling +
        // recovery + Realtime safety net, which settles the truth and only
        // surfaces an error if the wallet genuinely never appears.
        console.warn(
          "[circle] sdk challenge callback errored — deferring to webhook/polling:",
          err,
        );
      }
    }

    setStatus("wallet-ready");
    // If init-user already gave us the wallet (shouldn't happen on new-user
    // path because no inlineSession, but defensively skip the loop), use it.
    let wallet: { address: string } | null = initBody.walletAddress
      ? { address: initBody.walletAddress }
      : null;

    if (!wallet) {
      // Extended polling window — Circle's wallet provisioning is eventually
      // consistent and on a slow network we sometimes saw the wallet appear
      // 15-25s after PIN completion. The old 12s budget caused users to land
      // on the "Try again" error screen even though their wallet was being
      // created normally. Total worst-case wait now: ~24s.
      const intervalsMs = [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4000, 4000];
      for (let attempt = 0; attempt < intervalsMs.length; attempt++) {
        try {
          // userId is derived server-side from the verified Supabase session.
          // Do not pass it as a query param — it would be ignored anyway.
          const walletRes = await fetchWithTimeout(
            `/api/circle/wallet`,
            { credentials: "include" },
            10_000,
          );
          if (walletRes.ok) {
            wallet = await walletRes.json();
            console.log(`[circle] wallet appeared after ${attempt + 1} attempts`);
            break;
          }
        } catch (err) {
          console.warn(`[circle] wallet lookup attempt ${attempt + 1} errored:`, err);
        }
        await sleep(intervalsMs[attempt]);
      }
    }

    // ── Recovery: polling exhausted ─────────────────────────────────────
    // Instead of dumping the user on the "Try again" error screen, do
    // exactly what the user would have done by clicking it: re-call
    // init-user. By now Circle's wallet record has propagated and
    // init-user lights up its FAST PATH (returns an inline session),
    // letting us skip /wallet polling AND /session entirely.
    //
    // This is the single biggest UX fix — it converts the most common
    // signup failure mode into a silent extra ~1s wait.
    if (!wallet) {
      console.warn("[circle] wallet polling exhausted — auto-recovering via init-user");
      try {
        const recovery = await fetchJsonWithRetry<InitUserResponse>(
          `/api/circle/init-user`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
          },
          { label: "init-user (recovery)", retries: 2 },
        );
        if (recovery.session) {
          console.log("[circle] recovery FAST PATH succeeded");
          applyInlineSession(recovery.session);
          return;
        }
        if (recovery.walletAddress) {
          wallet = { address: recovery.walletAddress };
        }
      } catch (err) {
        // Fall through to the error screen with a sensible message —
        // truly something else is wrong if init-user can't recover here.
        console.error("[circle] recovery init-user failed:", err);
      }
    }

    if (!wallet) {
      setError(
        "Your wallet is still being created. Please give it a few seconds and try again.",
      );
      setStatus("error");
      return;
    }

    // ── Step 3: mint dotarc session JWT (with retry) ────────────────────
    try {
      const sessBody = await fetchJsonWithRetry<SessionResponse>(
        `/api/circle/session`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ walletAddress: wallet.address }),
        },
        { label: "session", retries: 3 },
      );
      const cleanSession: CircleSession = {
        userId: sessBody.session.userId,
        email: sessBody.session.email,
        walletAddress: sessBody.session.walletAddress,
        arcName: sessBody.session.arcName ?? null,
      };
      setSession(cleanSession);
      // Returning users with a .arc name go straight to the dashboard.
      // Brand-new users land on the mandatory name picker.
      setStatus(cleanSession.arcName ? "authenticated" : "needs-name");
    } catch (err) {
      console.error("[circle] session failed:", err);
      setError(describeFetchError(err));
      setStatus("error");
    }
    // fetchJsonWithRetry/sleep/fetchWithTimeout are defined inside this
    // component for closure-free reasons but are referentially stable across
    // renders (no captured state). Adding them to deps would force a new
    // startCircleFlow on every render with no behavioral benefit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getSdk]);

  const executeChallenge = useCallback(async (
    challengeId: string,
    userToken: string,
    encryptionKey: string
  ): Promise<{ txHash: string | null }> => {
    // Force a fresh SDK instance — re-using a previously-executed instance
    // makes the PIN dialog silently never open on second/subsequent calls.
    const sdk = await getSdk(true);
    sdk.setAuthentication({ userToken, encryptionKey });
    return await new Promise<{ txHash: string | null }>((resolve, reject) => {
      // No artificial short timeout. The user may legitimately leave the PIN
      // dialog open for a while, and auto-failing them mid-entry is exactly
      // the interference we want to avoid. We keep only a generous 5-minute
      // guard so a never-firing SDK callback (the stale-iframe bug) can't
      // leave this promise pending forever. The message is phrased as
      // "uncertain — check activity" so the caller (SendModal) routes it to
      // the soft amber screen + webhook check, not a hard red failure.
      const timeout = setTimeout(() => {
        reject(new Error(
          "Didn't get a response from the wallet dialog in time. Your transfer may still be processing — check your activity feed before retrying.",
        ));
      }, 5 * 60_000);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sdk.execute(challengeId, (err: any, result: any) => {
        clearTimeout(timeout);
        console.log("[circle] execute callback:", { err, result });
        if (err) {
          reject(new Error(err.message || err.code || "Challenge cancelled"));
          return;
        }
        if (result?.status === "COMPLETE") {
          // Circle's SDK callback shape varies between challenge types; sweep
          // a few likely places for the tx hash. If none match, return null
          // and let the caller fall back to the explorer's address page.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const data = result?.data as any;
          const txHash =
            (typeof data?.txHash === "string" && data.txHash) ||
            (typeof data?.transactionHash === "string" && data.transactionHash) ||
            (typeof result?.txHash === "string" && result.txHash) ||
            null;
          resolve({ txHash });
        } else if (result?.status === "FAILED" || result?.status === "ERROR") {
          reject(new Error(`Transaction ${result.status.toLowerCase()}`));
        } else {
          // Catch-all: Circle called back with an unrecognized status.
          // Log it so we know what to handle next, then reject.
          console.warn("[circle] unrecognized challenge status:", result?.status, result);
          reject(new Error(`Unexpected status: ${result?.status || "unknown"}`));
        }
      });
    });
  }, [getSdk]);

  /**
   * Realtime: watch for `profiles.wallet_address` updates during onboarding.
   * When the Circle webhook (challenges.initialize) updates the profile after
   * the user completes the PIN dialog, this fires and re-runs startCircleFlow.
   * init-user will then hit the FAST PATH (alreadyOnboarded=true) and the
   * client auto-transitions — no refresh required.
   */
  useEffect(() => {
    if (status !== "challenging" && status !== "wallet-ready") return;

    const supabase = createSupabaseBrowserClient();
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;

    async function setup() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || cancelled) return;

      channel = supabase
        .channel(`onboard-${user.id}`)
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "profiles",
            filter: `id=eq.${user.id}`,
          },
          (payload) => {
            const newWallet = (payload.new as Record<string, unknown>)?.wallet_address;
            const oldWallet = (payload.old as Record<string, unknown>)?.wallet_address;
            if (newWallet && !oldWallet) {
              console.log("[circle] Realtime: wallet_address appeared, triggering flow recovery");
              if (!cancelled) void startCircleFlow();
            }
          }
        )
        .subscribe();
    }

    setup();
    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [status, startCircleFlow]);

  const registerName = useCallback(async (name: string) => {
    if (status !== "authenticated" && status !== "needs-name") {
      throw new Error("Not authenticated");
    }
    setError(null);
    setStatus("registering-name");
    try {
      const res = await fetch(`/api/circle/register-name`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Registration failed (${res.status})`);

      setSession((prev) => prev ? { ...prev, arcName: data.arcName } : prev);
      setStatus("authenticated");
      return { arcName: data.arcName as string, txHash: data.txHash as string };
    } catch (err) {
      setError(friendlyError(err, "Name registration didn't go through. Please try again."));
      // Roll back to whichever screen the user came from.
      setStatus((prev) => (prev === "registering-name" ? "needs-name" : prev));
      throw err;
    }
  }, [status]);

  const logout = useCallback(async () => {
    // Surface server-side signout failures instead of silently swallowing
    // them. The user still gets logged out locally either way, but if the
    // server session couldn't be cleared we want them to know so they can
    // refresh / retry instead of believing they're fully signed out.
    let serverError: string | null = null;

    // Issue #9: Clear the Supabase session as well as the Circle session.
    // If we leave the Supabase session alive, AuthGate's getClaims() will
    // find it on the next remount, auto-fire onVerified, and put the user
    // straight back into the Circle flow — producing the "won't log out"
    // loop. signOut() with scope:"local" only clears this browser's
    // session (other devices stay signed in) and revokes the refresh
    // token so the cookie can't silently resurrect.
    if (isSupabaseConfigured()) {
      try {
        const supabase = createSupabaseBrowserClient();
        const { error: supabaseErr } = await supabase.auth.signOut({ scope: "local" });
        if (supabaseErr) {
          console.warn("[circle] supabase signOut returned error:", supabaseErr);
          serverError = friendlyError(
            supabaseErr,
            "Signed out locally, but we couldn't fully clear your sign-in session. Please refresh.",
          );
        }
      } catch (err) {
        console.warn("[circle] supabase signOut threw:", err);
        // Don't block the rest of logout — fall through to the Circle
        // server signout and local state clear below.
      }
    }

    try {
      const res = await fetch(`/api/circle/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        serverError = friendlyError(
          data?.error,
          "You're signed out locally, but we couldn't fully end your server session. Please refresh.",
        );
      }
    } catch (err) {
      serverError = friendlyError(
        err,
        "You're signed out locally, but we couldn't reach the server to fully sign you out.",
      );
    }
    setSession(null);
    setStatus("anonymous");
    if (serverError) setError(serverError);
  }, []);

  const value = useMemo<CircleWalletState>(() => ({
    status, session, error,
    startCircleFlow, registerName, executeChallenge, logout, refresh, clearError,
  }), [status, session, error, startCircleFlow, registerName, executeChallenge, logout, refresh, clearError]);

  return (
    <CircleWalletContext.Provider value={value}>
      {children}
    </CircleWalletContext.Provider>
  );
}
