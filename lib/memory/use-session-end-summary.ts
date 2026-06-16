"use client";

/**
 * useSessionEndSummary — fires a one-shot summary write to
 * /api/agent/memory/session-end when:
 *   1. The tab is being closed/hidden (`pagehide`/`beforeunload`).
 *   2. The user has been idle for IDLE_MS with at least one new
 *      meaningful turn since the last fire.
 *
 * Hard rules:
 *   - The hook is a passive nicety. It MUST NEVER block UI, throw, or
 *     surface errors. Every fire path is wrapped + best-effort.
 *   - We only count "meaningful turns" (non-pending, non-welcome user
 *     messages) so trivial visits don't trigger work.
 *   - We dedupe via a "fired-since-last-turn" flag so the same
 *     conversation can't get summarized twice in a row.
 *   - The unload path uses navigator.sendBeacon — the only reliable
 *     way to ship a POST during page teardown. No response inspection.
 *   - The idle path uses fetch with keepalive so it survives a fast
 *     tab-close after firing.
 *
 * Server-side gating (see app/api/agent/memory/session-end/route.ts)
 * shortcuts immediately when MEMWAL_ENABLED is unset, so it's safe to
 * leave this hook always-on regardless of Walrus state.
 */

import { useEffect, useRef } from "react";
import { buildConversationHistory, type ChatTurn } from "@/lib/agent-history";

type UIMessage = { role: string; text: string; pending?: boolean; id?: string };

const IDLE_MS = 10 * 60 * 1000; // 10 minutes
const MIN_USER_TURNS = 2;
const ENDPOINT = "/api/agent/memory/session-end";

export function useSessionEndSummary(messages: UIMessage[]): void {
  // Refs let the unload listener see the LATEST messages without
  // re-binding on every render (event listeners on `pagehide` are
  // expensive to swap and risk being missed mid-teardown).
  const messagesRef = useRef<UIMessage[]>(messages);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userTurnCountRef = useRef<number>(0);
  const firedForCurrentTurnRef = useRef<boolean>(true); // start "fired" so the first idle alone doesn't trigger
  const lastUserCountAtFireRef = useRef<number>(0);

  // Keep refs current and (re)arm the idle timer on each meaningful change.
  useEffect(() => {
    messagesRef.current = messages;

    const userTurns = countUserTurns(messages);
    if (userTurns > userTurnCountRef.current) {
      userTurnCountRef.current = userTurns;
      firedForCurrentTurnRef.current = false; // a NEW user turn re-arms the fire flag
    }

    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);

    // Only schedule when there's enough content AND we haven't already
    // summarized THIS state.
    if (userTurns >= MIN_USER_TURNS && !firedForCurrentTurnRef.current) {
      idleTimerRef.current = setTimeout(() => {
        fireSummary("idle", messagesRef.current);
        firedForCurrentTurnRef.current = true;
        lastUserCountAtFireRef.current = userTurnCountRef.current;
      }, IDLE_MS);
    }

    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [messages]);

  // Fire on tab close. We use `pagehide` (more reliable than
  // beforeunload, especially on mobile) and ALSO listen on
  // beforeunload as a fallback for older desktop browsers.
  useEffect(() => {
    function handler() {
      if (firedForCurrentTurnRef.current) return;
      const userTurns = countUserTurns(messagesRef.current);
      if (userTurns < MIN_USER_TURNS) return;
      // Avoid re-firing if nothing has changed since last fire
      if (userTurns === lastUserCountAtFireRef.current) return;
      fireSummaryViaBeacon(messagesRef.current);
      firedForCurrentTurnRef.current = true;
      lastUserCountAtFireRef.current = userTurns;
    }

    window.addEventListener("pagehide", handler);
    window.addEventListener("beforeunload", handler);
    return () => {
      window.removeEventListener("pagehide", handler);
      window.removeEventListener("beforeunload", handler);
    };
  }, []);
}

// ── Helpers ───────────────────────────────────────────────────────────

function countUserTurns(messages: UIMessage[]): number {
  return messages.filter(
    (m) => m.role === "user" && !m.pending && m.id !== "welcome" && m.text?.trim(),
  ).length;
}

function buildPayload(messages: UIMessage[]): { history: ChatTurn[] } {
  return { history: buildConversationHistory(messages, 24) };
}

/**
 * Idle-time fire. Uses fetch + keepalive so the request survives if
 * the user closes the tab a second after the timer fires.
 */
function fireSummary(reason: "idle", messages: UIMessage[]): void {
  try {
    const payload = JSON.stringify(buildPayload(messages));
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => {
      // Swallowed — passive memory write, not user-visible.
    });
    if (process.env.NODE_ENV === "development") {
      console.debug(`[memory] session-end summary requested (${reason})`);
    }
  } catch {
    // ignore
  }
}

/**
 * Tab-close fire. sendBeacon is the only API that reliably ships a
 * POST during page teardown. We accept its constraints (no auth headers
 * to set manually — cookies are still attached, no response inspection).
 */
function fireSummaryViaBeacon(messages: UIMessage[]): void {
  try {
    if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") {
      // Fallback: best-effort fetch with keepalive. Won't always make
      // it on a hard close, but it's better than nothing.
      void fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(messages)),
        keepalive: true,
      }).catch(() => {});
      return;
    }
    const blob = new Blob([JSON.stringify(buildPayload(messages))], {
      type: "application/json",
    });
    navigator.sendBeacon(ENDPOINT, blob);
  } catch {
    // ignore
  }
}
