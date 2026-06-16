# DotArc Agent — V4 Architecture (Final, Build-Ready)

**Status:** Locked for implementation
**Implementation window:** After V3 mainnet is stable
**Last updated:** June 14, 2026
**Supersedes:** `v4-architecture.md` and the earlier "Project Synesis" revision

> This document is the single source of truth for V4. Every decision here was
> argued through and locked. Where V4 reuses V3 code, it is named explicitly so
> we do not rebuild what already works. Read Section 0 before writing any code.

---

## 0. The Five Things That Will Cause Bugs If You Forget Them

1. **V4 is NOT native function calling.** It is prompt-defined JSON (the same
   mechanism V3 uses). We deliberately rejected native function calling and the
   wrapper tool. Do not "upgrade" to native FC later thinking it's cleaner — read
   Section 3 for why this was a deliberate, correct choice.
2. **Everything is serial.** No parallel tasks. No `Promise.all` over tasks. No
   spend reservation system. A single Circle wallet has a single nonce — parallel
   spend is physically unsafe. Tasks run one-by-one inside `withUserLock`.
3. **Tasks vs Steps grouping still matters even though all execution is serial.**
   It is not redundant. See Section 2.3.
4. **Preconditions are declared per-skill and gated on `affectsFunds`.** There is
   NO central map of "skill → checks". Each skill carries its own `precheck()`.
   Read/config skills have none, so they add zero latency. See Section 5.
5. **Reuse, don't rebuild.** `executePlan`, `resolvePrevRefs`, the idempotency
   layer, `withUserLock`, and `validateTasksShape` already exist and work. V4's
   real delta is small: lean prompt + per-skill precheck + memory restructure +
   a router seam. See Section 9.

---

## 1. What V4 Actually Changes (and What It Does Not)

V3 works. Its pains were: a bloated ~3,000-token prompt, occasional JSON parse
failures, and business logic (balance math, name resolution) living in the prompt.

**V4 fixes those by moving logic into the right layers — not by changing the
core mechanism.** The LLM still returns a `{ tasks: [ { steps: [] } ] }` JSON
envelope defined in the prompt; the engine still decodes it and executes serially.

| Concern | V3 | V4 |
|---|---|---|
| Output format | Prompt-defined JSON | **Same** — prompt-defined JSON |
| Schema guarantee | Self-validated (`validateTasksShape`) | **Same** — kept, prompt leaned so it rarely trips |
| Balance / affordability logic | In the prompt (SMART BALANCE INFERENCE) | Per-skill `precheck()` in code + cheap balance snapshot in prompt |
| Name resolution / slippage / buffers | Mixed prompt + skill | Per-skill `precheck()` in code |
| Skill descriptions | All 11 in prose, every call | Lean; all skills still sent (no active router yet — see Section 8) |
| Wallet balance | Polled from Circle | Webhook-maintained local cache (fast) |
| Execution | Serial tasks | **Same** — serial, reused engine |
| Parallel tasks | Never (sequential dispatch) | **Same** — explicitly never |

**The honest framing:** most of V3's bloat was *content* (business logic), not
*format*. Native function calling only removes *format* scaffolding. We remove the
*content* bloat by hand — into code, memory, and webhooks — which is the part that
actually matters and does not require native function calling.

---

## 2. Execution Model — Tasks and Steps (Serial)

### 2.1 The Envelope

The LLM returns this exact shape. It is defined in the system prompt, parsed by
the engine, and validated by `validateTasksShape`. It is NOT a function-calling
wrapper tool — it never maps to a callable function. It is pure ordering metadata.

```json
{
  "tasks": [
    {
      "trigger": { "type": "now" },
      "execution_mode": "once",
      "confirmation_message": "Send 10 USDC to sara.arc",
      "steps": [
        { "skill": "SEND_USDC", "description": "Send to Sara", "params": { "recipient": "sara.arc", "amount": 10 } }
      ]
    }
  ]
}
```

### 2.2 How It Executes

- **Tasks run sequentially**, one after another (reused: the `for` loop in
  `runBatch` → `dispatchTask` in `confirm-policy/route.ts`).
