# DotArc — Future Audits and Upgrades

This document tracks every known security improvement, architectural upgrade, and technical debt item that was deliberately deferred from the MVP build. Every item here was a conscious decision — not an oversight. Each entry explains what was done for now, what needs to change before mainnet or at scale, and why it matters.

The builder should read this at the start of every new phase. The owner should review it before any mainnet deployment.

---

## Treasury-Owned Names — Self-Healing Renewal Model

### What we did for testnet
The treasury wallet calls `register(label, userAddress)` directly. This pays the 5 USDC fee and points the name at the user's wallet, but on the registry contract the **treasury becomes the on-chain owner** of every registered name. Side effects:

- `reverseLookup(userAddress)` returns empty — the registry sets the reverse record based on `msg.sender`, which is the treasury, not the user.
- Only the treasury can `renew()`, `transferName()`, or otherwise mutate the record.
- The user can still **receive** USDC at `theirname.arc` because forward resolution (`name → address`) is correct.

### Why this is acceptable for the MVP
Forward resolution — the only path a sender uses to deliver USDC — works perfectly. Reverse resolution is a cosmetic loss confined to third-party explorers; in our own UI we read the user's `.arc` name from the `profiles` table in Supabase, which is authoritative for our app.

### The renewal model (and how it fixes ownership for free)

Names expire approximately one year after registration (the registry exposes `renew(string)` and `transferName(string,address)` but no `setPrimary` — see selector probe in chat history dated 2026-05-18).

DotArc explicitly **does not auto-renew**. The expiry date is the moment ownership transfers to the user organically:

```
Year 0:  Treasury calls register("maya", userWallet)
         → Forward record: maya.arc → userWallet
         → Reverse record: stuck on treasury (broken)
         → Owner: treasury
         (User can receive USDC fine — that's all an MVP needs.)

Year 1:  maya.arc expires → returns to the registry pool
         User funds own wallet with 5 USDC
         User calls register("maya", userWallet) from own wallet
         → Forward record: maya.arc → userWallet (unchanged)
         → Reverse record: userWallet → maya.arc (fixed automatically — msg.sender now matches)
         → Owner: userWallet (fixed)
```

After year 1, every active user **owns their name properly on-chain**, including a working primary (reverse) record, **without DotArc ever asking them to sign a transfer transaction**. The system self-heals on its first renewal cycle.

### Business-model implications
- DotArc subsidises **acquisition only** (year 0). After that, name renewal is the user's responsibility — same model as ENS, Namecheap, Google Domains.
- No perpetual treasury liability per active user. Treasury cost is bounded to acquisition events.
- Inactive users naturally release names back to the registry pool, freeing labels for new signups.

### Edge cases to address before year 1
1. **Squatting at expiry.** A third party could front-run the user's re-registration the moment the name expires. Mitigations:
   - Email reminders 30, 7, and 1 days before expiry.
   - In-app banner during the grace period.
   - Optional opt-in **auto-renew**: user toggles a setting, DotArc deducts 5 USDC from their own wallet's balance and renews on their behalf. Treasury never pays.
2. **Year-1 commit-reveal protection.** If the registry has commit-reveal enabled (`commitRevealRequired()` returns true), the user re-registration flow must implement the same pattern. Code lives in `lib/circle.ts:treasuryRegisterName` — port the commit-reveal path to a user-signs version.
3. **Recovering names from inactive users.** If a user abandons their account, their name expires and is reclaimable by anyone after the grace period. This is by design — do not build code to "rescue" abandoned names.

### What to change before this matters
Build the **user-signs renewal flow** in roughly month 9 of any deployment so it is ready before the first cohort hits expiry. Required components:

- A `renew()` route gated on the user's session, that calls `register(label, userAddress)` from the user's Circle wallet (not the treasury). PIN dialog will appear; that is correct UX for the renewal moment.
- Email cron for the 30/7/1-day reminders.
- A renewals dashboard page.
- Optional auto-renew toggle in the user's settings.

### Who owns this change
Backend + email infrastructure work; no smart-contract changes required.

---

## USDC Approval Strategy

### What we did for testnet
A one-time unlimited approval (`2^256 - 1`) was granted from the treasury wallet to the ANS registry contract. This means the registry can pull any amount of USDC from the treasury at any time without further permission. It was done this way to keep Phase 0 simple and unblock development.

