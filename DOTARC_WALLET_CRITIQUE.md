# DotArc Smart Wallet — Architecture Critique & Findings

This document captures every architectural concern, gap, and recommendation identified during review of:
- `DOTARC_MASTER_ARCHITECTURE.md`
- `DOTARC_AUTH_AND_SECURITY.md`

It is written for the builder/engineer to act on. Each finding includes severity, the problem, the consequence, and the recommended fix. Findings are grouped by theme.

Severity legend:
- **🔴 Critical** — must be addressed before launch; affects custody or correctness.
- **🟠 High** — affects security, UX promises, or business model viability.
- **🟡 Medium** — affects polish, scaling, or downstream features.
- **🟢 Low / Note** — informational or style.

---

## 1. Strengths to Preserve

These are the right calls. Do not let refactoring erode them.

- **No-crypto-complexity-visible UX principle.** The decision to hide `0x`, gas, chain IDs, and seed phrases is the actual product wedge. Most wallets fail here.
- **Two modes, one app.** Main wallet + optional Smart Agent in a single product is better than two apps fighting for the same user.
- **Three-layer auth separation** (your session vs Circle session vs Circle PIN). Conceptually clean.
- **Auth method choice for the agent** (Google re-auth OR PIN). Pragmatic; lets users pick their security/friction tradeoff.
- **Database as the connecting thread** between user-controlled and developer-controlled wallets. Correct architecture.
- **Phasing in section 22.** Build order is sane: wallet → agent foundation → intelligence → ecosystem.

---

## 2. Circle Wallet Scoping — A Limitation, Not a Bug

🟢 **Note** — but important to document so it's not rediscovered later.

### The Reality
Circle user-controlled wallets are scoped per `app_id`. The same email creates a **different** wallet on every platform that uses Circle. There is no global "Circle account" that follows a user across apps.

```
maya@gmail.com
  ├── DotArc Smart Wallet     → 0xMAYA_DOTARC...   (Circle wallet A)
  ├── Arcana Market           → 0xMAYA_ARCANA...   (Circle wallet B)
  └── Other Arc dApp          → 0xMAYA_OTHER...    (Circle wallet C)
```

Each is a separate Circle wallet with separate balances. The user cannot use one wallet to sign on another platform.

### What This Means for `.arc` Names
- `maya.arc` resolves to ONE address — the DotArc-issued wallet.
- Other dApps can read `maya.arc` and **send TO** it.
- Other dApps cannot **spend FROM** it without deep-linking the user back to DotArc.

### Why This Is Industry Standard
Every embedded wallet provider scopes per app: Privy, Magic, Web3Auth, Dynamic, Turnkey, Coinbase Smart Wallet. This is intentional — it prevents one compromised app from draining wallets created on other apps.

### Implication for Strategy
DotArc Smart Wallet is a **destination wallet**, not a portable identity. Plan accordingly:
- Don't promise "use your `.arc` everywhere on Arc" without qualification.
- For users who want their `.arc` name to point to another wallet (MetaMask, Phantom, etc.), implement off-chain multi-resolution (already in the future upgrades doc).

---

## 3. Custody & Trust Model Disclosure

### 3.1 The Smart Agent Is Custodial — Disclose It Clearly

🔴 **Critical**

The master doc describes the agent wallet as developer-controlled but never explicitly tells the user that **DotArc holds custody of agent funds**.

**Reality:**
- The agent wallet is signed by your entity secret + Circle MPC.
- Your backend can move agent funds with no user present.
- If your DB is compromised and an attacker inserts a fake `agent_policies` row with `auth_verified_at` set, the cron job will pay it.
- There is no on-chain or off-server check at execution time.

**Required fixes before shipping:**
1. **HMAC every policy.** When a policy is created, sign `(user_id || policy_id || recipient || amount || frequency || created_at)` with HMAC-SHA256 keyed by a server secret. Store the HMAC alongside the policy. The cron job verifies the HMAC before every execution. A DB-only compromise can no longer forge policies.
2. **Disclose custody in the UI.** During Smart Agent activation, the user must see: *"Your agent wallet is held in custody by DotArc. Spend limits protect you. You can withdraw to your main wallet at any time."*
3. **Hard daily caps at the cron layer.** Independent of `user_spend_limits`, enforce a global ceiling per agent wallet that no single policy or compromised row can override.

