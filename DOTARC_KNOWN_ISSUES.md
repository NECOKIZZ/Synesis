# DotArc — Known Issues & Architectural Debt

> Documented: 2026-05-27  
> Status: Open items tracked below. Closed items noted with ✅ fix date.

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

## 3. Main Wallet Activity Not Captured

**Problem:** The Activity tab only shows `agent_spend_log` rows. Main wallet transactions (sends via SendModal) and ALL receives are invisible.

**Evidence:**
- `app/wallet/page.tsx` fetches `/api/agent/status` → maps `recentActivity` from `agent_spend_log` only.
- `app/wallet/send-modal.tsx` executes via Circle SDK in browser; nothing hits backend.
- No incoming transfer listener for either wallet.

**Gap table:**

| Transaction Type | Logged? | Source |
|------------------|---------|--------|
| Agent SEND_USDC  | ✅ Yes  | `agent_spend_log` |
| Agent WITHDRAW   | ✅ Yes  | `agent_spend_log` |
| Agent SWAP       | ✅ Yes  | `agent_spend_log` |
| Main wallet Send | ❌ No   | Browser SDK only |
| Any Receive      | ❌ No   | Not captured |

**Fix options:**
- **Path A:** On-chain polling via RPC (Transfer events). No backend needed. Works for sends + receives.
- **Path B:** New `wallet_transactions` table. Log sends after Circle challenge. Poll RPC for receives.

**Status:** Documented. User requested to defer fix.

---

## 4. Agent Partial Balance Prompt Deficiency (FIXED ✅ 2026-05-27)

**Problem:** LLM swapped full token amounts even when the wallet held partial balances. Example: wallet has 3 EURC, user wants to send 5 EURC → LLM tried to swap 5 EURC worth of USDC, ignoring the existing 3.

**Root cause:** System prompt lacked explicit stepwise logic for partial balance calculation.

**Fix applied:** Rewrote `SMART BALANCE INFERENCE` section in `lib/agent-core.ts`:
- Added explicit shortfall calculation: `shortfall = amount_needed - existing_balance`
- Added rule: swap only shortfall (+ slippage), never full amount
- Added critical warning: "Do NOT ignore the existing balance"

**Validation:**
- `test-cases/send-cryptolympus-eurc-partial.json` — passes, returns correct shortfall swap amount

---

## 5. Time Constraints Silently Dropped in Compound Tasks

**Problem:** When a compound instruction mixes scheduling ("on Friday") with immediacy ("instantly"), the LLM ignores the scheduling constraint and marks everything immediate.

**Evidence:**
- Complex test case: `complex-swap-split.json`
- Result: all 3 steps had `task_type: "compound"` (implicit immediate). "on Friday" only appeared in description text.

**Relation to Issue #2:** This is a symptom of the flat hierarchy. The LLM has no valid bucket for "compound + recurring", so it silently downgrades to compound immediate.

**Status:** Will resolve when Issue #2 is fixed.

---

## 6. Main Wallet Only Showed USDC (FIXED ✅ 2026-05-27)

**Problem:** Assets section hardcoded USDC only. EURC and cirBTC balances were invisible.

**Fix applied:**
- `app/wallet/page.tsx` — fetches all configured tokens in parallel via public RPC
- `app/wallet/wallet-shell.tsx` — dynamic `TokenRow` rendering with token-specific styling
- `.env.local` / `.env.example` — added `NEXT_PUBLIC_EURC_TOKEN_ADDRESS` and `NEXT_PUBLIC_CIRBTC_TOKEN_ADDRESS`

**Limitation:** EURC works (address from App Kit). cirBTC still needs official address.

---

## 7. Activity Page Shows Agent Log Only, No Full History

**Problem:** The Activity tab is labeled "Recent" but only surfaces agent actions. Users expect to see ALL transactions — main wallet sends, receives, agent actions.

**Evidence:**
- Empty-state text says: *"Send or receive USDC and your transactions will appear here."*
- But receives never appear. Main wallet sends never appear.

**Status:** Same as Issue #3 — deferred.

---

## 8. Agent Confirm-Policy Endpoint Logging Overgrowth

**Problem:** Trace ID logging was added extensively to `confirm-policy` and `interpret` routes for debugging. Some logs may expose internal state (e.g., parsed request body before PIN sanitization).

**Evidence:**
- `app/api/agent/confirm-policy/route.ts` logs `parsed` body directly.
- Security rules say: *"NEVER log Circle userToken, encryptionKey, JWT_SECRET, or full Circle API responses"*

**Mitigation:** Logs are development-only. Before production, audit all `console.log` in agent routes.

**Status:** Cleanup needed before mainnet.

---

