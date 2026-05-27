# DotArc — Policy Orchestration Architecture

Date: 2026-05-21
Status: Spec — not yet implemented

---

## Overview

Instead of building separate skills for every combination of timing and action (RECURRING_SEND, RECURRING_SWAP, CONDITIONAL_SEND, CONDITIONAL_SWAP...), DotArc uses a single **POLICY orchestrator** that schedules or watches, then calls the right action skill when the trigger fires.

Action skills stay pure — they just execute. They have no knowledge of schedules or conditions. The policy layer is the only thing that knows about timing and triggers.

---

## The Three-Part Policy Model

Every policy has three independent parts: a **trigger**, an **action**, and **stop conditions**.

---

### Part 1 — Trigger (what starts the execution)

| Type | Description | Example |
|---|---|---|
| `time` | Cron schedule | "every Friday", "daily at 9am", "end of every month" |
| `price` | Asset price crosses a threshold | "when BTC drops below $80,000" |
| `balance_above` | Agent balance rises above X | "when I have more than 100 USDC" (auto-deploy) |

---

### Part 2 — Action (what skill gets called)

Any registered action skill plus its params:

- `SEND_USDC` → `{ recipient, amount }`
- `SWAP_USDC` → `{ from_asset, to_asset, amount }` *(when built)*
- `BRIDGE_USDC` → `{ destination_chain, amount }` *(when built)*

The policy stores the skill name and params. When the trigger fires, the cron calls the skill exactly as if the user had triggered it manually — going through the same execution path, the same balance check, the same spend limits.

---

### Part 3 — Execution Mode (how many times it runs)

| Mode | Behaviour | Example |
|---|---|---|
| `once` | Fires once then self-deactivates | "buy BTC once it drops below 80k" |
| `repeat` | Fires every time trigger condition is met (with cooldown) | "buy BTC every time it drops below 80k" |

**Cooldown on `repeat`:** A minimum gap between executions to prevent a price bouncing around a threshold from triggering 50 buys in an hour. Default cooldown: 1 hour for price triggers, not applicable for time triggers.

**"every time" vs "once" — LLM disambiguation:**
The interpreter maps these naturally:
- "once it goes below" → `mode: once`
- "every time it goes below" → `mode: repeat`
- "every week" → `trigger: time`, `mode: repeat`

---

### Part 4 — Stop Conditions (independent kill switches)

An array. All active stop conditions are AND'd — if any is met, the policy pauses.

| Condition | Description | Example |
|---|---|---|
| `balance_below` | Pause if agent USDC balance drops below X | "until my balance drops below 20 USDC" |
| `expires_at` | Stop after a date | "until end of month" |
| `max_executions` | Stop after N successful runs | "pay sara 5 times then stop" |
| `max_total_spend` | Stop after cumulative spend reaches X USDC | "spend no more than 200 USDC total" |

---

## Real-World Examples Mapped

| User says | Trigger | Mode | Stop conditions |
|---|---|---|---|
| "pay sara 5 USDC every week" | `time: weekly` | `repeat` | none |
| "buy BTC once it goes below $80k" | `price: BTC < 80000` | `once` | none |
| "buy BTC every time it drops below $80k" | `price: BTC < 80000` | `repeat` | `cooldown: 1hr` |
| "pay sara weekly until balance drops below 20" | `time: weekly` | `repeat` | `balance_below: 20` |
| "buy BTC every Friday while price is below $80k" | `time: weekly(friday)` | `repeat` | price checked as guard at execution |
| "pay sara 5 times then stop" | `time: weekly` | `repeat` | `max_executions: 5` |
| "send 10 USDC to john every month, max 100 total" | `time: monthly` | `repeat` | `max_total_spend: 100` |

---

## The Balance Kill Switch

### Why it is mandatory infrastructure, not a feature

Without a balance kill switch:
- Agent balance hits zero
- Cron fires, Circle rejects the transfer
- A FAILED log row is written
- Cron fires again next interval — same result
- Logs fill with failures, Circle API is spammed

This must be prevented at two layers:

**Layer 1 — Policy-level stop condition (user-configured)**
When the cron is about to execute a policy, it checks the current agent balance first. If `current_balance < stop_condition.balance_below`, the execution is skipped. The policy status is set to `PAUSED` with `pause_reason: "Balance below your set threshold of X USDC"`. No Circle call is made.

**Layer 2 — Global hard floor (always enforced)**
Even if the user never set a balance stop condition, the cron enforces a hard floor: **never execute any policy if agent balance < 1 USDC**. This protects against zero-balance spam globally, on every policy, regardless of user configuration.

The user-friendly message when a policy is paused by Layer 1:
> "Your weekly payment to sara.arc has been paused because your agent balance dropped below 20 USDC — your set safety threshold. Top up your agent wallet to resume."

The user-friendly message when a policy is paused by Layer 2 (global floor):
> "Your agent wallet is almost empty, so we've paused your scheduled payments to protect you. Add some USDC to your agent wallet to resume."

---

## Authorization Model