### Why this is not acceptable for mainnet
The unlimited approval is a standing permission. If the registry contract is ever exploited, upgraded maliciously, or if a bug is discovered in it, an attacker with control of that contract could drain the entire treasury balance in a single transaction. The approval window never closes.

### What to change before mainnet
Switch to just-in-time exact approvals inside `treasuryRegisterName()`. Before every registration call, approve exactly 5 USDC (or 50 USDC for short names) to the registry. The approval is consumed by the registration in the same flow. The window is open for milliseconds, not forever.

The cost is one additional Circle `createContractExecutionTransaction` call per signup, adding roughly 1–2 seconds to the registration flow. That is an acceptable tradeoff for protecting real treasury funds.

```
Testnet flow (current):
  approve once (unlimited) → register, register, register...

Mainnet flow (required):
  approve 5 USDC → register → approve 5 USDC → register → ...
```

### Who owns this change
Builder — update `treasuryRegisterName()` to include the exact approval step before the register call. Gate it behind an environment check so testnet still uses the simple flow during development if needed.

---

## Treasury Private Key Signing

### What we did for testnet
The original implementation guide incorrectly assumed a raw private key could be exported from a Circle developer-controlled wallet and used directly with `ethers.Wallet`. This was wrong — Circle MPC wallets do not expose private keys by design. The builder correctly identified this and switched to Circle's `createContractExecutionTransaction` API, which uses Circle's MPC infrastructure to sign internally.

### Current state
The treasury signs all transactions through Circle's API using `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, and `CIRCLE_TREASURY_WALLET_ID`. No raw private key exists or is needed. `TREASURY_PRIVATE_KEY` has been removed from `.env`.

### What to verify before mainnet
Confirm that the entity secret is stored securely and the recovery file is saved offline. These are the only credentials that give signing authority over the treasury. If either is lost, the treasury wallet cannot sign transactions and cannot be recovered.

Also confirm that the Circle API key used for treasury signing has the minimum required permissions — it should not have broader access than needed for wallet operations.

### Who owns this
Owner — verify entity secret and recovery file storage. Builder — confirm API key permissions in Circle console.

---

## Registry Contract Endpoint Safety

### What we did for testnet
The registry contract address (`0xf5e0E328119D16c75Fb4a001282a3a7b733EF6db`) is hardcoded in `.env` as `ARC_REGISTRY_ADDRESS`. The unlimited USDC approval points to this address.

### The risk at mainnet
If the ANS registry is upgraded or redeployed to a new address, the treasury's unlimited approval on the old address becomes worthless. More critically, if a new address is introduced and the system is updated to use it, a new approval must be issued — and if that approval is again unlimited, the risk resets.

Additionally, if someone were able to manipulate the `ARC_REGISTRY_ADDRESS` environment variable (through a compromised deployment pipeline or misconfigured secrets manager), the treasury could be pointed at a malicious contract.

### What to verify before mainnet
Confirm the registry contract address directly with the Arc Network team before mainnet deployment. Do not rely solely on the value from the testnet docs. Add it to a constants file in the codebase that requires a deliberate code change to update — not just an environment variable swap.

### Who owns this
Owner — confirm contract address with Arc Network. Builder — move registry address to a verified constants file with a comment requiring manual review to change.

---

## `/api/register-name` Authentication

### What we did for testnet
The route requires an authenticated session via `getServerSession`. This is correct and must not be removed.

### The risk if this is ever weakened
This route calls the treasury to spend USDC. If authentication is removed or bypassed — even temporarily during debugging — any anonymous POST request can trigger a registration and drain the treasury. There is no rate limiting at the contract level that protects you.

### What to add before mainnet
In addition to session authentication, add:

- Rate limiting per user — one registration per account, or a maximum per time window
- A check that the `userWalletAddress` in the request body matches the authenticated user's wallet in the database — prevent one user from registering names that resolve to someone else's address
- Request logging — every call to this route should log the user ID, name requested, and outcome so you have an audit trail

### Who owns this
Builder — add rate limiting, address ownership check, and structured logging to the route.

---

## Treasury Balance Monitoring

### What we did for testnet
No automated monitoring. The owner checks the balance manually via the block explorer.