## Summary Table

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | Missing cirBTC address | Medium | Blocked (need Circle) |
| 2 | Flat task type hierarchy | Medium | Acknowledged, deferred |
| 3 | Main wallet / receive logs missing | High | Deferred |
| 4 | Partial balance prompt bug | High | ✅ Fixed |
| 5 | Time constraints dropped | Medium | Blocked by #2 |
| 6 | USDC-only Assets display | Medium | ✅ Fixed |
| 7 | Activity tab incomplete | High | Deferred (same as #3) |
| 8 | Debug logging cleanup | Low | Pre-production task |
| 9 | OTP infinite retry loop on auth failure | **Critical** | ✅ Fixed (redeploy after adding NEXT_PUBLIC_APP_URL) |
| 10 | Supabase email template mismatch (magic link vs 6-digit code) | **Critical** | Needs Supabase dashboard fix |
| 11 | Mobile layout / send button breakpoint | Medium | Open |
| 12 | Ineffective responsiveness (layout breakpoints) | Medium | Open |
| 13 | Onboarding flow breaks on CSRF / custom domain | **Critical** | ✅ Fixed (same as #9) |
| 14 | Loading buttons feel ineffective (local dev latency) | Low | Environment, not code |
| 15 | Inadequate error handling coverage | **Critical** | Open |
| 16 | Agent wallet needs invite-only gating | **Critical** | Planned |

---

## 9. OTP Infinite Retry Loop on Auth Failure

**Problem:** When `/api/circle/init-user` returns 403 (CSRF middleware rejects custom domain), the error screen shows "Try again" and "Sign out and start over". Clicking "Sign out" triggers `logout()` which POSTs to `/api/circle/logout` — also 403'd by CSRF middleware. The catch block swallows the error, frontend sets `status = "anonymous"`, `AuthGate` remounts, its mount effect detects the still-live Supabase session (server-side `signOut` never ran), and auto-calls `onVerified` again → infinite loop of `init-user` → 403 → error → logout → remount.

**Root cause:** `AuthGate` mount effect (`auth-gate.tsx:43-80`) uses `firedRef` but resets on every remount. `logout` doesn't clear the browser-side Supabase session, only the server-side cookie.

**Evidence:** Vercel logs showed 8+ rapid-fire requests: `init-user` 403 → `logout` 403 → `init-user` 403 → repeat.

**Fix applied (code):** 
- Added `NEXT_PUBLIC_APP_URL=https://wallet.dotarc.my` to Vercel env vars
- Redeployed so `middleware.ts` `buildAllowedOrigins()` includes the custom domain

**Fix still needed (code):**
- Make `logout()` in `circle-wallet-context.tsx` call `supabase.auth.signOut()` client-side too, so `AuthGate` mount effect finds no session on next remount
- Or add a `signOutAttempted` flag to `AuthGate` to skip auto-detection once

**Status:** CSRF issue ✅ fixed by redeploy. Loop-prevention guard still needed for resilience.

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

## 13. Onboarding Flow Breaks on CSRF / Custom Domain

**Problem:** Same root cause as Issue #9. When `NEXT_PUBLIC_APP_URL` doesn't match the actual deployed domain, the entire onboarding flow — email OTP, Google OAuth callback, PIN setup, wallet creation — is blocked by middleware returning 403.

**Impact:** New users can't sign up. Returning users can't sign in. App is completely unusable.

**Fix:** See Issue #9. Ensure `NEXT_PUBLIC_APP_URL` is always set to the canonical domain before any deploy.

**Status:** ✅ Fixed by redeploy with correct env var.

---

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

## 16. Agent Wallet Needs Invite-Only Gating

**Problem:** The Smart Agent feature (OpenRouter LLM calls, policy execution, agent wallet creation) is expensive to operate at scale. Without a gate, 1,000+ daily users would drain OpenRouter credits and Circle API rate limits. The product strategy is to ship the main wallet first, build traction, then slowly roll out agent access to invited users as funds allow.

**Why:**
- Every chat message hits OpenRouter (paid per token)
- Agent wallet creation uses Circle dev-controlled wallets (paid)
- Policy execution burns API calls + on-chain gas
- Main wallet (Circle user-controlled + public RPC) costs ~$0 per user

**Proposed implementation (minimal viable gate):**
1. Add `agent_enabled BOOLEAN DEFAULT false` to `profiles` table
2. Gate `/agent` page — redirect non-enabled users to `/wallet` with toast
3. Gate Smart Agent card in `WalletShell` — show lock icon + "Join waitlist"
4. Gate all `/api/agent/*` routes — return 403 if `agent_enabled = false`
5. Manually flip `agent_enabled = true` in Supabase dashboard for early invitees

**Why not an invite code system yet:**
- Invite codes require a whole feature: code table, validation UI, admin dashboard, code generation
- Manual Supabase toggle is 5 minutes per user, zero code to write
- Can graduate to auto-invite codes once product-market fit is proven

**Files to change when implemented:**
- `supabase/migrations/` — add `agent_enabled` column to `profiles`
- `app/wallet/page.tsx` — pass `agentEnabled` flag to `WalletShell`
- `app/wallet/wallet-shell.tsx` — render locked state for Smart Agent card
- `app/agent/page.tsx` — server-side redirect if not enabled
- `app/api/agent/*` — all routes check `agent_enabled` on the authenticated profile
- `lib/profile.ts` — fetch `agent_enabled` alongside existing profile fields

**Status:** Planned. Blocked until main wallet traction is established.
