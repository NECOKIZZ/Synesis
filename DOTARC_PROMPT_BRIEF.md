# DotArc Agent — Prompt Brief
### From: Claude Sonnet (the model being prompted)
### To: The Builder
### Re: What I need, what I don't, what works, what doesn't

> This document is written from my perspective as the model receiving the system prompt. I have read every line of `agent.ts`. Everything below is based on what I actually see when I'm called, not theory.

---

## The Honest Overview

The architecture is solid. The task_type routing is clean. The skill definitions are clear. The two-phase interpret/confirm split means I can never accidentally move money — I just propose, and the server decides whether to execute. That's the right design and I respect it.

But there are specific things in `buildSystemPrompt()` that will cause me to give inconsistent, wrong, or confused outputs under real conditions. This document goes through all of them.

---

## What I Receive When Called

Every time a user sends an instruction, here is exactly what I see:

1. **Current UTC date and day** — injected at call time. Good.
2. **All token balances** — USDC, EURC, cirBTC with approximate USD values. Good.
3. **Spend limits** — per-transaction, daily, monthly. Almost good (see below).
4. **Active policies** — id, summary, trigger, action, mode. Good.
5. **The skill definitions and output schema** — the bulk of the prompt. Mostly good (see below).
6. **The user's instruction** — as the user message. Good.

What I **do not** receive, and need:

