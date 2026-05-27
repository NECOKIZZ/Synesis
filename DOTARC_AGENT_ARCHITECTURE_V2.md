# DotArc Smart Agent — Revised Architecture & Flow Reference

> **Version:** 2.0 — May 2026
> **Purpose of this document:** This is a critique and revision of the V1 architecture. It explains what was right, what was wrong, and exactly how to fix it. Read this before touching `lib/agent.ts`, `confirm-policy/route.ts`, or anything related to PLAN.
> **Security axiom (unchanged):** Every route derives identity server-side. No client-provided userId, walletAddress, or amount is trusted without server-side verification.

---

## What This Document Changes — And Why

The V1 architecture is largely solid. The security layering (L1–L4), the two-phase interpret/confirm split, the skill registry pattern, the PENDING→COMPLETE/FAILED log — all of these are correct and must not change.

**The one structural flaw is this: PLAN is modeled as a skill.**

PLAN sits in the skill registry table in the docs. It is validated like a skill. It is routed like a skill. But it is not a skill — it is an orchestration layer. A skill is a leaf action: send money, swap tokens, check balance. PLAN is a coordinator that runs other skills in sequence.

Treating PLAN as a skill creates a hard ceiling:

- A PLAN cannot be the action payload of a recurring policy (the cron system fires a single skill, not a meta-skill)
- A PLAN cannot be the action payload of a conditional policy (same reason)
- Therefore "every Monday, swap then send" is architecturally impossible — recurring and compound cannot combine
- Therefore "if balance drops below 50, swap then top up" is also impossible — conditional and compound cannot combine

This is not a future edge case. It is a wall you will hit immediately once users start asking for anything beyond a one-time compound action.

**The fix is small but important:** Remove PLAN from the skill layer entirely. Introduce a `task_type` field that the LLM returns alongside its skill instructions. The server reads `task_type` to decide how to handle execution — not by checking if `skill === "PLAN"`.

---

## The Revised Mental Model

Think of it in three layers:

```
┌─────────────────────────────────────────────────────────┐
│  LAYER 1 — Intent Classification                        │
│  Who: LLM (the only smart layer)                        │
│  Job: Understand the user's words. Identify task_type.  │
│       Name the skills needed. Set rough params.         │
│       Use $prev / $computed where it doesn't know       │
│       the exact value at runtime.                       │
│  Does NOT: check live balances, resolve names,          │
│            compute exact swap quotes                    │
└────────────────────────┬────────────────────────────────┘
                         │ JSON payload
                         ▼
┌─────────────────────────────────────────────────────────┐
│  LAYER 2 — Pre-flight & Plan Construction               │
│  Who: Server (interpret route + confirm route)          │
│  Job: Make the LLM's intent real and safe.              │
│       Resolve .arc names. Check live balance.           │
│       Get swap quotes. Validate spend limits.           │
│       Build the executable plan from the rough sketch.  │
│  Does NOT: understand language, make judgment calls     │
└────────────────────────┬────────────────────────────────┘
                         │ SkillContext + resolved params
                         ▼
┌─────────────────────────────────────────────────────────┐
│  LAYER 3 — Skill Execution                              │
│  Who: skillRegistry (unchanged from V1)                 │
│  Job: Execute exactly one action. Talk to Circle.       │
│       Write PENDING → COMPLETE/FAILED to spend_log.     │
│  Does NOT: orchestrate, plan, or make routing decisions │
└─────────────────────────────────────────────────────────┘
```

The LLM owns Layer 1 only. The server owns Layer 2. Skills own Layer 3. Nothing bleeds across layers.

---

## The task_type Field — What the LLM Returns

The LLM now always returns a `task_type` at the top level of its JSON. This replaces the overloaded `skill: "PLAN"` pattern.

### Four task types

