# DotArc — Known Issues & Open Items

> **Consolidated:** 2026-06-09 · **Verification pass:** 2026-06-16 (branch `v3-hardening`)  
> **Replaces:** `DOTARC_KNOWN_ISSUES.md`, `AUDIT_1.md`, `DOTARC_WALLET_CRITIQUE.md`, `DOTARC_FUTURE_AUDITS_AND_UPGRADES.md`, `DOTARC_AUTH_AND_SECURITY.md`  
> **Scope:** Every open problem, deferred item, and pre-mainnet task across the codebase.

---

## 0. Verification Status — 2026-06-16

The 2026-06-12 stress test ran against **pre-fix** code. The fixes below now live in
the working tree (branch `v3-hardening`) and were verified two ways:

- **`tsc --noEmit`** — whole tree compiles clean, zero errors.
- **Interpret-phase trace** (`scripts/agent-trace-v3.ts`, live OpenRouter) — the
  prose-hallucination and decomposition regressions are gone.

| Issue | Stress-test symptom | Verified fix | How verified |
|---|---|---|---|
| 1.4 GET_PRICE bypassed | prose "no live feeds" | emits `GET_PRICE` task | trace T-013 ✅ |
| 5.5 Prose escape hatch | prose instead of JSON (4×) | controlled `unknown_reason`; actions stay JSON | trace T-013/T-033/T-035 ✅ |
| 2.9 Category-blind balance gate | `SET_LIMIT` blocked "needs 100 USDC" | `requiresBalanceCheck` flag; gate skipped | code + trace T-033 ✅ |
| 5.6 Confirm-card / PIN scope | swap/withdraw/bridge show PIN card | `requiresPin` resolver (`pin-policy.ts`) | code ✅ |
| 2.10 Gas buffer on withdraw-all | drains to 0, next tx fails | `WITHDRAW_GAS_BUFFER_USDC` | code ✅ |
| 4.6 / 4.11 Circle timeout/retry | 44s hang, 204s 500 | timeout + retry + circuit breaker (`circle.ts`) | code ✅ |
| 4.10 session-end ByteString | em-dash crash, memory dead | LLM output in JSON body, not header | code ✅ |

**Still requires live-testnet verification** (cannot be run headlessly — needs a
logged-in session, funded agent wallet, and PIN): T-023 SEND_USDC, T-027 SWAP_USDC,
T-030 WITHDRAW, T-064–067 compound execution end-to-end, T-079 Layer-A memory.
Run these manually on the dev server before merging to `main`.

---

## Legend

| Symbol | Meaning |
|---|---|
| 🔴 | Critical — affects custody, correctness, or mainnet readiness |
| 🟠 | High — security risk, UX promise broken, or significant debt |
| 🟡 | Medium — polish, scaling concern, or downstream blocker |
| 🟢 | Low — informational, nice-to-have, or future feature |
| ✅ | Done (kept for historical context) |

---

## 1. Token & Oracle Gaps

### 1.1 Missing cirBTC Contract Address 🟡

Circle App Kit chain definitions only expose `usdcAddress` and `eurcAddress` for Arc Testnet. `cirBTC` has no public contract address.

- `lib/skills/send-token.ts` hardcodes `CIRBTC: { address: null, ... }`
- `lib/skills/swap-usdc.ts` hardcodes `CIRBTC: { address: null, ... }`
- Workaround: leave `NEXT_PUBLIC_CIRBTC_TOKEN_ADDRESS=` blank; wallet gracefully skips it
- **Fix:** Get official Arc Testnet cirBTC contract address from Circle

### 1.2 Price Triggers Never Fire 🟡

`agent_policies` accepts `trigger_type: "price"`, but the cron's `evaluateTriggerByType` returns `{ fired: false, reason: "Price triggers not yet implemented" }`.

- Pre-existing from V2; not a V3 regression
- **Quick fix:** Disable price triggers in LLM system prompt (5 min)
- **Proper fix:** Integrate Chainlink / CoinGecko / DEX quote into cron evaluator with cooldown

