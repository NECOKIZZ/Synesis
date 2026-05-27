# CREATE_POLICY — Interpreter Prompt Spec

Date: 2026-05-21
File this belongs in: `lib/agent.ts` → `interpretInstruction()` prompt

---

## Where This Lives in the Codebase

The `interpretInstruction()` function in `lib/agent.ts` sends a prompt to the LLM
(via OpenRouter) and gets back a JSON object like:

```ts
{ skill: string, params: object, requires_confirmation: boolean }
```

The prompt currently lists skills: CHECK_BALANCE, SEND_USDC, RECURRING_PAYMENT,
SET_LIMIT, CANCEL_POLICY, WITHDRAW.

**Change required:**
- Remove `RECURRING_PAYMENT` from the skill list
- Add `CREATE_POLICY` with the full schema and examples below
- `CANCEL_POLICY` stays — it cancels an existing policy by ID

---

## The Prompt Addition

Paste this block into the interpreter prompt, replacing the RECURRING_PAYMENT entry:

---

```
### CREATE_POLICY

Use this skill whenever the user's instruction contains a schedule, condition,
repetition, or any trigger that means "do this automatically later or repeatedly".

Trigger words that signal CREATE_POLICY (not exhaustive):
  every, whenever, when, once it, until, automatically, daily, weekly, monthly,
  every time, repeat, schedule, keep doing, stop when, as long as

Do NOT use CREATE_POLICY for one-time immediate actions.
  "send 5 USDC to sara" → SEND_USDC (immediate, no schedule)
  "send 5 USDC to sara every week" → CREATE_POLICY (has schedule)

---

Output schema for CREATE_POLICY:

{
  "skill": "CREATE_POLICY",
  "requires_confirmation": true,
  "params": {
    "trigger": {
      "type": "time" | "price" | "balance_above",

      // If type is "time":
      "frequency": "daily" | "weekly" | "monthly",
      "day_of_week": 0-6,        // 0=Sunday. Only include if frequency is "weekly"
      "day_of_month": 1-31,      // Only include if frequency is "monthly"

      // If type is "price":
      "asset": "BTC" | "ETH" | "USDC",
      "direction": "below" | "above",
      "threshold": number,       // Price in USD

      // If type is "balance_above":
      "threshold_usdc": number   // Agent USDC balance threshold
    },

    "action": {
      "skill": "SEND_USDC" | "SWAP_USDC" | "WITHDRAW",
      "params": {
        // Exact params the target skill needs
        // SEND_USDC: { "recipient": string, "amount": number }
        // SWAP_USDC: { "from_asset": string, "to_asset": string, "amount": number }
        // WITHDRAW:  { "amount": number | "all" }
      }
    },

    "execution_mode": "once" | "repeat",
    // "once"   = fire once when condition is met, then deactivate
    // "repeat" = fire every time condition is met (time: on schedule, price: on each crossing)

    "stop_conditions": [
      // Optional array. Include only what the user mentioned.
      // Leave as empty array [] if none mentioned.

      { "type": "balance_below",   "threshold_usdc": number },
      { "type": "expires_at",      "date": "YYYY-MM-DD" },
      { "type": "max_executions",  "count": number },
      { "type": "max_total_spend", "amount_usdc": number }
    ],

    "description": string
    // Plain English summary of what this policy does.
    // Shown to user on the confirmation card.
    // Examples:
    //   "Send 5 USDC to sara.arc every week. Stops when balance drops below 20 USDC."
    //   "Buy BTC once the price drops below $80,000."
    //   "Send 10 USDC to john.arc every Monday for 5 weeks."
  }
}

---

Few-shot examples:

---

User: "pay sara 5 USDC every week"

{
  "skill": "CREATE_POLICY",
  "requires_confirmation": true,
  "params": {
    "trigger": { "type": "time", "frequency": "weekly" },
    "action": {
      "skill": "SEND_USDC",
      "params": { "recipient": "sara.arc", "amount": 5 }
    },
    "execution_mode": "repeat",
    "stop_conditions": [],
    "description": "Send 5 USDC to sara.arc every week."
  }
}

---

User: "pay sara every week until my balance drops below 20 USDC"

{
  "skill": "CREATE_POLICY",
  "requires_confirmation": true,
  "params": {
    "trigger": { "type": "time", "frequency": "weekly" },
    "action": {
      "skill": "SEND_USDC",
      "params": { "recipient": "sara.arc", "amount": 5 }
    },
    "execution_mode": "repeat",
    "stop_conditions": [
      { "type": "balance_below", "threshold_usdc": 20 }
    ],
    "description": "Send 5 USDC to sara.arc every week. Stops when your balance drops below 20 USDC."
  }
}

---

User: "buy BTC once the price drops below 80000"

{
  "skill": "CREATE_POLICY",
  "requires_confirmation": true,
  "params": {
    "trigger": { "type": "price", "asset": "BTC", "direction": "below", "threshold": 80000 },
    "action": {
      "skill": "SWAP_USDC",
      "params": { "from_asset": "USDC", "to_asset": "BTC", "amount": 50 }
    },
    "execution_mode": "once",
    "stop_conditions": [],
    "description": "Swap 50 USDC for BTC once the BTC price drops below $80,000. Runs once then stops."
  }
}

---

User: "buy BTC every time the price drops below 80000"

{
  "skill": "CREATE_POLICY",
  "requires_confirmation": true,
  "params": {
    "trigger": { "type": "price", "asset": "BTC", "direction": "below", "threshold": 80000 },
    "action": {
      "skill": "SWAP_USDC",
      "params": { "from_asset": "USDC", "to_asset": "BTC", "amount": 50 }
    },
    "execution_mode": "repeat",
    "stop_conditions": [],
    "description": "Swap 50 USDC for BTC every time the BTC price drops below $80,000."
  }
}

---

User: "send 10 USDC to john every Monday, stop after 5 payments"

{
  "skill": "CREATE_POLICY",
  "requires_confirmation": true,
  "params": {
    "trigger": { "type": "time", "frequency": "weekly", "day_of_week": 1 },
    "action": {
      "skill": "SEND_USDC",
      "params": { "recipient": "john.arc", "amount": 10 }
    },
    "execution_mode": "repeat",
    "stop_conditions": [
      { "type": "max_executions", "count": 5 }
    ],
    "description": "Send 10 USDC to john.arc every Monday. Stops after 5 payments."
  }
}

---

User: "automatically withdraw everything when my balance hits 200 USDC"

{
  "skill": "CREATE_POLICY",
  "requires_confirmation": true,
  "params": {
    "trigger": { "type": "balance_above", "threshold_usdc": 200 },
    "action": {
      "skill": "WITHDRAW",
      "params": { "amount": "all" }
    },
    "execution_mode": "once",
    "stop_conditions": [],
    "description": "Withdraw everything from your agent wallet once your balance reaches 200 USDC. Runs once then stops."
  }
}

---

Disambiguation rules (include these in the prompt):

1. "once it goes below" → execution_mode: "once"
   "every time it goes below" → execution_mode: "repeat"

2. If the user says "every week" without specifying a day,
   do not guess a day. Leave day_of_week out. The server picks Monday as default.

3. If the user does not specify an amount for a swap or send policy,
   return skill: "UNKNOWN" with explanation:
   "I need to know how much you want to [send/swap]. How much USDC?"

4. If the trigger is "price" but no asset is mentioned,
   return skill: "UNKNOWN" with explanation:
   "Which asset's price should I watch — BTC, ETH, or something else?"

5. The description field must always be filled. Write it as if confirming
   back to the user in plain English what you understood. This is what
   they read on the confirmation card before entering their PIN.
```

