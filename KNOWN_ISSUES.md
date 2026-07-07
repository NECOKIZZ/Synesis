# Synesis — Known Issues & Open Items

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
| 1.4 GET_PRICE bypassed | prose "no live feeds" | emits task **+ validator accepts it (F-14)** | trace T-013 ✅ + code 2026-07-04 |
| 5.5 Prose escape hatch | prose instead of JSON (4×) | controlled `unknown_reason`; actions stay JSON | trace T-013/T-033/T-035 ✅ |
| 2.9 Category-blind balance gate | `SET_LIMIT` blocked "needs 100 USDC" | **Server + client fixed** — client reads server `upfront_usdc` (F-7, Phase 2) | code + trace T-033 ✅ / client ✅ |
| 5.6 Confirm-card / PIN scope | swap/withdraw/bridge show PIN card | `requiresPin` resolver + client reads `auto_confirm` — no card for no-PIN batches (F-8, Phase 2) | code ✅ / card ✅ |
| 2.10 Gas buffer on withdraw-all | drains to 0, next tx fails | `WITHDRAW_GAS_BUFFER_USDC` | code ✅ |
| 4.6 / 4.11 Circle timeout/retry | 44s hang, 204s 500 | timeout + retry + circuit breaker (`circle.ts`) | code ✅ |
| 4.10 session-end ByteString | em-dash crash, memory dead | **static `X-Title` header hyphenated (F-4)** — not the LLM-body theory | code 2026-07-04 ✅ |

> **2026-07-04 note:** the 2026-07-03 stress test (`STRESS_FINDINGS.md`, F-1…F-19) re-exercised
> several rows above against the *running* build and found two that were marked ✅ on
> v3-hardening but were **not actually closed end-to-end**: 1.4 (validator still rejected the
> emitted task → F-14) and 2.9 (client gate still category-blind → F-7). 4.10's root cause was
> also corrected (static header literal, not LLM summary text). Phase 0 closed 1.4/4.10; 2.9
> client + F-8 card are Phase 2. Lesson: "trace verified emission" ≠ "verified dispatch".

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

### 1.4 GET_PRICE Skill Bypassed by LLM ✅ Fixed (two layers) — 2026-07-04

When asked `what's the price of Bitcoin?`, Claude classified the request as "conversation" (due to the conversational escape hatch in the prompt) and returned prose: `I don't have access to live price feeds...` instead of emitting a `GET_PRICE` task.

- **Layer 1 (LLM emission) — fixed on v3-hardening:** escape hatch removed / controlled
  `unknown_reason`; the model now emits a `GET_PRICE` task (trace T-013 ✅).
- **Layer 2 (validator) — fixed in Phase 0 (F-14):** the emitted task was *still* being
  rejected one layer later because `GET_PRICE` was missing from `VALID_LEAF_SKILLS`
  (`agent-core-v3.ts`) → `unknown or non-leaf skill 'GET_PRICE'`, killing the whole batch.
  Added to the set (`:45`). This hid behind Layer 1 — the trace verified emission, not
  end-to-end dispatch. See `STRESS_FINDINGS.md` F-14.
- **Follow-up (Phase 1 / D1):** a guard asserting `VALID_LEAF_SKILLS === registry keys` so
  the catalog/validator/type/seed can't drift apart again (this exact class of bug).

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

### 2.9 Global Balance Gate Is Category-Blind ✅ Fixed (server + client) — 2026-07-05

`SET_LIMIT` with `amount: 100` was blocked: `Insufficient balance... this batch needs 100.00 USDC.`

- **Server — ✅ fixed:** `confirm-policy` counts only steps whose handler has
  `requiresBalanceCheck=true` (SEND_USDC / WITHDRAW / BRIDGE_USDC). SET_LIMIT (`CONFIG`,
  `affectsFunds:false`) is skipped. (Trace T-033.)
