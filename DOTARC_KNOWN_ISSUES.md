# DotArc — Known Issues & Architectural Debt

> Documented: 2026-05-27  
> Last updated: 2026-06-01  
> Status: Open items tracked below. Closed items removed once verified in production.

---

## 1. Missing cirBTC Contract Address

**Problem:** Circle App Kit chain definitions only expose `usdcAddress` and `eurcAddress` for Arc Testnet. `cirBTC` has no public contract address.

**Evidence:**
- `node_modules/@circle-fin/app-kit/chains.d.ts` → `ArcTestnet` has `eurcAddress` and `usdcAddress` only.
- `lib/skills/send-token.ts` hardcodes `CIRBTC: { address: null, alias: "cirBTC" }`
- `lib/skills/swap-usdc.ts` hardcodes `CIRBTC: { address: null, decimals: 8 }`

**Impact:**
- Main wallet cannot display cirBTC balance via public RPC (no address to query).
- Agent skill code falls back to Circle dev-wallet API (`getWalletTokenBalance`) which requires server-side API key.

**Workaround:** Leave `NEXT_PUBLIC_CIRBTC_TOKEN_ADDRESS=` blank in `.env`. Wallet gracefully skips it.

**Fix needed:** Get official Arc Testnet cirBTC contract address from Circle, then fill the env var.

---

## 2. Task Type Hierarchy Is Flat (Architectural)

**Problem:** `task_type` is a single enum: `"compound" | "recurring" | "conditional" | "immediate"`. This forces every task into one bucket, making it impossible to express a compound plan where some steps are immediate and others are scheduled.

**Evidence:**
- Complex test case: *"swap all EURC to USDC, send half to cryptolympus on Friday, withdraw remaining half instantly"*
- LLM returned `task_type: "compound"` with all steps immediate. "on Friday" was only in description text, not actionable.

**Root cause:** The data model assumes:
- Compound = all immediate
- Recurring = single scheduled action
- Never the two shall mix

**Correct model (when fixed):**
```
task_type: "compound" | "simple"
  compound_steps: Array<{
    skill: string;
    params: object;
    execution_mode: "immediate" | "recurring" | "conditional";
    schedule?: ScheduleConfig;
    condition?: ConditionConfig;
  }>
```

**Files to change when fixed:**
- `lib/agent-types.ts` — add `execution_mode` to `PlanStep`
- `app/api/agent/confirm-policy/route.ts` — route each step to right executor
- `lib/agent-core.ts` — update prompt to tag each step with mode
- `app/wallet/wallet-shell.tsx` (AgentTab) — render mixed timelines

**Status:** Acknowledged. Not urgent — flat model covers 90%+ of real usage.

---

<!-- Issue 3 (Main Wallet Activity Not Captured) FIXED 2026-06-01.
     Path B implemented: new wallet_transactions table (migration 0008),
     send-prepare writes PENDING rows, Circle webhook claims them on
     CLEARED state. Activity tab unifies wallet_transactions and
     agent_spend_log via /api/wallet/activity. -->


<!-- Issue 4 (Agent Partial Balance Prompt) FIXED 2026-05-27. -->


## 5. Time Constraints Silently Dropped in Compound Tasks

**Problem:** When a compound instruction mixes scheduling ("on Friday") with immediacy ("instantly"), the LLM ignores the scheduling constraint and marks everything immediate.

**Evidence:**
- Complex test case: `complex-swap-split.json`
- Result: all 3 steps had `task_type: "compound"` (implicit immediate). "on Friday" only appeared in description text.

**Relation to Issue #2:** This is a symptom of the flat hierarchy. The LLM has no valid bucket for "compound + recurring", so it silently downgrades to compound immediate.

**Status:** Will resolve when Issue #2 is fixed.

---

<!-- Issue 6 (Main Wallet Only Showed USDC) FIXED 2026-05-27. -->


<!-- Issue 7 (Activity Page Incomplete) FIXED 2026-06-01.
     Same fix as Issue 3 — unified feed via /api/wallet/activity merges
     main wallet rows (wallet_transactions) with agent rows
     (agent_spend_log) and badges each by source. -->


## 8. Agent Confirm-Policy Endpoint Logging Overgrowth

**Problem:** Trace ID logging was added extensively to `confirm-policy` and `interpret` routes for debugging. Some logs may expose internal state (e.g., parsed request body before PIN sanitization).

**Evidence:**
- `app/api/agent/confirm-policy/route.ts` logs `parsed` body directly.
- Security rules say: *"NEVER log Circle userToken, encryptionKey, JWT_SECRET, or full Circle API responses"*

**Mitigation:** Logs are development-only. Before production, audit all `console.log` in agent routes.

**Status:** Cleanup needed before mainnet.

---

