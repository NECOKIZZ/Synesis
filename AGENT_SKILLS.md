# DotArc Smart Agent — Skills Reference

Every skill follows the same two-phase flow:

```
User types instruction
       │
       ▼
POST /api/agent/interpret       ← OpenRouter (Claude) translates natural language
       │                           Returns: { skill, params, confirmation_message }
       │                           NEVER executes. Safe to call freely.
       ▼
Frontend shows confirmation card
       │
       ▼
POST /api/agent/confirm-policy  ← User enters agent PIN here
       │                           Server re-validates limits, verifies ownership
       │                           Then executes the skill
       ▼
Result shown in chat
```

**The interpreter only translates.** It does not know your balance, your history,
or your real wallet address. It only maps words → skill name + params.

**The executor is the security gate.** PIN, spend limits, address validation,
ownership checks — all enforced server-side in confirm-policy regardless of what
the interpreter returned. Claude output is treated as untrusted input.

---

## Security layers (applied to every skill execution)

| Layer | What it checks |
|---|---|
| **L1** | DotArc JWT session cookie (signed, short-TTL) |
| **L2** | Supabase email matches JWT email — `agent_wallets.user_id` ownership |
| **L3** | Agent PIN (bcrypt, 12 rounds). Lockout: 3 wrong → 15 min, 5 wrong → 60 min |
| **L4** | HMAC signature on stored policies (POLICY_HMAC_SECRET) — DB compromise alone cannot forge an instruction |

---

## Skill catalogue

---

### CHECK_BALANCE

**What it does:** Reads the agent wallet's current USDC balance from Circle.
Read-only. No PIN required in chat (PIN gate is bypassed for this skill only).

**Trigger phrases:**
- "what's my agent balance"
- "how much USDC do I have"
- "check balance"

**Interpreter output:**
```json
{ "skill": "CHECK_BALANCE", "params": {}, "requires_confirmation": false }
```

**Execution:**
- Calls Circle `getWalletTokenBalance` for the agent's `circle_wallet_id`
- Returns `{ balanceUsdc: "12.50" }`
- No DB write

**Edge cases:** If Circle is unreachable, returns cached value from `agent_wallets.balance_cache_usdc`.

---

### SEND_USDC

**What it does:** One-time immediate USDC transfer from the agent wallet to any address or `.arc` name.

**Trigger phrases:**
- "send 5 USDC to sara.arc"
- "pay 10 USDC to 0x848f…"
- "transfer 2 dollars to john.arc"

**Interpreter output:**
```json
{
  "skill": "SEND_USDC",
  "params": { "recipient": "sara.arc", "amount": 5 },
  "requires_confirmation": true
}
```

**Execution (server-side, after PIN):**
1. Resolve recipient server-side (`resolveRecipient`) — never trust Claude's resolution
2. Validate resolved address with `ethers.isAddress()`
3. Reject if recipient = own agent wallet address
4. Check spend limits: per-transaction cap + daily cap + monthly cap against `agent_spend_log`
5. Insert `agent_spend_log` row as `PENDING`
6. Call Circle developer-controlled wallet transfer API
7. Poll until confirmed, update log to `COMPLETE` with `tx_hash`

**What it needs:**
- `CIRCLE_AGENT_WALLET_SET_ID` (wallet lives here)
- `NEXT_PUBLIC_USDC_TOKEN_ADDRESS`
- Agent wallet must have sufficient balance

**Enforced limits:** `max_per_transaction_usdc`, `max_daily_usdc`, `max_monthly_usdc`

---

### RECURRING_PAYMENT

**What it does:** Saves a repeating payment policy. The agent will execute it automatically on schedule (requires a cron job — see below).

**Trigger phrases:**
- "send 10 USDC to sara.arc every week"
- "pay rent 50 USDC monthly on the 1st"
- "set up daily payment of 2 USDC to 0x848f…"

**Interpreter output:**
```json
{
  "skill": "RECURRING_PAYMENT",
  "params": {
    "recipient": "sara.arc",
    "amount": 10,
    "frequency": "weekly",
    "day_of_week": 1
  },
  "requires_confirmation": true
}
```

**Execution (server-side, after PIN):**
1. Resolve recipient address server-side
2. Check `amount ≤ max_per_transaction_usdc`
3. Compute `next_run` timestamp based on frequency + day params
4. Insert into `agent_policies` with all params
5. Compute HMAC over `(userId, policyId, skill, recipientAddress, amount, frequency, createdAt)` using `POLICY_HMAC_SECRET`
6. Store HMAC in `agent_policies.policy_hmac` — prevents DB-only forgery

