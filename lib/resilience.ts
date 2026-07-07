/**
 * lib/resilience.ts — provider-agnostic timeout + retry + circuit breaker.
 *
 * WHY THIS EXISTS (root cause D5)
 *   Every outbound call in the app used to reinvent (or skip) resilience.
 *   Circle had a good pattern (`lib/circle.ts` — timeout race, exponential
 *   backoff, breaker) but it was Circle-coupled and its breaker was a single
 *   MODULE-GLOBAL pair of variables: one flaky provider could trip the
 *   breaker for an unrelated one. OpenRouter had a bare 30s abort and no
 *   retry (→ F-1/F-2: 30–50s hangs, no fast friendly fail). ANS and
 *   embeddings had nothing.
 *
 *   This module lifts the Circle pattern out into a generic wrapper with a
 *   PER-KEY breaker, so an OpenRouter outage can't trip the embeddings or
 *   ANS breaker. Circle keeps its own copy for now (it works, and its
 *   read/write split is money-safety-critical); new sites use this.
 *
 * TYPED ERRORS (composes with D3 / lib/errors.ts)
 *   A timeout throws `AppError("TIMEOUT")`; an open breaker or exhausted
 *   retries throws `AppError("NETWORK")` (or "SERVER_ERROR" if the last
 *   error looked like a 5xx). Callers already branching on `appErr.retryable`
 *   (interpret / confirm-policy pre-resolve) get the right behavior for free.
 *
 * SAFETY
 *   Like Circle: retries are for IDEMPOTENT reads only. `retries: 0` (the
 *   default) makes this a timeout+breaker wrapper with no re-invocation —
 *   safe for any call. Only opt into retries where re-running the fn has no
 *   side effect (LLM interpret, embeddings, name resolution — all read-only).
 */

import "server-only";
import { AppError, type ErrorCode } from "./errors";

// ── Shared transient-error matcher ─────────────────────────────────────
// Same shape as Circle's RETRYABLE. Numeric HTTP codes require an
// HTTP/status prefix so a bare "500" in prose isn't treated as a 5xx
// (mirrors the D3 tightening in errors.ts / friendly-errors.ts).
export const TRANSIENT_ERROR =
  /socket hang up|ECONNRESET|ETIMEDOUT|ECONNREFUSED|timed out|timeout|fetch failed|network|EAI_AGAIN|ENOTFOUND|(?:HTTP|status(?:\s*code)?)\s*50[234]\b/i;

export function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return TRANSIENT_ERROR.test(msg);
}

// ── Per-key circuit breaker ────────────────────────────────────────────
// One state cell per breakerKey, created on first use. This is the crucial
// difference from Circle's global singleton: keys are isolated, so
// "openrouter" tripping does not fail-fast "embeddings" or "ans".

type BreakerState = { consecutiveFailures: number; openUntil: number };
const breakers = new Map<string, BreakerState>();

function getBreaker(key: string): BreakerState {
  let b = breakers.get(key);
  if (!b) {
    b = { consecutiveFailures: 0, openUntil: 0 };
    breakers.set(key, b);
  }
  return b;
}

function circuitOpen(b: BreakerState): boolean {
  return Date.now() < b.openUntil;
}

function recordSuccess(b: BreakerState): void {
  b.consecutiveFailures = 0;
  b.openUntil = 0;
}

function recordFailure(b: BreakerState, key: string, threshold: number, cooldownMs: number): void {
  b.consecutiveFailures += 1;
  if (b.consecutiveFailures >= threshold) {
    b.openUntil = Date.now() + cooldownMs;
    b.consecutiveFailures = 0;
    console.warn(`[resilience:${key}] circuit breaker OPEN for ${cooldownMs}ms`);
  }
}

/** Testing/ops hook — clear all breaker state (used by the logic harness). */
export function _resetBreakers(): void {
  breakers.clear();
}

// ── Timeout race ───────────────────────────────────────────────────────
// A plain Promise.race with a cleared timer. We deliberately do NOT wire an
// AbortController here — not every fn accepts a signal, and a timeout that
// abandons a hung socket is exactly what we want (the breaker + GC handle
// the rest). Sites that CAN abort (fetch) still pass their own signal.

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AppError("TIMEOUT", `${label} timed out after ${ms}ms`, { retryable: true })),
      ms,
    );
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ── The wrapper ────────────────────────────────────────────────────────