## Summary Table (Open items only)

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | Missing cirBTC address | Medium | Blocked (need Circle) |
| 2 | Flat task type hierarchy | Medium | Acknowledged, deferred |
| 5 | Time constraints dropped | Medium | Blocked by #2 |
| 8 | Debug logging cleanup | Low | Pre-production task |
| 9 | Auth loop-prevention hardening | High | Open |
| 10 | Supabase email template mismatch | Critical | Needs Supabase dashboard fix |
| 11 | Mobile layout / send button breakpoint | Medium | Open |
| 12 | Ineffective responsiveness (breakpoints) | Medium | Open |
| 14 | Loading buttons feel ineffective (local) | Low | Environment, not code |
| 15 | Inadequate error handling coverage | Critical | Open |
| 17 | Send modal: no tx hash returned by Circle SDK → "View transaction" button missing | Medium | Open |
| 18 | Send modal: no completion sound + entrance animation | Low | Open |

---

## 9. OTP Auth-Failure Loop — Resilience Guard Still Needed

**Problem:** The original CSRF-induced 403 loop is fixed (deploy with `NEXT_PUBLIC_APP_URL` set, plus webhook routes now exempt from CSRF). But the underlying race — `AuthGate` remount detects the still-live Supabase session and auto-fires `onVerified` again — is still possible if any server endpoint starts returning 403 unexpectedly.

**Fix needed (code):**
- `logout()` in `circle-wallet-context.tsx` should call `supabase.auth.signOut()` client-side so `AuthGate` finds no session on remount
- Or add a `signOutAttempted` flag to `AuthGate` to skip auto-detection once

**Status:** Original CSRF symptom fixed. Loop-prevention hardening still pending.

---

## 10. Supabase Email Template Mismatch — Magic Link vs 6-Digit OTP

**Problem:** The UI promises "We sent a 6-digit code" and renders a 6-digit numeric input. But Supabase's default `signInWithOtp` email template sends `{{ .ConfirmationURL }}` (a clickable magic link), not `{{ .Token }}` (a 6-digit code). Users receive a link in their inbox with nothing to type into the code box.

**Evidence:**
- `auth-gate.tsx:124` calls `supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } })`
- `auth-gate.tsx:145` verifies with `supabase.auth.verifyOtp({ email, token: code, type: "email" })`
- Supabase Auth → Email Templates → Magic Link template uses `{{ .ConfirmationURL }}` by default

**Fix needed (Supabase dashboard):**
1. Go to Supabase Dashboard → Authentication → Email Templates → Magic Link
2. Change template body to reference `{{ .Token }}` instead of `{{ .ConfirmationURL }}`
3. Or switch to "Email OTP" template if Supabase project supports it

**Status:** Blocked on Supabase dashboard configuration. Not a code change.

---

## 11. Mobile Layout — Send Button Breakpoint

**Problem:** On mobile viewport the Send button (and other quick-action buttons in the hero card) wrap awkwardly or break at unexpected breakpoints. Layout shifts make the touch target unreliable.

**Evidence:** User reports: "the send button has a break point etc" — button text wraps mid-word or the 4-column grid collapses into 2+2 in a visually jarring way.

**Likely cause:** `WalletShell` hero card uses a flex/grid layout that doesn't account for very small viewports (< 360px) or mid-range tablets.

**Files to inspect:**
- `app/wallet/wallet-shell.tsx` — hero quick-action buttons grid
- Tailwind classes around the Send/Receive/Request/Copy buttons

**Status:** Open. Needs device-width testing.

---

## 12. Ineffective Responsiveness (Layout Breakpoints)

**Problem:** Multiple layout elements don't adapt cleanly across the full device range. The sidebar→bottom-nav transition works, but inner components (token list, activity rows, agent chat bubbles) feel cramped or overflow on small screens.

**Evidence:**
- Activity tab rows truncate counterparty addresses aggressively
- Agent chat page `MessageRow` component has fixed-width bubbles that overflow on < 380px
- Token balance rows in Assets section have tight padding on mobile

**Status:** Open. Cosmetic — doesn't block functionality.

---

<!-- Issue 13 (Onboarding CSRF) FIXED. Resolved by setting
     NEXT_PUBLIC_APP_URL on Vercel and redeploying. Webhook routes are
     now also explicitly exempt from the CSRF gate via middleware.ts. -->


## 14. Loading Buttons Feel Ineffective (Local Dev Latency)

**Problem:** Buttons with loading spinners (Send, Request, Verify Code, Activate Agent) feel like they hang for multiple seconds before showing feedback. This creates anxiety — users click twice.

**Evidence:**
- `send-modal.tsx` — Circle SDK challenge can take 2-5s locally
- `agent-activation-modal.tsx` — fund step waits for on-chain confirmation
- `auth-gate.tsx` — "Sending…" and "Verifying…" states feel sluggish

**Root cause:** The user's development laptop is slow. When tested on Vercel production, the same operations feel snappy and the spinner feedback is adequate.

**Verdict:** Not a code fault. The loading states are correctly implemented. Local hardware is the bottleneck.

**Status:** Environment issue. No code change needed. Will naturally resolve for all users on production deployment.

---

## 15. Inadequate Error Handling Coverage

**Problem:** Multiple critical and non-critical paths lack robust error handling. Silent failures, unhelpful user-facing messages, and missing retry/circuit-breaker patterns create poor UX and make debugging difficult.

**Evidence by area:**