- **Steps within a task run sequentially**, each receiving the previous step's
  actual output via `$prev` (reused: `executePlan` + `resolvePrevRefs`).
- **No task ever runs in parallel with another.** The whole batch is wrapped in
  `withUserLock` when it affects funds.

### 2.3 Why Tasks vs Steps Still Matters (Even Though Both Are Serial)

This is the trap. Since we dropped parallel execution, it is tempting to flatten
everything into one list. **Do not.** The grouping still encodes three things:

| Property | Steps (within one task) | Tasks (separate) |
|---|---|---|
| `$prev` result passing | Yes — step 2 can use step 1's output | No — tasks are independent |
| Failure isolation | Chain stops; partial-success message | Task 3 still runs if task 2 fails |
| Idempotency key | One key per task (whole chain) | Separate key per task |

**Rule for the LLM (state in prompt):**
- Dependent actions (swap → send the result) → **one task, multiple steps**.
- Independent actions (send to A, send to B) → **separate tasks, one step each**.

### 2.4 `$prev` Stays

`$prev.<field>` references the *actual* runtime output of the previous step,
resolved by `resolvePrevRefs` before each step executes. This is already built and
working. It is the correct way to chain swap → send: send `$prev.amountOut` and the
send physically cannot fail from slippage because you send exactly what you received.

```
Step 1: SWAP_USDC  → returns { amountOut: 9.79, tokenOut: "EURC" }
Step 2: SEND_TOKEN params { amount: "$prev.amountOut" } → resolves to 9.79 at runtime
```

---

## 3. Why Prompt-Defined JSON, Not Native Function Calling

Recorded so no future contributor "fixes" this by adopting native FC.

**Native function calling can do sequential work in only two ways, and both were
rejected for us:**

1. **Multi-turn agentic loop** (call → result → call → result). Handles
   dependencies best, but every turn is a separate billable LLM call. On OpenRouter
   that is N× cost and N× latency per compound task. **Rejected: too expensive.**
2. **A single wrapper "plan" tool** whose arguments hold the ordered steps.
   Single call, schema-enforced — but it is the wrapper tool we explicitly do not
   want. **Rejected: user decision; adds nothing our guard doesn't already cover.**

   (Native FC's third mode — multiple `tool_calls` in one response — is *parallel*
   by spec, cannot express dependent chains, and cannot pass `$prev`. Useless here.)

**What we do instead:** the plan lives as JSON in the prompt (informal Pattern 3).
We get a single upfront dependent plan in one LLM call. We give up the API's free
*structural* validity guarantee and keep our own `validateTasksShape` guard.

**What this costs us:** one small job — structural validation (is it parseable,
correctly shaped?). It is already built. *Meaning* validation (balance, limits,
name resolution) we would have to write either way, even with native FC — the API
never guarantees those.

**Net:** we avoid the wrapper tool and keep full control of the envelope, in
exchange for ~30 lines of structural guard we already own. A lean prompt makes
malformed output rare. Coherent, standard choice.

---

## 4. Validation Guard (Reused)

Keep `validateTasksShape` in `confirm-policy/route.ts`. It already enforces:
- `tasks` is a non-empty array, max 5
- each task has a `trigger.type`, `execution_mode` of `once|repeat`
- `steps` is length 1–3, each with a string `skill` and object `params`
- skills are resolved against `skillRegistry` up front (fail fast on typos)

Add only a light JSON repair pass before it (strip prose preamble, fix trailing
commas) — but keep it minimal. With a lean prompt and low temperature, malformed
JSON is rare. Log every repair/validation failure with the raw LLM output for two
weeks, then tune based on real failure rates.

---

## 5. Preconditions — Per-Skill, Gated on `affectsFunds`

### 5.1 The Model

**There is no central "skill → checks" map.** Each skill declares its own
preconditions via an optional `precheck()` on its handler. The knowledge stays
co-located with the skill (it already lives inside each `execute()` today — we are
just lifting it earlier so the whole chain is validated before any money moves).