### Why this breaks at scale
If the treasury runs dry mid-signup, the registration transaction fails on-chain but the user's Circle wallet has already been created. The user has a wallet but no `.arc` name. This is a broken state that is confusing to recover from and frustrating for the user.

### What to add before launch
A background job or webhook that checks the treasury USDC balance after every registration and sends an alert (email, Slack, or SMS) when it drops below a defined threshold — suggested minimum is 100 USDC, which covers 20 standard registrations.

Separately, add a pre-flight balance check inside `treasuryRegisterName()` before attempting the registration. If the balance is too low, fail gracefully with a clear error and trigger the alert immediately rather than waiting for the background job.

### Who owns this
Builder — implement balance check in `treasuryRegisterName()` and set up a monitoring job. Owner — define the alert threshold and provide the notification destination (email or Slack webhook).

---

## Circle User-Controlled Wallet — App ID and Configuration

### Current state
`NEXT_PUBLIC_CIRCLE_APP_ID` is used by the frontend SDK to initialise user wallet creation. This value is public and safe to expose in the browser.

### What to configure before mainnet
In the Circle console under User-Controlled Wallets → Configurator, review and lock down:

- Allowed domains — restrict the App ID to only your production domain so it cannot be used from other origins
- Social login providers — enable only the providers you actually support (Google, email OTP) and disable the rest
- PIN requirements — configure minimum PIN length and recovery options appropriate for your users

These settings are in the Circle console and do not require code changes. They should be reviewed by the owner before mainnet.

### Who owns this
Owner — review and configure in Circle console before mainnet deployment.

---

## Race Condition on Name Registration

### What exists now
The registration flow checks name availability, then registers. There is a gap between the check and the register call where another user could claim the same name. If this happens, the user's wallet is already created but the registration fails with a `NameNotAvailable` error.

### Why it matters at scale
At low signup volume this is rare. At high volume — say during a launch spike — it becomes a real UX problem. Users complete the PIN setup flow only to be told their name is gone.

### What to add before launch
Move the availability check to the name picker step, before wallet creation begins. Check availability again immediately before calling the registry. If the second check fails, the user already has a wallet and just needs to pick a different name — the wallet is reusable. Make this recovery path explicit in the UI with a clear message.

A more robust solution is a short-lived name reservation system — when a user picks a name, reserve it in your database for 5 minutes while they complete wallet setup. This does not prevent on-chain conflicts but reduces the likelihood significantly.

### Who owns this
Builder — add name reservation to the signup flow and explicit recovery UI for the race condition case.

---

## Mainnet Migration Checklist

This is the complete list of things that must be done before any real money is involved. Do not deploy to mainnet until every item is checked.

- [ ] Switch USDC approval from unlimited to exact just-in-time per registration
- [ ] Verify registry contract address directly with Arc Network team
- [ ] Move registry address to a verified constants file, not just an env variable
- [ ] Add rate limiting and address ownership check to `/api/register-name`
- [ ] Add structured logging to all treasury-touching routes
- [ ] Implement treasury balance monitoring and low-balance alerts
- [ ] Add pre-flight balance check inside `treasuryRegisterName()`
- [ ] Configure Circle App ID allowed domains in console
- [ ] Review and lock Circle social login providers
- [ ] Confirm entity secret and recovery file are stored securely offline
- [ ] Confirm Circle API key has minimum required permissions
- [ ] Fund treasury with real USDC — plan for 2x expected first-month volume
- [ ] Update `ARC_RPC_URL` and `ARC_REGISTRY_ADDRESS` to mainnet values
- [ ] Switch Circle environment from testnet to mainnet in all API calls
- [ ] Legal review of self-custody disclosure for users
- [ ] Confirm Circle account plan supports expected transaction volume
- [ ] Test the full signup flow end to end on mainnet with a small real amount before opening to users

---

## Items to Revisit at Scale

These are not urgent but should be reviewed when the product grows.

**Batched registrations** — if you ever need to register names in bulk (for agent wallets, merchant onboarding, or airdrops), the current one-at-a-time flow will be slow. The ANS SDK supports batch resolution; a batch registration pattern using Circle's transaction API would need to be designed separately.

**Treasury key rotation** — the entity secret cannot be rotated easily once wallets are created under it. Plan for what happens if the entity secret is ever compromised. Circle's recovery file is the only mitigation today.