| Area | File | Gap |
|------|------|-----|
| Auth gate | `auth-gate.tsx:131-136` | `onSendCode` catch only shows `err.message` — no distinction between network failure, rate limit, or invalid email |
| Auth gate | `auth-gate.tsx:154-158` | `onVerifyCode` catch shows generic "Invalid or expired code" for ALL errors (including network) |
| Wallet context | `circle-wallet-context.tsx:169-173` | `init-user` failure sets `status = "error"` but doesn't surface HTTP status or error code to the UI |
| Wallet context | `circle-wallet-context.tsx:333-343` | `logout` silently swallows ALL errors — user thinks they're signed out when server session may persist |
| Wallet context | `circle-wallet-context.tsx:82-98` | `refresh` silently falls back to `anonymous` on ANY error — masks 5xx, network, or config problems |
| Send modal | `send-modal.tsx` | SDK challenge errors show raw Circle error strings which may be cryptic to users |
| Agent chat | `agent/page.tsx` | If `interpretInstruction` API returns 5xx, chat shows raw error with no recovery action |
| Agent chat | `agent/page.tsx` | PIN verification failures don't distinguish "wrong PIN" from "network error" |
| API routes | `api/circle/*` | Inconsistent error shape — some return `{ error: string }`, others leak stack traces |
| API routes | `api/agent/confirm-policy` | Catch-all returns 500 with raw error message — potential info leak |

**Missing patterns:**
- No React Error Boundary — uncaught render crashes show Next.js default error page
- No circuit breaker — failing endpoints (e.g., OpenRouter down) are retried blindly
- No structured error codes — every error is a human-readable string, impossible to programmatically handle
- No offline detection — app doesn't warn user when network is down

**Fix needed:**
1. Introduce typed error objects with `code`, `message`, `retryable` fields
2. Add a top-level React Error Boundary with "Reload" action
3. Make `logout` surface errors to the user instead of swallowing
4. Distinguish retryable (5xx, timeout) vs non-retryable (4xx, invalid input) errors in UI copy
5. Add network-status indicator for offline scenarios

**Status:** Open. Multi-file refactor. Best done after Vercel deploy is stable.

---

<!-- Issue 16 (Agent Invite Gating) FIXED 2026-05-30. Migration 0006 added
     `agent_enabled` to profiles, isAgentEnabled() gates /api/agent/status
     and dependent routes, WalletShell renders the locked state for
     non-invited users. To grant access:
       update public.profiles set agent_enabled = true where email = '...'; -->


---

## 17. Send Modal — "View Transaction" Button Missing After Send

**Problem:** After a successful send, the Done step in `send-modal.tsx` only shows the "Close" button. The intended "View transaction" button (which links to Arc Explorer with the tx hash) is conditionally rendered only when `txHash` is non-null, and Circle's W3S browser SDK does not consistently return `txHash` in its `onComplete` callback on Arc Testnet — the hash arrives later via webhook.

**Evidence:**
- `app/circle-wallet-context.tsx:325-329` — `executeChallenge` falls through multiple field paths (`data.txHash`, `data.transactionHash`, `result.txHash`) and resolves `null` if none match.
- `app/wallet/send-modal.tsx:449` — the "View transaction" anchor is wrapped in `{txHash && (...)}`, so when null nothing renders.
- The webhook DOES populate `tx_hash` on the corresponding `wallet_transactions` row ~2-3s after the send, but the modal has already closed by then.

**Fix options:**
- **Path A:** After Circle SDK returns null, poll the `wallet_transactions` row via Supabase realtime for ~5s waiting for the webhook to populate `tx_hash`, then enable the button.
- **Path B:** Always show the button — link to the wallet's address page on the explorer when the hash is missing (less satisfying but never empty).
- **Path C:** Log Circle's raw `result` object server-side or in a dev console to confirm whether the hash is actually present under a field name we missed (e.g., `id`, `transactionId`).

**Recommendation:** Path C first (1 line of `console.log`), then Path A if the hash truly isn't surfaced.

**Status:** Open. Activity tab DOES eventually show the hash for the row, so users can find it — but the modal experience is degraded.

---

## 18. Send Modal — No Sound + No Entrance Animation

**Problem:** The send modal pops in instantly with no transition and gives no audio feedback on success. Compared with native banking apps (and the bar set by the rest of the DotArc UI), this feels abrupt.

**Wanted:**
- **Entrance animation:** modal slides up + fades in over ~250ms with a subtle backdrop blur ramp (matches the existing bottom-sheet pattern on mobile).
- **Step transitions:** soft cross-fade between input → preparing → confirm → signing → done; the current hard cuts are jarring.
- **Success sound:** quiet, tasteful "ka-ching" / chime on the Done step (mute-aware — respect `prefers-reduced-motion` and don't play if the page tab is hidden).
- **Failure sound:** soft "thud" or descending tone on the Failed step.

**Files to touch:**
- `app/wallet/send-modal.tsx` — add framer-motion entrance / step transitions
- `public/sounds/` — add `success.mp3` + `fail.mp3` (small, royalty-free)
- New utility `lib/sound.ts` — preload + mute-aware playback wrapper

**Status:** Open. Polish, not blocking.
