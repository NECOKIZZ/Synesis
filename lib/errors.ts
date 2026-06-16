/**
 * errors.ts
 *
 * Typed error contract for the DotArc app.
 *
 * Every error that flows through the app can be classified into one of the
 * `ErrorCode` values below. Code that catches an error can then decide
 * programmatically whether to retry, what UI to show, or how to recover —
 * instead of doing fragile string matching on `err.message`.
 *
 * Companion to `friendly-errors.ts`:
 *   - `errors.ts`           → classifies + carries a code (this file)
 *   - `friendly-errors.ts`  → renders a human-readable string
 *
 * Usage:
 *   // Throwing a typed error
 *   throw new AppError("PIN_WRONG", "That PIN is wrong");
 *
 *   // Normalizing anything caught
 *   try { ... } catch (e) {
 *     const err = toAppError(e);
 *     if (err.retryable) { ...retry... }
 *     showToast(err.message);
 *   }
 */

// ── Codes ─────────────────────────────────────────────────────────────
// Keep this list small and orthogonal. Add a new code when there's a
// distinct UI reaction or retry strategy associated with it, not just for
// a new error message.

export type ErrorCode =
  // ── Auth / sign-in ────────────────────────────────────────────────
  | "AUTH_INVALID_CODE"      // wrong OTP / expired magic link
  | "AUTH_RATE_LIMIT"        // too many OTP requests
  | "AUTH_OAUTH_STATE"       // Google sign-in state expired / mismatched
  | "AUTH_NETWORK"           // network failure during auth
  | "AUTH_FAILED"            // generic auth failure

  // ── Wallet / Circle ───────────────────────────────────────────────
  | "PIN_WRONG"              // user typed the wrong PIN
  | "PIN_LOCKED"             // too many wrong PIN attempts
  | "PIN_NOT_SET"            // user hasn't set their agent PIN yet
  | "CHALLENGE_CANCELLED"    // user closed the Circle PIN dialog
  | "CHALLENGE_TIMEOUT"      // Circle PIN dialog timed out
  | "CIRCLE_UNAVAILABLE"     // Circle API / SDK failure
  | "WALLET_NOT_READY"       // wallet creation eventual-consistency window

  // ── Sends / on-chain ──────────────────────────────────────────────
  | "INSUFFICIENT_FUNDS"
  | "RECIPIENT_NOT_FOUND"    // .arc name unregistered or address invalid
  | "SELF_SEND"              // sending to your own wallet
  | "TX_REVERTED"            // on-chain revert
  | "TX_UNCERTAIN"           // connection dropped after submit — state unknown

  // ── Agent ─────────────────────────────────────────────────────────
  | "AGENT_NOT_ACTIVATED"
  | "AGENT_LIMIT_EXCEEDED"   // would exceed spending limit
  | "AGENT_INTERPRET_FAILED" // LLM / OpenRouter unavailable or returned junk
  | "AGENT_UNDERSTANDING"    // model returned but no actionable tasks
  | "POLICY_NOT_FOUND"       // automation doesn't exist anymore

  // ── Transport ─────────────────────────────────────────────────────
  | "OFFLINE"                // navigator.onLine === false
  | "TIMEOUT"                // request exceeded its deadline
  | "NETWORK"                // generic fetch / connection failure

  // ── HTTP ──────────────────────────────────────────────────────────
  | "UNAUTHORIZED"           // 401
  | "FORBIDDEN"              // 403
  | "NOT_FOUND"              // 404
  | "SERVER_ERROR"           // 5xx
  | "BAD_REQUEST"            // 4xx (other than the above)

  // ── Fallback ──────────────────────────────────────────────────────
  | "UNKNOWN";

// ── The error class ──────────────────────────────────────────────────

export interface AppErrorOptions {
  /**
   * Whether retrying this error has any chance of succeeding. Defaults
   * based on the `code` (network/timeouts/5xx are retryable; wrong PIN
   * and insufficient funds are not).
   */
  retryable?: boolean;
  /** The original thrown value, if any. Stored for debugging only. */
  cause?: unknown;
  /** Extra structured context (e.g. HTTP status, trace ID). */
  context?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly context?: Record<string, unknown>;
  // We deliberately don't use the native ES2022 `cause` field — TS lib
  // support varies. Store it as a plain property.
  readonly originalCause?: unknown;