```ts
// lib/skills/types.ts — add to SkillHandler
type SkillHandler = {
  category: "TRANSFER" | "READ" | "POLICY" | ...;
  affectsFunds: boolean;
  requiresPin: boolean;
  idempotencyKey?(params): string | null;
  precheck?(ctx: SkillContext): Promise<{ ok: true } | { ok: false; reason: string }>; // NEW
  execute(ctx: SkillContext): Promise<SkillOutput>;
};
```

### 5.2 The Gate

The engine runs prechecks **only for steps whose handler has `affectsFunds === true`**.
`IKNOW`, `LIST_POLICIES`, `GET_BALANCE`, `CREATE_POLICY`, `SET_LIMIT` declare no
`precheck` → engine skips them → **zero added latency** (this directly addresses the
V3 latency complaint — we never precheck simple read/config skills).

```ts
// inside executePlan, before handler.execute(stepCtx):
if (handler.affectsFunds && handler.precheck) {
  const pre = await handler.precheck(stepCtx);
  if (!pre.ok) return { ok: false, error: pre.reason, steps: stepResults };
}
```

### 5.3 What Each Spend Skill Prechecks

| Skill | precheck contents |
|---|---|
| `SEND_USDC` | name resolution, balance ≥ amount + gas buffer, spend limits |
| `SEND_TOKEN` | name resolution, token balance ≥ amount (+ swap-shortfall logic), limits |
| `SWAP_USDC` | tokenIn balance ≥ amountIn, get quote, slippage sanity |
| `BRIDGE_USDC` | balance ≥ amount + fees, destination validity |
| `WITHDRAW` | balance ≥ amount + gas buffer |
| `PAY_X402` | balance ≥ quoted price + buffer |

Read/config skills: **no precheck**.

### 5.4 The Compound-Chain Limit (Read This Carefully)

A precheck on step 2 (e.g. SEND after SWAP) can only validate against the
**estimated** swap output, because the real output is unknown until the swap runs.
**This is irreducible — V3 has the exact same limitation; no architecture solves
it without an atomic on-chain contract.** We make it rare and harmless with three
layers we already have:

1. **Buffer the swap** — swap shortfall + 5–8% so slippage still clears the send.
2. **`$prev.amountOut`** — for "swap then send the result", send the actual output;
   it cannot fail from slippage.
3. **Graceful partial-success messaging** — `executePlan` already says "step 1
   completed, tokens safe in your wallet, step 2 failed." Money is never lost.

**Preconditions are for the cheap, *certain* failures** (name won't resolve, can't
afford the first step, over limit). They are not a guarantee the whole chain
succeeds. Do not expect them to be.

---

## 6. Balance Strategy — Webhook Cache + Snapshot + Live Gate

The Circle webhook maintains balance locally (`agent_wallets.balance_cache_usdc`),
so reading balance is now a fast DB read, not a Circle poll. Use it in three places
with different trust levels:

1. **`GET_BALANCE` / display** → trust the cache directly. Fast, no Circle call.
2. **Balance snapshot injected into the prompt** → cheap now (~20 tokens). This
   keeps the V3 behavior we like: the LLM can decline obviously-impossible asks
   ("send 50, you have 2") conversationally, *before* building a plan. The LLM is
   the friendly first filter.
3. **Spend-time precheck** → the webhook cache is *eventually consistent* (lags the
   chain by seconds). For the actual spend gate, confirm against live balance right
   before moving money. The cache could be stale enough to wave through a spend the
   chain then rejects.

**Two layers, not a replacement:** LLM (cheap snapshot) is the first filter;
`precheck` (live at the gate) is the deterministic safety net.

---

## 7. Idempotency, Locking, Confirmation (All Reused — Do Not Rebuild)

These already exist in V3 and must be **preserved**, not reimplemented:

- **Idempotency:** `claimIdempotency` / `finalizeIdempotency` + `computeTaskIdemKey`
  (per-task key). Prevents double-spend on retry. (`lib/agent-idempotency.ts`)
- **Per-user serialization:** `withUserLock(userId, ...)` wraps fund-affecting
  batches. With serial execution this also removes any TOCTOU race — there is no
  concurrent request to race against, so **no spend-reservation system is needed.**