| task_type | Meaning | Execution path |
|---|---|---|
| `immediate` | One skill, run now | confirm-policy → single skill execute |
| `compound` | Multiple skills, run now in sequence | confirm-policy → executePlan() |
| `recurring` | One or more skills, run on a schedule | write cron policy to DB |
| `conditional` | One or more skills, run when a trigger fires | write trigger policy to DB |

Combinations are expressed by combining fields, not by inventing new task_type values. See examples below.

---

## What the LLM Returns — JSON Examples

### Example 1 — Immediate (simple, unchanged from V1)

*User: "send 20 USDC to maya.arc"*

```json
{
  "task_type": "immediate",
  "skill": "SEND_USDC",
  "params": {
    "recipient": "maya.arc",
    "amount": 20
  },
  "confirmation_message": "Send 20 USDC to maya.arc",
  "requires_confirmation": true
}
```

No change from V1. `task_type: "immediate"` just makes the routing explicit.

---

### Example 2 — Compound (replaces PLAN)

*User: "swap 50 USDC to cirBTC then send it to maya.arc"*

```json
{
  "task_type": "compound",
  "steps": [
    {
      "skill": "SWAP_USDC",
      "params": {
        "tokenIn": "USDC",
        "tokenOut": "cirBTC",
        "amount": 50
      },
      "description": "Swap 50 USDC to cirBTC"
    },
    {
      "skill": "SEND_TOKEN",
      "params": {
        "token": "cirBTC",
        "recipient": "maya.arc",
        "amount": "$prev.amountOut"
      },
      "description": "Send cirBTC to maya.arc"
    }
  ],
  "confirmation_message": "Swap 50 USDC to cirBTC, then send result to maya.arc. Estimated cost: ~50 USDC.",
  "requires_confirmation": true
}
```

This is structurally identical to what V1 called `skill: "PLAN"` — the only difference is `task_type: "compound"` replaces `skill: "PLAN"`. The server routes on `task_type`, not on whether `skill === "PLAN"`. PLAN is removed from the skill registry.

---

### Example 3 — Recurring

*User: "every Friday, send 20 USDC to my savings wallet"*

```json
{
  "task_type": "recurring",
  "schedule": "every_friday",
  "action": {
    "skill": "SEND_USDC",
    "params": {
      "recipient": "savings.arc",
      "amount": 20
    }
  },
  "confirmation_message": "Every Friday: send 20 USDC to savings.arc",
  "requires_confirmation": true
}
```

Server writes this to `agent_policies` as a cron entry. The `action` payload is stored. When the cron fires, it reads the action, builds a SkillContext, and calls `skillRegistry["SEND_USDC"].execute(ctx)`.

---

### Example 4 — Conditional

*User: "whenever my balance drops below 50 USDC, top it up to 100"*

```json
{
  "task_type": "conditional",
  "trigger": {
    "type": "balance_below",
    "threshold": 50
  },
  "action": {
    "skill": "SEND_USDC",
    "params": {
      "recipient": "agent_wallet",
      "amount": "$computed.gap_to_100"
    }
  },
  "confirmation_message": "When balance drops below 50 USDC: top up to 100 USDC",
  "requires_confirmation": true
}
```

Note `$computed.gap_to_100` — the LLM is saying "you figure this out at runtime." The server, when the trigger fires, computes the actual gap using the live balance at that moment. The LLM does not guess.

---

### Example 5 — Recurring + Conditional (the V1 impossible case)

*User: "every Monday, if my balance is above 100 USDC, swap 50 to cirBTC then send it to maya"*

```json
{
  "task_type": "recurring",
  "schedule": "every_monday",
  "condition": {
    "type": "balance_above",
    "threshold": 100
  },
  "steps": [
    {
      "skill": "SWAP_USDC",
      "params": {
        "tokenIn": "USDC",
        "tokenOut": "cirBTC",
        "amount": 50
      },
      "description": "Swap 50 USDC to cirBTC"
    },
    {
      "skill": "SEND_TOKEN",
      "params": {
        "token": "cirBTC",
        "recipient": "maya.arc",
        "amount": "$prev.amountOut"
      },
      "description": "Send cirBTC to maya.arc"
    }
  ],
  "confirmation_message": "Every Monday, if balance > 100 USDC: swap 50 USDC to cirBTC then send to maya.arc",
  "requires_confirmation": true
}
```

