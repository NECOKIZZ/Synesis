# DotArc Smart Agent — Policy Orchestration Build Log

**Build Date:** 2026-05-21  
**Builder:** Cascade (Kimi/Claude Code agent)  
**Session:** Phases 1–6 of Policy Orchestration Architecture

---

## Overview

This build replaces the legacy `RECURRING_PAYMENT` skill with a full **policy orchestration engine**: trigger + action + stop conditions. Policies are HMAC-signed, LLM-aware, and executed by a cron runner that verifies integrity before every execution.

---

## Phase 1: CREATE_POLICY Skill + HMAC v2

### What
Implemented a new skill that lets the LLM create policies via natural language (e.g. "send 5 USDC to sara.arc every week").

### Files
- `lib/skills/create-policy.ts` — validates trigger/action/stop conditions, resolves .arc names, inserts orchestration row, computes next_run
- `lib/skills/index.ts` — registered `CREATE_POLICY`
- `lib/agent.ts` — added `signPolicyHmac` and `verifyPolicyHmac` with **version-aware HMAC** (v1 legacy, v2 orchestration)

### HMAC v2 Schema
```
signPolicyHmac({
  userId, policyId, actionSkill, actionParams,
  triggerType, triggerParams, executionMode,
  cooldownSeconds, stopConditions, createdAt
})
```

### Key Design Decisions
- `computeNextRun()` returns UTC 09:00 for all triggers (consistent execution time)
- `.arc` names are resolved server-side at creation time, not at runtime
- HMAC v1 still works for legacy `RECURRING_PAYMENT` rows — backward compatible

---

## Phase 2: Skill Registry + LIST_POLICIES

### What
Created a read-only skill that returns the user's active and paused policies, normalized for LLM consumption.

### Files
- `lib/skills/list-policies.ts` — query `agent_policies`, filter by `active`, normalize output
- `lib/skills/index.ts` — registered `LIST_POLICIES`
- `lib/agent.ts` — extended `SkillName` union

### Key Design Decisions
- `requiresPin: false` — listing policies is a read operation
- `include_paused` param lets frontend show paused policies too
- `normalizePolicy()` flattens DB rows into a clean JSON structure

---

## Phase 3: CANCEL_POLICY Skill v2

### What
Rewrote `CANCEL_POLICY` to support three cancellation modes: specific IDs, mass cancel, and vague-description fallback.

### Files
- `lib/skills/cancel-policy.ts` — three modes:
  1. `policy_ids: string[]` — cancel exact policies
  2. `cancel_all: true` — cancel all active policies
  3. `description: string` — vague request → returns `nothingMatched: true` + active policy list

### Key Design Decisions
- On vague match, returns `ok: true` (not an error) with `nothingMatched` flag so frontend can show a picker
- Mass cancel requires explicit `cancel_all: true` — prevents accidental "cancel everything" from vague descriptions
- Deactivation uses `active: false` + `pause_reason: "Cancelled by user"` for audit trail

---

## Phase 4: Interpreter Context Injection

### What
The LLM interpreter prompt now includes the user's active policies, enabling smart matching for cancellation requests.

### Files
- `lib/agent.ts` — added `ActivePolicy` type, `formatActivePolicies()` helper, updated `buildSystemPrompt()` to inject policies, rewrote CANCEL_POLICY prompt section with 6 rules
- `app/api/agent/interpret/route.ts` — fetches active policies from DB, formats them, passes to `interpretInstruction()`

### Prompt Format (injected)
```
Active Policies:
- ID: abc-123 | Summary: Send 5 USDC to sara.arc every week | Category: time | Trigger: weekly | Action: SEND_USDC | Mode: repeat
- ID: def-456 | Summary: Buy BTC when price drops below 80000 | Category: price | Trigger: price | Action: SWAP_USDC | Mode: once
```

### Key Design Decisions
- Active policies are fetched on every interpret call — fresh data for the LLM
- Format is compact and LLM-optimized (one line per policy, key fields only)
- CANCEL_POLICY instructions now tell the LLM how to match descriptions against this list

