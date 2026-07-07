/**
 * friendly-errors.ts
 *
 * Translates raw error messages from Circle, Supabase, OpenRouter, ethers,
 * fetch, etc. into copy that doesn't leak product internals to the user.
 *
 * Two entrypoints:
 *   - friendlyError(unknown)         → string for any thrown value
 *   - friendlyApiError(res, fallback) → string for a non-OK fetch Response
 *
 * Adding a new mapping: append to PATTERNS. Order matters — first match wins.
 *
 * Companion: `lib/errors.ts` defines the typed `AppError` class with codes.
 * When `friendlyError` is given an `AppError`, it uses the curated per-code
 * copy below and skips the regex matcher.
 */

import { isAppError, type ErrorCode } from "./errors";

type Pattern = {
  // Either a regex or a substring (case-insensitive).
  match: RegExp | string;
  // Friendly replacement. Supports `(text)` capture groups via $1.
  replace: string;
};

// ── Mappings ─────────────────────────────────────────────────────────
// Specific patterns first (e.g. invalid PIN), generic ones last.
const PATTERNS: Pattern[] = [
  // ── Auth / Supabase ────────────────────────────────────────────────
  { match: /invalid login credentials/i,        replace: "That doesn't look right. Try again or request a new code." },
  { match: /invalid.*one[- ]?time.*password/i,  replace: "That code is wrong or expired. Try requesting a new one." },
  { match: /token.*expired|otp.*expired|expired token/i, replace: "Your code expired. Request a fresh one." },
  { match: /email.*not.*confirmed/i,            replace: "Please confirm your email first — check your inbox." },
  { match: /rate ?limit|too many requests|(?:HTTP|status(?:\s*code)?)\s*429/i,replace: "Too many tries — please wait a minute and try again." },
  { match: /user.*not.*found|no.*user.*found/i, replace: "We couldn't find an account for that email." },
  { match: /bad_oauth_state|oauth state/i,      replace: "Sign-in timed out. Close any extra tabs and try again." },
  // PKCE verifier in storage went missing — typical causes: started flow in
  // one tab and finished in another, browser cleared cookies between leaving
  // and returning, or the user took >10 minutes to complete Google.
  { match: /pkce.*code.*verifier|code.*verifier.*not found|code.*verifier.*storage/i,
    replace: "Your sign-in window expired. Please start again." },
  // Supabase returns this when a code is exchanged twice (refresh on
  // /auth/callback, double-fetch by some bot, etc). The route handler tries
  // to recover silently; this string only ever surfaces when no session
  // already exists.
  { match: /state.*already.*used|code.*already.*exchanged|invalid.*flow.*state/i,
    replace: "Sign-in was already completed in another tab. Please refresh." },

  // ── Circle / wallet PIN ────────────────────────────────────────────
  { match: /pin.*incorrect|wrong.*pin|invalid.*pin/i, replace: "That PIN is wrong. Try again." },
  { match: /pin.*locked|too many.*pin|pin.*attempts/i, replace: "PIN entry is locked for security. Wait a moment, then try again." },
  { match: /challenge.*expired|challenge.*not.*found/i, replace: "This action timed out. Please start again." },
  { match: /user.*token.*invalid|user token.*expired/i, replace: "Your session expired. Please refresh the page." },
  { match: /entity.*secret|secret.*ciphertext/i, replace: "Something went wrong on our side. Please try again." },
  { match: /circle.*api|circle.*sdk|w3s/i,      replace: "Wallet service is unreachable right now. Please try again." },

  // ── Insufficient funds / on-chain ──────────────────────────────────
  { match: /insufficient.*funds|insufficient.*balance|not enough.*balance/i, replace: "You don't have enough USDC to cover this transfer." },
  { match: /gas.*required|out of gas/i,         replace: "Network fee couldn't be covered. Please try again." },
  { match: /nonce.*too.*(low|high)|replacement.*underpriced/i, replace: "The previous transaction is still confirming. Please wait a moment." },
  { match: /reverted|execution reverted/i,      replace: "The transaction was rejected by the network. Double-check the recipient and amount." },

  // ── Recipient resolution ───────────────────────────────────────────
  { match: /name.*not.*registered|name.*not.*found|no.*owner/i, replace: "That .arc name isn't registered." },
  { match: /invalid.*address|invalid.*recipient/i, replace: "That recipient address looks invalid." },
  { match: /self[- ]?send|cannot.*send.*to.*self/i, replace: "You can't send to your own wallet." },

  // ── Agent / LLM ────────────────────────────────────────────────────
  { match: /AI interpretation failed|OPENROUTER_API_KEY/i, replace: "Hey buddy, feeling a bit sick right now — I'll get back to you once I recover. Try again in a moment." },
  { match: /openrouter|anthropic|llm|language model|model.*returned/i, replace: "I'm having trouble understanding that. Try rephrasing it." },
  { match: /could not interpret|cannot interpret|unknown.*instruction/i, replace: "I couldn't understand that instruction. Try rephrasing it." },
  { match: /agent.*not.*activated|activate.*agent.*first|agent.*not.*found/i, replace: "Activate your Smart Agent before using this feature." },
  { match: /policy.*not.*found|policy.*expired/i, replace: "That automation no longer exists. Refresh and try again." },
  { match: /limit.*exceeded|over.*limit|exceeds.*limit|max.*per.*(transaction|day|month)/i, replace: "This would exceed your spending limit. Adjust the amount or update your limits." },
  { match: /no.*pin.*set|pin.*not.*set|set.*pin.*first/i, replace: "Set your agent PIN before continuing." },
  { match: /preflight.*resolve|cannot.*resolve.*recipient/i, replace: "We couldn't find that recipient. Double-check the .arc name or address." },
  { match: /no.*tasks|empty.*tasks|tasks.*empty/i, replace: "I couldn't turn that into an action. Try rephrasing it." },
  { match: /step \d+: bad \$prev/i, replace: "One step depended on a previous result that wasn't available. Try rephrasing the request." },

  // ── Activation / onboarding ────────────────────────────────────────
  { match: /activation failed|failed to activate/i, replace: "Couldn't activate the agent. Please try again." },
  { match: /failed to set pin|pin.*could not be set/i, replace: "We couldn't save your PIN. Please try again." },
  { match: /failed to save limits|limits.*could not be saved/i, replace: "We couldn't save those limits. Please try again." },
  { match: /failed to prepare funding|funding.*could not be prepared/i, replace: "We couldn't prepare the funding transfer. Please try again." },
  { match: /pin must be.*digits|enter your.*digit.*pin/i, replace: "PIN must be 4–8 digits." },
  { match: /pins do not match|pin.*mismatch/i, replace: "Those PINs don't match. Please re-enter." },
  { match: /limits must be positive|positive numbers?/i, replace: "All limits must be positive numbers." },
  { match: /enter a valid amount|valid amount/i, replace: "Please enter a valid amount." },

  // ── Cancel policy / withdraw ───────────────────────────────────────
  { match: /cancel.*failed|cancellation.*failed/i, replace: "Couldn't cancel that automation. Please try again." },
  { match: /withdrawal.*failed|withdraw.*failed/i, replace: "The withdrawal didn't go through. Please try again." },

  // ── Name registration ──────────────────────────────────────────────
  { match: /name.*already.*taken|name.*registered|name.*in use/i, replace: "That .arc name is already taken. Try another." },
  { match: /name.*too short|name.*too long|invalid.*name/i, replace: "That .arc name isn't valid. Use 3–20 lowercase letters, numbers, or hyphens." },
  { match: /registration failed|register.*failed/i, replace: "Name registration didn't go through. Please try again." },

  // ── Wallet / session ───────────────────────────────────────────────
  { match: /backend can't see it|wallet was created but/i, replace: "Your wallet was created but our backend can't see it yet. Refresh in a few seconds." },
  { match: /session returned \d+|session expired/i, replace: "Your session expired. Please refresh the page." },
  { match: /init-user returned \d+/i, replace: "Couldn't start sign-in. Please try again." },
  { match: /challenge cancelled|wallet creation cancelled|transaction failed|transaction error/i, replace: "That action was cancelled. Please try again." },

  // ── Network / generic fetch ────────────────────────────────────────
  { match: /failed to fetch|networkerror|network.*error|fetch.*failed/i, replace: "Network hiccup — check your connection and try again." },
  { match: /timeout|timed out|etimedout/i,      replace: "That took too long. Please try again." },
  { match: /econnreset|socket.*hang up|connection.*reset/i, replace: "Connection dropped. Please try again." },
  { match: /aborted|cancel/i,                   replace: "Cancelled." },

  // ── HTTP status codes (only when nothing more specific hit) ────────
  // Numeric codes require an HTTP/status prefix so a bare 3-digit number in a
  // legitimate message (e.g. "Instruction too long (max 500 chars)", "sent 550
  // USDC") is NOT rewritten. Word alternates still catch real HTTP errors.
  { match: /(?:HTTP|status(?:\s*code)?)\s*401\b|unauthori[sz]ed/i, replace: "Please sign in again." },
  { match: /(?:HTTP|status(?:\s*code)?)\s*403\b|forbidden/i,       replace: "You don't have access to do that." },
  { match: /(?:HTTP|status(?:\s*code)?)\s*404\b|not found/i,       replace: "We couldn't find that." },
  { match: /(?:HTTP|status(?:\s*code)?)\s*5\d{2}\b|server error/i, replace: "Our servers are having a moment. Please try again." },
];

const DEFAULT_FALLBACK = "Something went wrong. Please try again.";

// Curated copy per typed error code. When friendlyError is given an
// AppError, we use this table instead of running the regex matcher —
// the code has already done the classification work.
const APP_ERROR_COPY: Record<ErrorCode, string> = {
  // Auth
  AUTH_INVALID_CODE: "That code is wrong or expired. Try requesting a new one.",
  AUTH_RATE_LIMIT: "Too many tries — please wait a minute and try again.",
  AUTH_OAUTH_STATE: "Sign-in timed out. Close any extra tabs and try again.",
  AUTH_NETWORK: "Couldn't reach the sign-in service. Check your connection.",
  AUTH_FAILED: "Sign-in didn't complete. Please try again.",

  // PIN / Circle
  PIN_WRONG: "That PIN is wrong. Try again.",
  PIN_LOCKED: "PIN entry is locked for security. Wait a moment, then try again.",
  PIN_NOT_SET: "Set your agent PIN before continuing.",
  CHALLENGE_CANCELLED: "That action was cancelled. Please try again.",
  CHALLENGE_TIMEOUT: "PIN confirmation timed out. Please try again.",
  CIRCLE_UNAVAILABLE: "Wallet service is unreachable right now. Please try again.",
  WALLET_NOT_READY: "Your wallet was created but our backend can't see it yet. Refresh in a few seconds.",

  // Sends
  INSUFFICIENT_FUNDS: "You don't have enough USDC to cover this transfer.",
  RECIPIENT_NOT_FOUND: "We couldn't find that recipient. Double-check the .arc name or address.",
  SELF_SEND: "You can't send to your own wallet.",
  TX_REVERTED: "The transaction was rejected by the network. Double-check the recipient and amount.",
  TX_UNCERTAIN: "Connection dropped while confirming. Your transfer may still have gone through — check your activity feed before retrying.",

  // Agent
  AGENT_NOT_ACTIVATED: "Activate your Smart Agent before using this feature.",
  AGENT_LIMIT_EXCEEDED: "This would exceed your spending limit. Adjust the amount or update your limits.",
  AGENT_INTERPRET_FAILED: "Hey buddy, feeling a bit sick right now — I'll get back to you once I recover. Try again in a moment.",
  AGENT_UNDERSTANDING: "I couldn't understand that instruction. Try rephrasing it.",
  POLICY_NOT_FOUND: "That automation no longer exists. Refresh and try again.",

  // Transport
  OFFLINE: "You're offline. Reconnect and try again.",
  TIMEOUT: "That took too long. Please try again.",
  NETWORK: "Network hiccup — check your connection and try again.",

  // HTTP
  UNAUTHORIZED: "Please sign in again.",
  FORBIDDEN: "You don't have access to do that.",
  NOT_FOUND: "We couldn't find that.",
  SERVER_ERROR: "Our servers are having a moment. Please try again.",
  BAD_REQUEST: "That request couldn't be processed. Please check and try again.",

  UNKNOWN: DEFAULT_FALLBACK,
};

/**
 * Convert any thrown value into user-facing copy.
 *
 * @param err     The error (Error, string, or anything thrown).
 * @param fallback Custom fallback if no pattern matches.
 */
export function friendlyError(err: unknown, fallback = DEFAULT_FALLBACK): string {
  // Fast path: typed errors carry their own curated copy via `code`.
  // Prefer the explicit message on the AppError if it has been customized,
  // otherwise fall back to the per-code default.
  if (isAppError(err)) {
    if (err.message && err.message !== err.code) return err.message;
    return APP_ERROR_COPY[err.code] ?? fallback;
  }

  if (err === null || err === undefined) return fallback;

  // Extract a usable string. We deliberately avoid String(err) on objects
  // because that produces "[object Object]".
  let raw = "";
  if (typeof err === "string") {
    raw = err;
  } else if (err instanceof Error) {
    raw = err.message;
  } else if (typeof err === "object" && err) {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string") raw = obj.message;
    else if (typeof obj.error === "string") raw = obj.error;
    else if (typeof obj.code === "string") raw = obj.code;
    // If still empty, do NOT stringify the object — that's how
    // "[object Object]" or huge JSON dumps end up on the UI.
  } else if (typeof err === "number" || typeof err === "boolean") {
    raw = String(err);
  }

  // Last-resort sanity check — anything that smells like an unhelpful
  // default string should fall back instead of leaking.
  if (
    !raw ||
    raw === "[object Object]" ||
    raw === "undefined" ||
    raw === "null" ||
    raw.trim() === ""
  ) {
    return fallback;
  }

  for (const p of PATTERNS) {
    if (typeof p.match === "string") {
      if (raw.toLowerCase().includes(p.match.toLowerCase())) return p.replace;
    } else {
      if (p.match.test(raw)) return raw.replace(p.match, p.replace);
    }
  }

  // No pattern hit. If the raw message is short and clean, surface it.
  // Otherwise show the fallback so we never expose stack traces or
  // operational identifiers (UUIDs, hex strings, trace IDs).
  const looksLikeNoise =
    /[<>{}]|stack|at \w+|trace=|0x[0-9a-f]{8,}|[0-9a-f]{8}-[0-9a-f]{4}/i.test(raw);
  if (raw.length < 120 && !looksLikeNoise) {
    // Strip any trailing parenthesized status code like "(401)".
    return raw.replace(/\s*\(\s*\d{3}\s*\)\s*$/, "").trim();
  }

  return fallback;
}

/**
 * Friendly message for a non-OK fetch Response. Reads `{ error }` from JSON
 * if present; falls back to the status code mapping.
 */
export async function friendlyApiError(
  res: Response,
  fallback = DEFAULT_FALLBACK
): Promise<string> {
  let serverMsg = "";
  try {
    const data = await res.clone().json();
    if (data && typeof data === "object" && typeof data.error === "string") {
      serverMsg = data.error;
    }
  } catch {
    // body wasn't JSON — that's fine
  }
  if (serverMsg) return friendlyError(serverMsg, fallback);
  return friendlyError(`HTTP ${res.status}`, fallback);
}