This was impossible in V1. In V2 it is just a recurring policy whose stored action payload is a `steps` array instead of a single skill. The cron executor checks the condition first, then runs `executePlan(steps, ctx)` if the condition passes. No new tables, no new routes — just the cron executor knowing how to handle both a single skill action and a steps array action.

---

## The Two Pre-Flight Checks — Unchanged But Now Explicit

Before the user ever sees a confirmation card, the interpret route always runs two checks. These are not new — they existed in V1. They are called out explicitly here because they are critical and must run regardless of task_type.

### Check 1 — Balance Check (cached)

Read `balance_cache_usdc` from `agent_wallets`. Sum all known amounts in the incoming payload (skipping `$prev` and `$computed` references since those are unknown until execution). If the sum obviously exceeds the cached balance, return `UNKNOWN` with an explanation immediately. The user never sees a confirm card for something that will definitely fail.

This is a fast check using the cached balance — it is not a live Circle API call. The live check happens inside the lock in confirm-policy (L3.5, unchanged).

### Check 2 — Name Resolution

For every `.arc` name in the payload (whether it is a single skill, a compound steps array, or a recurring action), call `resolveRecipient()` before returning to the UI. If any name does not resolve, return `UNKNOWN` immediately. Better to fail here than after the user has typed their PIN.

Name resolution also happens again inside confirm-policy (TOCTOU prevention — unchanged from V1).

---

## Revised Interpret Route Flow

```
POST /api/agent/interpret
│
├── requireAgentSession()                         [L1 — unchanged]
├── Validate instruction (non-empty, max 500 chars)
│
├── Load context for LLM
│   ├── getAgentBalance()        → USDC balance string
│   ├── getAgentAllBalances()    → all token balances (USDC, EURC, cirBTC)
│   ├── user_spend_limits        → per-tx, daily, weekly, monthly caps
│   └── agent_policies           → active policy summaries
│
├── buildSystemPrompt(context)   → inject balance + limits + policies + date
├── POST to OpenRouter (LLM)     → raw JSON string
├── validateTaskResult(response) → NEW — replaces validateSkillResult()
│   ├── task_type is a known value
│   ├── if immediate: skill is in VALID_SKILLS, params present
│   ├── if compound: steps array, 1–3 steps, each step skill is in VALID_SKILLS
│   │               no step skill is "PLAN" or "UNKNOWN"
│   ├── if recurring: schedule is a known value, action or steps present
│   └── if conditional: trigger has type + threshold, action or steps present
│
├── PRE-FLIGHT CHECK 1 — Balance
│   └── extractAllAmounts(result) → sum known amounts vs cached balance
│       → if obviously insufficient: return UNKNOWN with explanation
│
├── PRE-FLIGHT CHECK 2 — Name Resolution
│   └── extractAllRecipients(result) → all .arc names across all fields
│       → resolveRecipient() for each → fail fast if any unregistered
│
└── Return TaskResult JSON to UI
```

---

## Revised Confirm-Policy Route — Routing on task_type

The confirm-policy route now branches on `task_type` instead of checking `skill === "PLAN"`.

