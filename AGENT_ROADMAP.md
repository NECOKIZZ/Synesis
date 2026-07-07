# Synesis — Agent Roadmap

The agent's evolution across versions, in one place:
- **Part I** — V3.5 implementation plan (current build; companion to `MEMORY_ARCHITECTURE.md` Part I).
- **Part II** — V4 architecture (locked for implementation after V3 mainnet is stable).
- **Part III** — Extended Reasoning (DEFERRED — design only; do not build until V4 ships).

---

# PART I — V3.5 Implementation Plan

# Synesis Agent — V3.5 Implementation Plan

**Status:** Ready to execute.
**Companion doc:** `MEMORY_ARCHITECTURE.md` Part I (the architecture reference).
**Scope:** Four changes only — A) user identity line, B) wallet state cache, C) `RETRIEVE_TRANSACTIONS` skill, D) pgvector skill router. Layer B/C memory work is deferred.

---

## 0. Working principles

- **Branch:** start from `v3-hardening` (carries the HMAC fix). Branch name: `v3.5-memory`.
- **Additive only:** every DB migration adds columns/tables, never drops or alters.
- **Feature flags everywhere:** every behavior change behind an env flag, default OFF until proven on localhost.
- **Reversible:** if flag is OFF, V3 behavior is byte-identical. Rollback = flip flag.
- **No prompt regressions:** prompt restructure happens last, after all data sources are in place.

---

## 1. Feature flags

Add to `.env.local`:

```
# V3.5 — Memory & injection upgrades
AGENT_IDENTITY_INJECT=false
BALANCE_CACHE_ENABLED=false
RETRIEVE_TRANSACTIONS_ENABLED=false
SKILL_ROUTER_ENABLED=false
SKILL_ROUTER_K=6
SKILL_ROUTER_MIN_COSINE=0.4
```

Each flag gates exactly one of the four changes. They can be flipped independently in any order.

---

## 2. Database migrations

Two independent migrations. Both additive only.

### 2.1 `supabase/migrations/0014_balance_cache.sql`

```sql
-- =====================================================================
-- Synesis — Wallet balance cache (V3.5)
-- =====================================================================
-- Eliminates the live Circle API call on every interpret. Circle webhook
-- maintains this cache; interpret reads from it. Spend-time gates still
-- consult Circle live — the cache is for the LLM's first-filter only.
-- =====================================================================

alter table public.agent_wallets
  add column if not exists balance_cache jsonb not null default '{}',
  add column if not exists balance_cache_updated_at timestamptz;

create index if not exists agent_wallets_balance_cache_updated_idx
  on public.agent_wallets(balance_cache_updated_at desc nulls last);

comment on column public.agent_wallets.balance_cache is
  'V3.5: webhook-maintained token balances. Eventually consistent; never the final spend gate. Shape: { "USDC": "47.50", "EURC": "12.00", "cirBTC": "0" }';
```

### 2.2 `supabase/migrations/0015_skill_embeddings.sql`

```sql
-- =====================================================================
-- Synesis — Skill embeddings (V3.5, pgvector)
-- =====================================================================
-- Semantic skill router. Every interpret call embeds the user message
-- and pulls top-K skill descriptions for prompt injection. Replaces the
-- ~800-token hardcoded skill catalog with a context-sized subset.
-- =====================================================================

create extension if not exists vector;

create table if not exists public.skill_embeddings (
  skill_name     text primary key,
  description    text not null,              -- the prose injected into the prompt
  category       text not null,              -- TRANSFER | READ | POLICY | ...
  affects_funds  boolean not null default false,
  embedding      vector(1536) not null,      -- OpenAI text-embedding-3-small
  active         boolean not null default true,
  updated_at     timestamptz not null default now()
);

create index if not exists skill_embeddings_active_idx
  on public.skill_embeddings(active) where active = true;

-- IVFFlat will outperform seqscan around ~1000 rows; with ~14 skills
-- seqscan is faster. Created anyway so it exists when we grow.
create index if not exists skill_embeddings_vec_idx
  on public.skill_embeddings using ivfflat (embedding vector_cosine_ops)
  with (lists = 10);

-- Public read (no RLS needed — skill descriptions aren't user data)
alter table public.skill_embeddings enable row level security;
drop policy if exists "anyone authenticated can read skills" on public.skill_embeddings;
create policy "anyone authenticated can read skills"
  on public.skill_embeddings for select to authenticated using (true);

-- Writes via service role only.

-- Optional: a misses log for tuning the threshold and growing the catalog
create table if not exists public.skill_router_misses (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references public.profiles(id) on delete set null,
  message      text not null,
  top_cosine   double precision not null,
  fallback_used boolean not null default true,
  created_at   timestamptz not null default now()
);

create index if not exists skill_router_misses_created_idx
  on public.skill_router_misses(created_at desc);

comment on table public.skill_embeddings is
  'V3.5: pgvector store for the semantic skill router. One row per registered skill.';
comment on table public.skill_router_misses is
  'V3.5: every low-confidence routing decision logged here. Used to tune SKILL_ROUTER_MIN_COSINE and grow the catalog.';
```

---

## 3. Build order

Four independent tracks. Pick any order; recommended sequence shown.

### Track 1 — Wallet state cache (item B)