  constructor(code: ErrorCode, message: string, opts: AppErrorOptions = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.retryable = opts.retryable ?? defaultRetryable(code);
    this.context = opts.context;
    this.originalCause = opts.cause;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

// ── Retryability defaults ────────────────────────────────────────────

function defaultRetryable(code: ErrorCode): boolean {
  switch (code) {
    // User-facing input errors — retrying without changes won't help.
    case "PIN_WRONG":
    case "PIN_LOCKED":
    case "PIN_NOT_SET":
    case "INSUFFICIENT_FUNDS":
    case "RECIPIENT_NOT_FOUND":
    case "SELF_SEND":
    case "AGENT_NOT_ACTIVATED":
    case "AGENT_LIMIT_EXCEEDED":
    case "UNAUTHORIZED":
    case "FORBIDDEN":
    case "NOT_FOUND":
    case "BAD_REQUEST":
    case "AUTH_INVALID_CODE":
    case "SELF_SEND" as ErrorCode:
      return false;

    // State unknown — let the user decide; don't auto-retry.
    case "TX_UNCERTAIN":
    case "CHALLENGE_CANCELLED":
      return false;

    // Transient — safe to retry.
    case "OFFLINE":
    case "TIMEOUT":
    case "NETWORK":
    case "SERVER_ERROR":
    case "CIRCLE_UNAVAILABLE":
    case "AGENT_INTERPRET_FAILED":
    case "WALLET_NOT_READY":
    case "CHALLENGE_TIMEOUT":
    case "AUTH_NETWORK":
    case "AUTH_RATE_LIMIT":
    case "AUTH_OAUTH_STATE":
      return true;

    default:
      return false;
  }
}

// ── Normalization: unknown → AppError ────────────────────────────────

/**
 * Classify an unknown thrown value into an `AppError`. Pattern-matches
 * on the underlying message to assign a code; falls back to UNKNOWN.
 *
 * Use this at the boundary of any catch block where you want typed
 * error handling, not for every internal throw.
 */
export function toAppError(err: unknown, fallbackCode: ErrorCode = "UNKNOWN"): AppError {
  if (isAppError(err)) return err;

  // Offline detection — works in browser. `globalThis.navigator` is used
  // (instead of bare `navigator`) so this file is safe to import in any
  // environment (server, worker, test).
  if (
    typeof globalThis !== "undefined" &&
    typeof globalThis.navigator !== "undefined" &&
    globalThis.navigator.onLine === false
  ) {
    return new AppError("OFFLINE", "You're offline. Reconnect and try again.", { cause: err });
  }

  const raw = extractRawMessage(err);
  const code = classifyMessage(raw, fallbackCode);
  return new AppError(code, raw || fallbackMessage(code), { cause: err });
}

function extractRawMessage(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.code === "string") return obj.code;
  }
  return "";
}

// Order matters: most specific first. This is parallel to (but smaller
// than) the pattern table in friendly-errors.ts — we only enumerate the
// codes here, the user-facing copy lives there.
const CLASSIFIERS: Array<{ test: RegExp; code: ErrorCode }> = [
  // Auth
  { test: /invalid.*one[- ]?time.*password|invalid.*otp|expired.*token|otp.*expired/i, code: "AUTH_INVALID_CODE" },
  { test: /rate ?limit|too many requests|\b429\b/i, code: "AUTH_RATE_LIMIT" },
  { test: /bad_oauth_state|oauth state/i, code: "AUTH_OAUTH_STATE" },

  // PIN / Circle
  { test: /pin.*locked|too many.*pin|pin.*attempts/i, code: "PIN_LOCKED" },
  { test: /pin.*incorrect|wrong.*pin|invalid.*pin/i, code: "PIN_WRONG" },
  { test: /no.*pin.*set|pin.*not.*set|set.*pin.*first/i, code: "PIN_NOT_SET" },
  { test: /pin confirmation timed out|challenge.*timed.*out/i, code: "CHALLENGE_TIMEOUT" },
  { test: /challenge.*cancelled|wallet creation cancelled/i, code: "CHALLENGE_CANCELLED" },
  { test: /circle.*api|circle.*sdk|w3s|entity.*secret/i, code: "CIRCLE_UNAVAILABLE" },
  { test: /backend can't see it|wallet was created but/i, code: "WALLET_NOT_READY" },

  // Sends
  { test: /insufficient.*funds|insufficient.*balance|not enough.*balance/i, code: "INSUFFICIENT_FUNDS" },
  { test: /name.*not.*registered|name.*not.*found|invalid.*address|invalid.*recipient/i, code: "RECIPIENT_NOT_FOUND" },
  { test: /self[- ]?send|cannot.*send.*to.*self/i, code: "SELF_SEND" },
  { test: /reverted|execution reverted/i, code: "TX_REVERTED" },
  { test: /connection dropped while confirming|may still have gone through/i, code: "TX_UNCERTAIN" },

  // Agent
  { test: /agent.*not.*activated|activate.*agent.*first|agent.*not.*found/i, code: "AGENT_NOT_ACTIVATED" },
  { test: /limit.*exceeded|over.*limit|exceeds.*limit|max.*per.*(transaction|day|month)/i, code: "AGENT_LIMIT_EXCEEDED" },
  { test: /AI interpretation failed|OPENROUTER_API_KEY|openrouter|anthropic|llm/i, code: "AGENT_INTERPRET_FAILED" },
  { test: /no.*tasks|empty.*tasks|could not interpret|cannot interpret/i, code: "AGENT_UNDERSTANDING" },
  { test: /policy.*not.*found|policy.*expired/i, code: "POLICY_NOT_FOUND" },

  // Transport
  { test: /failed to fetch|networkerror|network.*error|fetch.*failed|econnreset|socket.*hang up/i, code: "NETWORK" },
  { test: /timeout|timed out|etimedout|aborted/i, code: "TIMEOUT" },

  // HTTP
  { test: /\b401\b|unauthori[sz]ed/i, code: "UNAUTHORIZED" },
  { test: /\b403\b|forbidden/i, code: "FORBIDDEN" },
  { test: /\b404\b|not found/i, code: "NOT_FOUND" },
  { test: /\b5\d{2}\b|server error/i, code: "SERVER_ERROR" },
  { test: /\b4\d{2}\b|bad request/i, code: "BAD_REQUEST" },
];

function classifyMessage(raw: string, fallback: ErrorCode): ErrorCode {
  if (!raw) return fallback;
  for (const { test, code } of CLASSIFIERS) {
    if (test.test(raw)) return code;
  }
  return fallback;
}

function fallbackMessage(code: ErrorCode): string {
  switch (code) {
    case "OFFLINE": return "You're offline.";
    case "TIMEOUT": return "That took too long.";
    case "NETWORK": return "Network error.";
    case "SERVER_ERROR": return "Server error.";
    case "UNAUTHORIZED": return "Please sign in again.";
    case "FORBIDDEN": return "You don't have access to do that.";
    case "NOT_FOUND": return "Not found.";
    default: return "Something went wrong.";
  }
}