**Frequency options:** `daily` | `weekly` (+ `day_of_week` 0-6) | `monthly` (+ `day_of_month` 1-31)

**Cron execution (TODO — not yet built):**
- A cron job reads `agent_policies` where `active = true AND next_run <= now()`
- Re-verifies HMAC before executing (rejects tampered rows)
- Re-resolves `.arc` name at execution time — if address changed, pauses policy with `pause_reason`
- After execution, updates `next_run` to next scheduled time

---

### SET_LIMIT

**What it does:** Updates one of the user's spend guardrails. Requires PIN. Enforces hard ceilings.

**Trigger phrases:**
- "set my daily limit to 200 USDC"
- "change per-transaction limit to 25"
- "lower my monthly cap to 300"

**Interpreter output:**
```json
{
  "skill": "SET_LIMIT",
  "params": { "type": "daily", "amount": 200 },
  "requires_confirmation": true
}
```

**Limit types:** `per_transaction` | `daily` | `weekly` | `monthly`

**Hard ceilings (server-enforced, not configurable via chat):**

| Limit | Ceiling |
|---|---|
| per_transaction | $500 USDC |
| daily | $1,000 USDC |
| weekly | $2,000 USDC |
| monthly | $5,000 USDC |

**Execution:** Upserts `user_spend_limits` for the specific column.

---

### CANCEL_POLICY

**What it does:** Deactivates one or all active recurring policies. Requires PIN.

**Trigger phrases:**
- "cancel my weekly payment to sara.arc"
- "stop all recurring payments"
- "cancel policy abc-123"

**Interpreter output:**
```json
{
  "skill": "CANCEL_POLICY",
  "params": { "policy_id": "abc-123", "description": "weekly payment to sara.arc" },
  "requires_confirmation": true
}
```

**Execution:**
- If `policy_id` provided: cancels that specific policy (ownership-checked via `user_id`)
- If no `policy_id`: cancels ALL active policies for this user
- Sets `active = false`, `pause_reason = "Cancelled by user"`
- The HMAC row is left intact for audit history

---

### WITHDRAW

**What it does:** Moves USDC from the agent wallet back to the user's main wallet. Requires PIN.

**Trigger phrases:**
- "withdraw everything from my agent"
- "move 20 USDC back to my main wallet"
- "pull out all funds"

**Interpreter output:**
```json
{
  "skill": "WITHDRAW",
  "params": { "amount": "all" },
  "requires_confirmation": true
}
```

**Amount:** Decimal number OR the string `"all"` (server resolves current balance minus rounding buffer).

**Execution:**
1. Resolve destination = `session.walletAddress` (main wallet — from JWT, not from Claude)
2. Validate with `ethers.isAddress()`
3. Log `PENDING`, execute Circle transfer, update to `COMPLETE`

**Note:** Withdraw is NOT subject to spend limits — it's moving funds back to the owner's control, not spending.

---

### UNKNOWN

**What it does:** Returned by the interpreter when the instruction doesn't map to any skill.

**Interpreter output:**
```json
{
  "skill": "UNKNOWN",
  "params": { "explanation": "I can help with sending, scheduling, balance checks, limits, and withdrawals." },
  "requires_confirmation": false
}
```

**Execution:** Nothing. The explanation is shown directly in chat. No confirm card shown.

---

## Adding a new skill (checklist)

1. Add the skill name to `SkillName` type in `lib/agent.ts`
2. Add it to the OpenRouter prompt's JSON schema in `interpretInstruction()` with its required params
3. Add a case in the `confirm-policy/route.ts` switch (after PIN + limits are already validated)
4. Document it here with trigger phrases, interpreter output, execution steps, and edge cases
5. If it needs DB storage, add the table/column in a new migration

---

## What's NOT built yet (planned)

- **Cron job** for recurring payment execution (`/api/cron/execute-policies`)
- **SWAP_USDC** — swap one token for another via Circle Swap Kit
- **BRIDGE_USDC** — bridge USDC to another chain via CCTP
- **PRICE_CHECK** — look up token price via OpenRouter + paid API
- **NOTIFY** — send a push/email alert when balance drops below threshold