**Agent wallet architecture** — when agent wallets are built, decide whether they use developer-controlled wallets (you control the agent's signing) or a new pattern. Document the decision here.

**Spending policy enforcement** — the research document describes per-agent spend limits and allowlisted recipients. This is not implemented in Phase 1. When agent wallets are built, this policy layer needs to be designed and audited before agents are given any real USDC.

**Name renewal** — `.arc` names expire after one year. The current build has no renewal flow. Decide before launch whether the treasury auto-renews on behalf of users or whether users are responsible for renewals. If users pay for renewals, build the payment flow. If the treasury covers renewals, add the annual cost to your treasury funding model.

---

## Phase 2 Deferrals (Frontend Wallet)

The following items were deferred while building the Circle wallet UI in Phase 2. They are not blockers for the hackathon demo but will need to be addressed before public launch.

### Wallet send flow not yet implemented
The wallet dashboard at `/wallet` shows balance, receive (QR), and copy actions, but the **Send** button currently links to the existing MetaMask-only `/send` page. A user signed in via Circle has no way to send USDC from the dashboard. This needs a server-side send route that accepts a session-authenticated request, looks up the user's `userToken`, and submits a USDC transfer through `createTransaction` on Circle's user-controlled wallet API. A user PIN challenge is required for every transfer — the SDK opens the PIN modal client-side, identical to the wallet creation flow.

### No transaction history
The dashboard does not list incoming or outgoing transfers. At minimum, the `/wallet` page should show the last 10–20 transactions with timestamp, counterparty (resolved to `.arc` name where possible), amount, and on-chain link. Two implementation options: (a) query Arc Testnet logs filtered by the user's address, or (b) poll Circle's `listTransactions` endpoint for the user's wallet. Option (b) is simpler but does not include external transfers — only ones initiated through Circle.

### Unified wallet context across the app
The app currently has **two separate wallet contexts** — `WalletProvider` (MetaMask) and `CircleWalletProvider` (Circle). Routes like `/dashboard` and `/send` only work with MetaMask. A user signed in via Circle cannot manage names they own or send funds from those pages. Before launch, decide on one of three patterns:

1. Unify into a single `useWallet()` that says `{ source: "metamask" | "circle", address, signTransaction }` — the cleanest API but requires every signing call site to be aware of both signing modes
2. Keep contexts separate but add a `<WalletGuard>` component that blocks Circle-signed-in users from MetaMask-only pages with a clear "this feature requires MetaMask" message
3. Build Circle-equivalent versions of `/dashboard` and `/send` and route based on which context is active

The right answer depends on the product strategy decision around whether the Circle wallet is a "starter wallet that graduates to self-custody" (Option A) or "the primary wallet for non-crypto users" (Option B). Until that's settled, the Circle wallet is functionally read-only outside the `/wallet` page.

### Wallet portal subdomain decision
Whether the wallet lives at `wallet.arc.io` (separate product) or stays inside the main app at `/wallet` (one product) is unresolved. This affects cookie scope (`SameSite` settings, auth domain), branding, marketing copy, and how the wallet integrates with `/n/<name>` profile pages. Decide this before any external linking (e.g., `pay alice.arc` flows) is built — the URL choice is hard to reverse once partners are integrating.

### "Link external wallet" feature is missing
A user with a `.arc` name should be able to link external wallets (MetaMask, Phantom, hardware wallets) to their identity. Without this, power users have no reason to use `.arc` once they have their own wallet. The flow:

1. User clicks "Link external wallet" on `/wallet`
2. They connect MetaMask via the existing Web3 flow
3. They sign a message proving control of that address — message format must include their `.arc` userId and a nonce to prevent replay
4. Backend stores `(userId, externalAddress, signature, chain)` in a new `linked_wallets` table
5. The `.arc` profile page (`/n/<name>`) lists all linked addresses, with the primary resolver clearly marked
6. The user can change which linked wallet is the primary resolver — this calls `updateResolvedAddress` on the registry contract, paid by the treasury or by the user

This is the differentiator from Coinbase usernames or pure ENS. Without it, `.arc` is just another naming service.

### Multi-chain resolver / "resolve to other names"
The user wants `.arc` names to resolve to either wallet addresses **or other `.arc` names** (chain-agnostic resolution). This is not currently supported by the `register(label, resolvedAddress)` contract function on the ANS registry — that function takes only an EVM address. To support multi-chain (Solana, Bitcoin, etc.) and name-aliasing:

1. Confirm with Arc Network team whether the registry has alternate resolution methods (text records, multi-chain address fields, etc.) that aren't surfaced in the current SDK. If yes, use them.
2. If not, build the multi-resolver layer **off-chain** in the dotarc backend — a database table `(arcName, chain, address_or_alias)` that the backend resolves on top of the on-chain primary resolver. The on-chain primary stays authoritative for "where do I send USDC on Arc"; the off-chain layer handles "where do I send SOL to alice.arc" or "alice.arc → bob.arc → bob's actual address".
3. The SDK's `resolve()` method should return a structured object — `{ primary: "0x...", chains: { solana: "...", btc: "...", evm: "..." }, aliasOf: "bob.arc" | null }` — instead of a single address string. Consumers can pick the field they need.
4. UI: a "Resolver settings" page on `/wallet` listing all chains with editable address fields. Adding a chain just writes to the off-chain table, no on-chain transaction.

This is a substantial feature — design the schema carefully because once integrators are reading these resolutions, the shape is hard to change. Consider whether to align with ENS's text-record convention (`org.telegram`, `com.twitter`, `io.solana.address`) so existing ENS tooling can be reused.

### QR code only encodes the raw address
The QR code in the receive modal currently encodes the user's **raw 0x address as plain text**. This is the same behaviour as MetaMask and most existing wallets — a wallet app scanning it gets the address and pre-fills it as the recipient. **It is not a URL and will not open anything when scanned with a generic camera app.** This is correct behaviour for a wallet QR but does not match what the user expected.

To make the QR open a payment page when scanned with any camera app, encode a URL like `https://arc.io/pay/alice.arc` (or `https://arc.io/pay/0x...`) instead. That URL would route to a public payment page on the dotarc site that lets the scanner enter an amount and pay. Decide which behaviour you want:

- **Address-only QR** (current) — works inside other wallet apps, doesn't open a link from a camera app, matches user expectations once they're in a wallet flow
- **URL QR** — works with any camera app, requires a public `/pay/<name>` page that handles unauthenticated visitors, optionally with deep-links to wallet apps using EIP-681 (`ethereum:` URI scheme)

For a payments-first product (Option B in the strategy doc), URL QR is correct. For a generic crypto wallet (Option A), address-only is correct. The current implementation matches Option A.

### Receive modal does not validate address checksum visually
The QR encodes a raw lowercase address. EIP-55 mixed-case checksumming should be applied to both the displayed address text and the QR payload to give scanners a chance to detect transcription errors. Easy fix: pass the address through `getAddress()` from ethers before encoding.

### Wallet auto-refresh polling is naive
Balance is refetched every 15 seconds while `/wallet` is open. This means an idle tab burns RPC calls indefinitely. Before launch, add: (a) pause polling when the tab is not visible (`document.visibilityState`), (b) extend the interval after the tab has been idle for a few minutes, and (c) consider websocket-based push updates from the backend instead of polling — Circle's webhooks could feed a pub/sub channel.

### No session expiry handling
The dotarc auth cookie has a 30-day TTL but there is no client-side handling for when the session expires while the tab is open. The user will see the dashboard until they perform an action that returns 401, then be silently bounced to the signup form. Before launch, add a 401 interceptor in the Circle wallet context that surfaces "session expired, please sign in again" with the email pre-filled.

### No "switch account" support
A user who wants to use a different email needs to sign out, then sign in with the new email. There is no concept of multiple accounts on the same device. For shared devices (family, public computers) this is a gap. Likely fix: store last 3 emails in localStorage and offer them as a quick-switch list on the signup screen.

### Owner ownership of `.arc` name vs resolved address
Currently `treasuryRegisterName()` registers names with the **user's address as the resolved address**, but the **treasury is the on-chain owner** of the name (because the treasury is `msg.sender` in the registry contract). This means the user cannot transfer their name, set a primary, or update its resolver without going through the treasury. Before launch, after registration succeeds, the treasury must call `transferName(label, userAddress)` so the user becomes the on-chain owner. Otherwise users are locked into the treasury for any future name management. Confirm the registry's `transferName` function exists and works as expected — if not, the registration flow needs to use a different pattern (e.g., user's address as `msg.sender` via meta-transactions, with the treasury subsidising gas through Arc's USDC-as-gas model).

This is **the most important Phase 2 deferral** — without fixing it, every registered name is effectively held by the treasury on the user's behalf, which is a custody model the user did not consent to and which is hard to migrate away from later.

---

## Persistence Layer (User Database)

### What we have now
There is **no database**. The Phase 1 backend is fully stateless:

- User identity is derived from email via `userIdFromEmail(email)` → `dotarc-<sha256(email).slice(0,32)>`. The mapping email → userId is purely a hash function, recomputed on every request.
- Sessions are JWTs signed with `JWT_SECRET`, stored as cookies. Nothing about the session is server-side.
- The user's wallet, name, and metadata live entirely on Circle (wallet) and the Arc registry (name). The dotarc backend remembers nothing between requests.

### Why this works for the hackathon
- Zero ops — no Postgres, no migrations, no backups
- Reproducibility — re-deploying the backend doesn't lose any user state because there is no user state stored
- Idempotency — every signup re-derives the userId from the email, so users can come back forever

### Why it breaks at scale
The stateless design has hard ceilings:

1. **No off-chain resolution data** — multi-chain resolvers, name aliases, `payroll.arc` groups, profile metadata (display name, avatar, bio, social links), HashPay payment requests — none of this can exist on-chain (registry doesn't support it). Without a database there is nowhere to store any of it.
2. **No transaction history** — Circle's `listTransactions` only shows wallets we manage; external receives need to be indexed from chain logs and cached. That cache is a database.
3. **No rate limiting** — "max 1 registration per user" needs a record of past registrations per user. Today there is no such record server-side.
4. **No audit log** — every treasury-touching action should be logged with timestamps, user IDs, outcomes, and tx hashes. Today these go to stdout and are lost on restart.
5. **No "who linked which external wallet"** — the linked-wallets feature (see above) requires storing `(userId, externalAddress, signature)` rows.
6. **No "remember this user agreed to terms"** — legal flows need persisted consent records.
7. **No social features** — friends, contact lists, "send to people you've paid before", search-by-username — all need a database.

### What to add before launch

A **single Postgres database** (Supabase, Neon, or self-hosted) with the following tables, designed up front:

- `users` — `(id, email, circle_user_id, arc_name, primary_address, created_at, last_seen_at, metadata jsonb)`. The `id` is the deterministic `dotarc-<hash>` so existing JWT cookies keep working unchanged.
- `linked_wallets` — `(user_id, chain, address, signature, verified_at, is_primary)`. Lets users link MetaMask/Phantom/Ledger to their `.arc` identity (see "Link external wallet" deferral above).
- `resolutions` — `(arc_name, key, value)` where `key` is something like `solana.address`, `bitcoin.address`, `com.twitter`, etc. ENS-style text records stored off-chain because the registry doesn't support them on-chain (see "Multi-chain resolver" deferral). The `resolve()` API merges this with the on-chain primary.
- `name_aliases` — `(arc_name, alias_of_name)`. Lets `alice.arc` resolve through to `bob.arc` if the user has migrated.
- `name_groups` — `(group_name, member_arc_name, weight, position)`. Lets `payroll.arc` resolve to `[alice.arc, bob.arc, charlie.arc]`. The `weight` field lets group payouts split unevenly (e.g., 50/30/20). Used by HashPay group requests and any future "split payment" features.
- `payment_requests` — `(id, requester_arc_name, payer_arc_name nullable, amount_usdc, memo, status, expires_at, paid_tx_hash, created_at)`. The HashPay table — see HashPay section below.
- `transactions` — `(id, user_id, direction, counterparty_address, counterparty_arc_name, amount_usdc, tx_hash, block_number, created_at)`. Cached transaction history for fast dashboard rendering.
- `audit_log` — `(id, actor_user_id, action, resource, metadata jsonb, created_at)`. Append-only log of every treasury-touching or auth-changing action.
- `rate_limits` — `(user_id, action, count, window_start)` or use an in-memory store like Redis if signup volume warrants it.

The schema should be designed end-to-end before any of it is built so that `users` and `transactions` (the most-read tables) can be indexed appropriately and so that referential integrity between `users.arc_name`, `name_groups.member_arc_name`, etc., is consistent.

### Choice of database
- **Supabase** — fastest to ship, includes auth/RLS/realtime, gives you a hosted Postgres with backups. Recommended for the hackathon-to-launch transition.
- **Neon** — pure Postgres, branch-per-environment, great DX. Pick this if you don't need Supabase's auth layer (you have your own).
- **Self-hosted Postgres on a VPS** — cheaper at scale, more ops. Don't do this until you're past initial launch.

### Migration from current state
Today every user-related lookup goes to either Circle's API (wallet info) or the on-chain registry (name info). When the database is added, the order should be: **DB first, fall back to source of truth**. The DB acts as a cache + extension layer; if a row is missing, fetch from Circle/chain and backfill.

The first DB write should happen the first time a user successfully completes wallet setup — at the point where `setSession()` is called in the backend, write the row to `users` if it doesn't exist.

### Who owns this
Builder — design the schema, set up the chosen DB, migrate the auth layer to read from it. Do this **before** building any of the features that depend on it (multi-chain resolvers, HashPay, transaction history, linked wallets) so they're not built against an in-memory placeholder that has to be rewritten.

---

## HashPay — Payment Requests

### Concept
A user requests money from another user. The other user pays. Optionally the request has a memo, an amount, and an expiry. Payment requests can target a single payer (`alice.arc requests 5 USDC from bob.arc`) or be open links anyone can pay (`alice.arc receives anything from anyone via this link`).

### Why this matters for dotarc
This is the feature that turns dotarc from "a wallet" into "a payment app." Cash App's defining UX is `$Cashtag` requests, not the wallet itself. The same mechanic on stablecoin rails is the wedge.

### What it needs
- `payment_requests` table (defined in the database section above)
- A `/request` page where a logged-in user creates a request — picks amount, memo, expiry, payer (optional), and gets a shareable URL like `dotarc.app/r/<id>` or `dotarc.app/pay/alice.arc?req=<id>`
- A public `/pay/<arc-name>` and `/r/<id>` page that shows the request to whoever opens it. If they're logged in, one-tap pay. If they're not, sign in with email and pay.
- Server-side pay flow — the payer's Circle wallet sends the USDC via `createTransaction` (PIN challenge), and the request is marked paid with the resulting tx hash.
- Webhook or polling so the requester sees their request fulfilled in real time without refresh.
- Optional: group payment requests where `payroll.arc` requests from multiple payers, and the request is marked paid only when all (or N) have contributed. This depends on the `name_groups` table.

### What to design carefully
- **Cancellation and expiry** — what happens when a request is paid AFTER expiry? Refund? Reject in the contract layer (off-chain, since stablecoin tx is irreversible)? Most products silently accept late payments and mark them as such; some refund automatically by sending USDC back. Decide.
- **Privacy** — is a request URL guessable? Use long random ids (16+ bytes hex), not auto-incremented integers.
- **Spam** — anyone can open a request URL and see the requester's `.arc` name and amount. Decide whether the requester's identity is public on the link or whether the link gates it behind a "view request" click.
- **Cross-currency** — initial version is USDC-only. Future: USDC ↔ EURC, or stablecoin ↔ local currency via off-ramp partner. Out of scope until launch.

### Who owns this
Builder — design the table, build `/request` UI, build `/pay/<name>` and `/r/<id>` pages, integrate with the Circle send flow (see "Wallet send flow not yet implemented" deferral). Owner — decide the cancellation/expiry policy and the privacy model.

---

## Aggregate / Universal QR Codes

### The problem
The current QR encodes a raw `0x` address — works inside crypto wallets, doesn't open anything from a phone camera. Users expect "scan and it does something." A wallet-only QR fails that expectation.

### What's technically possible
A single QR encodes a single string. That string is interpreted differently by different scanners. There is **no QR format that is simultaneously a URL to a camera and an address to a wallet**.

### What real payment products do
The closest thing to "aggregate" is encoding an **HTTPS URL** pointing to a smart payment landing page that handles all visitor types:

- Phone camera → opens browser → page lets them sign in by email and pay from their dotarc wallet
- Wallet browser (Rainbow, MetaMask mobile, Phantom EVM) → page detects injected provider, offers EIP-681 / WalletConnect deep-link
- Wallet's "scan recipient" feature → many modern wallets auto-detect addresses inside URLs; older ones will reject

Cash App, Strike, and Wallet of Satoshi all use this pattern for Bitcoin Lightning.

### What to build
1. A public, unauthenticated `/pay/<arc-name>` page that:
   - Shows the recipient's display name, avatar, and `.arc` handle
   - Has an amount input and memo field
   - If the visitor has a dotarc session, shows "Pay from your dotarc wallet" with one-tap PIN flow
   - If the visitor has `window.ethereum` injected, shows "Pay from your connected wallet" with an EIP-681 deep-link
   - If neither, shows "Sign in with email to pay" linking to the wallet onboarding flow with a `?redirect=/pay/<name>` parameter
2. Update the receive QR in the wallet dashboard to encode `https://dotarc.app/pay/<arc-name>` (or fallback `/pay/<address>` if no name yet)
3. Below the QR, show a copy-address button and a small note: "*Scan with any camera to pay. Wallet apps: paste address below.*"
4. Optionally: encode the URL with an EIP-681 fallback in the URL hash, e.g. `dotarc.app/pay/alice.arc#ethereum:0xfb1a...@5042002` — wallets that scan and parse the hash get the EIP-681 part for free; browsers ignore the hash.

### Who owns this
Builder — build `/pay/<name>` page with the multi-mode pay flow, swap the QR encoding from raw address to URL once the page exists, write the copy below the QR explaining behaviour. Owner — decide whether the page itself shows the recipient's identity publicly (`alice.arc` visible to anyone with the link) or gates it.

### Don't build the QR change before the landing page
Switching the QR to a URL today, before `/pay/<name>` exists, gives users a 404. Order matters: build the landing page first, then update the QR.

---

## On-Chain Multi-Name Resolution Is Not Possible Today

### What was claimed
The user was told by a previous builder that dotarc supports multi-name resolution via a CSV file. **This is incorrect.** The CSV reference in `ANS-Integration-Feedback.md` is about an unrelated dApp (Arc Global Payouts) that supports CSV import of recipients into its own batch-payment UI — each row in the CSV is still a normal one-name-one-address lookup. There is no on-chain CSV mechanism, no group-name registry feature, and no alias support in the contract.

### What the registry actually supports
The current ANS registry contract exposes (full ABI in `packages/sdk/src/constants.ts`):

```
register(string label, address resolvedAddress)
resolve(string label) → address              // single address
getRecord(string label) → (owner, resolvedAddress, expiry, ...)
updateResolvedAddress(string label, address newAddress)
```

Every resolution function returns exactly one EVM address. There are no text records, no multi-chain fields, no alias pointers, no group-member arrays. The contract is owned and deployed by the Arc Network team — dotarc cannot modify it.

### What this means for `payroll.arc → [alice.arc, bob.arc, charlie.arc]`
This must be done **off-chain** in the dotarc database (`name_groups` table — see Persistence Layer section). The `payroll.arc` name is registered on-chain like any other name and its on-chain `resolvedAddress` can be set to whatever (the requester's own address, or a zero address sentinel). The dotarc backend's `resolve("payroll.arc")` checks the DB first, sees it's a group, and returns the list of members. SDK consumers using the on-chain registry directly will see only the single primary address.

### What this means for `alice.arc → solana, bitcoin, ethereum addresses`
Same answer: **off-chain.** The `resolutions` table stores key-value pairs per name. The dotarc SDK's `resolve(name, { chain: "solana" })` queries the DB first, falls back to nothing for chains not in the table.

### When this changes
If the Arc Network team adds text records to the registry (the way ENS has), the resolution can move on-chain. Until then, off-chain is the only option, and a database is required. There is no clever workaround — encoding multi-resolution data into the single `resolvedAddress` field is impossible because it's an `address` type, not a string.

### Who owns this
Owner — ask the Arc Network team if text records are planned for the registry. If yes, get a timeline. If no, the off-chain DB design is permanent.
Builder — build the off-chain resolution layer in the database, design the SDK API so it can transparently switch to on-chain text records later if/when they ship.