- **Client — ✅ fixed (Phase 2, F-7):** the client no longer re-derives the amount at all.
  Deleted `sumStepsUsdc`/`extractBatchUsdcAmount` from `wallet-shell.tsx`; the pre-flight now
  reads the server-shipped `interpret.upfront_usdc` (computed by the shared `pin-policy` SSOT,
  which both interpret and confirm-policy use — no more two-gates-that-disagree). Logic-verified:
  `set daily 100 + monthly 10000` → `upfront_usdc = 0`.
- **Root cause killed (D2):** server computes the gating authority and ships it; the client
  renders it instead of maintaining a parallel (drifting) copy.
- **Ref:** `STRESS_FINDINGS.md` F-7; `fixplan.md` Phase 2.

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

### 4.10 `session-end` Memory Crash: `ByteString` Encoding ✅ Fixed (Phase 0, 2026-07-04) — root cause corrected

`app/api/agent/memory/session-end` was failing on every session:

```
LLM error: Cannot convert argument to a ByteString because the character at index 21
has a value of 8212 which is greater than 255.
```

- **Corrected root cause (2026-07-04, was wrong before):** char `8212` = em dash, and it
  sat in the **static request header literal** `X-Title: "Synesis Smart Wallet — Memory"`
  (`Synesis Smart Wallet ` = 21 chars → `—`), NOT in LLM-generated summary text. The prior
  theory ("LLM writes summaries with em dashes → raw LLM output into a ByteString context")
  was incorrect — LLM output is sent in the JSON **body** (`JSON.stringify`, unicode-safe)
  and never touches a header.
- **Why the v3-hardening "fix" didn't stop it:** that fix put LLM output in the body — real,
  but it addressed a vector that wasn't the live crash. The static `X-Title` header literal
  remained, so F-4 still fired live on 2026-07-03.
- **Actual fix (Phase 0):** hyphenated both header literals — `session-end/route.ts:193`
  (`- Memory`) and `:295` (`- Profile`). All header-bound strings on this path are now
  static + Latin-1 clean. Memory Layer B (Profile) + Layer C (MemWal) populate again.
- **Impact (was):** two of four memory layers effectively dead system-wide (every interpret
  showed `profile=none`, `recalled=0`) until this landed. Now resolved.
- **Ref:** `STRESS_FINDINGS.md` F-4. Live retest still worthwhile (confirm a real session
  writes a Profile card + MemWal summary end-to-end).

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

### 5.6 Confirm Card Scope Bug ✅ Fixed (PIN + card) — 2026-07-05

**PIN scope** was fixed earlier (`requiresPin` per skill). The remaining half — the *card
itself* still showing for no-PIN money moves like WITHDRAW (F-8) — is fixed in **Phase 2**:
the client's hardcoded read-only auto-confirm allowlist is gone on both surfaces
(`wallet-shell.tsx`, `agent/page.tsx`); the card decision now reads the server-computed
`interpret.auto_confirm` (= `!requires_pin`). No-PIN batches (reads, config, same-user
withdraw/swap/self-bridge, and PAY_X402) auto-execute with no card; outward sends still show
card + PIN. Ref `STRESS_FINDINGS.md` F-8, `fixplan.md` Phase 2. Original report below.

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
| 22 | Fix category-blind balance gate (`SET_LIMIT` should not be gated) | ✅ Fixed server + client (F-7, Phase 2 — client reads server `upfront_usdc`) |
| 23 | Remove conversational escape hatch from interpret prompt | ✅ Fixed (controlled `unknown_reason`) — trace T-013/033/035 |
| 24 | Add gas buffer to `WITHDRAW all` (reserve ~0.1 USDC) | ✅ Fixed (`WITHDRAW_GAS_BUFFER_USDC`) — needs live retest |
| 25 | Fix `session-end` ByteString encoding crash | ✅ Fixed (Phase 0: static `X-Title` header hyphenated, F-4) — needs live retest |
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

---

# Appendix — Mainnet Hardening Checklist

> Items safe to ship for hackathon / testnet but that MUST be addressed before mainnet launch. Kept distinct from the active-bug list above.

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