### 1.3 IKNOW Oracle Timeout 🟡

Timeout increased from 6s → 20s. The oracle is slow; 20s is the pragmatic ceiling. If users still timeout, the oracle itself needs optimization or caching.

### 1.4 GET_PRICE Skill Bypassed by LLM 🟠

When asked `what's the price of Bitcoin?`, Claude classifies the request as "conversation" (due to the conversational escape hatch in the prompt) and returns prose: `I don't have access to live price feeds...` instead of emitting a `GET_PRICE` task.

- `GET_PRICE` skill is never called; no oracle or fallback is invoked.
- Same failure for T-013 (BTC), T-014 (ETH), T-015 (DOGE).
- **Fix:** Remove the conversational escape hatch from the interpret prompt. Force `GET_PRICE` task emission for any price query, then handle "no live feed" in the skill layer, not the LLM.

### 1.5 CCTP Bridging From Arc Not Supported 🟠

`bridge 30 USDC to Base` → `Invalid chain 'Arc_Testnet': Chain "ethereum" is not supported`. Arc is not in the `BridgeChain` enum for CCTP source.

- Bridging FROM Arc Testnet is blocked at the SDK level.
- Bridging TO Arc works (Arc as destination).
- **Fix:** Either (a) add Arc to CCTP `BridgeChain` when Circle supports it, or (b) document that Arc-native bridging is outbound-only via swap/bridge flow, not direct CCTP.

---

## 2. Security & Auth

### 2.1 Duplicate Agent Routes Still Exist 🟠 — partially resolved (2026-06-16)

Standalone routes bypass the registry and create security drift (e.g. the 2026-06-16
rate limiter protects `confirm-policy` but NOT these side doors). The skills
themselves (`WITHDRAW`, `SET_LIMIT`, `CANCEL_POLICY` in `lib/skills/`, registered in
`lib/skills/index.ts`) are the canonical path and are **untouched** — only the
duplicate HTTP routes are in question.

Verification (2026-06-16):
- `app/api/agent/withdraw/route.ts` — ✅ **dead code, no callers → DELETED.** The
  `WITHDRAW` skill via `confirm-policy` is the live path.
- `app/api/agent/set-limits/route.ts` — ⚠️ **still used** by `agent-activation-modal.tsx:98`
  and `wallet-shell.tsx:1035`. Retiring it requires repointing those buttons to
  `confirm-policy` (`SET_LIMIT`) + live testing. **Deferred.**
- `app/api/agent/cancel-policy/route.ts` — ⚠️ **still used** by `agent/page.tsx:622`,
  `wallet-shell.tsx:1370` & `:2036`. Same migration + test needed. **Deferred.**

- **Remaining fix:** migrate the 4 frontend call sites to `confirm-policy`, then
  delete the two standalone routes. Skills stay; only the routes go.

### 2.2 HMAC Does Not Bind Full Policy Params 🟢 — mostly stale (re-verified 2026-06-16)

Re-checked against `signOrchestrationHmac` (`lib/agent.ts:218`). The V2 canonical
already signs `actionParams`, `triggerParams`, `stopConditions`, `cooldownSeconds`,
`steps`, etc. So the original claims are largely false:
- `day_of_week` / `day_of_month` — **already covered**: they live inside
  `trigger_params`, which is signed.
- arbitrary `params` JSON — **already covered**: `action_params` is signed.
- `next_run` — **must NOT be signed**: the cron legitimately mutates it every run;
  signing it would invalidate every policy after its first fire. The original "fix"
  was wrong here.

Only genuine residual (low severity, robustness not security): `JSON.stringify`
assumes stable key order, but Postgres JSONB may reorder nested keys between
sign-time and verify-time → could cause *false* HMAC rejections. A recursive
sorted-key canonicalization would harden this, but must be done carefully (a naive
change invalidates all existing signed policies). **Not urgent; no action taken.**