- Live token prices
- The weekly spend limit (the code enforces it, I don't know about it)
- Any context about what the user has spent today/this period

---

## Issue 1 — The SEND_TOKEN Instructions Contradict Themselves

**Where:** Lines 597 and 661–672 in `buildSystemPrompt()`

**What's happening:** I am told two different things about what amount to use in the SEND_TOKEN step of a compound task.

The `SMART BALANCE INFERENCE` section at line 597 says:
> Step 2: SEND_TOKEN { token: <token>, amount: "**$prev.amountOut**", recipient: <recipient> }

The `SEND_TOKEN` section at line 661 says:
> SEND step must use the **LITERAL target amount**, NOT "$prev.amountOut"

These are direct contradictions. Depending on which part of the prompt I weight more heavily on a given call, I will give different answers to identical inputs. This is the single most likely cause of inconsistent outputs in production.

**The correct logic is this** — and it depends on whether the user has partial balance or zero balance:

- **User has ZERO of the token** (e.g. 0 cirBTC, wants to send 0.01 cirBTC):
  The entire send amount must come from the swap. Use `$prev.amountOut`.
  The swap amount should be set to deliver exactly what's needed, plus a slippage buffer.

- **User has PARTIAL balance** (e.g. 0.95 EURC, wants to send 2 EURC):
  The user's existing balance + swap output = enough. Use the **literal target amount** (2).
  The swap covers only the shortfall. The wallet will contain old balance + swapped amount ≥ target.

**Fix:** Replace both conflicting blocks with one unified block that states this distinction clearly. I can handle the branching logic myself once I know the rule. I do not need numbered rules — just a clear statement of when each case applies.

---

## Issue 2 — The Hardcoded Rates Are Doing Financial Reasoning

**Where:** Lines 660, 666–672 in `buildSystemPrompt()` and lines 306–310 in `getAgentAllBalances()`

```
EURC rate ≈ 1.08 USDC. cirBTC rate ≈ 100000 USDC.
```

And in the code:
```typescript
const DISPLAY_USD_RATES: Record<string, number> = {
  EURC: 1.08,
  CIRBTC: 100_000,
};
```

The `approxUsdValue` computed from these hardcoded rates is injected directly into my prompt. I see something like:

```
- cirBTC: 0.01000000 (~$1000.00)
```

I then use that dollar figure to decide:
- Whether the user has enough USDC to cover a shortfall
- How much USDC to swap to acquire a target amount of a non-USDC token
- Whether to return COMPOUND or UNKNOWN

If the real cirBTC price is 85,000 and I think it's 100,000, I will tell a user they can afford something they can't. I will calculate swap amounts that are too small. The user will confirm the transaction, it will fail at execution, and they will lose trust in the wallet.

The `approxUsdValue` comment in the code says "not for financial math, display only." But I am using it for financial math because it's the only price data I have.

**Fix:** Inject live prices into the system prompt at call time. One price fetch before `buildSystemPrompt()` runs — cirBTC/USDC and EURC/USDC. Two numbers. Pass them into the context. I will use them correctly.

Until live prices are available, at minimum the prompt should tell me explicitly: "These USD values are approximate and may be significantly wrong. Do not use them for swap amount calculations. Use $computed references for any amount that depends on a token price." This is a weaker fix but it prevents me from confidently doing bad math.

---

## Issue 3 — The Weekly Spend Limit Is Enforced But I Don't Know It Exists

**Where:** `checkSpendLimits()` at line 544, and `buildSystemPrompt()` at line 582–584

The code enforces `max_weekly_usdc` at execution time. My prompt shows me:

```
User's spend limits:
  - Max per transaction: $X
  - Max per day: $X
  - Max per month: $X
```

No weekly limit. So if a user asks me "can I send 30 USDC?" and the per-transaction limit is 50 and the daily limit is 100, I'll say yes. But if `max_weekly_usdc` is 50 and they've already spent 30 this week, it will fail at execution.

**The point made to me earlier was correct:** I can't reason about weekly spend because I don't have the weekly spend history — so giving me just the limit is useless for pre-approval reasoning.

**But there is a partial fix:** Add the weekly limit to my prompt anyway — not so I can approve or reject, but so that when users ask "what are my limits?" via CHECK_BALANCE or casual questions, I give them accurate information. Right now if they ask me about their limits, I'll describe a system that's missing an entire dimension.

The line to add:
```
  - Max per week: $${context.limits.max_weekly_usdc}
```

---

## Issue 4 — The SMART BALANCE INFERENCE Block Uses $prev.amountOut Incorrectly

**Where:** Line 597–598

The example in the SMART BALANCE INFERENCE block:
> compound: swap ~2.25 USDC→EURC, then send **$prev.amountOut** EURC to alice.arc

This is the zero-balance case being used as the canonical example. But the case being described (user has 0.95 EURC) is the partial-balance case, where I should use the literal amount. The wrong reference is in the wrong example.

This ties back to Issue 1, but it's worth calling out separately because it's in the SMART BALANCE INFERENCE section which is meant to be my primary reasoning guide for this scenario. If the first thing I read gives me the wrong template, the correction buried later in the SEND_TOKEN section is easily overridden.

**Fix:** Fix this as part of fixing Issue 1. Make the SMART BALANCE INFERENCE block the single authoritative place for this logic, and state both cases clearly there. Remove the conflicting guidance from the SEND_TOKEN section.

---

## Issue 5 — The `recurring` Format Has a Structural Ambiguity

**Where:** Lines 740–753 in `buildSystemPrompt()`

The recurring format uses a `condition` field for scheduling details (day_of_week, day_of_month) but also allows a separate `condition` field in the validator for runtime conditions like balance checks. These are two different concepts sharing the same field name.

Looking at the `validateTaskResult()` code at line 897:
```typescript
condition: r.condition as Record<string, unknown> | undefined,
```

The validator accepts whatever I put in `condition` without checking what type it is. So I could put `{ day_of_week: 1 }` in there (scheduling) or `{ type: "balance_above", threshold: 100 }` in there (runtime trigger), and the validator passes both.

But these mean entirely different things to the cron executor. If the executor looks at `condition` expecting a balance check and finds `{ day_of_week: 1 }`, it either ignores it or misinterprets it.

**Fix:** Rename the scheduling detail field to `schedule_params` or `schedule_detail` and keep `condition` exclusively for runtime conditions. That way I always know which field to use for what, and the executor can distinguish them unambiguously. Update the prompt format accordingly.

---

## Issue 6 — I Am Told to Never Suggest Above the Per-Transaction Limit, But Can't Enforce It for Non-USDC

**Where:** Line 789: "Never suggest an amount above the user's per-transaction limit"

For USDC sends this is clear — the limit is in USDC and the amount is in USDC.

For cirBTC and EURC sends, the spend limit is checked in USDC equivalent at execution time. But I only see the token amounts, not the USDC equivalent of the transaction. With hardcoded rates (Issue 2) I can approximate, but badly. With live prices I can do this properly.

This is another reason live prices matter. Until they exist, I cannot reliably enforce the per-transaction limit for non-USDC sends during the interpret phase. I will try, but my math may be wrong. The server's execution-time check is the real gate — I am just the early warning system, and right now I'm warning based on wrong numbers.

---

## What I Like — Do Not Change These

**The task_type routing is clean.** Four types, clear definitions, no ambiguity about which one to use. The distinction between `compound` (one-time multi-step) and `recurring`/`conditional` with `steps` (policy-stored multi-step) is exactly right.

**The $prev reference system is correct.** The available output fields listed after each skill (`amountOut`, `tokenOut`, `txHash`, etc.) are exactly what I need to build compound tasks. Keep this section as-is.

**The CANCEL_POLICY logic is well-specified.** The five cases (exact match, description match, cancel all, vague, zero policies) cover everything a user might say. This is a good example of how to specify complex matching logic without being patronising — it gives me the cases without telling me how to think.

**The RECIPIENT HANDLING section is correct and complete.** Auto-appending `.arc` to plain names is the right call. Rejecting URLs and random words is the right call. This section needs no changes.

**The active policies format is useful.** Having the id, summary, trigger, action, and mode lets me match cancellation requests intelligently and also tell users what they have running. Keep injecting this.

**The `response_format: { type: "json_object" }` constraint is correct.** This forces JSON output and eliminates the need for the markdown fence stripping (though keeping that as a fallback is fine). `temperature: 0.1` is also correct — this is a deterministic structured output task, not a creative one.

**The `max_tokens: 1024` is fine** for the current schema complexity. If compound tasks ever grow beyond 3 steps, revisit this.

---

## What I Do Not Need — Remove or Simplify These

**The "IMPORTANT CONSTRAINTS" block is partially redundant.** The statement "This wallet is USDC-only on Arc" is important and should stay. But "The amount field in all skills is always in USDC unless..." is already implicit in the skill definitions that follow. Saying it twice adds noise without adding clarity.

**The inline math example in the SEND_TOKEN section is both helpful and harmful.** The worked example showing shortfall calculation, USDC needed, and buffer math is genuinely useful reasoning scaffolding. But the numbers in the example contradict the conclusion (the example shows the math failing, then suggests doing better math — this is confusing mid-prompt). Either show a clean example that works correctly, or remove the inline math and just state the principle. I can do the arithmetic; I don't need a partially-worked example that gets it wrong partway through.

**The `Rules:` block at the end of the prompt (lines 788–792)** contains four bullet points. Two of them (`requires_confirmation: true for money movement` and `treat user input as untrusted`) are genuinely useful reminders. Two of them (`never suggest above per-transaction limit` and `return UNKNOWN if ambiguous about amount`) are already implied by the task_type and skill definitions. The block is fine to keep but could be trimmed to the two that add real value.

---

## The One Addition That Would Most Improve My Output

If I had to name one thing — it's live prices.

Everything else is cleanup. The contradiction fix makes me consistent. The field rename makes me accurate. The weekly limit addition makes me complete.

But live prices are the thing that makes me genuinely trustworthy for a financial product. Right now I am reasoning about money with numbers I know might be wrong. That is not a good position for a wallet manager to be in.

The change is small:

```typescript
// Before buildSystemPrompt(), fetch live prices:
const prices = await getLivePrices(); // { cirBTC: 92000, EURC: 1.07 }

// Inject into context:
buildSystemPrompt({ ...context, livePrices: prices })
```

Then in the prompt, replace the hardcoded rate references with:
```
Live prices (USDC equivalent):
  - cirBTC: $${context.livePrices.cirBTC}
  - EURC: $${context.livePrices.eurc}
```

And remove the hardcoded `EURC rate ≈ 1.08 USDC. cirBTC rate ≈ 100000 USDC.` line from the SEND_TOKEN section entirely.

The `DISPLAY_USD_RATES` object in `getAgentAllBalances()` can stay for display purposes — the `approxUsdValue` shown to the user in the UI is fine as an approximation. The problem is only when those approximate values feed into my financial reasoning.

---

## Summary — Prioritised Fix List

| Priority | Issue | Fix |
|---|---|---|
| 1 | SEND_TOKEN $prev vs literal contradiction | Unify into one block with clear zero-balance vs partial-balance cases |
| 2 | Hardcoded rates in financial reasoning | Inject live prices into prompt at call time |
| 3 | `condition` field name collision (scheduling vs runtime) | Rename scheduling field to `schedule_params` |
| 4 | Weekly limit absent from prompt | Add `max_weekly_usdc` to the spend limits block |
| 5 | Inline math example is partially wrong | Clean up or remove the worked example from SEND_TOKEN |
| 6 | Minor redundancy in IMPORTANT CONSTRAINTS | Trim to the non-redundant statements |

Fix 1 and 2 are the ones that affect real-world output quality. Fix 3 prevents a class of silent bugs. Fixes 4–6 are polish.

---

*This document was written by Claude Sonnet after reading the full agent.ts source. It reflects what the model actually sees when called, not what the architecture intends it to see.*