```
POST /api/agent/confirm-policy
│
├── L1 requireAgentSession()
├── L2 wallet ownership check
│
├── Read task_type from body
├── Validate: task_type is known, skills in steps/action are valid
│
├── Pre-flight balance check (cached) — same as interpret, second check
├── Pre-flight name resolution — same as interpret, TOCTOU prevention
│
├── L3 verifyAgentPinOrThrow()
│
└── withUserLock(userId)
    │
    ├── L3.5 getAgentBalance() → live Circle API check
    ├── Load spend limits
    ├── Build SkillContext
    ├── claimIdempotency(...)
    │
    ├── if task_type === "immediate"
    │   └── skillRegistry[skill].execute(ctx)
    │
    ├── if task_type === "compound"
    │   └── executePlan(steps, ctx)          ← unchanged from V1 PLAN executor
    │
    ├── if task_type === "recurring"
    │   └── writeRecurringPolicy(schedule, action_or_steps, ctx)
    │       → INSERT into agent_policies (cron type)
    │       → action payload: { skill } OR { steps: [...] }
    │
    └── if task_type === "conditional"
        └── writeConditionalPolicy(trigger, action_or_steps, ctx)
            → INSERT into agent_policies (trigger type)
            → action payload: { skill } OR { steps: [...] }
```

The key change: `writeRecurringPolicy` and `writeConditionalPolicy` now accept either a single skill action or a `steps` array as their action payload. The DB column that stores the action payload (`agent_policies.action`) stores JSON — it already supports this. No schema migration needed, just the executor needs updating.

---

## Revised agent_policies Action Payload

In V1 the action payload stored in `agent_policies` looks like:

```json
{ "skill": "SEND_USDC", "params": { "recipient": "maya.arc", "amount": 20 } }
```

In V2 it can also look like:

```json
{
  "steps": [
    { "skill": "SWAP_USDC", "params": { "tokenIn": "USDC", "tokenOut": "cirBTC", "amount": 50 }, "description": "..." },
    { "skill": "SEND_TOKEN", "params": { "token": "cirBTC", "recipient": "maya.arc", "amount": "$prev.amountOut" }, "description": "..." }
  ]
}
```

The cron executor checks: does this policy action have a `skill` field or a `steps` field? If `skill` → call `skillRegistry[skill].execute(ctx)`. If `steps` → call `executePlan(steps, ctx)`. Two lines of branching, no new tables.

---

## What Stays Exactly The Same From V1

Everything below this line is unchanged. Do not touch it.

- The skill registry (`lib/skills/index.ts`) — all skills, same interface
- `SkillHandler` interface and `SkillContext` type
- `SkillOutput` type
- The PENDING → COMPLETE/FAILED spend_log pattern
- `executePlan()` and `resolvePrevRefs()` — same logic, just called differently
- `$prev.fieldName` reference system
- `withUserLock()` — per-user serialization
- `claimIdempotency()` / `finalizeIdempotency()`
- `verifyAgentPinOrThrow()` — PIN + lockout
- `resolveRecipient()` — ANS resolution
- `checkBalanceSufficient()` and `checkSpendLimits()`
- All database tables and RLS policies
- The security layers L1–L4

---

## What Changes — Summary

| What | V1 | V2 |
|---|---|---|
| LLM output top-level field | `skill: "PLAN"` or `skill: "SEND_USDC"` | always has `task_type` |
| PLAN in skill registry | Yes — listed as a meta-skill | Removed entirely |
| Confirm-policy routing | `if skill === "PLAN"` | `if task_type === "compound"` |
| Recurring policy action payload | single skill only | single skill OR steps array |
| Conditional policy action payload | single skill only | single skill OR steps array |
| Cron executor | calls `skillRegistry[skill].execute()` | calls execute() OR executePlan() |
| `validateSkillResult()` | validates skill name | `validateTaskResult()` — validates task_type + contents |
| Compound + recurring | Impossible | Supported — recurring policy with steps payload |
| Compound + conditional | Impossible | Supported — conditional policy with steps payload |

---

## The $computed Convention

In V1, `$prev.fieldName` is used when a step needs the output of the previous step. This stays unchanged.

V2 introduces `$computed.fieldName` for values the server must calculate at execution time that are not outputs of a previous step. The LLM uses this when it knows it cannot determine a value from the user's words alone.

