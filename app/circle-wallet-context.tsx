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

  function describeFetchError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("aborted") || msg.includes("AbortError"))
      return "Request timed out. Please try again.";
    if (msg.toLowerCase().includes("failed to fetch") || msg.toLowerCase().includes("networkerror"))
      return "Couldn't reach the server. Check your connection.";
    return msg;
  }

  const startCircleFlow = useCallback(async () => {
    setError(null);
    // Don't commit to "challenging" yet — that text says "complete the PIN
    // setup", which is wrong for returning users. We use "signing-in" as a
    // neutral interim state and only escalate to "challenging" once we know
    // a PIN dialog is actually about to open.
    setStatus("signing-in");
    console.log("[circle] startCircleFlow");

    // ── Step 1: init-user (single round-trip) ───────────────────────────
    let userId: string, userToken: string, encryptionKey: string, email: string;
    let challengeId: string | undefined;
    let alreadyOnboarded = false;
    let walletAddressFromInit: string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let inlineSession: any | undefined;
    try {
      const initRes = await fetchWithTimeout(`/api/circle/init-user`, {
        method: "POST",
        // Content-Type is required even for empty-body POSTs: our CSRF
        // middleware blocks any mutating request that isn't application/json.
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      if (!initRes.ok) {
        const data = await initRes.json().catch(() => ({}));
        throw new Error(data.error || `init-user returned ${initRes.status}`);
      }
      const body = await initRes.json();
      ({ userId, userToken, encryptionKey, challengeId, alreadyOnboarded, email } = body);
      walletAddressFromInit = body.walletAddress;
      inlineSession = body.session;
      console.log("[circle] init-user ok", {
        userId,
        email,
        alreadyOnboarded,
        hasChallenge: !!challengeId,
        hasInlineSession: !!inlineSession,
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
    if (inlineSession) {
      const cleanSession: CircleSession = {
        userId: inlineSession.userId,
        email: inlineSession.email,
        walletAddress: inlineSession.walletAddress,
        arcName: inlineSession.arcName ?? null,
      };
      setSession(cleanSession);
      setStatus(cleanSession.arcName ? "authenticated" : "needs-name");
      return;
    }

    // ── New-user path: PIN dialog + wallet polling + session create ─────
    if (!alreadyOnboarded && challengeId) {
      setStatus("challenging"); // now we KNOW a PIN dialog is about to show
      try {
        const sdk = await getSdk();
        sdk.setAuthentication({ userToken, encryptionKey });
        await new Promise<void>((resolve, reject) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          sdk.execute(challengeId!, (error: any, result: any) => {
            if (error) {
              reject(new Error(error.message || error.code || "Wallet creation cancelled"));
              return;
            }
            if (result?.status === "COMPLETE") resolve();
            else if (result?.status === "FAILED" || result?.status === "ERROR")
              reject(new Error(`Challenge ${result.status}`));
          });
        });
      } catch (err) {
        console.error("[circle] sdk challenge failed:", err);
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
        return;
      }
    }

    setStatus("wallet-ready");
    // If init-user already gave us the wallet (shouldn't happen on new-user
    // path because no inlineSession, but defensively skip the loop), use it.
    let wallet: { address: string } | null = walletAddressFromInit
      ? { address: walletAddressFromInit }
      : null;

    if (!wallet) {
      // Exponential backoff for the eventual-consistency window after PIN
      // setup. Most wallets appear in 1-3s, so try fast first then back off.
      // Total worst-case wait: 500+1000+1500+2000+3000+4000 = 12s, same as old.
      const intervalsMs = [500, 1000, 1500, 2000, 3000, 4000];
      for (let attempt = 0; attempt < intervalsMs.length; attempt++) {
        try {
          // userId is derived server-side from the verified Supabase session.
          // Do not pass it as a query param — it would be ignored anyway.
          const walletRes = await fetchWithTimeout(
            `/api/circle/wallet`,
            { credentials: "include" }
          );
          if (walletRes.ok) {
            wallet = await walletRes.json();
            console.log(`[circle] wallet appeared after ${attempt + 1} attempts`);
            break;
          }
        } catch (err) {
          console.warn(`[circle] wallet lookup attempt ${attempt + 1} errored:`, err);
        }
        await new Promise((r) => setTimeout(r, intervalsMs[attempt]));
      }
    }

    if (!wallet) {
      setError("Your wallet was created but our backend can't see it yet. Refresh in a few seconds.");
      setStatus("error");
      return;
    }

    try {
      const sessRes = await fetchWithTimeout(`/api/circle/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ walletAddress: wallet.address }),
      });
      if (!sessRes.ok) {
        const data = await sessRes.json().catch(() => ({}));
        throw new Error(data.error || `session returned ${sessRes.status}`);
      }
      const { session: newSession } = await sessRes.json();
      const cleanSession: CircleSession = {
        userId: newSession.userId,
        email: newSession.email,
        walletAddress: newSession.walletAddress,
        arcName: newSession.arcName ?? null,
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
      const timeout = setTimeout(() => {
        reject(new Error("PIN confirmation timed out. Please try again."));
      }, 60_000);

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
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      // Roll back to whichever screen the user came from.
      setStatus((prev) => (prev === "registering-name" ? "needs-name" : prev));
      throw err;
    }
  }, [status]);

  const logout = useCallback(async () => {
    try {
      await fetch(`/api/circle/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
    } catch {}
    setSession(null);
    setStatus("anonymous");
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
