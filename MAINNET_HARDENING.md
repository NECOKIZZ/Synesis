# Mainnet Hardening Checklist

Issues that are **safe to ship for hackathon / testnet** but **must be addressed before mainnet launch**. Each item lists the symptom, the root cause, the location, and the proposed fix.

This file is the source of truth for "what's left before real money flows through this." Don't bury this stuff in `KNOWN_ISSUES.md` — that file is for active bugs against the running V3 build.

---

## Auth & Identity

### 🔴 H2 — `USER_ID_PEPPER` must be treated as immutable in production

**Symptom**
Every existing user appears as a brand-new user. Their Circle wallets still exist, but our app can't find them. Funds appear "missing" — they're not, but the user thinks they are.

**Root cause**
`userIdFromEmail()` derives the Circle userId by HMAC-SHA256(pepper, email). Rotating the pepper changes the derivation. We DO pin `profiles.circle_user_id` at first signup as a safeguard — so users **with a profile row are safe**. But users who:
- Started signup but never completed (no profile row yet)
- Had their profile row deleted (manual cleanup, RLS misconfig)
- Predate the `circle_user_id` column

…are orphaned forever after a pepper rotation.

**Where**
- `@lib/circle.ts:223-260` — `userIdFromEmail` + `resolveCircleUserId`

**Fix**
1. **Document in `.env.local.example`**: `USER_ID_PEPPER` is set-once. Rotating it in production orphans existing users.
2. (Optional, defense-in-depth) On every successful sign-in for a user without a profile row, try BOTH derivations (current pepper + last-known pepper) against `listWallets` and adopt whichever finds a wallet. Requires keeping a `USER_ID_PEPPER_PREVIOUS` env var during the rotation window.
3. Backfill any `profiles` rows missing `circle_user_id` from the legacy SHA-256 derivation before the next rotation.

---

### 🟠 M1 — Profile upsert silently overwrites `circle_user_id` and `wallet_address`

**Symptom**
If Circle ever returns a different wallet for the same userId (their bug, race condition, partial outage), our app silently follows along. The user's original wallet record is gone from our DB; their original funds appear lost. They're still on Circle, but we've forgotten about them.

**Root cause**
`upsertProfileForCurrentUser` blindly upserts both columns on every fast-path sign-in.

**Where**
- `@lib/profile.ts:85-116`

**Fix**
Treat `circle_user_id` and `wallet_address` as **set-once after first write**. On every subsequent call:
- If the row already has these set and the new values match → no-op.
- If the values **don't match** → refuse the write, log a hard alert (Sentry/PagerDuty), and surface a 500 to the client. This is an "impossible" state that warrants human review.

Only `email` should remain mutable through this code path.

---

### 🟠 M2 — Email typos create permanent dead accounts

**Symptom**
`john@gmial.com` (typo) is a syntactically valid email. The user verifies the code (Gmail bounces it to their real inbox or it goes to a spam trap), gets a wallet, and never returns. A small percentage of every signup cohort becomes orphan accounts with funded wallets.

**Root cause**
`signInWithOtp({ shouldCreateUser: true })` accepts any well-formed email. We don't validate domain plausibility or warn on common typos.

**Where**
- `@app/auth-gate.tsx:133-136`

**Fix**
1. Use a small typo-detection library (e.g. `mailcheck`) to suggest corrections on submit: "Did you mean `john@gmail.com`?"
2. (Optional) Sanity-check MX records server-side before accepting the OTP request.
3. Reject obvious garbage (`test@test.com`, etc.) in low-risk hackathon mode; production should be more permissive.

---

### 🟠 A5 — Stale Supabase session sticks across "use a different account" attempts

**Symptom**
User starts signing in with `alice@example.com`, cancels mid-flow. Returns to `/wallet` later wanting to use `bob@example.com`. The Supabase cookie from Alice's verified session is still valid — `AuthGate.getClaims()` finds it on mount and auto-fires `onVerified("alice@example.com")` before Bob ever sees the email input. Bob ends up in Alice's account.

**Root cause**
Supabase sessions persist across page reloads. AuthGate treats any valid session as "user is signed in, skip the gate."

**Where**
- `@app/auth-gate.tsx:52-89` — auto-fire logic

**Fix**
On the auth gate, when a Supabase session exists:
- Show the email at the top: "Continuing as `alice@example.com`"
- Add a "Use a different account" link that calls `supabase.auth.signOut({ scope: "local" })` and returns to the email picker
- (Optional) Auto-expire Supabase sessions older than N minutes that never completed a Circle flow

---

### 🟠 M3 — Realtime listener can race the polling loop during onboarding recovery