- **Confirmation / nonce safety:** every spend goes through
  `createContractExecutionTransaction` on the single agent wallet, then
  `waitForCircleTx` blocks until confirmed. This is *why* spend is serial — one
  wallet, one nonce, one at a time.
- **PIN gate:** `batchRequiresPin` — only prompts for PIN when a step actually moves
  funds outward.

---

## 8. Skill Routing — Seam Now, Vector Module for the Pitch, Active Routing in V5

**Decision: there is no active router in V4.** At 14 skills, every tool schema fits
in the lean prompt (~350–800 tokens). An intent router at this scale adds a new
failure mode (misrouting → wrong skill subset → wrong plan) for almost no token
savings. Regex was rejected outright — it misfires on no-keyword phrasing
("move my money to mum") and is not worth the risk at this scale.

**What we build instead — a clean seam with a no-op default:**

```ts
// lib/tool-router.ts
interface ToolRouter { select(message: string, all: SkillName[]): SkillName[]; }

// V4 default — zero risk, all skills go to the LLM
class PassthroughRouter implements ToolRouter {
  select(_msg, all) { return all; }
}

// Scalability showpiece — built, demo-able, NOT on the live demo path
class VectorRouter implements ToolRouter {
  // embed message → cosine similarity over embedded skill descriptions → top-k
  // Activated by config flag. Falls back to PassthroughRouter if it errors.
}
```

| | Passthrough (V4 default) | Vector (pitch module) |
|---|---|---|
| Latency | Zero | +1 embedding call |
| Reliability | Deterministic | Probabilistic |
| Live demo | Yes | No — showpiece only |
| Scales to | Dozens (all-in-prompt) | Hundreds |

**Pitch line (honest):** "At our scale all tools fit in context. The same router
interface swaps to semantic vector retrieval as the catalog grows into the
hundreds — without touching the engine." True, and demo-able.

**V5:** turn on active routing (vector) when the catalog actually needs it.

---

## 9. Memory Architecture

Three distinct systems — not interchangeable.

| Layer | Tech | Stores | Injected |
|---|---|---|---|
| Layer A | in-session history | last ~12 turns | every call (reused: `buildConversationHistory`) |
| Layer B | Supabase | identity, active-policy summary, habits, spend limits, **balance snapshot** | every call (~100–150 tokens) |
| Layer C | Walrus / memwal | facts the user taught ("Sara is my sister") | on semantic match (cosine > ~0.82) |

**Layer B invalidation (prevents stale-policy bugs):** every function that mutates
policy state must call `invalidateUserMemory(userId)` immediately after —
`createPolicy`, `cancelPolicy`, `setLimit`, and cron post-execution. Rebuild the
policy summary from `agent_policies` and write it back. If the summary is >10 min
old at call time, append "(may be stale — use list_policies to confirm)".

The balance snapshot in Layer B is fed by the webhook (Section 6), not a poll.

---

## 10. System Prompt

Lean, with minimum safety rails. The envelope format is specified here (Section 2.1),
plus:

```
You are the DotArc wallet agent. Return ONLY a JSON object shaped exactly like the
format below — no prose. Use the user's balance snapshot to decline impossible
requests conversationally (return { "tasks": [] } with a message) instead of
building a plan that cannot work.

Rules:
- Dependent actions → one task with multiple steps (use $prev to chain).
- Independent actions → separate tasks.
- Never spend more than the user explicitly stated.
- If amount or recipient is unclear, return an empty plan and ask for clarification.
- Confirm single amounts above the user's threshold (from memory) before executing.
```

Conversation = absence of tasks. An empty `tasks` array (or a plain message) is the
conversational signal. **There is no `chat_response` tool.**

---

## 11. What Is Reused / New / Deleted

**Reused as-is (do not rebuild):**
- `executePlan` + `resolvePrevRefs` (`confirm-policy/route.ts`)
- `validateTasksShape` (structural guard)
- Idempotency layer (`claimIdempotency` / `finalizeIdempotency` / `computeTaskIdemKey`)
- `withUserLock`, `batchRequiresPin`, `waitForCircleTx`
- Sequential `dispatchTask` loop
- Partial-success messaging
- `buildConversationHistory` (Layer A)
- Trigger types, `CREATE_POLICY` skill + cron, `IKNOW`