### 3.2 The Main Wallet Is Non-Custodial — Verify This in Code

🟠 **High**

The doc claims the main wallet is user-controlled (Maya signs with her PIN). Verify this is **actually** true in implementation:
- The Circle SDK PIN must be enforced for every send.
- Your backend must never have a code path that signs from the user's main wallet.
- If you ever add "passwordless send" or "skip PIN for small amounts," you've made it custodial. Don't.

---

## 4. Authentication Layer Gaps

### 4.1 Google OAuth Does Not Authenticate the Circle Wallet

🟠 **High**

The auth doc imagines Google sign-in as Layer 1 and Circle email-OTP as Layer 2, with the user-id-by-email lookup tying them together. This has a gap:

**Anyone who signs into Maya's Google account can claim Maya's Circle wallet** — unless Circle's own session check still requires OTP on the new device. The doc tries to skip Circle OTP after first setup, but Circle controls when its session expires; you don't.

**Required:**
- Reframe the public promise. "OTP **once per device**, never on the device you use daily" is honest. "Never see OTP again" is not.
- Auth doc Section 6 already acknowledges this. Section 3's promise contradicts it. Pick the honest version and enforce it across all marketing copy.

### 4.2 Recovery Path Is Missing

🔴 **Critical**

Lose Google account = lose wallet. Lose Google access AND Circle session = funds are unrecoverable.

**Required:**
- Allow users to set a separate recovery email distinct from the Google sign-in email.
- Document Circle's recovery flow for user-controlled wallets explicitly. If Circle does not offer recovery for user-controlled wallets in your tier, this is a launch-blocker.
- For agent wallets (developer-controlled), recovery is **your responsibility** — define exactly what happens if a user loses access.

### 4.3 Email-Based Lockout Recovery Is Single-Channel

🟠 **High**

Auth doc section 11: 5 wrong PIN attempts → unlock via email verification. But the same email is used for Circle OTP. Compromise the email = compromise both factors.

**Required:**
- Add a second factor (recovery codes generated at signup, or phone-based) for full agent unlock.

### 4.4 JWT Secret Rotation Plan Is Missing

🟡 **Medium**

If `JWT_SECRET` leaks, all sessions are forgeable forever. Document a rotation procedure and consider using short-lived access tokens + refresh tokens instead of long-lived JWTs.

---

## 5. Treasury & Registration Economics

### 5.1 Treasury Drain via Bot Signups

🔴 **Critical**

5 USDC per signup, no bot protection in the spec. 10,000 fake Gmail accounts → 50,000 USDC drained + 10,000 squatted names with no recovery path (the names belong to whichever wallet registered them).

**Required (pick at least two):**
- Cloudflare Turnstile or hCaptcha on the signup endpoint.
- Phone verification via Twilio.
- Invite codes for launch (off by default after launch).
- Rate limit per IP and per Google sub-ID.
- Optionally: replace EOA treasury with a smart-contract treasury that enforces "one registration per `(google_sub_id_hash)`" on-chain.

### 5.2 Treasury Owns Every Registered Name

🔴 **Critical**

If `treasury.arc` registers `maya.arc`, the treasury **owns** `maya.arc` per the registry contract. Maya cannot transfer, renew, or move the name without your cooperation.

**Required (one of):**
- Update or extend the ANS registry to support `registerFor(string name, address owner)` so the treasury pays gas/fee but the name is minted to Maya's wallet.
- If contract changes are not feasible: the treasury funds Maya's wallet with exactly 5 USDC, and Maya's wallet itself calls `register`. Maya owns the name from the start. Cost is the same; ownership is correct.

### 5.3 Name Renewal Has No Business Model

🟠 **High**

5 USDC/year. Phase 4 mentions automation but never says **who pays**. Three options, pick one and document it:
- **Treasury pays forever** — recurring liability per active user. Acceptable only if monetisation is in place.
- **User pays from main wallet balance** — auto-debit with a setting to disable.
- **Names expire and become reclaimable** — typical ENS-style model.

