# SEND_USDC Skill — Audit Findings

Date: 2026-05-21
Scope: `lib/skills/send-usdc.ts`

---

## What the skill does

User types something like "send 5 USDC to sara.arc". The skill resolves sara's real wallet address server-side, checks the user hasn't blown their spend limits, logs the attempt, fires the Circle transfer, then marks it complete. The user never sees a raw `0x` address.

**Params required:** `recipient` (`.arc` name or `0x` address), `amount` (number)

---

## Findings

---

### S1 — No balance check before transfer (HIGH)

**Problem:**
The skill checks spend *limits* (daily/weekly/monthly caps) but never checks whether the agent wallet actually has enough USDC to cover the transfer. If the balance is 2 USDC and the user tries to send 5, Circle rejects it — but the user sees a generic 502 error with no explanation.

Beyond UX, this means a PENDING log row is written and the Circle call is attempted even when the outcome is guaranteed to fail.

**Fix:**
Every money-moving skill must check balance first, before anything else — before limit checks, before logging, before calling Circle. This is a global rule for all money-moving skills, not just SEND_USDC.

```ts
// Fetch agent wallet balance before anything else
const balance = await getAgentWalletBalance(agentWallet.circle_wallet_id);
if (balance < amount) {
  return {
    ok: false,
    error: `userFriendly`,
    status: 400,
  };
}
```

**User-friendly error message:**
> "Your agent wallet only has [X] USDC, but you're trying to send [Y]. Top up your agent wallet and try again."

---

### S2 — Silent failure if PENDING log insert fails (HIGH)

**Problem:**
The PENDING log is inserted using the user-scoped Supabase client. If this insert fails silently (RLS edge case, DB hiccup), `logRow` is `null`. The code checks `if (logRow?.id)` before updating status — but it does **not** stop execution. The transfer goes through with zero audit trail.

Money moves. Nothing is recorded. This is a silent integrity failure.

**Fix:**
Treat a failed PENDING insert as a hard stop. Do not proceed to the Circle call if there is no log row.

```ts
if (!logRow?.id) {
  return {
    ok: false,
    error: `userFriendly`,
    status: 500,
  };
}
```

**User-friendly error message:**
> "Something went wrong on our end before we could process your transfer. No money has moved. Please try again in a moment."

---

### S3 — Idempotency window is undefined in this file (MEDIUM)

**Problem:**
The idempotency key `SEND_USDC:sara.arc:5.000000` correctly blocks double-tap duplicates. But the dedup window (how long the key stays active) is not defined here — it lives somewhere in `confirm-policy`. If that window is too long (e.g. 5 minutes), a user who legitimately wants to send sara 5 USDC twice in quick succession will be silently blocked with no explanation.

**Fix:**
The dedup window should be short — 60 seconds is reasonable. And if a request is rejected due to idempotency, the user must be told why, not just silently dropped.

**User-friendly error message:**
> "It looks like you just sent this exact payment. If you meant to send it again, wait a minute and try once more."

---

### S4 — Amount precision: limit check uses raw float, Circle gets rounded value (MEDIUM)

**Problem:**
JavaScript floating point means `5.1 + 0.2 !== 5.3`. The spend limit check runs against the raw `Number(params.amount)` before `toFixed(6)` is applied. The Circle call uses the rounded value. In most cases the difference is negligible, but the limit check and the actual transfer amount are technically operating on different values.

**Fix:**
Normalise the amount to a fixed-precision decimal string first, then derive the number from that for all downstream uses.

```ts
const amountNormalised = parseFloat(Number(params.amount).toFixed(6));
```

Use `amountNormalised` for both the limit check and the Circle call.

---

### S5 — Generic 502 on Circle failure gives user no actionable information (LOW)

**Problem:**
Any Circle transfer failure returns `{ ok: false, error: msg, status: 502 }` where `msg` is the raw Circle error message. Circle errors are technical and not user-friendly. Users may see things like `"TRANSFER_FAILED"` or `"INSUFFICIENT_FUNDS"` with no context.

**Fix:**
Map known Circle error codes to friendly messages before returning. Unknown errors get a safe generic fallback.

**User-friendly error messages:**
- Insufficient funds: `"Your agent wallet doesn't have enough USDC to complete this transfer."`
- Invalid address: `"The recipient address doesn't look right. Double-check the .arc name and try again."`
- Unknown: `"The transfer didn't go through. No money has left your wallet. You can try again — if the problem keeps happening, contact support."`

---

## Summary Table

| ID | Severity | Issue | Fix Required |
|---|---|---|---|
| S1 | HIGH | No balance check before transfer | Check balance first on every money-moving skill |
| S2 | HIGH | Silent execution if PENDING log insert fails | Hard-stop if no log row |
| S3 | MEDIUM | Idempotency window undefined and silent | Define 60s window, surface friendly error |
| S4 | MEDIUM | Float precision mismatch between limit check and transfer | Normalise amount to fixed decimal first |
| S5 | LOW | Raw Circle errors exposed to user | Map known codes to friendly messages |

---

## Global Rule Added (applies to all money-moving skills)

> **Every skill that moves money must check the agent wallet balance before doing anything else — before limit checks, before logging, before calling Circle. A balance shortfall must return a clear, friendly error immediately.**
