# Circle Integration — Decisions & Build Notes

Living document. Updated as decisions are made.

---

## Locked Decisions

| Topic | Decision |
|---|---|
| **User wallet type** | User-Controlled (Circle MPC, user holds keys) |
| **Treasury wallet type** | Developer-Controlled (one wallet, dotarc holds key, auto-pays 5 USDC fees) |
| **Sign-in method (MVP)** | Email OTP via Circle |
| **Sign-in (future)** | Add Google OAuth |
| **Existing MetaMask flow** | Untouched — coexists with Circle path |
| **Hosting** | Path-based: `dotarc.vercel.app/wallet` |
| **Hosting (future)** | Subdomain `wallet.dotarc.app` once a real domain is purchased |
| **Treasury signing** | Circle `createContractExecutionTransaction` API (MPC — no raw private key exists or is needed) |
| **Database** | None for MVP — Circle is the user DB, registry contract is the name DB, JWT cookie for sessions |
| **Name ownership** | Spec Option A — treasury owns, name resolves to user's wallet (cleaner recovery) |
| **Fee model** | Treasury pays 5 USDC per signup |

---

## Architecture Summary

```
User (Email OTP)
    ↓
dotarc.vercel.app/wallet/signup
    ↓
Frontend (@circle-fin/w3s-pw-web-sdk) ──── 1. PIN setup, MPC wallet created
    ↓
Backend API (packages/api)
    │
    ├── 2. Verifies OTP via Circle
    ├── 3. Reads user's wallet address from Circle
    ├── 4. Treasury (dev-controlled) signs ans.register(name, userAddress)
    ├── 5. Issues JWT cookie containing { circleUserId, walletAddress }
    └── 6. Returns { arcName, walletAddress }
    ↓
Frontend shows "Welcome, maya.arc"
```

No database. Circle holds user data. Registry holds name data. Cookie holds session.

---

## Build Phases

- **Phase 0** — One-time setup scripts in `packages/api/scripts/`
- **Phase 1** — Backend routes added to `packages/api/src/server.ts`
- **Phase 2** — `/wallet/*` routes added to `packages/web/app/`
- **Phase 3** — Home page CTA cross-linking the two flows

---

## Future Upgrades (deferred — do not build until MVP works)

1. **Database** (SQLite → Postgres) — needed once we want:
   - Fee recovery tracking (which user owes which fee)
   - Analytics (signups per day, retention)
   - dotarc-specific user profile fields (display name, avatar, social links)
   - Renewal notifications cron
2. **Google OAuth sign-in** alongside email OTP
3. **Modular / Passkey wallets** (Face ID, Touch ID) — premium tier
4. **Circle Gas Station / Paymaster** — gasless UX for SCA wallets
5. **x402 micro-payments** for fee recovery (Spec §7 Strategy 1)
6. **Annual renewal flow** with auto-deduct from user wallet (Spec §7 Strategy 2)
7. **Send-fee skim** (0.5% protocol fee on transfers, Spec §7 Strategy 3)
8. **Agent wallets** (`-agent.arc` registrations) — already partially supported via existing `/agent/register` endpoint
9. **Payment app wallets** (`-usdc.arc`) — same
10. **Subdomain split** — move `/wallet/*` to its own Vercel project at `wallet.dotarc.app` once a real domain is owned
11. **Replace raw `TREASURY_PRIVATE_KEY`** with Circle's transaction signing API (mainnet hardening)
12. **Option B name ownership** — let users transfer name ownership from treasury to themselves once they have USDC

---

## Files That Will Change / Be Created

### New
- `packages/api/scripts/generate-secret.mjs`
- `packages/api/scripts/register-secret.mjs`
- `packages/api/scripts/create-treasury.mjs`
- `packages/api/src/circle.ts` — Circle SDK client + helpers
- `packages/api/src/auth.ts` — JWT issue/verify, session middleware
- `packages/web/app/wallet/page.tsx` — wallet dashboard
- `packages/web/app/wallet/signup/page.tsx` — email OTP + PIN + name picker
- `packages/web/app/wallet/signin/page.tsx` — returning user
- `packages/web/app/wallet/circle-context.tsx` — `<CircleWalletProvider>`

### Modified
- `packages/api/src/server.ts` — add `/circle/*` and `/treasury/*` routes
- `packages/api/package.json` — add `@circle-fin/developer-controlled-wallets`, `@circle-fin/user-controlled-wallets`, `jsonwebtoken`, `cookie-parser`
- `packages/web/package.json` — add `@circle-fin/w3s-pw-web-sdk`
- `packages/web/app/page.tsx` — add "New here? Get a free .arc name" CTA pointing to `/wallet/signup`
- `.env.example` — add Circle env vars

### Untouched
- `packages/sdk/*` — works as-is, just gets a different signer (treasury) on the backend
- `packages/react/*`
- `packages/contracts/*`
- Existing `/register`, `/send`, `/dashboard`, `/n/*` pages — MetaMask flow unchanged

---

## Important Corrections vs. the Implementation Guide

The implementation guide (`DOTARC_IMPLEMENTATION_GUIDE (1).md`) contains one outdated assumption — fixed here:

- **`TREASURY_PRIVATE_KEY` does not exist.** Circle dev-controlled wallets are MPC; you cannot export a private key. Instead, the backend calls Circle's `createContractExecutionTransaction` API with `walletId = CIRCLE_TREASURY_WALLET_ID`. Circle's MPC signs internally. No `ethers.Wallet` is involved.
- This means the `@arcnames/sdk` is used **only for reads** on the backend (availability check, quote price). For writes, we encode calldata via `Interface.encodeFunctionData` and submit through Circle.
- The treasury must **approve USDC to the registry once** (max amount) so that subsequent registrations are a single Circle tx instead of two.

## Important Reminders

- `CIRCLE_API_KEY` and `CIRCLE_ENTITY_SECRET` are **backend only**. Never `NEXT_PUBLIC_`.
- `NEXT_PUBLIC_CIRCLE_APP_ID` is the only Circle value safe in the browser.
- Treasury wallet **address** is public (it's on-chain). Treasury **private key** is not.
- `/api/circle/register-name` MUST require a valid session — otherwise anyone can drain the treasury.
- The recovery file produced by `register-secret.mjs` is the only way to recover the treasury if `CIRCLE_ENTITY_SECRET` is lost. Save offline.