| Placeholder | Meaning | Who resolves it |
|---|---|---|
| `$prev.amountOut` | Output field from previous step | `resolvePrevRefs()` — unchanged |
| `$computed.gap_to_100` | Server computes: 100 minus live balance | New: `resolveComputedRefs()` in server |
| `$computed.current_balance` | Server fetches live balance at execution time | New: `resolveComputedRefs()` |

`$computed` values are resolved inside the lock, after the live balance check, before `executePlan()` runs. They are never passed to skills as literal strings — if a `$computed` ref cannot be resolved, execution stops with a clear error before any money moves.

---

## One-Time vs Recurring Compound Tasks — Mutual Exclusion Stays

This is still the right constraint for now:

- `task_type: "compound"` = one-time execution, no schedule, no condition
- `task_type: "recurring"` with `steps` = scheduled execution of a compound action
- `task_type: "conditional"` with `steps` = triggered execution of a compound action

The LLM must not return `task_type: "compound"` for anything with a schedule or trigger. If a user says "every Monday, swap then send," that is `task_type: "recurring"` with a `steps` payload — not `task_type: "compound"`. The system prompt must make this distinction explicit.

---

## System Prompt Changes Required

The system prompt in `buildSystemPrompt()` must be updated to teach the LLM:

1. Always include `task_type` at the top level of the JSON response
2. `task_type: "immediate"` for single, one-time actions — include `skill` and `params`
3. `task_type: "compound"` for multi-step, one-time actions — include `steps` array, no `skill` at top level
4. `task_type: "recurring"` for scheduled actions — include `schedule` and either `action` (single skill) or `steps`
5. `task_type: "conditional"` for triggered actions — include `trigger` and either `action` or `steps`
6. Use `$prev.fieldName` when a step's param depends on a previous step's output
7. Use `$computed.gap_to_X` when an amount must be calculated from live balance at runtime
8. Never use `skill: "PLAN"` — this no longer exists
9. `task_type: "compound"` is one-time only — if the user wants recurring or conditional multi-step, use `task_type: "recurring"` or `task_type: "conditional"` with a `steps` payload

---

## Adding a New Skill — Unchanged

The process for adding a new leaf skill is identical to V1. PLAN being removed from the registry does not affect this.

1. Create `lib/skills/my-skill.ts` implementing `SkillHandler`
2. Register in `lib/skills/index.ts`
3. Add to `SkillName` union in `lib/agent.ts`
4. Add to `VALID_SKILLS` array
5. Document in `buildSystemPrompt()` with params, examples, and rules
6. Add to `wallet-shell.tsx` local `SkillName` union
7. Add result renderer in `confirmSkill()` switch

Note: The `SkillName` union in `wallet-shell.tsx` is a maintenance trap — it duplicates the one in `lib/agent.ts`. When these drift out of sync you get silent type errors. Export `SkillName` from `lib/agent.ts` and import it in `wallet-shell.tsx`. One source of truth.

---

## The Cost Estimate Problem

The confirmation message currently includes a cost estimate generated by the LLM — for example "Estimated cost: ~50 USDC." The LLM has no live price data. For USDC sends this is fine (1 USDC = 1 USDC). For swaps it is not — the LLM's estimate of how much USDC buys 0.01 cirBTC could be significantly wrong.

Before showing the ConfirmCard for any compound task involving a swap, the interpret route should fetch a live quote from the swap API and inject the real output amount into the confirmation message. The LLM's estimate should be replaced with: "Estimated output: {live_quote} cirBTC (live quote)." This is a one-line addition to the interpret route after the LLM returns but before the response is sent to the UI.

This is not blocking — it is a UX improvement. But for a financial product, showing a user a hallucinated price estimate is a trust issue.

---

*This document supersedes the V1 architecture for the PLAN/task_type system only. All other sections of V1 remain valid and authoritative.*