---

## Confirmation Card Display

The frontend reads `params.description` from the interpreter output and shows it
on the confirmation card before the user enters their PIN.

This means the LLM-generated `description` is the user's last chance to catch a
misunderstanding before the policy is saved. It must be accurate, complete, and
written in plain English.

Example card for "pay sara every week until balance below 20":

```
┌─────────────────────────────────────────┐
│  📅  New Scheduled Policy               │
│                                         │
│  Send 5 USDC to sara.arc every week.    │
│  Stops when your balance drops          │
│  below 20 USDC.                         │
│                                         │
│  This will run automatically using      │
│  your original authorization.           │
│                                         │
│  [Enter PIN to confirm]  [Cancel]       │
└─────────────────────────────────────────┘
```

---

## confirm-policy Changes Required

When `confirm-policy` receives `skill: "CREATE_POLICY"`:

1. Validate all required fields are present (trigger, action, execution_mode)
2. Resolve action.params.recipient server-side if action.skill is SEND_USDC
   — never trust the LLM's resolution
3. Validate action.params against the target skill's own param rules
4. Compute HMAC over the full policy params (see POLICY_ORCHESTRATION_SPEC.md)
5. Insert into agent_policies
6. Return confirmation with the policy ID and human-readable summary

The target action skill's `execute()` is NOT called here.
confirm-policy only saves the policy. The cron calls execute() later.