| Step | File | Action |
|---|---|---|
| 1.1 | `supabase/migrations/0014_balance_cache.sql` | Create migration (above). |
| 1.2 | Apply migration on dev Supabase | `supabase db push` or via SQL editor. |
| 1.3 | `lib/circle-webhook.ts` (or wherever the webhook handler lives) | Extend webhook handler: on any balance-affecting event for an agent wallet, update `balance_cache` + `balance_cache_updated_at`. Verify which Circle webhook events fire on inbound/outbound transfers. |
| 1.4 | `lib/agent.ts` — `getAgentAllBalances` | Add a `readBalanceCache(walletId)` helper that returns `{cache, age_seconds}` or `null` if missing. |
| 1.5 | `app/api/agent/interpret/route.ts:172-180` | When `BALANCE_CACHE_ENABLED=true`: try `readBalanceCache` first. Fall back to `getAgentAllBalances` (live Circle) if cache is missing or `age_seconds > 600`. Log which path was taken (`traceId` tagged). |
| 1.6 | Test on localhost: flip flag on, send a transaction, verify webhook updated the cache row, verify next interpret read from cache. |

**Verification:** local agent send → check `agent_wallets.balance_cache_updated_at` ticks → next interpret call logs `[balance:cache]` instead of `[balance:live]`.

### Track 2 — `RETRIEVE_TRANSACTIONS` skill (item C)

| Step | File | Action |
|---|---|---|
| 2.1 | `lib/skills/retrieve-transactions.ts` (new) | Implement handler with the param shape in memory doc §5.2 and return shape in §5.3. Use Supabase server client scoped to user. |
| 2.2 | `lib/skills/registry.ts` (or wherever skills are registered) | Register the new skill. Set `category: "READ"`, `affectsFunds: false`, `requiresPin: false`, no `precheck`. |
| 2.3 | `lib/agent-core-v3.ts` — skill catalog prose | Add `RETRIEVE_TRANSACTIONS` description (params, when to use, examples). Use plain bullet examples (don't expand to full worked tasks — keeps the prompt lean). |
| 2.4 | Feature flag in registration: only register if `RETRIEVE_TRANSACTIONS_ENABLED=true`. Lets us toggle the skill without code changes. |
| 2.5 | Add to skill_embeddings seed (Track 4 step 4.2). |
| 2.6 | Test on localhost with three questions: "what did I send last week?", "how much BTC came in?", "how much have I tipped sara?". Verify filter params chosen correctly, aggregate computed, ≤50 rows returned. |

**Verification:** the three test questions return correct totals against seeded `agent_spend_log` data.

### Track 3 — User identity line (item A)

| Step | File | Action |
|---|---|---|
| 3.1 | `app/api/agent/interpret/route.ts` | After reading the agent wallet, also fetch `profiles.arc_name` for the user. Pass as `userArcName?: string` in the context to `interpretInstructionV3`. |
| 3.2 | `lib/agent-core-v3.ts` — `buildSystemPromptV3` signature | Add `userArcName?: string` to the context type. |
| 3.3 | `lib/agent-core-v3.ts:104-153` — the WHO YOU ARE section | When `AGENT_IDENTITY_INJECT=true` and `userArcName` is present, add one line after "You are Synesis's smart wallet agent.": `You are talking to <name>.arc.` If null, omit. |
| 3.4 | Smoke test: log in as a user with `arc_name` set, verify the line appears in the prompt log; log in as a freshly-registered user with null `arc_name`, verify the line is omitted. |

**Verification:** `[CONTEXT]` log shows `userArcName` populated; system prompt log shows the new line for registered users.

### Track 4 — pgvector skill router (item D)

This is the biggest of the four. Broken into substeps.

| Step | File | Action |
|---|---|---|
| 4.1 | `supabase/migrations/0015_skill_embeddings.sql` | Create migration (above). Apply on dev Supabase. |
| 4.2 | `scripts/seed-skill-embeddings.ts` (new) | Script that reads every current skill's name + description from `lib/skills/registry.ts` (or wherever the catalog is defined), embeds each with OpenAI `text-embedding-3-small`, upserts into `skill_embeddings`. Idempotent (re-runnable). |
| 4.3 | `lib/embeddings.ts` (new) | Thin wrapper around OpenAI embeddings API. One function: `embedText(text: string): Promise<number[]>`. Configurable model, default `text-embedding-3-small`. Caches via in-memory LRU for repeated identical strings. |
| 4.4 | `lib/skill-router.ts` (new) | The router. Exports `selectSkills(userMessage: string, userId: string): Promise<SelectedSkills>` where `SelectedSkills = { skills: SkillRow[], usedFallback: boolean, topCosine: number }`. Logic: embed the message → pgvector cosine search → if top result < `SKILL_ROUTER_MIN_COSINE`, log to `skill_router_misses` and return the full catalog with `usedFallback: true`. Otherwise return top `SKILL_ROUTER_K`. |
| 4.5 | `lib/agent-core-v3.ts` | Refactor `buildSystemPromptV3`: instead of hardcoded skill prose, accept a `skillsToInject: SkillRow[]` parameter and render their descriptions. The hardcoded prose stays as a fallback used when `SKILL_ROUTER_ENABLED=false`. |
| 4.6 | `app/api/agent/interpret/route.ts` | When `SKILL_ROUTER_ENABLED=true`, call `selectSkills` before `interpretInstructionV3`, pass result through. Log: `[router] topCosine=0.71 selected=[SEND_USDC,SEND_TOKEN,CHECK_BALANCE,IKNOW,LIST_POLICIES,GET_PRICE] fallback=false`. |
| 4.7 | Localhost smoke test with 5 messages: a) "send 5 to sara" (expect SEND_USDC, SEND_TOKEN, CHECK_BALANCE in top 6) b) "what's BTC at?" (expect GET_PRICE) c) "cancel my weekly send" (expect CANCEL_POLICY, LIST_POLICIES) d) "I think Real Madrid will win" (expect IKNOW) e) "asdf gibberish nonsense" (expect fallback=true, full catalog injected). |
| 4.8 | Inspect `skill_router_misses` for the gibberish case to confirm logging works. |