### 5.4 Short Names Are Subsidised Implicitly

🟡 **Medium**

Short names cost 50 USDC. If the treasury pays signup, every user could request `pay.arc` and drain 10x faster. Cap the treasury subsidy to standard names only. Short names = user-paid.

---

## 6. QR Code & Public Profile Contradiction

🟠 **High**

Two parts of the doc disagree:
- Section 2: QR encodes the raw `0x` address.
- Section 17: Public profile page exists at `/n/maya`.

If QR encodes `0x...`, scanning with a generic camera does nothing. If QR encodes the profile URL, wallet apps that expect EIP-681 can't auto-fill.

**Required:**
- QR encodes the **profile URL** (`https://wallet.dotarc.my/n/maya` or future custom domain).
- The profile page sniffs the client:
  - Wallet deep-link / `eip681` query param → return EIP-681 address payload
  - Generic browser → render the pay-Maya landing page
  - Wallet "scan to pay" mode → resolve to address
- Document this routing logic in the master architecture doc as the canonical answer.

---

## 7. Smart Agent Execution Risks

### 7.1 Recipient Address Caching Is a Foot-Gun Either Way

🟠 **High**

Master doc section 13 caches `recipient_address` on policy creation. Two failure modes:

| Strategy | Failure Mode |
|---|---|
| Cache at creation (current spec) | Recipient transfers `sara.arc` → Maya keeps paying old address. Recipient loses name on expiry → Maya pays squatter. |
| Re-resolve every cron run | Recipient gets hacked / loses control of name → Maya's recurring payment is hijacked. |

**Required:**
- **Re-resolve every cron run** AND store the previous resolved address.
- If the resolved address changes between runs, **pause the policy** and notify Maya: *"sara.arc now points to a different wallet. Confirm to continue paying."*
- Re-confirmation requires the user's chosen auth method (Google re-auth or PIN).

### 7.2 Cron Idempotency

🔴 **Critical**

Vercel Cron retries on timeout. Two `createContractExecutionTransaction` calls for the same policy + same week = double payment.

**Required:**
- Idempotency key = `policy_id || scheduled_run_timestamp`.
- Insert into a `cron_runs` table BEFORE calling Circle. If insert conflicts (key already exists), skip.
- Circle's API also accepts idempotency keys — pass the same one.

### 7.3 Prompt Injection Through Claude

🟠 **High**

Claude is the interpretation layer. User input flows in unsanitised. Voice + speech-to-text amplifies risk.

**Required:**
- Hard server-side spend caps that Claude's JSON cannot override (read from `user_spend_limits.max_per_transaction`, applied **after** Claude returns).
- Confirmation card must show **every recipient + amount line** explicitly. No "..." or "and 3 others."
- Reject Claude output where suspicious patterns appear (recipient = sender's own name, amount >10x median, recipient address fields populated when only `.arc` name was requested).
- Treat Claude as **untrusted user input** at every step.

### 7.4 Cron Job Has No Per-Run Quota

🟡 **Medium**

If many policies are due in one hour, the cron may exceed Vercel's execution time limit and miss some. Add:
- Pagination (process N policies per run, mark `last_processed_at`).
- A separate "catch-up" cron that detects missed runs.

### 7.5 Timezone for Recurring Policies

🟡 **Medium**

"Every Friday" in whose timezone? The doc never says. Required: store the user's timezone on the policy at creation and compute `next_run` in that timezone, not server time.

---

## 8. Database Schema Concerns

### 8.1 Missing Audit Log

🟠 **High**

`agent_spend_log` records spend but there is no `auth_audit_log` for: logins, PIN changes, auth-method switches, recovery events, lockouts. Required for incident response and compliance.

**Add table:**
```
auth_audit_log
  id, user_id, event_type, ip, user_agent, succeeded, metadata, created_at
```

### 8.2 Indexing Gaps

🟡 **Medium**

For the volumes this product needs to handle:
- `agent_policies (user_id, active, next_run)` — for cron lookups.
- `agent_spend_log (user_id, executed_at DESC)` — for the activity feed.
- `users (email)` — unique index for OAuth lookup.
- `users (arc_name)` — unique index.
- `agent_wallets (user_id)` — for the agent fetch on app load.

### 8.3 Balance Cache Lifecycle

🟡 **Medium**

`agent_wallets.balance_cache` is mentioned but there is no documented policy on:
- When is it written? (After every send? On every Circle webhook?)
- TTL?
- What if it diverges from on-chain truth?

**Required:** Use Circle webhooks as the source of truth, write the cache on every webhook, and add a "last_synced_at" timestamp.

---

## 9. Server-Side Enforcement Gaps

🟠 **High**

The doc states spend limits are checked by the policy engine. They must also be enforced at:
- The send endpoint for the **main wallet** (currently no limits documented for the main wallet at all — what stops a phished session from draining everything?)
- A monthly hard cap that no DB row or Claude output can exceed.
- The Circle API itself if Circle supports per-wallet spend caps (verify and use).

**Required:** Document `user_spend_limits` for the **main wallet** too, not just agent. Section 15 only covers agent.

---

## 10. Public Profile & SEO Concerns

🟡 **Medium**

`/n/<name>` is public. This means:
- Names are publicly enumerable through the contract anyway, but pages put them on Google. Confirm this is desired.
- The page should have `rel="noindex"` until the user opts in to discovery.
- If the user's balance or recent activity ever leaks to the page (don't), it's privacy-sensitive.