---

## Phase 5: Cron Runner

### What
Built the execution engine that evaluates triggers, checks stop conditions, and fires action skills on schedule.

### Files
- `app/api/cron/agent-policies/route.ts` — cron route with full orchestration logic

### Architecture
```
GET /api/cron/agent-policies
  1. Verify CRON_SECRET
  2. Load all active policies
  3. For each policy:
     a. Verify HMAC (v1 or v2)
     b. Check stop conditions (balance_below, expires_at, max_executions, max_total_spend)
     c. Evaluate trigger:
        - time          → next_run <= now()
        - price         → placeholder (needs oracle)
        - balance_above → agent balance >= threshold
     d. If trigger fires:
        - Legacy (v1)    → call skill.onCronTick()
        - Orchestration  → build SkillContext → dispatch to action skill
     e. Update policy state (execution_count, total_spent_usdc, next_run, active)
```

### Trigger Types Implemented
| Trigger | Status | Notes |
|---|---|---|
| `time` | ✅ Ready | `daily`, `weekly`, `monthly` with next_run |
| `price` | 🚧 Placeholder | Needs CoinGecko / Chainlink integration |
| `balance_above` | ✅ Ready | Live balance check per tick |

### Stop Conditions Implemented
- `balance_below` — pause if wallet balance drops below threshold
- `expires_at` — pause if expiry date passed
- `max_executions` — pause after N runs
- `max_total_spend` — pause after spending N USDC total

### Key Design Decisions
- Legacy `RECURRING_PAYMENT` policies work unchanged via `onCronTick()` path
- Orchestration policies dispatch to any registered action skill (SEND_USDC, SWAP_USDC, WITHDRAW)
- Failed executions are either retried (transient: 429/502/503) or paused (permanent)
- `WITHDRAW` looks up `mainWalletAddress` from `profiles.wallet_address`

### Environment Variable
```
CRON_SECRET=<64-char-random-hex>
```

---

## Phase 6: Hardened CANCEL_POLICY Routes

### What
Rewrote `POST /api/agent/cancel-policy` to delegate to the `CANCEL_POLICY` skill, supporting all four cancellation modes with backward compatibility.

### Files
- `app/api/agent/cancel-policy/route.ts` — complete rewrite

### Supported Body Formats
```json
// Legacy single cancel
{ "pin": "1234", "policyId": "abc-123" }

// Batch cancel
{ "pin": "1234", "policy_ids": ["abc-123", "def-456"] }

// Mass cancel
{ "pin": "1234", "cancel_all": true }

// Vague request (from LLM)
{ "pin": "1234", "description": "that thing with sara" }
```

### Key Design Decisions
- Route still requires PIN even though skill is `requiresPin: false` — policy mutation is sacred
- `policyId` (legacy) is automatically wrapped as `policy_ids[0]` for the skill
- On vague match, returns `{ nothingMatched: true, activePolicies: [...] }` for frontend picker
- Confirm-policy route (`/api/agent/confirm-policy`) already works for CANCEL_POLICY via generic skill pipeline — no changes needed

---

## Database Schema

### New Columns on `agent_policies` (Migration: `0004_policy_orchestration.sql`)

| Column | Type | Purpose |
|---|---|---|
| `policy_category` | text | `time`, `price`, `balance_above` |
| `trigger_type` | text | trigger mode |
| `trigger_params` | jsonb | trigger config (frequency, threshold, etc.) |
| `action_skill` | text | which skill to fire (SEND_USDC, SWAP_USDC, WITHDRAW) |
| `action_params` | jsonb | action config (amount, recipient, etc.) |
| `execution_mode` | text | `repeat` or `once` |
| `cooldown_seconds` | int | minimum seconds between executions |
| `stop_conditions` | jsonb[] | array of stop rules |
| `execution_count` | int | how many times executed |
| `total_spent_usdc` | text | cumulative spend |
| `last_executed_at` | timestamptz | last run time |
| `pause_reason` | text | why policy was paused |
| `hmac_version` | int | `1` or `2` |

