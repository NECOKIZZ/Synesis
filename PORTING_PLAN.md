# Porting Plan — From `.arc` Monorepo to Standalone Wallet Project

This file tracks the migration of wallet code from the `.arc` monorepo (`packages/web/app/wallet/*`, `packages/api/src/circle.ts`, etc.) into this standalone project. It also tracks which security fixes from `DOTARC_WALLET_CRITIQUE.md` get applied during the port — so we don't carry over known bugs.

---

## Step 0 — Skeleton (DONE)

- [x] `package.json` with Next.js 15 + Circle SDKs + Tailwind
- [x] TypeScript + Tailwind + PostCSS configs
- [x] `app/layout.tsx`, placeholder `app/page.tsx`, `globals.css`
- [x] `.env.example` with all needed variables documented
- [x] `.gitignore` and `README.md`

**Verify before continuing:** run `npm install` and `npm run dev`. Confirm placeholder loads at localhost:3000.

---

## Step 1 — Server-side utilities

Port these from `.arc` to `lib/` (rewriting any Express-specific bits):

- [ ] `lib/circle.ts` — Circle SDK clients (developer + user controlled), treasury helpers
  - Source: `.arc/packages/api/src/circle.ts`
- [ ] `lib/auth.ts` — JWT issue / verify / cookie helpers
  - Source: `.arc/packages/api/src/auth.ts`
  - Switch from Express `Request/Response` to Next.js `cookies()` API
- [ ] `lib/ans.ts` — Inline the ANS registry ABI + a thin `resolveName(name)` helper using ethers
  - Source: `.arc/packages/sdk/src/constants.ts` + `index.ts` (only what we need)
- [ ] `lib/treasury.ts` — Treasury registration helper using `createContractExecutionTransaction`
  - Source: `.arc/packages/api/src/circle.ts` `treasuryRegisterName` function

**Security fix during port (CRITIQUE §5.2):** Treasury must NOT register names directly. Either implement `treasury-funds-user-then-user-registers` flow, OR add a TODO comment noting the registry contract change is required.

---

## Step 2 — Setup scripts

Port these to `scripts/` (no logic changes):

- [ ] `scripts/generate-secret.mjs`
- [ ] `scripts/register-secret.mjs`
- [ ] `scripts/create-treasury.mjs`
- [ ] `scripts/treasury-balance.mjs`
- [ ] `scripts/treasury-approve-usdc.mjs`

---

## Step 3 — API routes (Next.js App Router)

Rewrite Express routes from `.arc/packages/api/src/server.ts` as Next.js route handlers under `app/api/`:

- [ ] `app/api/circle/create-user/route.ts` — POST: create Circle user-controlled wallet
- [ ] `app/api/circle/initialize-wallet/route.ts` — POST: trigger PIN setup
- [ ] `app/api/circle/wallet/route.ts` — GET: fetch the user's wallet info
- [ ] `app/api/circle/balance/route.ts` — GET: fetch USDC balance
- [ ] `app/api/auth/session/route.ts` — GET: current session info
- [ ] `app/api/auth/logout/route.ts` — POST: clear session cookie
- [ ] `app/api/register-name/route.ts` — POST: treasury-funded name registration

**Security middleware during port (CRITIQUE §3, §9):**
- Every route reads JWT from cookie and resolves `user_id`.
- Every route that touches a wallet checks ownership: `session.user_id === wallet.user_id`. Reject 403 otherwise.
- This is implemented as a reusable `requireSession()` and `requireWalletOwnership(walletId)` in `lib/auth.ts`.

---

## Step 4 — Client-side context + UI

Port the React side from `.arc/packages/web/`:

- [ ] `app/circle-wallet-context.tsx` — Circle SDK init, signup/signin flow, wallet state
  - Source: `.arc/packages/web/app/circle-wallet-context.tsx`
- [ ] `app/page.tsx` — Replace placeholder with the real landing page (Get Started CTA)
- [ ] `app/(onboard)/onboard/page.tsx` — Email entry + name picker + PIN setup
- [ ] `app/wallet/page.tsx` — Main dashboard (balance, QR, send, receive, history)
  - Source: `.arc/packages/web/app/wallet/page.tsx`
- [ ] `app/n/[name]/page.tsx` — Public profile page

**Fix during port (CRITIQUE §6):** QR encodes `https://<host>/n/<name>` URL, NOT raw 0x address. Profile page handles routing for wallet vs browser clients.

---

## Step 5 — Database (deferred until needed)

When we add Google OAuth (and certainly when we add the agent), we'll need Postgres. Schema lives in `lib/db/schema.ts` once added. Tables (per `DOTARC_MASTER_ARCHITECTURE.md` §16 + `CRITIQUE.md` §8):

- [ ] `users`
- [ ] `auth_audit_log`
- [ ] `agent_wallets` (empty until Phase 2, but defined now)
- [ ] `agent_policies` (with HMAC column)
- [ ] `cron_runs` (idempotency table)

---

## Step 6 — Deployment prep

- [ ] Vercel project set up
- [ ] Env vars added in Vercel dashboard
- [ ] `wallet.dotarc.app` DNS pointed once domain is purchased

---

## Critique Items Carried Over (Track Their Resolution)

These will be applied as part of the port. None should slip through unfixed.

| ID | Critique § | Description | Step |
|---|---|---|---|
| FIX-1 | §3.1 | HMAC every agent policy | Step 5+ (when agent ships) |
| FIX-2 | §5.1 | Bot protection on signup | Step 3 |
| FIX-3 | §5.2 | Treasury-funds-user pattern | Step 1 / Step 3 |
| FIX-4 | §6 | QR encodes profile URL | Step 4 |
| FIX-5 | §7.1 | Re-resolve recipient on cron runs | Step 5+ |
| FIX-6 | §7.2 | Cron idempotency | Step 5+ |
| FIX-7 | §8.1 | Audit log table from day one | Step 5 |
| FIX-8 | §9 | Server-side spend limits for main wallet | Step 3 |
| FIX-9 | §4.1 | Drop "never see OTP again" promise | Step 4 (UI copy) |

---

## Next Action

Run `npm install` in this folder, confirm `npm run dev` works, then we begin Step 1.
