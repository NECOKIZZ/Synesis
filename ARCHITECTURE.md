# DotArc Smart Wallet — Architecture

> **Date:** 2026-06-09  
> **Scope:** Unified architecture reflecting current codebase. Replaces all prior DOTARC_* docs.

---

## Table of Contents

1. [What DotArc Is](#1-what-dotarc-is)
2. [Core Design Principle](#2-core-design-principle)
3. [Tech Stack](#3-tech-stack)
4. [Wallet Types](#4-wallet-types)
5. [Authentication & Security](#5-authentication--security)
6. [Database Schema](#6-database-schema)
7. [Smart Agent V3](#7-smart-agent-v3)
8. [Skill System](#8-skill-system)
9. [Agent Memory](#9-agent-memory)
10. [Policy Orchestration & Cron](#10-policy-orchestration--cron)
11. [Name Service (ANS)](#11-name-service-ans)
12. [Circle Webhooks & Realtime](#12-circle-webhooks--realtime)
13. [Known SDK Limitations](#13-known-sdk-limitations)
14. [Mainnet Checklist](#14-mainnet-checklist)

---

## 1. What DotArc Is

DotArc is a USDC-native wallet on Arc where identity is a `.arc` name. Two modes, one app:

- **Main Wallet** — Circle user-controlled wallet. PIN-protected. Sends/receives USDC by name (`sara.arc`).
- **Smart Agent** — Optional AI agent. Plain-English instructions: "send 5 USDC to sara every Friday", "swap 10 USDC to cirBTC", "I know Arsenal will win the UCL".

No `0x` addresses shown by default. No seed phrases. Gas is USDC on Arc.

---

## 2. Core Design Principle

**Never show crypto complexity unless the user asks.**

| Hide | Show Instead |
|---|---|
| `0x` addresses | `maya.arc` |
| Seed phrases | Email OTP / Google sign-in |
| Gas fees | Nothing (USDC is gas) |
| Chain IDs | Nothing |
| Private keys | Transaction PIN |

---

## 3. Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 15 (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS + shadcn/ui |
| Auth | Supabase Auth (email OTP) |
| Database | Supabase Postgres (RLS + service-role) |
| Wallets | Circle User-Controlled (main) + Developer-Controlled (agent + treasury) |
| LLM | Claude via OpenRouter |
| Swap/Bridge | Circle App Kit + CCTP |
| Name Registry | Arc Testnet ANS (`0xf5e0E328119D16c75Fb4a001282a3a7b733EF6db`) |

---

## 4. Wallet Types

### 4.1 Main Wallet (User-Controlled)
- Circle MPC wallet. User authenticates via email OTP (Supabase) → Circle SDK creates wallet.
- PIN required for every send from main wallet.
- Session persisted in device secure storage by Circle SDK.
- Address is what `maya.arc` resolves to.

### 4.2 Agent Wallet (Developer-Controlled)
- Created during agent activation. Backend-signed via Circle entity secret.
- No Circle PIN. Agent actions are gated by agent PIN (bcrypt) or re-auth.
- Holds USDC for agent-executed transfers. User tops up from main wallet.
- Address ends in `-agent` suffix on `.arc` (not enforced on-chain).

### 4.3 Treasury Wallet (Developer-Controlled)
- Single wallet funded with USDC. Pays 5 USDC per `.arc` name registration.
- Signs via `createContractExecutionTransaction` API. No raw private key exists.
- Entity secret + recovery file are the only credentials.

---

## 5. Authentication & Security

Four security layers. Every money-moving route enforces all applicable layers.

### L1 — Session Identity
- `requireAgentSession()` validates DotArc JWT cookie + Supabase JWT.
- Cross-checks email in both tokens (prevents session swap attacks).
- `getClaims()` preferred; falls back to `getUser()`.

### L2 — Wallet Ownership
- Every route derives `user_id` server-side from the verified JWT.
- `agent_wallets.user_id === supabaseUserId` check before any wallet operation.
- No client-provided `userId`, `walletAddress`, or `amount` is ever trusted.

### L3 — Agent PIN + Lockout
- Stored as bcrypt hash (12 rounds) in `agent_wallets.agent_pin_hash`.
- 3 wrong attempts → 15 min lockout.
- 5 wrong attempts → 60 min lockout.
- Successful entry resets `pin_attempts` to 0.
- Optional: user can choose Google re-auth instead of PIN at agent activation.

### L4 — Policy HMAC
- Every stored policy in `agent_policies` is HMAC-SHA256 signed with `POLICY_HMAC_SECRET`.
- Fields signed: `userId || policyId || actionSkill || actionParams || triggerType || triggerParams || executionMode || createdAt`.
- Cron verifies HMAC before every execution. A DB compromise alone cannot forge a policy.

---

## 6. Database Schema

### 6.1 `profiles`
| Column | Purpose |
|---|---|
| `id` | Supabase auth user UUID |
| `email` | User email |
| `arc_name` | Registered `.arc` name |
| `circle_user_id` | Circle user ID |
| `wallet_address` | Main wallet address (populated by webhook) |

### 6.2 `agent_wallets`
| Column | Purpose |
|---|---|
| `user_id` | FK to profiles |
| `circle_wallet_id` | Circle dev-controlled wallet ID |
| `wallet_address` | Agent wallet address |
| `balance_cache_usdc` | Last known balance |
| `auth_method` | `"pin"` or `"google_reauth"` |
| `agent_pin_hash` | bcrypt hash (null if Google method) |
| `pin_attempts` | Failed PIN count |
| `pin_locked_until` | Lockout timestamp |

### 6.3 `user_security`
| Column | Purpose |
|---|---|
| `user_id` | FK |
| `pin_hash` | bcrypt hash |
| `failed_attempts` | Count |
| `lockout_until` | Timestamp |

### 6.4 `user_spend_limits`
| Column | Purpose |
|---|---|
| `user_id` | FK |
| `max_per_transaction` | USDC cap per tx |
| `daily` | Daily cap |
| `weekly` | Weekly cap |
| `monthly` | Monthly cap |

### 6.5 `agent_policies`
| Column | Purpose |
|---|---|
| `id` | UUID |
| `user_id` | FK |
| `trigger_type` | `time` / `price` / `balance_above` |
| `trigger_params` | JSON (cron expr, threshold, etc.) |
| `action_skill` | Skill to execute |
| `action_params` | JSON |
| `execution_mode` | `once` / `repeat` |
| `next_run` | Next execution time |
| `active` | Boolean |
| `hmac` | HMAC-SHA256 signature |

### 6.6 `agent_spend_log`
| Column | Purpose |
|---|---|
| `id` | UUID |
| `user_id` | FK |
| `status` | `PENDING` → `COMPLETE` / `FAILED` |
| `amount_usdc` | Amount |
| `tx_hash` | On-chain tx hash |
| `error_message` | On failure |

Lifecycle: `PENDING` inserted **before** Circle call. Updated to `COMPLETE` or `FAILED` after. Counted in spend limit calculations.

### 6.7 `agent_audit_log`
- Every skill execution (success, failure, replay). Non-fatal — logging outage never blocks execution.

### 6.8 `agent_idempotency`
- Deduplication window per skill+key. 90s for fund-affecting, 30s otherwise.

### 6.9 `wallet_transactions`
- Main wallet activity. Populated by Circle webhook (`challenges.createTransaction` → `CLEARED`).

### 6.10 `user_memory`
- Agent memory Layer B. Kinds: `contact`, `spending_pattern`, `token_pref`, `preference`, `note`.
- `record_user_memory` RPC upserts with increment on `hit_count`.

---

## 7. Smart Agent V3

### 7.1 Two-Phase Design

| Phase | Route | Does |
|---|---|---|
| **Interpret** | `POST /api/agent/interpret` | LLM turns English → structured `Task[]` JSON. Never executes. |
| **Confirm** | `POST /api/agent/confirm-policy` | PIN gate → idempotency → execute. |

The LLM **proposes only**. It can never move money directly.

### 7.2 V3 Task Model

A single user message can produce **multiple independent tasks**, each with its own trigger and execution mode.

```ts
interface Task {
  steps: PlanStep[];
  trigger: { type: "now" | "time" | "price" | "balance_above" | "and-composite"; ... };
  execution_mode: "once" | "repeat";
  confirmation_message: string;
}
```

Example: *"send half to sara on Friday, withdraw the rest now"* → two tasks:
- Task 0: trigger `{type:"time", when:"friday"}`, mode `"once"`
- Task 1: trigger `{type:"now"}`, mode `"once"`

### 7.3 Interpret Flow

1. `requireAgentSession()` [L1]
2. Validate instruction (non-empty, max 500 chars)
3. Load context: `getAgentBalance()`, `user_spend_limits`, `agent_policies`, `user_memory`
4. `buildSystemPrompt(context)` → injects balance, limits, policies, date, memory
5. POST to OpenRouter (Claude) → raw JSON
6. `validateSkillResult()` → enforce schema
7. `extractAllRecipients()` → resolve `.arc` names fail-fast
8. Return `InterpretResult` to UI

### 7.4 Confirm-Policy Flow

1. `requireAgentSession()` [L1]
2. `agent_wallets` lookup [L2]
3. Validate steps, skills, `$prev` references
4. Pre-flight balance check (cached)
5. Pre-flight name resolution (TOCTOU prevention)
6. `verifyAgentPinOrThrow()` [L3]
7. `withUserLock(userId)` → critical section
8. `getAgentBalance()` live [L3.5]
9. `claimIdempotency()` → claimed / replay / in_flight / recent_failure
10. Dispatch: `executePlan()` for now-tasks, or `CREATE_POLICY` for scheduled
11. `finalizeIdempotency()` + `logSkillExecution()`

### 7.5 Compound Task Execution (`executePlan`)

Sequential step execution with `$prev.*` resolution:

```ts
"amount": "$prev.amountOut"  // resolved from previous step's result
```

Available `$prev` fields per previous skill:
| Previous | Fields |
|---|---|
| `SWAP_USDC` | `amountOut`, `tokenOut`, `amountIn`, `tokenIn`, `txHash` |
| `SEND_TOKEN` | `txHash`, `recipientAddress`, `amount`, `token` |
| `SEND_USDC` | `txHash`, `recipientAddress`, `amountUsdc` |
| `BRIDGE_USDC` | `burnTxHash`, `amount`, `fromChain`, `toChain` |

Failure handling: if step N fails, steps 1..N-1 have already executed. Response includes which steps succeeded so the user knows their token state.

---

## 8. Skill System

### 8.1 SkillHandler Contract

```ts
interface SkillHandler {
  category: "READ" | "TRANSFER" | "CONFIG" | "POLICY";
  affectsFunds: boolean;
  requiresPin?: boolean;
  validate?(params): Record<string, unknown>;
  execute(ctx: SkillContext): Promise<SkillOutput>;
}
```

Skills **never import each other**. Shared logic lives in `lib/agent.ts`.

### 8.2 Skill Registry

| Skill | Category | PIN | Funds | File |
|---|---|---|---|---|
| `CHECK_BALANCE` | READ | No | No | `check-balance.ts` |
| `LIST_POLICIES` | READ | No | No | `list-policies.ts` |
| `IKNOW` | READ | No | No | `iknow.ts` |
| `GET_PRICE` | READ | No | No | `get-price.ts` |
| `SEND_USDC` | TRANSFER | Yes | Yes | `send-usdc.ts` |
| `SEND_TOKEN` | TRANSFER | Yes | Yes | `send-token.ts` |
| `SWAP_USDC` | TRANSFER | Yes | Yes | `swap-usdc.ts` |
| `BRIDGE_USDC` | TRANSFER | Yes | Yes | `bridge-usdc.ts` |
| `PAY_X402` | TRANSFER | Yes | Yes | `pay-x402.ts` |
| `WITHDRAW` | TRANSFER | Yes | Yes | `withdraw.ts` |
| `SET_LIMIT` | CONFIG | Yes | No | `set-limit.ts` |
| `CREATE_POLICY` | POLICY | Yes | No | `create-policy.ts` |
| `CANCEL_POLICY` | POLICY | Yes | No | `cancel-policy.ts` |

### 8.3 TRANSFER Skill Pattern

Every money-moving skill follows the same safety pattern:

1. Validate params (amount > 0, valid addresses, supported tokens)
2. `checkBalanceSufficient()` — real Circle API call
3. `[if external send]` `checkSpendLimits()` — vs limits + `getSpentSince()`
4. `INSERT` `agent_spend_log` `PENDING`
5. Call Circle / App Kit
6. `UPDATE` `agent_spend_log` → `COMPLETE` (tx_hash) or `FAILED` (error)

**`SWAP_USDC` exception:** swaps transform value within the wallet. No spend limit check, no spend_log entry.

**`BRIDGE_USDC` modes:** self-bridge (no limits) vs cross-chain send (spend limits apply).

### 8.4 IKNOW (Oracle Query)

Queries a prediction-market oracle with the user's belief statement.

```ts
// lib/skills/iknow.ts
const ORACLE_BASE = process.env.POLYMARKET_ORACLE_URL;
fetch(`${ORACLE_BASE}/query?belief=${encodeURIComponent(belief)}`, { signal })
```

Timeout: **20 seconds** (was 6s, increased due to slow oracle responses).

Response handling priority (frontend):
1. `verdict === "MATCH"` + `market` exists → show market (even if `success === false`)
2. `stage === "broad_summary"` + suggestions → numbered list
3. Any suggestions → closest matches
4. Fallback → "not found"

---

## 9. Agent Memory

Three layers. Only Layers A and B are shipped. Layer C is experimental.

### 9.1 Layer A — In-Session History
- Client-side `useState` in chat surfaces (`wallet-shell.tsx`, `app/agent/page.tsx`).
- Last 12 turns, human-readable text only (no raw task JSON).
- Sent with every `interpret` call. Server re-validates + re-clamps length.
- Injected between system prompt and new user message.

### 9.2 Layer B — Persisted Habits
- Supabase `user_memory` table (kinds: `contact`, `spending_pattern`, `token_pref`, `preference`, `note`).
- `record_user_memory` RPC upserts with increment on `hit_count`.
- `recallUserMemory()` returns top facts → injected into system prompt as delimited memory block.
- `confirm-policy` records send habits after successful `SEND_USDC`/`SEND_TOKEN`.
- Graceful fallback: recall/record failures never block execution.

### 9.3 Layer C — Walrus Memory (Pending)
- Experimental off-chain storage on Sui.
- Not yet active. A/B test against `pgvector` before depending on it.

---

## 10. Policy Orchestration & Cron

### 10.1 Policy Model

Three parts: **trigger**, **action**, **stop conditions**.

| Trigger Type | Description |
|---|---|
| `time` | Cron schedule — "every Friday", "daily at 9am" |
| `price` | Asset price threshold — "when BTC < $80k" |
| `balance_above` | Agent balance rises above X |

| Execution Mode | Behaviour |
|---|---|
| `once` | Fires once then self-deactivates |
| `repeat` | Fires every time condition met (with cooldown) |

| Stop Condition | Description |
|---|---|
| `balance_below` | Pause if balance drops below X |
| `expires_at` | Stop after date |
| `max_executions` | Stop after N runs |
| `max_total_spend` | Stop after cumulative spend reaches X |

### 10.2 Cron Runner

- Route: `/api/cron/agent-policies`
- Evaluates `time` triggers every minute (via cron-job.org or Vercel cron).
- `evaluateTrigger()` checks trigger type + stop conditions.
- Before execution: verifies HMAC on policy.
- Re-resolves `.arc` names at runtime (names may change).
- Executes via `skillRegistry[skill].execute(ctx)` or `executePlan(steps, ctx)`.

---

## 11. Name Service (ANS)

### 11.1 Registration Flow

1. User completes Circle PIN setup → wallet created
2. Backend calls `treasuryRegisterName(label, userWalletAddress)`
3. Treasury pays 5 USDC fee → calls `register(label, address)` on ANS registry
4. Name resolves on-chain: `maya.arc` → `0x...`

### 11.2 Current Limitations

- Treasury is the on-chain owner of all registered names (because it is `msg.sender`).
- Reverse resolution is broken (returns treasury, not user).
- Forward resolution works — users can receive USDC at their `.arc` name.
- **Self-healing renewal:** After ~1 year, name expires. User re-registers from own wallet → becomes proper owner.

### 11.3 Before Mainnet

- Switch from unlimited USDC approval to exact just-in-time approvals per registration.
- Verify registry contract address with Arc Network team.
- Move registry address to a constants file (not just env var).

---

## 12. Circle Webhooks & Realtime

### 12.1 Webhook Endpoint

`POST /api/webhooks/circle`

Handles:
- **Transaction events** (`transfers`, `transactions`) — updates `wallet_transactions`
- **Challenge events** (`challenges.initialize`) — on `COMPLETE`, fetches wallet and updates `profiles.wallet_address`

Signature verification enforced. All events acknowledged with `200`.

### 12.2 Supabase Realtime

During onboarding, client subscribes to `profiles.wallet_address` updates:

```ts
// app/circle-wallet-context.tsx
supabase.channel(`onboard-${user.id}`)
  .on("postgres_changes", { event: "UPDATE", table: "profiles", filter: `id=eq.${user.id}` },
    (payload) => {
      if (newWallet && !oldWallet) {
        // Webhook updated profile after PIN completion
        void startCircleFlow(); // triggers fast path
      }
    })
  .subscribe();
```

This auto-transitions the UI from "challenging" to "needs-name" without requiring a manual refresh.

---

## 13. Known SDK Limitations

### 13.1 Circle W3S SDK — 10-Second Timeout

The Circle SDK (`@circle-fin/w3s-pw-web-sdk`) has a **hardcoded 10-second timeout** for iframe `postMessage` communication. If the iframe fails to signal readiness within 10s, the SDK reports "Network error".

**Mitigation:**
- Removed 60-second Promise timeout wrapper in our code (was compounding the problem).
- Rely on webhook (`challenges.initialize` → `COMPLETE`) + Supabase Realtime for onboarding completion signal.
- SDK callback is a nice-to-have, not the source of truth.

### 13.2 Stale Iframe Bug

If `sdk.execute()` fails, the iframe is **not removed from the DOM**. Subsequent retries can target the stale iframe, causing repeated "Network error" and the PIN dialog not appearing.

**Impact:** Affects both development and production. Root cause is in the SDK, not application code.

**Mitigation:** No reliable workaround. Circle SDK internal fix required.

---

## 14. Mainnet Checklist

- [ ] Switch USDC approval from unlimited to exact just-in-time
- [ ] Verify ANS registry contract address with Arc Network
- [ ] Move registry address to verified constants file
- [ ] Add rate limiting + address ownership check to `/api/register-name`
- [ ] Add structured logging to all treasury-touching routes
- [ ] Implement treasury balance monitoring + low-balance alerts
- [ ] Add pre-flight balance check inside `treasuryRegisterName()`
- [ ] Configure Circle App ID allowed domains in console
- [ ] Review + lock Circle social login providers
- [ ] Confirm entity secret + recovery file stored securely offline
- [ ] Confirm Circle API key has minimum required permissions
- [ ] Update `ARC_RPC_URL` and `ARC_REGISTRY_ADDRESS` to mainnet
- [ ] Switch Circle environment from testnet to mainnet
- [ ] Legal review of self-custody disclosure for users
- [ ] Test full signup flow end-to-end on mainnet with real funds