### 2.3 No Rate Limiting on Agent Routes 🟠

`/api/agent/interpret` (calls OpenRouter, costs money) and `/api/agent/confirm-policy` (moves money) have no rate limits.

- **Fix:** Per-user token bucket — e.g. 10 interprets/min, 5 confirms/min. Use `rate_limits` table or Upstash.

### 2.4 `requireAgentSession` Missing Cross-Email Check ✅ Already done (verified 2026-06-16)

Re-checked `lib/agent.ts:103-108`: `requireAgentSession` **does** cross-check
`claimEmail !== session.email → 401 "Session mismatch"`. The doc was stale. No action.

### 2.5 WITHDRAW Spend-Limit Semantics 🟡

`WITHDRAW` writes to `agent_spend_log` and counts against `max_daily_usdc`. Withdrawing to your own main wallet consumes the daily quota.

- **Decision needed:** (a) keep counting (simpler), or (b) exclude `WITHDRAW` from spend limits (cleaner semantics)
- **Recommendation:** (b) — filter `skill != "WITHDRAW"` in `getSpentSince`

### 2.6 Unlimited USDC Approval on Treasury 🔴

Treasury granted one-time unlimited approval (`2^256 - 1`) to ANS registry contract. If registry is exploited, treasury can be drained.

- **Fix:** Switch to just-in-time exact approvals (5 USDC per registration) inside `treasuryRegisterName()`

### 2.7 `/api/register-name` Hardening 🟡 — re-scoped (verified 2026-06-16)

Actual route is `app/api/circle/register-name/route.ts`. Re-checked:
- Ownership check — ✅ **already safe**: uses `session.walletAddress`, never a
  client-supplied address (no spoofable field).
- Structured logging — ✅ **already present** (server-side error logs, lines 96/103).
- Rate limiting — missing, but Guard 1 (`reverseLookup`) caps each wallet to one
  name, so plain rate limiting adds little.