Policies are authorized **once** at creation time via the agent PIN. The original PIN authorization covers all future executions — the cron does not re-request the PIN.

This means the HMAC signature on the stored policy is the security guarantee for all future executions. If the HMAC fails verification, the cron must refuse to execute and flag the policy for manual review.

---

## HMAC Signing (what must be signed)

The current HMAC covers too narrow a set of fields. With this architecture, the HMAC must sign the **full policy intent** — everything that, if tampered with, would change the behaviour:

```
HMAC input:
  userId
  policyId
  skill (action skill name)
  action params (full JSON — recipient, amount, asset, etc.)
  trigger type
  trigger params (frequency, day_of_week, price_threshold, asset, direction)
  execution mode (once / repeat)
  cooldown_seconds
  stop_conditions (full JSON array)
  createdAt
```

Changing `once` to `repeat`, removing a `balance_below` stop condition, or raising the price threshold — any of these must invalidate the HMAC.

---

## Cron Execution Flow

For every active policy where `next_run <= now()`:

```
1. Load policy row
2. Verify HMAC — reject and flag if invalid
3. Check global hard floor (balance >= 1 USDC) — skip if not met
4. Check stop conditions in order:
   a. balance_below — fetch current balance, pause if triggered
   b. expires_at — deactivate if past
   c. max_executions — deactivate if reached
   d. max_total_spend — deactivate if reached
5. For price/balance triggers: evaluate current condition
   - If condition not met: skip this run, update next_check time
   - If mode is `once` and already executed: deactivate
6. Check cooldown (repeat mode) — skip if last execution was too recent
7. Call action skill execute() — goes through full skill path:
   - Balance check (global rule — every money-moving skill)
   - Spend limits
   - PENDING log
   - Circle transfer
   - COMPLETE / FAILED log
8. On success:
   - If mode is `once`: set policy active = false
   - If mode is `repeat`: update next_run, increment execution_count, update total_spent
9. On failure:
   - Log failure with reason
   - Do NOT retry immediately
   - After N consecutive failures: pause policy, notify user
```

---

## Database Schema (additions required)

New columns on `agent_policies`:

```sql
-- Trigger
trigger_type          text NOT NULL,         -- 'time' | 'price' | 'balance_above'
trigger_params        jsonb NOT NULL,         -- { frequency, day_of_week, price_threshold, asset, direction }

-- Action
action_skill          text NOT NULL,          -- 'SEND_USDC' | 'SWAP_USDC' etc.
action_params         jsonb NOT NULL,         -- skill-specific params

-- Execution mode
execution_mode        text NOT NULL,          -- 'once' | 'repeat'
cooldown_seconds      int DEFAULT 3600,       -- minimum gap between repeat executions

-- Stop conditions
stop_conditions       jsonb NOT NULL DEFAULT '[]',
  -- [{ type: 'balance_below', threshold_usdc: 20 },
  --  { type: 'expires_at', date: '2026-12-31' },
  --  { type: 'max_executions', count: 5 },
  --  { type: 'max_total_spend', amount_usdc: 200 }]

-- Execution tracking
execution_count       int DEFAULT 0,
total_spent_usdc      numeric DEFAULT 0,
last_executed_at      timestamptz,
next_run              timestamptz,
pause_reason          text,

-- HMAC (must cover all fields above)
policy_hmac           text NOT NULL,
```

---

## Error Messages — User-Friendly Tone

All policy-related errors must be written in plain English, never expose internal codes, and always tell the user what happened and what to do next.

| Situation | Message |
|---|---|
| HMAC verification failed | "We couldn't verify the integrity of this policy. It's been paused for your safety. Please cancel and recreate it." |
| Balance below user threshold | "This payment has been paused because your agent balance dropped below [X] USDC — your safety threshold. Top up your agent wallet to resume." |
| Balance below global floor | "Your agent wallet is almost empty, so we've paused your scheduled payments. Add USDC to your agent wallet to resume." |
| expires_at reached | "This policy has ended — it was set to stop on [date]." |
| max_executions reached | "Done! This policy completed all [N] scheduled runs you set up." |
| max_total_spend reached | "This policy has been stopped because it reached your total spend limit of [X] USDC." |
| Consecutive failures | "We've tried to run this payment [N] times and it keeps failing. We've paused it to protect you. Check your agent balance and try resuming from settings." |
| Price condition not yet met | "Watching for [asset] to reach [price]. We'll execute automatically when the condition is met." |
| Mode `once` already executed | "This was a one-time policy and it already ran successfully on [date]." |
| Cooldown active | "This policy ran recently. The next execution is scheduled after [time] to prevent duplicate runs." |

---

## What Is NOT Built Yet

- Price feed integration (needed for `price` trigger type)
- `balance_above` trigger evaluation in cron
- Cron runner itself (`app/api/cron/agent-policies/route.ts`)
- Frontend policy management UI (view, pause, cancel active policies)
- Push/email notification when a policy is paused

These are tracked in `DOTARC_FUTURE_AUDITS_AND_UPGRADES.md`.
