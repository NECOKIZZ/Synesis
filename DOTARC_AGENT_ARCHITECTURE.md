# DotArc Smart Agent — Architecture & Flow Reference

> **Last updated:** May 2026  
> **Security axiom:** Every route derives identity server-side. No client-provided userId, walletAddress, or amount is trusted without server-side verification.

---

## Table of Contents

1. [High-Level Architecture](#1-high-level-architecture)
2. [Two-Phase Design: Interpret → Confirm](#2-two-phase-design-interpret--confirm)
3. [Phase 1 — POST /api/agent/interpret](#3-phase-1--post-apiageninterpret)
4. [Phase 2 — POST /api/agent/confirm-policy](#4-phase-2--post-apiagentconfirm-policy)
5. [Skill System — The Contract](#5-skill-system--the-contract)
6. [Skill Registry & All Skills](#6-skill-registry--all-skills)
7. [PLAN — The Meta-Skill](#7-plan--the-meta-skill)
8. [Cross-Cutting Infrastructure](#8-cross-cutting-infrastructure)
9. [Database Tables](#9-database-tables)
10. [Security Layers (L1–L4)](#10-security-layers-l1l4)
11. [System Prompt & LLM Behaviour](#11-system-prompt--llm-behaviour)
12. [Full End-to-End Flow Diagram](#12-full-end-to-end-flow-diagram)
13. [Adding a New Skill](#13-adding-a-new-skill)

---

## 1. High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Browser (Next.js)                   │
│  wallet-shell.tsx — chat UI, ConfirmCard, PIN input     │
└────────────┬───────────────────────────┬────────────────┘
             │ POST /api/agent/interpret  │ POST /api/agent/confirm-policy
             ▼                           ▼
┌────────────────────┐       ┌───────────────────────────┐
│  interpret/route   │       │  confirm-policy/route      │
│  (AI only, no exec)│       │  (execution gate)          │
└────────┬───────────┘       └──────────┬────────────────┘
         │                              │
         ▼                              ▼
┌─────────────────┐          ┌──────────────────────────┐
│   lib/agent.ts  │          │   lib/skills/<name>.ts   │
│  buildSystemPrompt         │   SkillHandler.execute() │
│  interpretInstruction      └──────────┬───────────────┘
│  validateSkillResult                  │
└────────┬────────┘          ┌──────────▼───────────────┐
         │                   │   Circle / AppKit / ANS   │
         ▼                   │   Supabase (RLS + service)│
   OpenRouter (Claude)        └──────────────────────────┘
```

**Key principle:** The interpret route calls the LLM and returns intent. It never touches Circle or moves money. The confirm-policy route enforces every security layer, then calls exactly one skill. Skills talk to Circle and Supabase.

---

## 2. Two-Phase Design: Interpret → Confirm

| Phase | Route | Does what |
|-------|-------|-----------|
| **Interpret** | `POST /api/agent/interpret` | Converts plain English → structured `SkillResult` JSON. Calls LLM. Pre-resolves `.arc` names. Returns to UI. |
| **Confirm** | `POST /api/agent/confirm-policy` | User supplies PIN. Route enforces 4 security layers, claims idempotency key, delegates to skill. |

The UI shows a **ConfirmCard** between the two phases. The user reads what will happen, types their agent PIN, and submits. Only then does confirm-policy run.

This design means:
- The LLM can never directly move money — it only proposes.
- All balance checks, spend limit checks, and name resolution happen server-side.
- A wrong PIN attempt (lockout after 3 tries) cannot undo an already-proposed intent.

---

## 3. Phase 1 — POST /api/agent/interpret

**File:** `app/api/agent/interpret/route.ts`

### Input
```json
{ "instruction": "swap 10 USDC to EURC then send to sara.arc" }
```

### Step-by-step flow

```
1. requireAgentSession()
   └── Validate DotArc JWT + Supabase JWT
   └── Cross-check email in both tokens (prevents session swap)

2. Validate instruction
   └── Must be non-empty, max 500 chars

3. Load context for LLM
   ├── getAgentBalance()  → USDC balance string (non-fatal if Circle unavailable)
   ├── user_spend_limits  → max_per_transaction, daily, weekly, monthly
   └── agent_policies     → active policies (summaries, ids, triggers)

4. interpretInstruction({ instruction, context })
   ├── buildSystemPrompt(context)     → inject balance + limits + policies + date
   ├── POST to OpenRouter (Claude)    → ~1–3 sec
   └── validateSkillResult(response)  → throw if schema invalid

5. extractAllRecipients(result)
   └── For SEND_USDC / SEND_TOKEN:  params.recipient
   └── For CREATE_POLICY:           action.params.recipient
   └── For PLAN:                    ALL steps' recipients
   └── For each .arc name → resolveRecipient() → fail fast before PIN

6. Return AnySkillResult JSON to UI
```

### Output (single skill example)
```json
{
  "skill": "SEND_USDC",
  "params": { "recipient": "sara.arc", "amount": 10 },
  "confirmation_message": "Send 10 USDC to sara.arc (0xABCD…)",
  "requires_confirmation": true
}
```

### Output (PLAN example)
```json
{
  "skill": "PLAN",
  "steps": [
    { "skill": "SWAP_USDC", "params": { "tokenIn": "USDC", "tokenOut": "EURC", "amount": 10 }, "description": "Swap 10 USDC → EURC" },
    { "skill": "SEND_TOKEN", "params": { "token": "EURC", "amount": "$prev.amountOut", "recipient": "sara.arc" }, "description": "Send EURC to sara.arc" }
  ],
  "confirmation_message": "Swap 10 USDC to EURC, then send result to sara.arc.",
  "requires_confirmation": true
}
```

### Why `.arc` names are resolved HERE
If the name is invalid or unregistered, we return an `UNKNOWN` result immediately — before the user ever sees a ConfirmCard. Better UX than failing after PIN entry. The confirm-policy route also re-resolves to prevent TOCTOU attacks.

---

## 4. Phase 2 — POST /api/agent/confirm-policy

**File:** `app/api/agent/confirm-policy/route.ts`

### Input (single skill)
```json
{ "pin": "123456", "skill": "SEND_USDC", "params": { "recipient": "0xABCD…", "amount": 10 } }
```

### Input (PLAN)
```json
{
  "pin": "123456",
  "skill": "PLAN",
  "steps": [
    { "skill": "SWAP_USDC", "params": { "tokenIn": "USDC", "tokenOut": "EURC", "amount": 10 }, "description": "..." },
    { "skill": "SEND_TOKEN", "params": { "token": "EURC", "amount": "$prev.amountOut", "recipient": "sara.arc" }, "description": "..." }
  ]
}
```

### Full execution pipeline

```
┌─────────────────────────────────────────────────────────────┐
│  PRE-PIN (fast reject — no expensive ops yet)               │
├─────────────────────────────────────────────────────────────┤
│  L1 requireAgentSession()                                   │
│     DotArc JWT + Supabase JWT cross-check                   │
│                                                             │
│  L2 Wallet ownership                                        │
│     agent_wallets WHERE user_id = supabaseUserId            │
│     (derived server-side — never from client)               │
│                                                             │
│  Fail-fast: unknown skill, PLAN with 0 or >3 steps,        │
│             unknown skill inside PLAN step                  │
│                                                             │
│  Pre-flight balance check (cached)                          │
│     extractPlanAmount sums ALL steps (skips $prev refs)     │
│     vs wallet.balance_cache_usdc                            │
│     → 400 immediately if obviously insufficient             │
│                                                             │
│  Pre-flight name resolution (before PIN)                    │
│     resolveRecipient() for every .arc name in steps         │
│     → 400 if unregistered name                              │
├─────────────────────────────────────────────────────────────┤
│  L3 PIN verification                                        │
│     verifyAgentPinOrThrow() → bcrypt compare                │
│     Lockout: 3 wrong = 15 min, 5 wrong = 60 min            │
├─────────────────────────────────────────────────────────────┤
│  CRITICAL SECTION  (withUserLock — serializes per user)     │
├─────────────────────────────────────────────────────────────┤
│  L3.5 Live balance gateway                                  │
│     getAgentBalance() → real Circle API call               │
│     Definitive check after lock is acquired                 │
│                                                             │
│  Load spend limits from user_spend_limits                   │
│                                                             │
│  Build SkillContext (injected into skill.execute)           │
│     supabase, serviceSupabase, supabaseUserId,              │
│     mainWalletAddress, agentWallet, limits,                 │
│     params, getSpentSince()                                 │
│                                                             │
│  Idempotency claim                                          │
│     claimIdempotency() → insert PENDING row                 │
│     replay  → return cached result (no re-execute)          │
│     in_flight → 409                                         │
│     recent_failure → 409                                    │
│                                                             │
│  Execute                                                    │
│     isPlan → executePlan() (sequential steps)               │
│     else   → handler.execute(ctx)                           │
│                                                             │
│  finalizeIdempotency() → COMPLETE or FAILED                 │
│  logSkillExecution()   → agent_audit_log                    │
└─────────────────────────────────────────────────────────────┘
```

### `getSpentSince(since: Date)`

Counts both `PENDING` and `COMPLETE` rows in `agent_spend_log` since the given timestamp. PENDING rows are counted because an in-flight Circle tx may still settle — this prevents the race condition where two concurrent sends both read the same spend total before either completes.

---

## 5. Skill System — The Contract

**File:** `lib/skills/types.ts`

Every skill is a plain TypeScript object implementing `SkillHandler`:

```typescript
interface SkillHandler {
  readonly category: "READ" | "TRANSFER" | "CONFIG" | "POLICY";
  readonly version: number;
  readonly affectsFunds: boolean;   // true = stricter audit + idempotency + locking
  readonly requiresPin?: boolean;   // default true; false only for READ skills
  idempotencyKey?(params): string | null;   // stable dedup key
  validate?(params): Record<string, unknown>;
  execute(ctx: SkillContext): Promise<SkillOutput>;
  onCronTick?(ctx: CronContext, policy: AgentPolicy): Promise<CronTickOutput>;
}
```

### SkillContext — what every skill receives

```typescript
type SkillContext = {
  supabase: SupabaseClient;          // RLS client — reads, user-owned writes
  serviceSupabase: SupabaseClient;   // service-role — ONLY for spend_log status updates
  supabaseUserId: string;            // verified server-side, never from client
  mainWalletAddress: string;         // from JWT session
  agentWallet: AgentWallet;          // circle_wallet_id, circle_wallet_address, balance_cache
  limits: SpendLimits;               // from user_spend_limits table
  params: Record<string, unknown>;   // the LLM-populated parameters
  getSpentSince(since: Date): Promise<number>; // sum of COMPLETE+PENDING spend log
};
```

**Skills must not re-verify PIN or session** — that already happened in the route.

### SkillOutput

```typescript
type SkillOutput =
  | { ok: true;  result: Record<string, unknown>; status?: number }
  | { ok: false; error: string;                   status?: number };
```

### Rule: skills never import from each other

Skills communicate only through `SkillContext`. If two skills share logic, that logic lives in `lib/agent.ts` (e.g. `checkSpendLimits`, `checkBalanceSufficient`).

---

## 6. Skill Registry & All Skills

**File:** `lib/skills/index.ts`

| Skill Name | File | Category | affectsFunds | PIN | Description |
|---|---|---|---|---|---|
| `CHECK_BALANCE` | `check-balance.ts` | READ | ✗ | ✗ | Returns USDC + all Arc token balances |
| `SEND_USDC` | `send-usdc.ts` | TRANSFER | ✓ | ✓ | Send USDC to `.arc` name or `0x` address |
| `SEND_TOKEN` | `send-token.ts` | TRANSFER | ✓ | ✓ | Send EURC or cirBTC to recipient |
| `SWAP_USDC` | `swap-usdc.ts` | TRANSFER | ✓ | ✓ | Swap tokenIn → tokenOut via Circle AppKit |
| `BRIDGE_USDC` | `bridge-usdc.ts` | TRANSFER | ✓ | ✓ | Move USDC cross-chain via CCTP |
| `PAY_X402` | `pay-x402.ts` | TRANSFER | ✓ | ✓ | Call x402-enabled API, pay in USDC |
| `CREATE_POLICY` | `create-policy.ts` | POLICY | ✓ | ✓ | Create recurring / conditional policy |
| `LIST_POLICIES` | `list-policies.ts` | READ | ✗ | ✓ | List active agent policies |
| `CANCEL_POLICY` | `cancel-policy.ts` | POLICY | ✗ | ✓ | Deactivate a policy by ID |
| `SET_LIMIT` | `set-limit.ts` | CONFIG | ✗ | ✓ | Update per-tx / daily / weekly / monthly caps |
| `WITHDRAW` | `withdraw.ts` | TRANSFER | ✓ | ✓ | Move USDC back to main wallet |
| `RECURRING_PAYMENT` | `recurring-payment.ts` | POLICY | ✓ | ✓ | **DEPRECATED** — use CREATE_POLICY |
| **`PLAN`** | *(meta — no file)* | — | — | ✓ | Multi-step orchestrator (see §7) |

### How TRANSFER skills handle money safety

Every TRANSFER skill follows the same pattern:

```
1. Validate params (amount > 0, valid addresses, supported tokens)
2. checkBalanceSufficient()     → real Circle API balance check
3. [if external send] checkSpendLimits() → vs limits + getSpentSince()
4. Insert PENDING row into agent_spend_log (before calling Circle)
   → If insert fails → abort (no funds touched)
5. Call Circle / AppKit
6. Update spend_log row → COMPLETE (tx_hash) or FAILED (error_message)
```

**SWAP_USDC is an exception** — swaps transform value within the wallet. No spend limit check, no spend_log entry. Balance check is token-aware (checks tokenIn's actual balance, not USDC).

**BRIDGE_USDC has two modes:**
- `toAddress = mainWalletAddress` → self-bridge, no spend limits, no spend_log
- `toAddress ≠ mainWalletAddress` → treated as a cross-chain send: spend limits + PENDING/COMPLETE log

---

## 7. PLAN — The Meta-Skill

PLAN is not in `skillRegistry`. It is handled directly by `confirm-policy/route.ts` via `executePlan()`.

### What it does

Executes up to 3 skills **sequentially**, passing outputs from one step to the next via `$prev.*` references.

### `$prev` reference resolution

Before each step runs, `resolvePrevRefs()` walks the step's params:
```
"amount": "$prev.amountOut"
```
It looks up `amountOut` in the previous step's `output.result`. If the field doesn't exist, it **throws immediately** with a clear error — the literal string `"$prev.amountOut"` is never passed to the skill.

### Available `$prev` fields

| Previous skill | Fields available |
|---|---|
| `SWAP_USDC` | `amountOut`, `tokenOut`, `amountIn`, `tokenIn`, `txHash` |
| `SEND_TOKEN` | `txHash`, `recipientAddress`, `amount`, `token` |
| `SEND_USDC` | `txHash`, `recipientAddress`, `amountUsdc` |
| `BRIDGE_USDC` | `burnTxHash`, `amount`, `fromChain`, `toChain` |

### Idempotency for PLAN

Key is built as:
```
STEP1_SKILL:{params_json}|STEP2_SKILL:{params_json}|...  (truncated at 512 chars)
```
TTL: 90 seconds. If the same plan is submitted twice within 90s, the second call gets the cached result back — Circle is never called twice.

### Failure handling

If step N fails:
- Steps 1..N-1 have already executed (their tokens are in the wallet).
- The response includes `{ error: "Step N failed: ...", steps: [{...}] }`.
- The error message tells the user which steps succeeded.

```
Step 2 failed: Not enough EURC. Step 1 completed — tokens are safe in your agent wallet.
```

### Pre-flight balance check for PLAN

`extractPlanAmount()` sums `amount` across ALL steps, skipping any step whose amount is a `$prev.*` reference (since we don't know it yet). If the sum exceeds the cached balance, the user never sees a PIN prompt.

### PLAN execution diagram

```
confirm-policy receives { skill:"PLAN", steps:[s1,s2,s3], pin }
│
├── L1..L3 security layers (same as single skill)
│
├── withUserLock(userId) → critical section
│
├── claimIdempotency(PLAN:steps-hash)
│   └── replay / in_flight / recent_failure → exit early
│
└── executePlan(steps, ctx)
    │
    ├── Step 1: resolvePrevRefs({}, prev={}) → execute s1 → s1.result
    │   └── logSkillExecution(s1)
    │   └── if fail → { ok:false, error:..., steps:[s1_fail] }
    │
    ├── Step 2: resolvePrevRefs(s2.params, prev=s1.result) → execute s2 → s2.result
    │   └── logSkillExecution(s2)
    │   └── if fail → { ok:false, error:..., steps:[s1_ok, s2_fail] }
    │
    └── { ok:true, steps:[s1_ok, s2_ok, s3_ok] }
        └── finalizeIdempotency(PLAN → COMPLETE)
        └── logSkillExecution(PLAN parent)
        └── return 200 { skill:"PLAN", steps:[...] }
```

---

## 8. Cross-Cutting Infrastructure

### `lib/agent-idempotency.ts` — Dedup window

Prevents double-executes from double-clicks or network retries.

```
claimIdempotency(userId, skill, key, ttlSeconds)
  → claimed      : proceed to execute
  → replay       : return cached HTTP status + result
  → in_flight    : 409 (another request in progress)
  → recent_failure: 409 (just failed, don't hammer)

finalizeIdempotency(userId, skill, key, ok, httpStatus, resultJson)
  → updates row to COMPLETE or FAILED
```

Storage: `agent_idempotency` table (service-role writes only). TTL: 90s for fund-affecting, 30s otherwise.

### `lib/agent-lock.ts` — Per-user serialisation

```typescript
withUserLock(userId, fn)
```

Serialises the balance-check → limit-check → PENDING-insert → Circle-call path for each user. Without this, two concurrent confirm requests could both pass the daily cap check before either logs a PENDING row, letting the user overspend.

### `lib/agent-audit.ts` — Execution log

Every skill execution (success, failure, replay) is written to `agent_audit_log`. Non-fatal — a logging outage never blocks the skill from running.

```typescript
logSkillExecution({ skill, category, affectsFunds, params, ok, httpStatus, durationMs, replayed })
```

Sensitive params (`pin`, `password`, `secret`, `token`, `api_key`) are stripped before persistence.

### `lib/agent-pin.ts` — PIN verify + lockout

```
verifyAgentPinOrThrow({ supabase, userId, pin })
  → bcrypt.compare(pin, stored_hash)
  → wrong: increment failed_attempts
  → 3 wrong: 15 min lockout
  → 5 wrong: 60 min lockout
  → locked: throw 429
```

### `lib/ans.ts` — Arc Name Service

```typescript
resolveRecipient(input: string): Promise<string>
  → if 0x address: validate with ethers.isAddress(), return as-is
  → if .arc name:  call ANS registry contract → resolve to 0x address
  → throw if not found or invalid
```

Called twice: once in interpret (fast UX), once in confirm-policy (security — TOCTOU prevention).

### `lib/agent.ts` — Shared math helpers

```typescript
checkBalanceSufficient(walletId, amount)
  → real Circle API call → returns { sufficient, error }

checkSpendLimits({ amountUsdc, limits, spentToday, spentThisWeek, spentThisMonth })
  → pure function → returns { allowed, reason }

startOfDayUTC() / startOfWeekUTC() / startOfMonthUTC()
  → Date helpers for getSpentSince() calls

getAgentBalance(walletId): Promise<string>
  → Circle getWalletTokenBalance → USDC amount string

getAgentAllBalances(walletId): Promise<AgentTokenBalance[]>
  → all tokens: USDC, EURC, cirBTC + approx USD values
```

---

## 9. Database Tables

| Table | Purpose | Who writes | RLS |
|---|---|---|---|
| `agent_wallets` | Circle wallet ID + address + balance cache | activate route | user reads own row |
| `user_security` | bcrypt PIN hash, failed attempts, lockout_until | set-pin, verify-pin | no SELECT (secrets) |
| `user_spend_limits` | per-tx / daily / weekly / monthly caps | set-limit skill | user reads/updates own |
| `agent_policies` | recurring/conditional policies (HMAC-signed) | create-policy skill | user reads own |
| `agent_spend_log` | PENDING → COMPLETE/FAILED for every TRANSFER | skill files (service role) | user reads own; no UPDATE from user |
| `agent_audit_log` | every skill call (all outcomes, categories) | agent-audit.ts | user reads own |
| `agent_idempotency` | dedup window per skill+key | idempotency lib | service role only |

### `agent_spend_log` row lifecycle

```
INSERT status=PENDING  (before Circle call)
       ↓
UPDATE status=COMPLETE, tx_hash=...   (on success)
       OR
UPDATE status=FAILED, error_message=... (on failure)
```

The PENDING → COMPLETE/FAILED update uses `serviceSupabase` (service role) because the RLS on `agent_spend_log` intentionally has **no user-level UPDATE policy** — only the server-side skill code can finalize rows.

---

## 10. Security Layers (L1–L4)

```
L1  DotArc JWT (requireAgentSession)
    ├── Validates DotArc session token
    ├── Validates Supabase JWT (getClaims, fallback getUser)
    └── Cross-checks: DotArc email === Supabase email
        (prevents one session being used with another user's Supabase token)

L2  Wallet ownership
    └── SELECT agent_wallets WHERE user_id = supabaseUserId
        (supabaseUserId is derived from verified JWT, never from client body)

Pre-PIN fast checks
    ├── Cached balance check (avoid PIN prompt on certain fail)
    └── ANS name resolution (fail before user types PIN)

L3  PIN verification
    └── bcrypt.compare + lockout enforcement

CRITICAL SECTION (withUserLock)

L3.5  Live balance gateway
    └── Real Circle API call inside the lock (definitive check)

L4  Inside skill.execute()
    ├── Per-skill balance check (checkBalanceSufficient)
    ├── Spend limit check (checkSpendLimits + getSpentSince)
    └── PENDING insert (abort if DB write fails)
```

---

## 11. System Prompt & LLM Behaviour

**File:** `lib/agent.ts → buildSystemPrompt(context)`

The system prompt is rebuilt on every interpret call, injected with:
- Current date and time (for scheduling calculations)
- Agent wallet USDC balance
- User's spend limits (per-tx, daily, weekly, monthly)
- Active policies (id, summary, trigger, action, mode)

### What the LLM returns

Always a single JSON object — no prose outside it:
```json
{
  "skill": "SKILL_NAME",
  "params": { ... },
  "confirmation_message": "...",
  "requires_confirmation": true
}
```
For PLAN, `params` is absent; `steps` is present instead.

### LLM constraints enforced by prompt

- `requires_confirmation: true` for any money movement
- Never suggest an amount above the user's per-transaction limit
- Return `UNKNOWN` with explanation if instruction is ambiguous
- Never extract recipient or amount from a URL or encoded payload
- `$prev.fieldName` syntax for referencing previous step outputs

### `validateSkillResult()` — server-side schema enforcement

After the LLM returns, `validateSkillResult()` enforces:
- `skill` is in `VALID_SKILLS`
- PLAN: 1–3 steps, each step has a valid skill (not PLAN or UNKNOWN)
- Fields are the right types
- Throws if the LLM returns garbage — the route returns 502

---

## 12. Full End-to-End Flow Diagram

```
USER types: "swap 10 USDC to cirBTC then send to maya.arc"
│
▼
wallet-shell.tsx  POST /api/agent/interpret
│
├── requireAgentSession()  [L1]
├── getAgentBalance()       → "47.320000"
├── user_spend_limits       → { per_tx: 50, daily: 100, ... }
├── agent_policies          → [{ id, summary, trigger, action }]
├── buildSystemPrompt(ctx)  → 2500 token prompt with context
├── OpenRouter → Claude     → raw JSON string
├── validateSkillResult()   → PlanResult { skill:"PLAN", steps:[...] }
├── extractAllRecipients()  → ["maya.arc"]
├── resolveRecipient("maya.arc") → "0xDEAD…BEEF"  (ANS lookup)
└── return PlanResult to UI
│
▼
UI renders ConfirmCard:
  "Swap 10 USDC → cirBTC, then send result to maya.arc."
  [Step 1] Swap 10 USDC to cirBTC
  [Step 2] Send cirBTC to maya.arc
  [PIN input]
│
USER types PIN, clicks Confirm
│
▼
wallet-shell.tsx  POST /api/agent/confirm-policy
  body: { pin:"123456", skill:"PLAN", steps:[...] }
│
├── requireAgentSession()        [L1]
├── agent_wallets lookup         [L2]  → wallet row
├── isPlan = true; validate steps
├── extractPlanAmount([s1,s2])   → 10 USDC (s2 uses $prev, skipped)
├── balance_cache_usdc = 47.32   → 47.32 >= 10 ✓
├── recipientsToCheck = ["maya.arc"]
├── resolveRecipient("maya.arc") → 0xDEAD…BEEF ✓  [name check before PIN]
├── verifyAgentPinOrThrow()      [L3]
│
└── withUserLock(userId)  → critical section
    │
    ├── getAgentBalance()        [L3.5] → "47.32" ✓
    ├── user_spend_limits        → loaded
    ├── Build SkillContext       → { supabase, serviceSupabase, ... }
    ├── claimIdempotency("PLAN:SWAP_USDC:{…}|SEND_TOKEN:{…}")
    │   └── claimed ✓
    │
    └── executePlan(steps, ctx)
        │
        ├── STEP 1: SWAP_USDC
        │   ├── resolvePrevRefs({tokenIn:"USDC",tokenOut:"cirBTC",amount:10}, {})
        │   ├── SwapUsdc.execute(ctx)
        │   │   ├── TOKEN_INFO["USDC"] → address 0x3600…
        │   │   ├── readUsdcBalanceWei(walletAddr, usdcAddr) → 47.32 ✓
        │   │   ├── AppKit.swap({ from:{USDC,10}, to:{cirBTC} })
        │   │   └── { ok:true, result:{ amountOut:"0.000103", tokenOut:"cirBTC", txHash:"0x…" } }
        │   └── logSkillExecution(SWAP_USDC, ok:true)
        │
        ├── STEP 2: SEND_TOKEN
        │   ├── resolvePrevRefs({token:"cirBTC",amount:"$prev.amountOut",recipient:"maya.arc"}, s1.result)
        │   │   → { token:"cirBTC", amount:"0.000103", recipient:"maya.arc" }
        │   ├── SendToken.execute(ctx)
        │   │   ├── resolveRecipient("maya.arc") → 0xDEAD…BEEF
        │   │   ├── checkSpendLimits({ amountUsdc: 0.000103 * 100000 ≈ 10.3, ... }) ✓
        │   │   ├── INSERT agent_spend_log PENDING
        │   │   ├── circleDev.createTransaction(…)
        │   │   ├── UPDATE agent_spend_log COMPLETE, tx_hash
        │   │   └── { ok:true, result:{ txHash:"0x…", recipientAddress:"0xDEAD…" } }
        │   └── logSkillExecution(SEND_TOKEN, ok:true)
        │
        └── { ok:true, steps:[step1_ok, step2_ok] }
            │
            ├── finalizeIdempotency(PLAN → COMPLETE)
            ├── logSkillExecution(PLAN, ok:true)
            └── 200 { skill:"PLAN", steps:[{ step:1, ok:true, … }, { step:2, ok:true, … }] }
│
▼
wallet-shell.tsx renders:
  ✓ Step 1: Swap 10 USDC to cirBTC
  ✓ Step 2: Send cirBTC to maya.arc
```

---

## 13. Adding a New Skill

1. **Create** `lib/skills/my-skill.ts` implementing `SkillHandler`
2. **Register** it in `lib/skills/index.ts`
3. **Add the name** to `SkillName` union in `lib/agent.ts`
4. **Add it** to `VALID_SKILLS` array in `lib/agent.ts`
5. **Document it** in `buildSystemPrompt()` — one block with params, examples, and rules
6. **Add to wallet-shell.tsx** `SkillName` union (frontend type)
7. **Add a result renderer** in `confirmSkill()` switch in `wallet-shell.tsx`

For TRANSFER skills, follow the PENDING → COMPLETE/FAILED pattern and implement `idempotencyKey()`.

For READ skills, set `affectsFunds: false` and `requiresPin: false`.

---

*This document reflects the architecture as of the audit + bug-fix pass (May 2026). For future planned work, see `DOTARC_FUTURE_AUDITS_AND_UPGRADES.md`.*