**Verification:** the 5-message smoke test passes; `skill_router_misses` has the expected one row.

---

## 4. Prompt restructure (final step)

After all four tracks pass on localhost individually, restructure the prompt to the V3.5 sectioned layout from the memory doc §1. This is one change to `buildSystemPromptV3`:

- Reordered into clear sections (IDENTITY, WALLET STATE, ACTIVE POLICIES, AVAILABLE SKILLS, etc.).
- Skill catalog driven by `skillsToInject` parameter, not hardcoded prose.
- User identity line conditionally added.
- All other prompt content (rules, output spec, trigger vocab, worked examples) unchanged.

**Behind a single rollout flag:** `PROMPT_LAYOUT=v3.5` (default `v3`). Flip after all four tracks are individually green.

---

## 5. Verification checklist (run before merging to `main`)

| # | Check | How |
|---|---|---|
| V1 | All flags off → V3 behavior byte-identical | Diff a sample prompt with all V3.5 flags off vs `main` |
| V2 | `BALANCE_CACHE_ENABLED=true` shaves >200ms off avg interpret latency | Log timing before/after on 10 calls |
| V3 | Webhook updates `balance_cache` within 5s of a confirmed send | Manual send, watch `balance_cache_updated_at` |
| V4 | `RETRIEVE_TRANSACTIONS` returns correct aggregates for known seeded data | Three test questions, hand-verified |
| V5 | Skill router top-K never misses the correct skill for the 5 test messages | Smoke test 4.7 |
| V6 | `skill_router_misses` populated only when expected (gibberish case) | Inspect table |
| V7 | Full prompt with V3.5 layout produces correct JSON for the 10 stress-test scenarios in `dotarc-stress-test.md` | Run the existing stress suite |
| V8 | Token count of average interpret prompt drops by ≥300 tokens vs V3 | `scripts/measure-tokens.ts` (if it exists; otherwise estimate) |

---

## 6. Rollback plan

Each track rolls back independently by flipping its flag to `false`. No DB rollback needed — every migration is additive.

| Track | Rollback step |
|---|---|
| A (identity) | `AGENT_IDENTITY_INJECT=false` |
| B (balance cache) | `BALANCE_CACHE_ENABLED=false` → falls back to live Circle |
| C (RETRIEVE_TRANSACTIONS) | `RETRIEVE_TRANSACTIONS_ENABLED=false` → skill not registered |
| D (router) | `SKILL_ROUTER_ENABLED=false` → hardcoded catalog used |
| Prompt layout | `PROMPT_LAYOUT=v3` → old prompt returned |

If everything breaks: set all 5 to `false` and deploy. The V3.5 code becomes dormant.

---

## 7. Out of scope (do not build in this branch)

- Any change to `user_memory` table or its injection
- Any change to memwal/Walrus retrieval
- Behavior summary generator
- Two-call subconscious model
- Conditional injection of wallet state / policies / limits
- Solana skills
- V4 work (precheck, etc.)

---

## 8. Recommended execution order

1. **Track 1 (wallet cache)** — independent, low risk, highest user-visible perf win
2. **Track 3 (identity line)** — trivial, no dependencies
3. **Track 2 (RETRIEVE_TRANSACTIONS)** — independent, new skill
4. **Track 4 (pgvector router)** — biggest scope, depends on all skills being registered so Track 2 must precede it
5. **Prompt restructure** — last, after all four tracks individually verified

*Code begins after this plan is approved.*

---

# PART II — V4 Architecture

# Synesis Agent — V4 Architecture (Final, Build-Ready)

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
You are the Synesis wallet agent. Return ONLY a JSON object shaped exactly like the
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

---

# PART III — Extended Reasoning (DEFERRED)

# Extended Reasoning — Design & Implementation Plan

**Status:** Planning only. **Do not implement until V4 is stable and the hackathon build is shipped.**
**Supersedes:** `reasoning-loop-plan-1.md`, `hermes-openclaw-architecture-map-1.md`, `synesis_architecture_session.md` — everything still-relevant from those three is captured here (see Appendix C). They can be deleted once this lands.
**Scope:** A user-toggleable "Extended Reasoning" mode for the agent: a multi-call ReAct loop with extended thinking, model-in-the-loop step execution, `.md` skills instead of tool-schemas, and prompt-cached identity. The cheap single-call path stays the default. The toggle lets the user choose the costly path or the cheap one.

---

## 0. TL;DR

- Today: **one** LLM call produces a full `tasks[]` plan, then a **mechanical** executor runs it. No streaming, no prompt caching, no extended thinking, no model-in-the-loop. (Grounded file anchors in §1.)
- We add an **Extended Reasoning engine** behind a UI toggle. ON = the model plans one step at a time, the executor runs it, the result is fed back, the model decides the next step (classic ReAct) — with extended thinking and a prompt-cached static prefix so it stays affordable. OFF = exactly today's behavior, byte-for-byte.
- Skills move from hardcoded prose in `catalog.ts` to **readable `.md` files** with progressive disclosure (only a name+one-liner index is always in-context; the full `.md` loads on demand). This also unlocks **knowledge skills** (advice `.md` with no executable handler).
- The hard part is **not** the loop — it's (a) restructuring the prompt so identity/skills are cacheable, and (b) reconciling a model-in-the-loop with Synesis's PIN/HMAC/value guardrails. Both are addressed in §5 and §6.
- Everything is **flag-gated and default-off**, matching the existing byte-idempotent-fallback convention.

---

## 1. Where we are today (grounded baseline)

This is the honest current state. Every claim is anchored to a file so the plan is actionable.