---

## 11. Smart Agent — Strategic Concern

🟢 **Note** — not a build blocker but a positioning one.

`RECURRING_PAYMENT`, `SET_SPEND_LIMIT`, `BATCH_PAYMENT`, `CHECK_BALANCE` are all features every consumer banking app has via autopay/standing orders — without AI. The agent's defensible wedge is `x402_PAYMENT` and the Circle agent marketplace — paying for things autopay cannot pay for (APIs, agent-to-agent, microtransactions).

**Recommendation:** Re-order the agent skill priorities so the demo leads with `x402_PAYMENT`, not "pay Sara every Friday." The Sara story is impressive technically but doesn't differentiate from Venmo + Apple Pay autopay.

---

## 12. The "Maya-Agent.arc" Naming Decision

🟡 **Medium**

Registering a separate `.arc` name for every agent wallet:
- Doubles the treasury cost per user (5 USDC main + 5 USDC agent).
- Doubles the phishing surface (two named wallets to spoof).
- Provides no functional benefit — agents pay outward, they rarely receive.

**Recommendation:** Don't register `.arc` names for agent wallets. They are internal infrastructure. If a user wants to top up their agent, the UI handles it via "transfer to my agent" — no name needed. Save the 5 USDC and the attack surface.

---

## 13. Existing Code That Needs Reconciling

The current implementation in the `.arc` monorepo:
- `@/c:\Users\DELL\Desktop\Hackathon Products\.arc\packages\web\app\wallet\page.tsx` — implements the `/wallet` route inside the registry frontend.
- `@/c:\Users\DELL\Desktop\Hackathon Products\.arc\packages\web\app\circle-wallet-context.tsx` — Circle session context.
- `@/c:\Users\DELL\Desktop\Hackathon Products\.arc\packages\api\src\circle.ts` — server-side Circle integration.
- `@/c:\Users\DELL\Desktop\Hackathon Products\.arc\packages\api\src\auth.ts` — JWT session helpers.

These were built before this critique. Most of them are reusable but:
- The auth doc's NextAuth + Google flow is **not yet implemented**. Current implementation uses Circle's email OTP only.
- The HMAC policy signing is not implemented.
- Treasury currently registers names directly (Treasury owns each name). Needs the fix from §5.2.
- No idempotency on any backend route yet.
- No audit log table.
- Public profile `/n/<name>` does not exist yet.

---

## 14. Recommended Pre-Build Decisions

These are decisions the owner must make **before** the engineer starts building. Each one shapes the architecture significantly.