---

## Security Checklist

| Item | Status |
|---|---|
| HMAC-signed policies | ✅ v1 + v2 |
| HMAC verified before every execution | ✅ Cron runner |
| PIN required for policy mutation | ✅ cancel-policy route |
| User can only cancel own policies | ✅ `.eq("user_id", supabaseUserId)` |
| CRON_SECRET gate on cron route | ✅ 401 if missing/wrong |
| Stop conditions prevent over-execution | ✅ |
| Balance checks before money movement | ✅ Both skill.execute and cron |
| Spend limits enforced | ✅ |
| Idempotency keys for deduplication | ✅ confirm-policy route |
| Audit logging | ✅ confirm-policy route |

---

## Environment Variables Required

```
# Existing
CIRCLE_API_KEY=
CIRCLE_ENTITY_SECRET=
CIRCLE_TREASURY_WALLET_SET_ID=
CIRCLE_AGENT_WALLET_SET_ID=
NEXT_PUBLIC_CIRCLE_APP_ID=
JWT_SECRET=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Added during this build
OPENROUTER_API_KEY=
OPENROUTER_MODEL=anthropic/claude-sonnet-4
POLICY_HMAC_SECRET=<generate-once-keep-forever>
CRON_SECRET=<generate-with-crypto-randomBytes(48).toString('hex')>
```

---

## Files Touched / Created

| File | Action |
|---|---|
| `lib/skills/create-policy.ts` | Created |
| `lib/skills/list-policies.ts` | Created |
| `lib/skills/cancel-policy.ts` | Rewritten (v2) |
| `lib/skills/index.ts` | Modified (registrations) |
| `lib/agent.ts` | Modified (HMAC v2, prompt injection, SkillName union) |
| `app/api/agent/interpret/route.ts` | Modified (active policies fetch + inject) |
| `app/api/cron/agent-policies/route.ts` | Created |
| `app/api/agent/cancel-policy/route.ts` | Rewritten (skill delegation) |
| `supabase/migrations/0004_policy_orchestration.sql` | Created |

---

## Verification

```bash
npm run typecheck  # Clean
npm run lint       # 0 errors in touched files
```

---

## Next Steps (Phase 7+)

1. **Price Oracle Integration** — Wire CoinGecko or Chainlink for `price` triggers
2. **Frontend Integration** — Show active policies in agent chat, click-to-cancel
3. **Notifications** — Email/push when policies fire, fail, or pause
4. **Policy Chains** — Multi-step flows: trigger → action A → action B
5. **Gas-aware Execution** — "Only execute if gas < X gwei"

---

## Future Upgrades (Phase 7 — Tracking)

These items are tracked in `DOTARC_FUTURE_AUDITS_AND_UPGRADES.md` and represent the natural evolution of the policy system:

### Price Triggers
- Integrate CoinGecko or Chainlink price feeds
- Support cross-chain price monitoring
- Add price deviation thresholds ("notify me when BTC moves > 5%")

### Frontend Policy Dashboard
- Active policies tab in agent chat
- Visual policy cards with status badges
- One-click cancel with confirmation modal
- Execution history timeline

### Notifications
- Push/email when policy fires successfully
- Alert when policy is paused (balance low, HMAC fail, etc.)
- Weekly digest of policy activity

### Policy Chains / Composability
- Sequential execution: "When I receive USDC → swap 50% to ETH → send ETH to cold wallet"
- Conditional branching: "If balance > 100 → invest 20 USDC, else skip"
- Policy dependencies: "Only execute B if A succeeded"

### Gas & MEV Protection
- Max gas price gating
- Time-delayed execution (MEV resistance)
- Batch execution window optimization

### Advanced Stop Conditions
- "Pause if gas > 50 gwei"
- "Only execute on weekdays 9am–5pm UTC"
- "Require 2-of-3 multisig approval"
- "Pause if recipient address changed since creation"