**New:**
- `precheck()` on each spend skill handler + the gate in `executePlan`
- Balance snapshot injected into Layer B (webhook-fed)
- `invalidateUserMemory()` on policy mutations
- `ToolRouter` seam: `PassthroughRouter` (default) + `VectorRouter` (showpiece)
- Leaned system prompt (business logic removed)
- `scripts/measure-tokens.ts` (honest cost numbers before any pitch claim)

**Deleted:**
- SMART BALANCE INFERENCE prose (moved to `SEND_TOKEN.precheck`)
- Worked examples + trigger vocabulary prose (envelope spec replaces them)
- Inline wallet-state/policy injection prose (now structured Layer B)
- `tryRepairJson` heavy logic → reduced to a light repair pass
- **Never added:** parallel execution, spend reservations, wrapper tool, native FC,
  active regex/vector routing, `chat_response` tool

---

## 12. Token Budget (Measure Before Pitching)

Run `scripts/measure-tokens.ts` against the real prompt before quoting any number.
Do **not** repeat the old "83% / ~500 tokens" claim — it was wrong (ignored history,
tool results, real schema sizes).

| Component | V3 | V4 (estimate, confirm by measuring) |
|---|---|---|
| System prompt + format | ~400 | ~120 |
| Skill descriptions (all, leaned) | ~800 | ~300–500 |
| Layer B (incl. balance snapshot) | ~500 | ~100–150 |
| Layer C (on match) | 0 | 0–100 |
| History (3-turn avg) | ~200 | ~200 |
| Step results (compound) | 0 | ~100–200 |
| User message | ~50 | ~50 |
| **Total** | **~2,870** | **~900–1,300 (~55–67% reduction)** |

---

## 13. Build Order

| # | Task | Reuses | Effort |
|---|---|---|---|
| 1 | Lean the system prompt; add envelope spec + balance-snapshot rule | prompt only | 0.5 day |
| 2 | Add `precheck()` to spend skills; gate in `executePlan` on `affectsFunds` | `executePlan` | 1 day |
| 3 | Move SMART BALANCE INFERENCE logic into `SEND_TOKEN.precheck` | existing logic | 0.5 day |
| 4 | Wire webhook balance snapshot into Layer B | webhook + Supabase | 0.5 day |
| 5 | `invalidateUserMemory()` on all policy mutations | — | 0.5 day |
| 6 | `ToolRouter` seam + `PassthroughRouter` default | — | 0.25 day |
| 7 | Light JSON repair pass before `validateTasksShape` | guard | 0.25 day |
| 8 | `scripts/measure-tokens.ts` | — | 0.25 day |
| 9 | `VectorRouter` showpiece (pitch only, behind flag) | seam | 1–2 days |

Critical path for a working V4: steps 1–7 (~3.5 days). Step 9 is pitch polish.

---

## 14. Gotchas / Open Questions

1. **Balance snapshot staleness vs. spend gate.** Snapshot in prompt is for the
   LLM's first-filter judgment only. The authoritative check is the live precheck
   at the spend gate. Never let the LLM's snapshot judgment be the only affordability
   check.
2. **Compound slippage.** Irreducible (Section 5.4). Always buffer the swap and/or
   send `$prev.amountOut`. Add a stress-test case: "send 50 EURC to maya" with 2 EURC
   held → must swap (shortfall + buffer) then send, and degrade gracefully if slippage
   exceeds buffer.
3. **Empty-plan UX.** Confirm the UI handles `{ tasks: [] }` + message as a plain
   conversational reply (no confirm card).
4. **Idempotency key coverage.** Verify `computeTaskIdemKey` still keys correctly once
   prechecks run earlier — the key is derived from steps/params, which are unchanged.

---

*Locked June 14, 2026. V3 mainnet first. Build V4 in the order above. Do not adopt
native function calling, parallel execution, spend reservations, or a wrapper tool —
each was considered and deliberately rejected; the reasons are in Sections 0, 2, 3, 7.*