### 1.1 The single LLM call
- One HTTP POST to OpenRouter: `https://openrouter.ai/api/v1/chat/completions` — `lib/agent-core-v3.ts:761`.
- Model from `OPENROUTER_MODEL` (default `anthropic/claude-3.5-sonnet`; currently set to an `anthropic/claude-sonnet-4`-class model) — `lib/agent-core-v3.ts:732`. **No model switching.**
- Request body: `{ model, messages:[system, ...history, user], response_format:{type:"json_object"}, max_tokens:2048, temperature:0.1 }` — `lib/agent-core-v3.ts:769-781`.
- **No `stream:true`. No `cache_control`. No `thinking`/`reasoning`.** Confirmed absent.

### 1.2 The "flat one call" planner
- `buildSystemPromptV3()` (`lib/agent-core-v3.ts:93-526`) assembles a ~400-line prompt; `interpretInstructionV3()` (`lib/agent-core-v3.ts:700-842`) makes the call.
- Returns `InterpretResult = { tasks: Task[], combined_confirmation_message, unknown_reason?, requires_pin? }` — `lib/agent-types.ts:138-158`.
  - `Task = { trigger, steps: PlanStep[ /*1-3*/ ], execution_mode, stop_conditions?, confirmation_message }` — `lib/agent-types.ts:124-131`.
  - `PlanStep = { skill: LeafSkill, params, description }` — `lib/agent-types.ts:29-33`.