**Symptom**
During slow onboardings, two recovery paths fire simultaneously:
1. The polling loop in `startCircleFlow` finds the wallet via `/api/circle/wallet`.
2. The Supabase Realtime listener on `profiles.wallet_address` re-invokes `startCircleFlow` from scratch.

Both call `POST /api/circle/session`, minting two cookies back-to-back. Last write wins, so no correctness issue — but logs are noisy and we're doing 2× the server work on a path that should be cheap.

**Where**
- `@app/circle-wallet-context.tsx:238-448` — `startCircleFlow`
- `@app/circle-wallet-context.tsx:512-550` — Realtime subscription

**Fix**
Add an `inFlightRef` boolean inside `startCircleFlow`. Bail at the top of the function if already running. Cheap, ~10-line change.

---

## Performance & Resilience

### 🟡 L1 — `/api/agent/status` is hammered by multiple unrelated surfaces

**Symptom**
On every wallet page mount, `/api/agent/status` is hit 4-8 times in quick succession. Each call does:
- JWT verification
- Invite-gate lookup
- Possibly a Circle balance refresh (gated to 30s cache)
- 3 separate Supabase queries

Result: 1-2s per call, sometimes longer. Annoying in dev; would be a real bill in production.

**Root cause**
Three independent surfaces (`wallet/page.tsx`, `wallet/wallet-shell.tsx`, `agent/page.tsx`) each fetch on mount. Two of them also subscribe to Supabase Realtime that re-fetches on every DB change.

**Where**
- `@app/wallet/wallet-shell.tsx:973-991, 1065-1075, 2022-2028`
- `@app/agent/page.tsx:442-463`
- `@app/wallet/page.tsx:95-105`

**Fix**
1. Adopt SWR or React Query at the `/api/agent/status` boundary, with dedupe-interval ≥ 2s.
2. Lift the status fetch to a single context provider so all consumers share one in-flight request.
3. Move the heavy "recent activity + policies" portion to a separate endpoint that only the agent page calls.

---

### 🟡 L2 — OAuth callback `?next=` is hardcoded to `/wallet`

**Symptom**
If we ever add a sign-in entry from `/agent` or `/settings`, the user lands on `/wallet` after Google OAuth instead of where they started.

**Where**
- `@app/auth-gate.tsx:112-115`

**Fix**
Pass the current path as `?next=` when calling `signInWithOAuth`, and validate it server-side in `auth/callback/route.ts` (must be a relative path, no protocol).

---

## Operational

### Pre-mainnet ops checklist (non-code)

These aren't code bugs — they're things that need to exist before mainnet:

- [ ] Document `USER_ID_PEPPER` immutability in `.env.local.example` (covers H2)
- [ ] Add a `USER_ID_PEPPER_PREVIOUS` mechanism for emergency rotation (defense-in-depth)
- [ ] Set up Sentry / error tracking — required for M1's hard-alert fix
- [ ] Set up uptime monitoring on `/api/agent/status` and `/api/circle/init-user`
- [ ] Document the OTP rate-limit story (Supabase free tier has tight limits)
- [ ] Audit Supabase RLS on `profiles`, `agent_wallets`, `agent_spend_log`, `agent_idempotency`
- [ ] Verify Circle webhook signature validation under load (currently single-key fetch per webhook — should be cached)

---

## Priority order (for the day we decide "we're going to mainnet")

1. **H2 doc change** — 1 line, do today regardless
2. **M1 set-once profile** — 10 lines, hardens against the worst kind of silent data loss
3. **A5 "use a different account"** — visible UX bug, easy fix
4. **M3 inFlightRef** — defensive, prevents wasted work
5. **L1 status dedupe** — perf win, real bills on production
6. **M2 typo detection** — UX polish, not a correctness bug
7. **L2 next-path** — only matters when we add more sign-in entry points

---

## What's already fixed (don't redo)

These were in the original audit but have since been closed:

- ✅ **H1 — `listWallets` silent fall-through** — fixed in `@lib/circle.ts:308-320`. We now hard-fail and let the client's `fetchJsonWithRetry` retry the whole flow.
- ✅ **Email server-trust** — `init-user` reads email from the verified Supabase session, never from the body. Prevents the "anyone with an email can sign in" bug.
- ✅ **OAuth callback PKCE recovery** — `@app/auth/callback/route.ts:52-73` handles "code already used" gracefully.
- ✅ **`AuthGate` firedRef** — prevents remount loops on failed Circle flows.
- ✅ **Logout clears both Supabase + dotarc sessions** — kills the "can't log out" zombie loop.
