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
 */

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
  { match: /rate ?limit|too many requests|429/i,replace: "Too many tries — please wait a minute and try again." },
  { match: /user.*not.*found|no.*user.*found/i, replace: "We couldn't find an account for that email." },
  { match: /bad_oauth_state|oauth state/i,      replace: "Sign-in timed out. Close any extra tabs and try again." },

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
  { match: /openrouter|claude|anthropic|llm|language model|model.*returned/i, replace: "I'm having trouble understanding that. Try rephrasing it." },
  { match: /agent.*not.*activated|activate.*agent.*first/i, replace: "Activate your Smart Agent before using this feature." },
  { match: /policy.*not.*found|policy.*expired/i, replace: "That automation no longer exists. Refresh and try again." },
  { match: /limit.*exceeded|over.*limit|exceeds.*limit/i, replace: "This would exceed your spending limit. Adjust the amount or update your limits." },

  // ── Network / generic fetch ────────────────────────────────────────
  { match: /failed to fetch|networkerror|network.*error|fetch.*failed/i, replace: "Network hiccup — check your connection and try again." },
  { match: /timeout|timed out|etimedout/i,      replace: "That took too long. Please try again." },
  { match: /econnreset|socket.*hang up|connection.*reset/i, replace: "Connection dropped. Please try again." },
  { match: /aborted|cancel/i,                   replace: "Cancelled." },

  // ── HTTP status codes (only when nothing more specific hit) ────────
  { match: /\b401\b|unauthori[sz]ed/i,          replace: "Please sign in again." },
  { match: /\b403\b|forbidden/i,                replace: "You don't have access to do that." },
  { match: /\b404\b|not found/i,                replace: "We couldn't find that." },
  { match: /\b5\d{2}\b|server error/i,          replace: "Our servers are having a moment. Please try again." },
];

const DEFAULT_FALLBACK = "Something went wrong. Please try again.";

/**
 * Convert any thrown value into user-facing copy.
 *
 * @param err     The error (Error, string, or anything thrown).
 * @param fallback Custom fallback if no pattern matches.
 */
export function friendlyError(err: unknown, fallback = DEFAULT_FALLBACK): string {
  if (!err) return fallback;
  const raw =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : typeof err === "object" && err && "message" in err && typeof (err as { message?: unknown }).message === "string"
          ? (err as { message: string }).message
          : "";

  if (!raw) return fallback;

  for (const p of PATTERNS) {
    if (typeof p.match === "string") {
      if (raw.toLowerCase().includes(p.match.toLowerCase())) return p.replace;
    } else {
      if (p.match.test(raw)) return raw.replace(p.match, p.replace);
    }
  }

  // No pattern hit. If the raw message is short and clean, surface it.
  // Otherwise show the fallback so we never expose stack traces.
  if (raw.length < 120 && !/[<>{}]|stack|at \w+/i.test(raw)) {
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