export interface ResilienceOptions {
  /** Human-readable label for logs (e.g. "openrouter/interpret"). */
  label: string;
  /**
   * Breaker bucket. Sites that share an upstream MUST share a key so they
   * trip together (e.g. all OpenRouter calls → "openrouter"). Defaults to
   * `label` if omitted, which gives each call site its own breaker.
   */
  breakerKey?: string;
  /** Per-attempt timeout. Default 15s (interactive) — tune per site. */
  timeoutMs?: number;
  /**
   * Number of RE-tries after the first attempt. 0 = one attempt, no retry
   * (safe default for any call). Only raise for idempotent reads.
   */
  retries?: number;
  /** Base backoff; attempt N waits base * 2^(N-1). Default 500ms. */
  backoffBaseMs?: number;
  /**
   * Decide whether a caught error is worth retrying / should count toward
   * the breaker as transient. Defaults to the shared `isTransientError`.
   * ANS passes `isTransientRpcError` (ethers-code aware).
   */
  isRetryable?: (err: unknown) => boolean;
  /** Consecutive failures before the breaker opens. Default 4. */
  breakerThreshold?: number;
  /** How long the breaker stays open. Default 30s. */
  breakerCooldownMs?: number;
  /**
   * Error code thrown when the breaker is open or retries are exhausted.
   * Default "NETWORK". A site can pass "AGENT_INTERPRET_FAILED" etc. so the
   * downstream friendlyError copy is right.
   */
  failCode?: ErrorCode;
}

/**
 * Run `fn` with a timeout, optional retries on transient failure, and a
 * per-key circuit breaker. On terminal failure throws a typed `AppError`.
 *
 * A NON-transient error (per `isRetryable`) is rethrown immediately and
 * still counts as a breaker failure — a definitive upstream error (a 400, a
 * contract revert) is a real failure, just not one worth retrying.
 */
export async function withResilience<T>(
  fn: (attempt: number) => Promise<T>,
  opts: ResilienceOptions,
): Promise<T> {
  const {
    label,
    breakerKey = label,
    timeoutMs = 15_000,
    retries = 0,
    backoffBaseMs = 500,
    isRetryable = isTransientError,
    breakerThreshold = 4,
    breakerCooldownMs = 30_000,
    failCode = "NETWORK",
  } = opts;

  const breaker = getBreaker(breakerKey);
  if (circuitOpen(breaker)) {
    throw new AppError(failCode, `${label} is temporarily unavailable — please try again in a moment.`, {
      retryable: true,
      context: { breakerKey, breakerOpen: true },
    });
  }

  const maxAttempts = retries + 1;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await withTimeout(fn(attempt), timeoutMs, label);
      recordSuccess(breaker);
      return result;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[resilience:${breakerKey}] ${label} attempt ${attempt}/${maxAttempts} failed: ${msg}`);

      // A definitive (non-transient) failure: don't waste retries, but DO
      // count it — a hard upstream error is still an upstream failure.
      if (!isRetryable(err)) {
        recordFailure(breaker, breakerKey, breakerThreshold, breakerCooldownMs);
        // Preserve an already-typed error (e.g. AppError from ANS) verbatim
        // so its code/retryable survive; wrap anything else.
        if (err instanceof AppError) throw err;
        throw new AppError(failCode, msg, { retryable: false, cause: err });
      }

      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, backoffBaseMs * 2 ** (attempt - 1)));
      }
    }
  }

  // Exhausted retries on a transient error → open-eligible failure.
  recordFailure(breaker, breakerKey, breakerThreshold, breakerCooldownMs);
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  console.error(`[resilience:${breakerKey}] ${label} exhausted ${maxAttempts} attempt(s):`, msg);
  // If the last error was itself a typed AppError (e.g. our own TIMEOUT),
  // surface it — it already carries the right code + retryable.
  if (lastErr instanceof AppError) throw lastErr;
  const code: ErrorCode = /(?:HTTP|status(?:\s*code)?)\s*5\d{2}\b|server error/i.test(msg)
    ? "SERVER_ERROR"
    : failCode;
  throw new AppError(code, msg || `${label} failed`, { retryable: true, cause: lastErr });
}