- **Real residual (TOCTOU double-payment race) — ✅ Fixed (2026-06-16):** the
  guard+register critical section is now wrapped in `withUserLock(session.walletAddress)`
  so concurrent registrations for the same wallet serialize and can't double-charge
  the treasury. Same-instance protection (matches confirm-policy's accepted caveat);
  cross-instance hardening (Postgres advisory lock) remains a mainnet item. Touches
  the treasury payment path → **verify on testnet** (concurrent double-submit).

### 2.8 No Bot Protection on Signup 🟠

5 USDC per signup, no bot protection. 10k fake emails → 50k USDC drained.

- **Fix:** Add Cloudflare Turnstile / hCaptcha before wallet creation

### 2.9 Global Balance Gate Is Category-Blind 🔴

`checkBalanceSufficient()` in `confirm-policy` treats **every** numeric parameter as a spend amount. `SET_LIMIT` with `amount: 100` is blocked: `Insufficient balance. Your agent wallet has 4.66 USDC but this batch needs 100.00 USDC.`

- `SET_LIMIT` updates a DB row. Costs zero USDC. Should never hit a balance gate.
- `IKNOW`, `CHECK_BALANCE`, `LIST_POLICIES` are similarly gated if they contain numeric params.
- **Root cause:** No `requiresBalanceCheck: boolean` flag per skill. All tasks flow through the same pre-flight gate.
- **Fix:** Add `requiresBalanceCheck: boolean` and `requiresPin: boolean` to each skill definition. Skip gate for `false`.

### 2.10 No Gas Buffer on "Withdraw All" 🟠

`withdraw all my funds` withdraws the **entire** agent wallet balance. Zero USDC remains. Next Arc transaction (gas in USDC) fails.

- Agent should auto-reserve ~0.1 USDC for gas.
- **Fix:** In `WITHDRAW` skill handler, when `amount === "all"`, subtract `GAS_BUFFER_USDC` (0.1) before executing transfer.

### 2.11 WITHDRAW Spend-Limit Semantics 🟡

`WITHDRAW` writes to `agent_spend_log` and counts against `max_daily_usdc`. Withdrawing to your own main wallet consumes the daily quota.

- **Decision needed:** (a) keep counting (simpler), or (b) exclude `WITHDRAW` from spend limits (cleaner semantics)
- **Recommendation:** (b) — filter `skill != "WITHDRAW"` in `getSpentSince`

---

## 3. Cron & Policy Execution

### 3.1 Cron Row-Level Claim/Lock Missing ✅ Fixed (2026-06-16) — needs live retest

**Resolution (branch `v3-hardening`, migration `0012_cron_runs.sql`):** Each policy
fire now claims a slot via the atomic `claim_cron_run()` RPC before executing. Two
concurrent cron invocations race the claim; only the winner runs. A stale claim
(crashed holder, older than `CRON_CLAIM_STALE_SECONDS`=300) is retaken.

### 3.2 Cron Idempotency (Circle API) ✅ Fixed (2026-06-16) — needs live retest

**Resolution:** Same `cron_runs` mechanism. The slot key is `(policy_id,
scheduled_for)` — `next_run` for time triggers, minute-bucket for price/balance —
so a Vercel retry within the cycle hits the unique claim and is an idempotent skip
instead of a second payment. Transient failures `freeClaim()` so the next tick can
retry; permanent failures deactivate the policy. Wired in
`app/api/cron/agent-policies/route.ts` (`runPolicy`).

### 3.3 No Cron Per-Run Quota 🟡

Many policies due in one hour may exceed Vercel execution time limit.

- **Fix:** Pagination (process N policies per run) + catch-up cron for missed runs

### 3.4 Recipient Address Re-Resolution + Pause 🟡

Policy stores `recipient_address` at creation time. If `sara.arc` changes ownership, payments go to wrong wallet.

- **Fix:** Re-resolve `.arc` names every cron run. If resolved address changed from previous run, pause policy and notify user for re-confirmation.

### 3.5 Timezone for Recurring Policies 🟡

"Every Friday" is computed in UTC/server time, not user's timezone.

- **Fix:** Store user's timezone on policy at creation; compute `next_run` in that timezone

### 3.6 Recurring Compound Amounts Frozen 🟡

Recurring swap policies (e.g. "every Friday, swap 100 USDC to BTC") store the BTC amount computed at creation time. Price drift means the dollar value diverges.

- **Fix:** At each cron tick, re-quote using live prices and recompute input amount to preserve user's original dollar intent

---

## 4. Performance & Architecture

### 4.1 Synchronous Tx Confirmation in confirm-policy 🟠

`confirm-policy` polls Circle until transaction confirms before returning. Slow UX, timeout risk on serverless.

- **Fix:** Async lifecycle — return `{ status: "submitted", circleTxId }` immediately; background worker/cron resolves final state

### 4.2 Balance Cache Not Used 🟡

`/api/agent/status` and `/api/agent/interpret` hit Circle API for fresh balance on every request.

- `agent_wallets.balance_cache_usdc` and `balance_cache_at` exist but are not read
- **Fix:** Use cache if `< 30s` old; add explicit `/api/agent/refresh-balance` endpoint

### 4.3 RPC Providers Initialized at Import Time 🟡

`lib/circle.ts` and `lib/ans.ts` create `JsonRpcProvider` at module import, causing cold-start spam.

- **Fix:** Lazy-create via `getArcProvider()` / `getRegistryContract()` accessors

### 4.4 CHECK_BALANCE Cache Fallback Missing 🟡

Docs promise Circle-down fallback to cached balance; code returns 502.

- **Fix:** Extend `SkillContext.agentWallet` with `balance_cache_usdc` / `balance_cache_at`; fallback in skill

### 4.5 Lazy RPC Provider Initialization 🟡

Same as 4.3 — providers instantiated at import, not on demand.

### 4.6 Circle API `socket hang up` / `ECONNRESET` 🔴

`circleDev.getWalletTokenBalance()` (and other Circle SDK calls) have **no explicit timeout**. Circle Testnet drops TCP sockets mid-request.

- Each hung call waits **44+ seconds** before failing with `ECONNRESET`.
- `confirm-policy` with 3 tasks serially = **204 seconds total** for a 500 error.
- **Impact:** All money-moving skills (`SEND_USDC`, `WITHDRAW`, `SWAP_USDC`) fail. No graceful fallback.
- **Fix:** Add `timeout: 10_000` to all Circle SDK calls. Wrap in retry (3×, exponential backoff). Return friendly "Circle is temporarily unavailable — please try again" instead of 500.

### 4.7 Skills Run Serially, Not Parallel 🟠

`runBatch()` in `confirm-policy` awaits each task sequentially with `for...of`.

- 3 tasks × 44s hung calls = 3+ minute total response time.
- No feedback to user during wait; UI appears frozen.
- **Fix:** Run independent tasks in parallel with `Promise.allSettled()`. Preserve dependency order for `$prev`-chained steps only.

### 4.8 Redundant Balance API Calls 🟡

`SEND_TOKEN`, `WITHDRAW`, and `SWAP_USDC` each independently call `getAgentBalance()` to Circle.

- Same flaky endpoint hit 3× per compound task.
- **Fix:** Compute balance **once** in `confirm-policy` pre-flight and pass it into each skill's context.

### 4.9 OpenRouter Connect Timeout 🟠

`ConnectTimeoutError` to Cloudflare (`172.64.149.246:443`) after 10s on first interpret attempt.

- Retry succeeds but adds **~63s** latency.
- **Fix:** Increase OpenRouter `fetch` timeout from 10s to 30s. Add pre-warm health check on app load.

### 4.10 `session-end` Memory Crash: `ByteString` Encoding 🔴

`app/api/agent/memory/session-end` fails on every session:

```
LLM error: Cannot convert argument to a ByteString because the character at index 20
has a value of 8212 which is greater than 255.
```

- Character `8212` = em dash (`—`, U+2014). LLM writes summaries with em dashes.
- The endpoint passes raw LLM output into a `ByteString` context (likely HTTP header or `FormData` field).
- **Impact:** **Layer A memory is completely broken.** Session summaries never persisted. Agent cannot remember context between sessions.
- **Fix:** Sanitize LLM output before passing to `ByteString` contexts. Replace Unicode em dash with ASCII hyphen (`-`). Or store summary in request body/DB directly, not in headers.

### 4.11 No Circuit Breaker on Circle Failures 🟠

Raw `ECONNRESET` is thrown through to the user as a hard 500 crash.

- No retry/backoff. No graceful fallback message.
- **Fix:** Wrap Circle SDK calls in a circuit breaker (e.g., 3 failures → 30s cooldown). Return `"Circle is temporarily down — please retry in a moment."`

---

## 5. UX & Polish

### 5.1 Mobile Layout Responsiveness 🟡

Activity rows truncate addresses aggressively. Agent chat bubbles overflow on `< 380px`. Token balance rows have tight padding.

- **Status:** Cosmetic; doesn't block functionality

### 5.2 Send Modal — No Sound + No Entrance Animation 🟢

Modal pops instantly, no audio feedback on success.

- **Fix:** framer-motion transitions + `public/sounds/` + `lib/sound.ts` mute-aware wrapper

### 5.3 Prompt Bloat 🟡

V3 system prompt is ~3,000 tokens. Models lose fidelity on long prompts.

- **Fix:** Trim worked examples (5 → 2), remove "SMART BALANCE INFERENCE" prose, merge "HARD RULES" into output shape. Target: ~1,200 tokens.

### 5.4 Add `reasoning` Field to LLM Output 🟡

Claude reasons about complex balance scenarios AND formats JSON simultaneously. Easy to self-contradict.

- **Fix:** Add `reasoning` string field to JSON schema. Model writes reasoning first, then `tasks`. Backend ignores the field; purely a scratchpad.

### 5.5 Conversational Escape Hatch Causes JSON Parse Failures 🟠

The V3 prompt (lines 115–127) explicitly teaches Claude that `unknown_reason` is for "helpful, conversational answers." When Claude sees a simple condition (insufficient balance, simple config change, unsupported asset), it takes the easier path: writes prose directly instead of structured JSON.

**Failure modes observed (4× in one session):**

| Input | Claude's Thought | What It Outputs |
|---|---|---|
| `send 50 USDC` ($4.66 balance) | "I'll explain why this can't happen" | Prose: `Insufficient balance. Your agent wallet has 4.66 USDC...` |
| `set limit to 100` | "This is a simple config change" | Prose: `Insufficient balance... this batch needs 100.00 USDC` |
| `withdraw all my funds` | "I'll just confirm what I did" | Prose: `✓ Withdrew all funds (3.66 USDC)...` — **fake success hallucination** |
| `what's the price of Bitcoin?` | "This is conversation, not action" | Prose: `I don't have access to live price feeds...` |

- **Root cause:** The prompt has split personality. Lines 115–127 say "prose is fine for conversation"; line 393 says "NEVER prose." Claude picks the easier instruction.
- **Fix:** Remove the conversational escape hatch entirely from the **interpret** prompt. Every response must be JSON. Handle "no live feed" / "insufficient balance" inside the skill layer, not the LLM. Reserve a separate prose-generation step (post-skill) for the actual UI message.

### 5.6 Confirm Card Scope Bug 🟠

Every `trigger: "now"` task shows a `ConfirmCard` + PIN prompt. But only **external sends** (`SEND_USDC` / `SEND_TOKEN` / `SEND_EURC` to another user) should require PIN confirmation.

| Skill | Currently Shows Card? | Should Show? |
|---|---|---|
| `WITHDRAW` (agent → main wallet) | ✅ Yes | ❌ No (same user) |
| `SWAP_USDC` | ✅ Yes | ❌ No (same wallet) |
| `BRIDGE_USDC` (self) | ✅ Yes | ❌ No (same user, different chain) |
| `SET_LIMIT` | ✅ Yes | ❌ No (DB update, zero USDC) |
| `CHECK_BALANCE` / `GET_PRICE` / `LIST_POLICIES` / `IKNOW` | Likely yes | ❌ No (READ skills) |
| `SEND_USDC` to external | ✅ Yes | ✅ Yes |

- **Root cause:** Frontend treats every `trigger: "now"` the same. No `requiresPin: boolean` per skill.
- **Fix:** Add `requiresPin: boolean` and `requiresConfirmCard: boolean` to skill registry. Frontend checks flag. If `false`, skip `ConfirmCard`, execute immediately without PIN.

### 5.7 Supabase Email Template Mismatch 🟡

UI promises "6-digit code"; template sends `{{ .ConfirmationURL }}` instead of `{{ .Token }}`.

- **Fix:** Supabase dashboard tweak — no code change. Deferred until pre-launch polish.

### 5.8 Circle Modal Error Handling Needs Refinement ✅ Fixed (2026-06-16) — needs live retest

**Resolution (branch `v3-hardening`):** The Circle SDK modal now owns its own
interaction (PIN entry, internal retries, cancel); the **webhook + Realtime** own
completion truth. Changes:
- `startCircleFlow` no longer escalates an SDK challenge callback failure to the
  full-screen `"error"` state — it logs and falls through to the existing
  polling + recovery + Realtime safety net.
- `executeChallenge` 60s hard timeout removed (was auto-failing users who left the
  PIN dialog open) → generous 5-min guard phrased as "uncertain — check activity".
- `SendModal.handleConfirm` confirms via the webhook (`confirmSendViaWebhook` →
  `/api/wallet/tx-hash` status) before declaring failure; deliberate cancel returns
  softly to the confirm screen; ambiguous errors show the amber "uncertain" screen.
- `refresh()` now resets `error`; `AuthGate` re-syncs `initialError` via `useEffect`
  so stale errors never bleed onto a fresh login screen.

Verified: `tsc --noEmit` clean. Live retest (onboarding cancel, slow PIN on send,
ambiguous failure) still pending on the dev server.

<details><summary>Original report</summary>

The login flow (`circle-wallet-context.tsx` → `wallet/page.tsx` → `auth-gate.tsx`) has overlapping and persistent error handling around the Circle PIN modal:

1. **Error state persists across page revisits.** `refresh()` sets `status: "anonymous"` but never calls `setError(null)`. When the user revisits `/wallet`, the stale error from a previous failed PIN attempt is still there and gets passed to `AuthGate` as `initialError`, blocking the login screen.
2. **Redundant error handling.** Circle's modal already shows wrong-PIN errors and allows retry internally. Our `catch` block in `startCircleFlow` ALSO surfaces `"Wallet setup was cancelled..."` on any SDK failure, so the user gets two error surfaces.
3. **No error reset on retry.** The "Try again" button in the error screen calls `clearError(); startCircleFlow();`, but `clearError` only resets local React state — if the error came from the Circle SDK callback, the next flow may still hit it.
4. **Modal state vs. app state are not separated.** A transient PIN entry failure should live only inside the modal's own retry loop. It should never propagate into the app's global `error` state or survive a page transition.

- **Fix:** Distinguish "modal cancelled / wrong PIN" (transient, modal-internal) from "infrastructure failure" (persistent, app-level). Only propagate the latter into `error`. Reset `error` aggressively on `startCircleFlow()` entry and in `refresh()`.

</details>

---

## 6. Missing Features (No Code Exists)

### 6.1 Telegram Bot 🟢

No bot token, no webhook receiver, no message parser. Future integration.

### 6.2 WhatsApp Bot 🟢

No Meta app, no Business API approval. Future integration.

### 6.3 Auth Audit Log 🟡

`agent_audit_log` captures skill executions, but no `auth_audit_log` for: logins, PIN changes, auth-method switches, recovery events, lockouts.

- **Fix:** Add `auth_audit_log` table + logging hooks at login/logout/PIN change sites

### 6.4 Recovery Path 🟠

Lose Google account + Circle session = funds unrecoverable.

- **Fix:** Allow separate recovery email; document Circle's exact recovery behavior for user-controlled wallets

### 6.5 Second Factor for Agent Unlock 🟡

5 wrong PIN attempts → unlock via email. Same email is used for Circle OTP. Compromise email = compromise both factors.

- **Fix:** Add recovery codes (generated at signup) or phone-based 2FA for agent unlock

### 6.6 Main Wallet Spend Limits 🟡

`user_spend_limits` is enforced for agent wallet only. Main wallet has no spend caps.

- **Fix:** Apply same limit checks to main wallet sends (or document why not)

### 6.7 Public Profile `/n/<name>` SEO 🟡

Page may be indexed by Google. No `rel="noindex"` confirmed.

- **Fix:** Add `noindex` until user opts in to discovery

---

## 7. Mainnet Checklist

These must be complete before real money is involved.

| # | Item | Status |
|---|---|---|
| 1 | Switch USDC approval from unlimited to exact JIT | 🔴 Open |
| 2 | Verify registry contract address with Arc Network | 🔴 Open |
| 3 | Move registry address to verified constants file | 🟡 Open |
| 4 | Add rate limiting + address ownership check to `/api/register-name` | 🔴 Open |
| 5 | Add structured logging to all treasury-touching routes | 🟡 Open |
| 6 | Implement treasury balance monitoring + alerts | 🟡 Open |
| 7 | Add pre-flight balance check inside `treasuryRegisterName()` | 🟡 Open |
| 8 | Configure Circle App ID allowed domains in console | 🟡 Open |
| 9 | Review + lock Circle social login providers | 🟡 Open |
| 10 | Confirm entity secret + recovery file stored securely offline | 🟡 Open |
| 11 | Confirm Circle API key has minimum required permissions | 🟡 Open |
| 12 | Update `ARC_RPC_URL` and `ARC_REGISTRY_ADDRESS` to mainnet | 🔴 Open |
| 13 | Switch Circle environment from testnet to mainnet | 🔴 Open |
| 14 | Legal review of self-custody disclosure for users | 🟠 Open |
| 15 | Test full signup flow end-to-end on mainnet with real funds | 🔴 Open |
| 16 | Add bot protection (Turnstile) to signup | 🔴 Open |
| 17 | Add cron claim/lock mechanism | 🟠 Open |
| 18 | Delete duplicate agent routes (withdraw, set-limits, cancel-policy) | 🟠 Open |
| 19 | HMAC bind full policy params | 🟠 Open |
| 20 | Add auth_audit_log | 🟡 Open |
| 21 | Fix confirm card scope (only external sends need PIN) | ✅ Fixed (working tree) — needs live retest |
| 22 | Fix category-blind balance gate (`SET_LIMIT` should not be gated) | ✅ Fixed — trace T-033 |
| 23 | Remove conversational escape hatch from interpret prompt | ✅ Fixed (controlled `unknown_reason`) — trace T-013/033/035 |
| 24 | Add gas buffer to `WITHDRAW all` (reserve ~0.1 USDC) | ✅ Fixed (`WITHDRAW_GAS_BUFFER_USDC`) — needs live retest |
| 25 | Fix `session-end` ByteString encoding crash | ✅ Fixed (output in JSON body) — needs live retest |
| 26 | Add timeout + retry to all Circle SDK calls | ✅ Fixed (`circle.ts` resilience) — needs live retest |
| 27 | Add circuit breaker for Circle API failures | ✅ Fixed (`circle.ts` circuit breaker) — needs live retest |
| 28 | Add `requiresPin` / `requiresBalanceCheck` flags to skill registry | ✅ Fixed (all skills declare flags) |
| 29 | Fix CCTP Arc source chain support (or document limitation) | 🟠 Open |
| 30 | Add cirBTC contract address for Arc Testnet | 🟡 Open |

---

## 8. Historical Fixes (Completed)

| Date | Fix | Files |
|---|---|---|
| 2026-05-20 | Tier 1: Shared PIN helper, safe logging, server-side userId, PEND+COMPLETE spend checks, service-role updates, weekly limits, aligned ceilings, tx poll timeout | `lib/agent-pin.ts`, `lib/circle.ts`, `lib/agent.ts`, etc. |
| 2026-05-27 | Agent partial balance prompt | `app/agent/page.tsx` |
| 2026-06-01 | V3 task model, multi-intent, time constraints, main wallet activity, activity page | `lib/agent-core-v3.ts`, migrations |
| 2026-06-06 | Flat task_type hierarchy removed | Migration 0009 |
| 2026-06-07 | JSON repair layer, RECURRING_PAYMENT removal, signup resilience, send modal tx-hash polling, PIN gating (outward-only), friendly errors, error boundaries | `lib/agent-core-v3.ts`, `app/circle-wallet-context.tsx`, `app/auth/callback/route.ts`, etc. |
| 2026-06-09 | IKNOW formatter prioritizes verdict over success; oracle timeout 6s→20s | `app/agent/page.tsx`, `app/wallet/wallet-shell.tsx`, `lib/skills/iknow.ts` |
| 2026-06-12 | **Stress Test Session (Diagnostic):** Identified 11 critical issues: confirm card scope bug, category-blind balance gate, LLM prose hallucinations (prompt split personality), no gas buffer on withdraw-all, `session-end` ByteString crash, Circle API `socket hang up` / no timeout, serial skill execution, redundant balance calls, OpenRouter connect timeout, CCTP Arc source unsupported, cirBTC address null. Documented in `KNOWN_ISSUES.md` sections 1.4–1.5, 2.9–2.10, 4.6–4.11, 5.5–5.6. | `dotarc-stress-test.md`, `KNOWN_ISSUES.md` |