- **Skills are presented as TEXT prose, not tool-calling** — `lib/agent-core-v3.ts:156-241`. The model writes JSON with skill names as strings. There is no `tools` array anywhere. *(This is why ".md skills instead of tools" is a natural fit — we already don't use tool schemas.)*

### 1.3 The executor ("the executioner")
- `app/api/agent/confirm-policy/route.ts`: PIN verify (`verifyAgentPinOrThrow`, `lib/agent-pin.ts:33-93`) → balance preflight → `withUserLock()` → `runBatch()` (`:614-712`).
- `runBatch` loops tasks sequentially (`:681-694`); `executePlan()` (`:230-286`) loops steps sequentially.
- **Intra-task data passing exists**: `resolvePrevRefs()` (`:195-219`) lets step N+1 read `$prev.field` from step N's output.
- **No model feedback.** `prevResult` is used only for `$prev` resolution; no LLM call happens in the executor. The executor is purely mechanical. This is the single most important fact for this plan.

### 1.4 The 10 real context injections (resolves the "9 with 2 unknown")
Built in `buildSystemPromptV3` + the interpret route. All dynamic-per-call today; all interleaved into one string (which is *why* nothing is cacheable yet):

| # | Injection | Source | Flag |
|---|---|---|---|
| 1 | Agent identity one-liner ("You are talking to {name}.arc") | `profiles.arc_name` | `AGENT_IDENTITY_INJECT` |
| 2 | User profile card ("ABOUT THIS USER") | `user_profile.profile_card` (mig 0018) | `USER_PROFILE_ENABLED` |
| 3 | Current UTC date & weekday | runtime | always |
| 4 | Agent wallet balances (all tokens) | Circle / balance cache | `BALANCE_CACHE_ENABLED` |
| 5 | Spend limits (per-tx/day/week/month) | `user_spend_limits` | always |
| 6 | Active policies | `agent_policies` | always |
| 7 | MemWal episodic memory (top-3 semantic) | Walrus | `MEMWAL_ENABLED` |
| 8 | Contact memory digest (top-6, intent-gated) | `agent_contact_mem` (mig 0015) | `CONTACT_MEM_INJECT` |
| 9 | Skill catalog (prose or router-selected) | `catalog.ts` / pgvector | `SKILL_ROUTER_ENABLED` |
| 10 | Live prices (EURC/cirBTC vs USDC) | CoinGecko oracle (5-min cache) | always |

- **Fixed role line:** `"You are Synesis's smart wallet agent. Parse the user's instruction and return ONLY a valid JSON object."` — `lib/agent-core-v3.ts:243`. **There is no `SOUL.md` / persona file** — identity = this line + the `.arc` hint + the profile card.

### 1.5 Skills & memory plumbing
- Skills = TS modules (`lib/skills/*.ts`) + a hardcoded `SKILL_CATALOG` array; `renderSkillCatalog()` joins `.description` strings into prose — `lib/skills/catalog.ts:206-208`. **No `.md`, no `skill_type`, no knowledge skills today.**
- pgvector router (`lib/skill-router.ts`) embeds the message, `match_skills` RPC returns top-K (`SKILL_ROUTER_K`, default 6; `SKILL_ROUTER_MIN_COSINE`, default 0.4), falls back to full catalog. Off by default.
- Memory layers (`lib/memory/*`): contact-mem (keyword/recency), MemWal (semantic top-K), user-profile (1 row), session history (client-supplied, ≤12 turns). All best-effort, all flag-gated, all default-off.

---

## 2. The core insight: there are TWO "reasoning" axes, not one

The three research docs blur these together. Separating them is the key design move, because they have very different cost, risk, and security profiles.

| Axis | What it is | Cost | Touches funds? | Anthropic feature |
|---|---|---|---|---|
| **A. Extended thinking** | A private scratchpad on a *single* call before it answers. Improves plan quality. | +output tokens | No (still produces a plan that is then PIN-gated) | `thinking: { budget_tokens }` |
| **B. Model-in-the-loop (ReAct)** | *Multiple* calls; the model sees each executed step's real result and chooses the next step (enables swap-fail-reroute). | +N calls | **Yes** — multiple model-chosen actions after one approval | conversation-array loop |

**The toggle the user wants enables both** — but they roll out in stages because Axis B crosses the fund-safety boundary and Axis A does not. The doc treats the toggle as one user-facing switch with a staged backend (§9).

---

## 3. The toggle — behavior spec

A single UI switch: **⚡ Fast ⟷ 🧠 Reasoning** (per the `synesis_architecture_session.md` decision).

| | Fast (default) | Extended Reasoning |
|---|---|---|
| Planning call | 1 call, no thinking | thinking ON (budget configurable) |
| Execution | mechanical sequential (today) | model-in-the-loop ReAct (Phase 2) |
| Model | `OPENROUTER_MODEL` (Sonnet-class) | stronger reasoning model (Opus-class) |
| Prompt caching | n/a (single call) | static prefix cached across iterations |
| Streaming | optional | thinking + step breadcrumbs streamed to UI |
| Cost | 1× (baseline) | ~2.5–6× (see §8) |

**Auto-escalation:** even with the toggle OFF, force Reasoning when the task is high-value or high-complexity. Signals: estimated transaction USD value over a threshold; pgvector router low-confidence or many candidate skills; composite/multi-skill plans (bridge+yield, swap+bridge). (`synesis_architecture_session.md §2`.)

**No plan-approval step inside reasoning.** Per the product decision, thinking is a *silent quality upgrade* — the user watches it stream but does not approve the plan. The one interrupt is the **value-threshold guard** ("You're about to move $X. Proceed?"), which is independent of the toggle and already aligns with Synesis's PIN model (§6).

---

## 4. What "`.md` skills instead of tools" means here

Today a skill's human-readable description is a prose string baked into `catalog.ts`. We move it to a file.

### 4.1 New shape
```
lib/skills/
  send-usdc.ts            # executable handler (unchanged contract: SkillHandler)
  send-usdc.skill.md      # NEW: human-readable spec + usage + guidance
  ...
knowledge/
  defi_yield.md           # NEW: knowledge-only skill, no handler
  portfolio_management.md
  risk_management.md
  rug_detection.md         # detection LENS — needs a paired data skill (see §4.4)
  cctp_bridge_guide.md
```

- **Executable skill** = TS `SkillHandler` (unchanged) **+** a `.skill.md` describing it (name, one-liner, params, when-to-use, examples, cautions).
- **Knowledge skill** = `.md` only, no handler. Injected as *reference context* the model reasons with; never "called." (`synesis_architecture_session.md §3`.)
- A `skill_type` discriminator (`executable | knowledge`) rides the existing catalog + `skill_embeddings` table (mig 0014). After router retrieval, split: executable → action list, knowledge → reference block (`synesis_architecture_session.md §3` shows the split).

**Why this matters beyond docs:** today the agent can *execute* a yield deposit but has no framework for *whether it's wise* — no risk tiers, no notion of impermanent loss, no Arc/CCTP nuance. Knowledge `.md` turns Synesis from a doer into an advisor that can answer "should I?", not just "I did." This is real product differentiation at near-zero risk.

### 4.2 Progressive disclosure (the Hermes/OpenClaw pattern)
- The **cached static prefix** carries only a compact **index**: `SKILL_NAME — ≤60-char one-liner`, for every skill. Cheap, stable, cache-friendly.
- The model loads a full `.md` **on demand** during the loop via a `skill_view(name)` meta-action — the executor returns the file contents as an observation. (Mirrors Hermes `skill_view` and our own pgvector routing, applied at the content layer — `hermes-openclaw-architecture-map-1.md §7, §10`.)
- The pgvector router still selects top-K relevant skills to pre-expand into the prefix for the common case; everything else stays behind `skill_view`.

### 4.3 Why this is low-risk
The executor already dispatches by skill-name string against `skillRegistry` — the `.md` is *documentation + routing text*, not a new execution path. The handler contract (`lib/skills/types.ts`) is untouched. Knowledge skills add a render branch, not a new executor.

### 4.4 Knowledge skills: framework vs. detection (the dangerous distinction)
"Add portfolio management / risk / rug detection as `.md`" splits into two categories with very different risk profiles. **Do not treat them the same.**

**(a) Static frameworks — pure `.md`, zero risk, add freely.**
Timeless, opinionated reference text the model reasons *with*: impermanent loss, APY vs APR, position sizing, diversification, protocol risk tiers, market-cycle behavior, Arc/CCTP quirks. These have no live-data dependency. This is the ideal knowledge skill. Starter set: `portfolio_management`, `defi_yield`, `risk_management`, `crypto_market_cycles`, `arc_network_guide`, `cctp_bridge_guide`.

**(b) Detection / factual verdicts — `.md` ALONE IS DANGEROUS.**
"Is *this* token a rug" / "is *this* pool safe" is **not static knowledge** — it's a judgment over live state (liquidity locked? mint authority renounced? holder concentration? contract verified? recent dumps? honeypot behavior?). A `.md` can encode the *checklist*, but a model applying a checklist **with no live data** produces confident-sounding safety verdicts out of thin air. For a money app, an endorsed "looks safe" that's actually a hallucination is the worst failure mode — the user apes in and loses funds with the agent's blessing.

**The rule:** a knowledge `.md` is the **lens**; a factual verdict needs a **paired executable skill** that fetches the data.
- `rug_detection.md` (heuristics) **+** `CHECK_TOKEN_SAFETY` executable (pulls liquidity / mint-authority / holder data, or a token-safety/honeypot API). The `.md` tells the model how to *interpret* what the skill returns. Neither alone suffices.
- `defi_yield.md` (framework) **+** a live APY/TVL read skill, for "is this yield good."
- **Until the data skill exists, scope the detection `.md` to "educate and ask," not "verdict":** explain the risks and tell the user what to check, never declare safe/unsafe.

**Two hygiene rules for high-stakes knowledge `.md`:**
1. **Curated + pinned, in-repo, never auto-generated or user-editable.** A knowledge file is trusted context shaping *financial advice* — a poisoned one is prompt injection straight into money decisions (OpenClaw trust-tier point, `hermes-openclaw-architecture-map-1.md §9`).
2. **Scope to where it applies.** Rug/scam detection matters where users hold *arbitrary tokens* — the **Solana SPL** surface — not the Arc USDC/EURC/cirBTC core, where there is nothing to rug. Don't author rug knowledge for chains with no rug surface.

---

## 5. Target architecture

### 5.1 Prerequisite refactor — tier the prompt so identity is cacheable
This is the gating prerequisite and the research's central caching lesson (`reasoning-loop-plan-1.md §5,§7`; `hermes-openclaw-architecture-map-1.md §1,§3`). Today all 10 injections are interleaved into one string rebuilt every call — nothing can be cached. Split `buildSystemPromptV3` output into three blocks:

| Tier | Contents | Cache | Rebuild |
|---|---|---|---|
| **T1 — static** | fixed role line, reasoning-mode instructions, agent identity, **skill index** | `cache_control: ephemeral, ttl:"1h"` | per deployment / per user |
| **T2 — session** | user profile card, spend limits, policies, MemWal summary, contact digest | `cache_control: ephemeral` (5-min) | once at session start |
| **T3 — per-call** | UTC date, wallet balances, live prices, **the growing observation history** | not cached | every iteration |

- **Build the static + session blocks ONCE per reasoning session; pass them unchanged every iteration.** The messages array carries what changes. (`synesis_architecture_session.md §5` — resolved decision.)
- **OpenRouter caveat (must verify):** OpenRouter can silently drop `cache_control` markers in chat-completions mode. Verify `prompt_tokens_details.cached_tokens > 0` after call 1; if 0, switch to OpenRouter's Anthropic-native messages layout or rely on automatic caching. Use a sticky `session_id` so all iterations hit the same backend and keep the cache warm. (`reasoning-loop-plan-1.md §7`.)

### 5.2 The reasoning loop engine
Conceptually (sketch, not final code):
```
buildStaticPrefix(userId)        // T1+T2, cached, built once
messages = [ { role:"user", content: intent } ]
for (iteration = 1 .. MAX):
   resp = call(model, prefix(cached) + T3(fresh) + messages, thinking:on, stream:on)
   if resp.action == FINAL_ANSWER: break
   if resp.action == skill_view(name): obs = readSkillMd(name)
   else: obs = executor.runOneStep(resp.skill, resp.params, ctx)   // SAME executor seam
   messages.push(assistant: resp); messages.push(observation: obs)
   guardrails(resp, obs)         // stale-action, value, iteration cap
```
- **The executor seam already exists.** `executePlan()` (`confirm-policy/route.ts:230-286`) already runs one step and returns a structured result with `$prev` stashing. The loop calls *that same single-step path* and feeds the result back as an observation instead of advancing mechanically. We are wrapping the executor, not rewriting it (see research "the agentic loop IS the executor with a loop around it" — `synesis_architecture_session.md §4`).
- **Termination:** `FINAL_ANSWER` emitted; hard iteration cap (default 6–8); **stale-action guard** (same skill+params twice → stop/clarify); value/limit breach → stop. (`reasoning-loop-plan-1.md §4`.)
- **Self-correction is free — but scoped:** because the model sees the real error observation, swap-route-A-fails → route-B is emergent, not hardcoded (`synesis_architecture_session.md §4`). **This autonomy is bounded to in-place transforms (swaps, then bridges-with-guards) — never outbound transfers — per §6.1.**

### 5.3 Streaming (new surface)
There is **no streaming today** (§1.1). Reasoning mode needs SSE from the executing endpoint to the UI:
- `thinking_delta` → thinking panel; `{type:"action", skill}` → breadcrumb; `{type:"observation"}` → result; `{type:"complete"}` → done. (`synesis_architecture_session.md §2` has a concrete stream-consumer sketch; `reasoning-loop-plan-1.md §11`.)

### 5.4 Model selection + the thinking-block replay footgun
- Plan/loop with an Opus-class model in reasoning mode; keep Sonnet-class for Fast. Pick exact OpenRouter ids at implementation time.
- **Hard constraint (do not skip):** if interleaved thinking is replayed across iterations, thinking blocks must be returned **byte-identical** (with signature) or **dropped entirely** — partial reconstruction silently corrupts history and the API 400s several turns later. Store the raw response content array as source of truth, or deliberately drop thinking between turns. This is a real, documented failure (`hermes-openclaw-architecture-map-1.md §11`).

---

## 6. Security reconciliation (Synesis-specific — the part the research docs miss)

The research assumes "no confirmation step." Synesis has a **PIN + HMAC + value** boundary that must survive. Resolution:

1. **PIN stays once, before the loop.** Reasoning mode does its thinking at plan time and, in Phase 3, its model-in-the-loop execution **inside the existing post-PIN, `withUserLock()` critical section** (`confirm-policy/route.ts:610`). One PIN authorizes one bounded reasoning session — not an open-ended agent.
2. **Per-step caps still apply.** Every fund-moving skill already runs its own spend-limit + balance checks during `execute()` (e.g. `send-solana-usdc.ts:100-132`). The loop does not bypass these — each model-chosen step re-validates. A model that reroutes still can't exceed caps.
3. **Value-threshold guard.** Before any single step moves more than `$X` (configurable, e.g. $500), pause for an explicit "move $X?" confirmation — independent of the toggle (`synesis_architecture_session.md §2`).
4. **Bounded autonomy.** Iteration cap + stale-action guard + a per-session cumulative-spend ceiling. The loop cannot run forever or drain via many small steps.
5. **Audit every revision.** When the model deviates from the originally-confirmed plan, log it (plan A → revised plan B after step N) for the spend log / Alerta. Trust-tier note: keep identity/skills above memory-injected content in trust (don't let `.md`/memory creep to identity-level authority) — `hermes-openclaw-architecture-map-1.md §9`.

### 6.1 Scoped write-autonomy — autonomy over *how*, not *whether* (the swap/bridge case)
The decision isn't "money is irreversible, so PIN everything." It's **direction of value**:

- **Outward (transfer / send to a third party):** value leaves the user's custody and is gone. → **PIN, always.** Never model-autonomous. The headline ReAct "reroute" pattern does **not** apply to transfers.
- **In-place transform (swap):** USDC→EURC keeps value in the *user's own wallet*. The user already decided to swap; the model only chooses the **execution path**. **"Try route 1 → on failure, try route 2" is safe to do autonomously here** — autonomy is over *how*, not *whether*. **Guard: a minimum-output / slippage bound** (default `REASONING_SLIPPAGE_BOUND_BPS`) so a worse route can't quietly hand the user a bad rate. "Swap 100 USDC" implies "for a reasonable amount out," and the loop must enforce that bound on every retried route.
- **Cross-chain transform (bridge):** same custody logic as a swap (funds stay the user's, just on another chain), **but CCTP is async** — attestation arrives later via webhook (`app/api/webhooks/circle/route.ts`). A bridge that *looks* failed may actually be **in flight**, so a naive "failed → reroute" can **double-bridge / double-spend.** → Bridge route-retry is **yellow**: allowed, but only behind **attestation-aware idempotency** — confirm the prior attempt is genuinely dead (not pending) before re-issuing. Until that guard exists, bridges do **not** get autonomous retry.

So Phase 3 is narrowly: **autonomous execution-path selection (route-retry) for swaps first, bridges-with-attestation-guards second; PIN for anything outbound.** This is defensible "acts like a real agent" behavior, not an open-ended fund mover. **Designed and kept in this doc, but deferred — not greenlit for build.**

**Phasing implication:** Axis A (thinking-on-planning) preserves the security model untouched and ships first. Axis B (scoped route-retry, §6.1) ships last, behind its own sub-flag, swaps before bridges.

---

## 7. Memory in a multi-call session

- **Build the static/session prefix once, freeze it** (§5.1). Don't rebuild the 10 injections per iteration.
- **Wallet-state staleness:** balances change mid-loop. Don't re-inject fresh balances every call — let the model learn state from the step **observations** (it just saw the transfer result). Re-fetch only when the model explicitly emits `CHECK_BALANCE`. (`synesis_architecture_session.md §5`, chosen option.)
- **Write timing:** mid-session writes are durable but slow; session-end writes are fast but lose data on a mid-loop crash. Recommendation: keep the existing **PENDING→COMPLETE spend-log row per fund-moving step** (already the pattern) as the durable record, and do the *memory* (MemWal/contact/profile) write at session end. The spend log is the crash-safe truth; memory is best-effort.
- **Pre-prune flush:** if a long loop ever hits context compression, a narrow-toolset "must-preserve" flush (open steps, pending CCTP attestations, spend reservations) beats judgment-based flushing — Hermes's own tracker shows the judgment approach loses things (`hermes-openclaw-architecture-map-1.md §2, §10, Open Questions`). For hackathon scope this is unlikely to trigger; note it, don't build it yet.

---

## 8. Cost model

| Mode | Calls | Relative cost | When |
|---|---|---|---|
| Fast (today) | 1 | 1× | default, simple intents |
| Reasoning, thinking only (Phase 1) | 1 | ~2.5–4× | better plans for complex intents |
| Reasoning, loop, 4 turns (Phase 2) | 4 | ~2.5× (static cached) | multi-step, self-correcting |
| Reasoning, loop, 8 turns + thinking | 8 | ~6–10× | genuinely hard multi-asset chains |

Caching a ~6k-token static prefix across 8 calls is ~87% cheaper on that block (1 write @2× + 7 reads @0.1× vs 8 full) — this is what makes the loop affordable (`reasoning-loop-plan-1.md §12`). **Reserve extended thinking for the top ~5% of intents**; the loop without thinking already buys self-correction cheaply.

---

## 9. Phased rollout (all flag-gated, default-off, byte-idempotent when off)

**Phase 0 — Prompt tiering (prerequisite).** Refactor `buildSystemPromptV3` into T1/T2/T3 blocks (§5.1) with **no behavior change** when reasoning is off. Add `cache_control` only on the reasoning path. Verify `cached_tokens`. *Lowest risk; do first.*

**Phase 1 — Thinking on planning (Axis A).** Add the toggle + `EXTENDED_REASONING_ENABLED` flag + per-request `reasoning:true`. When on: switch model, set `thinking`, stream the thinking to UI. **Execution stays mechanical and PIN-gated.** Big quality win, security untouched.

**Phase 2 — `.md` skills + progressive disclosure.** Move skill descriptions to `.skill.md`; add **static-framework** knowledge `.md` (portfolio/risk/yield/cycles/Arc/CCTP — §4.4a); add `skill_view`; re-seed embeddings. Independent of the loop; improves both modes. *(Detection `.md` like `rug_detection` waits for its paired data skill — §4.4b.)*

**Phase 3 — Scoped route-retry execution (Axis B). Designed, deferred — not greenlit.** Wrap the single-step executor in the ReAct loop inside the post-PIN lock, with §6 + §6.1 guardrails. **Autonomy is limited to execution-path retry on in-place transforms — swaps first (slippage-bounded), bridges second (attestation-aware idempotency); transfers stay PIN-only.** Own sub-flag (`EXTENDED_REASONING_LOOP_ENABLED`). The riskiest piece; ships last, swaps before bridges.

**Phase 4 — Streaming polish + auto-escalation.** SSE breadcrumbs, heartbeats, complexity/value auto-escalation.

(Deferred, out of scope: self-building skills — `synesis_architecture_session.md §7`.)

---

## 10. Open decisions (resolve before Phase 1)

1. **Toggle granularity:** does ON mean thinking-only until Phase 3 lands, or do we hide the toggle until the loop exists? (Recommend: ship the toggle at Phase 1 as thinking-only; loop activates the same toggle when Phase 3 flag flips.)
2. **Where the loop runs:** confirm it lives inside `confirm-policy`'s post-PIN `withUserLock` section (recommended) vs a new endpoint.
3. **OpenRouter caching layout:** chat-completions `cache_control` vs Anthropic-native messages endpoint — decide after a `cached_tokens` spike test.
4. **Value-guard threshold** default ($ amount) and whether it's per-step or per-session cumulative.
5. **Knowledge-skill budget:** token ceiling for injected knowledge `.md` so it can't crowd the observation history.
6. **Detection data source:** what backs `CHECK_TOKEN_SAFETY` on Solana SPL — direct RPC reads (liquidity/mint-authority/holders) vs a third-party token-safety/honeypot API. Until chosen, ship `rug_detection.md` as educate-and-ask only (§4.4b).
7. **Swap-reroute slippage default** (`REASONING_SLIPPAGE_BOUND_BPS`) and where it's enforced (skill-level vs loop-level).

---

## Appendix A — Research term → real code map

| Research term | Reality in this repo |
|---|---|
| "flat one call" | `interpretInstructionV3` (`lib/agent-core-v3.ts:700-842`) |
| "the executioner" | `runBatch`/`executePlan` (`confirm-policy/route.ts:230-286, 614-712`) |
| "Tasks+Steps JSON" | `InterpretResult`/`Task`/`PlanStep` (`lib/agent-types.ts:29-158`) |
| "9 injections (2 unknown)" | 10 injections, fully listed (§1.4) |
| "SOUL.md / persona" | none — fixed role line `agent-core-v3.ts:243` + `.arc` hint + `user_profile` card |
| "skills as tools" | skills are **prose text**, model returns JSON skill-name strings (`agent-core-v3.ts:156-241`) |
| "$prev between steps" | `resolvePrevRefs` (`confirm-policy/route.ts:195-219`) — intra-task only |

## Appendix B — Flags (existing + proposed)

Existing (all default-off, byte-idempotent): `SKILL_ROUTER_ENABLED`, `SKILL_ROUTER_K`, `SKILL_ROUTER_MIN_COSINE`, `MEMWAL_ENABLED`, `CONTACT_MEM_INJECT`, `USER_PROFILE_ENABLED`, `AGENT_IDENTITY_INJECT`, `BALANCE_CACHE_ENABLED`, `SOLANA_ENABLED`, `RETRIEVE_TRANSACTIONS_ENABLED`, `OPENROUTER_MODEL`.

Proposed: `EXTENDED_REASONING_ENABLED` (master), `EXTENDED_REASONING_LOOP_ENABLED` (Phase 3 route-retry), `REASONING_MODEL` (Opus-class id), `REASONING_THINKING_BUDGET`, `REASONING_MAX_ITERATIONS`, `REASONING_VALUE_GUARD_USD`, `REASONING_SLIPPAGE_BOUND_BPS` (swap reroute guard), `SKILL_MD_ENABLED` (progressive disclosure).

## Appendix C — Preserved decisions from the deleted source docs

So the three source `.md` files can be deleted without losing anything:

- **Knowledge skills (`.md`)** — `skill_type: executable | knowledge`; knowledge `.md` injected as reference context, never called; lives in the same embeddings table. **Static frameworks (safe now):** `portfolio_management`, `defi_yield`, `risk_management`, `crypto_market_cycles`, `arc_network_guide`, `cctp_bridge_guide`. **Detection (needs a paired data skill before it can give verdicts — §4.4b):** `rug_detection` + `CHECK_TOKEN_SAFETY`, scoped to Solana SPL. (Full treatment in §4.4.)
- **The 5 memory design questions** are answered in §7 (build prefix once; staleness via observations; spend-log durable + memory at session end; pre-prune flush noted-not-built; knowledge budget in §10).
- **Alerta (Encrisoft) operational alerting** — *separate concern, its own future plan, NOT part of extended reasoning.* Decision to preserve: fire a single POST at the end of each skill's execution phase (preconditions → execution → **alert** → memory write); severity map (swap/bridge done=`info`, skill failure=`critical`, CCTP timeout=`high`, anomalous large swap=`high`). Also a clean place to emit the §6 plan-revision audit events. Move this into `alerta_integration.md` when it's time.
- **Mastra** — optional local-only visual debugger to prototype the loop before porting; reference material, not shipped (`synesis_architecture_session.md §6`).
- **Self-building skills** — explicitly deferred until after core stability (`synesis_architecture_session.md §7`).
- **Synesis-specific strength worth keeping:** PIN-on-a-separate-trusted-surface (Mini App) is more conservative than Hermes/OpenClaw's allowlist model — treat as a strength, not a gap (`hermes-openclaw-architecture-map-1.md §12`).
```