| Decision | Options | Recommended |
|---|---|---|
| Treasury custody fix | (a) `registerFor()` contract change; (b) treasury funds user, user registers | (b) for MVP, (a) for v1 |
| Name renewal payer | (a) treasury forever; (b) user auto-debit; (c) expire | (b) auto-debit, with grace period |
| QR contents | (a) raw `0x`; (b) profile URL | (b) profile URL |
| Recipient address strategy | (a) cache; (b) re-resolve | (b) re-resolve + pause on change |
| Agent wallet `.arc` name | (a) register; (b) skip | (b) skip |
| Recovery flow | Document Circle's exact behaviour | TBD — research required |
| Bot protection on signup | Turnstile / phone / invite | All three at launch |
| Subdomain or path | `wallet.dotarc.my` vs `dotarc.app/wallet` | Subdomain when domain is bought |

---

## 15. Build Order Adjustment

Original build order from master doc Section 22 is sound but missing critical security items. Insert these:

```
WEEK 1 — Foundation
  □ Auth (Google OAuth via NextAuth + Circle session persistence)
  □ /api/user/load (single endpoint for app open)
  □ user_id-as-primary-key everywhere
  □ JWT issuance + verification
  □ Bot protection on signup (Turnstile)
  □ Audit log table from day one

WEEK 2 — Wallet UX
  □ Circle user-controlled wallet creation
  □ .arc registration (treasury-funds-user pattern)
  □ Main wallet dashboard (balance, QR, name)
  □ Send by .arc name
  □ Receive (QR encodes profile URL)
  □ Public profile page /n/<name>
  □ Spend limits for main wallet
  □ Transaction history (read from Circle webhooks)

WEEK 3 — Polish & Hardening
  □ Recovery flow
  □ Lock screen + biometric unlock
  □ Full logout flow with warning
  □ Error states and edge cases
  □ Rate limiting on every API route

(Smart Agent work begins only after Week 3 is solid.)
```

---

## 16. Open Questions for Engineer

These need verification or input from the engineering side before relevant sections are finalised:

1. **Does Circle's user-controlled wallet support recovery on lost-device + lost-Google scenarios?** If no, what's the actual recovery story?
2. **Does the ANS registry contract support `registerFor(name, owner)`?** If no, what's involved in adding it?
3. **Does Circle support per-wallet spend caps natively?** If yes, use them as belt-and-braces for our DB caps.
4. **Does Circle webhook notify on every USDC inbound to a user-controlled wallet?** Required for accurate balance cache.
5. **What's the actual rate limit on Circle's API per app?** Affects how we design the cron and load endpoint.
6. **What does Circle charge per wallet creation / per signed transaction at scale?** Required to model unit economics.
7. **What's the feasibility of publishing `@arcnames/sdk` to npm so the wallet project can depend on it cleanly?**

---

## 17. Document Hygiene

🟢 **Note**

- Master doc and auth doc both include database schemas that should be merged into a single canonical schema doc — currently there is risk of them drifting.
- `treasury.arc` is mentioned in master doc section 5 — drop this. The treasury is a wallet address, no name needed (same logic as agent wallets in §12).
- Section 18 (`agents.circle.com`) lists DotArc as a marketplace seller in Phase 4. Listing has real onboarding requirements (KYC, legal entity). Confirm requirements before promising the timeline.
- The "OTP once per device" and "OTP never under normal use" phrasings disagree across master and auth docs. Pick one and replace globally.

---

## 18. Verdict

**Executable as written: ~70% of Phase 1 and Phase 2.**

The wallet UX, auth layering, and database design are buildable with the fixes above. The Smart Agent is buildable but is currently described in non-custodial language while implemented as custodial — that mismatch must be resolved before anything ships to users. The treasury economics need a redesign before public launch or the system is trivially drainable.

**Top 5 changes before build:**
1. HMAC every agent policy.
2. Treasury-funds-user (not treasury-registers-name).
3. QR encodes profile URL with smart routing.
4. Re-resolve recipient on every cron run.
5. Drop the "never see OTP again" promise; replace with "OTP once per device."

This document supersedes any conflicting guidance in master/auth docs where security is concerned. When in doubt, prefer the more conservative option here.
