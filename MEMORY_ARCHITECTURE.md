# Synesis — Memory Architecture

**Status:** Source of truth for the agent's memory + context-injection design.
**Last updated:** 2026-07-02 (reconciled to the shipped 4-layer stack)
**Consolidates:** `dotarc-agent-v3.5-memory.md` (current, authoritative) + `pasion_memory_architecture.md` (broader multi-chain behavioral vision).
**Companion docs:** `AGENT_ROADMAP.md` Part I (build instructions), `STRESS_TEST.md` §8 (memory test suite), `ARCHITECTURE.md` §9 (summary).

> **Reconciliation note (2026-07-02):** the shipped stack is **four layers** — identity (`profiles.arc_name`), user profile (`user_profile`, migration 0018), contact stats (`agent_contact_mem`, migration 0015), and episodic (MemWal/Walrus). The **`user_memory` table was dropped in migration 0017**; where Part I below still names `user_memory` (an earlier intermediate-V3.5 model where it was to survive as a counter store), read it as the split it actually became: deterministic counters → `agent_contact_mem`, learned facts → MemWal. Part II's 7-table vision remains the forward design target.

- **Part I** — the **current** V3.5 injection architecture. This is what ships and what the LLM actually sees today.
- **Part II** — the **extended** behavioral + episodic memory model (the multi-chain Pasion vision the 4-layer stack builds toward). Design reference, not all implemented.

---

# PART I — V3.5 Injection Architecture (current, authoritative)

**Scope:** V3.5 is a focused upgrade of V3. It does NOT change the execution engine, the JSON envelope, the validation guard, the idempotency layer, or `withUserLock`. V3.5 changes ONLY what the LLM is shown and how that information is sourced.

## 0. The principle

> **What to inject, when to inject, what holds what.**

Three questions answered once, applied to every piece of context the LLM sees.

**The split that drives every other decision:**

- **Hardcoded / structured facts** (identity, balances, limits, policies, skill catalog) → Supabase. Exact lookup or vector retrieval. Always reliable.
- **Agent personality / how it thinks** → hardcoded in the system prompt. Constant. Never learned, never drifts.
- **Learned facts about the user** (preferences, episodic memory, behavior summary) → Memwal. Semantic. Personality-bearing. (Detailed model in Part II.)

**Agent identity ≠ User identity.** The agent's *persona* is hardcoded. The *user's name* is a one-line lookup. These are not the same thing.

## 1. Full injection map

Every layer the LLM sees on a normal `/api/agent/interpret` call.

| # | Block | Source | Storage | Cadence | ~Tokens |
|---|---|---|---|---|---|
| 1 | Agent persona, hard rules, output spec | hardcoded | `lib/agent-core-v3.ts` | always | ~600 |
| 2 | User identity line | `profiles.arc_name` | Supabase (exact lookup) | always | ~10 |
| 3 | Wallet state (balances) | `agent_wallets.balance_cache` (webhook-fed) | Supabase (exact lookup) | always | ~30 |
| 4 | Spend limits | `user_spend_limits` | Supabase (exact lookup) | always | ~40 |
| 5 | Active policies | `agent_policies WHERE active=true` (top 20) | Supabase (exact lookup) | always | ~30-300 |
| 6 | Live prices (EURC, cirBTC) | oracle | external | always | ~20 |
| 7 | Skill catalog (top-K semantic) | `skill_embeddings` (pgvector) | Supabase (vector lookup) | always — semantic | ~300-500 |
| 8 | Layer A — in-session history | client `history[]` | browser only | when present | ~50-500 |
| 9 | Contact stats (who / how much) | `agent_contact_mem` (mig 0015) | Supabase (exact lookup) | **intent-gated** — injected only when the router picks SEND_USDC/SEND_TOKEN | ~0-120 |
| 9b | User profile card (style + standing prefs) | `user_profile` (mig 0018) | Supabase (exact lookup) | always | ~40-150 |
| 10 | Layer C — episodic / session summaries | MemWal (Walrus) | external semantic store | always — top-3 semantic | ~0-150 |
| 11 | Behavior summary | (deferred — see §7) | (TBD: MemWal as tagged fact) | (deferred) | 0 |

**What shipped vs. what's deferred:** the earlier V3.5 plan kept a single `user_memory` table as an un-injected counter store. That was superseded — `user_memory` was **dropped (mig 0017)** and split into two shipped stores: **`agent_contact_mem`** (deterministic contact counters, webhook-written, intent-gated injection — row 9) and the **`user_profile`** card (row 9b, always injected). Learned free-form facts live in **MemWal** (row 10). **Item 11 (behavior summary) remains out of scope.**

## 2. The four V3.5 changes

| # | Change | Item touched |
|---|---|---|
| **A** | Inject `arc_name` from `profiles` (one line, always) | #2 |
| **B** | Move wallet state from "live Circle API call" to "read `balance_cache`, fed by webhook" | #3 |
| **C** | New skill: `RETRIEVE_TRANSACTIONS` (on-demand history queries with smart filters) | new |
| **D** | Move skill catalog from hardcoded prose to `skill_embeddings` (pgvector), semantically routed every call | #7 |

Everything else in §1 is unchanged from V3.

## 3. Agent identity vs User identity

### 3.1 Agent identity (hardcoded, never moves)

The agent's persona — *"You are Synesis's smart wallet agent. You are financially-minded. You return JSON. You never speculate on prices. You stay financial."* — lives in `lib/agent-core-v3.ts:104-153`. It is a constant. Memwal does not learn it. Supabase does not store it. It travels with the code.

**Why:** the agent's character must not drift. If memwal had a bad day, we don't want the agent forgetting it's a wallet agent.

### 3.2 User identity (lookup, lives in `profiles`)

The `profiles` table has 7 columns; only one matters to the LLM:

| Column | LLM relevance |
|---|---|
| `id` | none (internal) |
| `email` | none (PII, no value to agent reasoning) |
| **`arc_name`** | **inject** — used for "You are talking to daniel.arc" |
| `arc_name_tx` | none (on-chain proof) |
| `circle_user_id` | none (internal) |
| `wallet_address` | none — the LLM never signs; transactions go through Circle |
| `created_at`, `updated_at` | none |

**Injection:** one line, always, ~10 tokens:
```
You are talking to daniel.arc.
```

If `arc_name` is null (not yet registered), the line is omitted.

## 4. Wallet state — webhook-fed cache

### 4.1 The problem with V3

Every interpret call does:
```ts
allBalances = await getAgentAllBalances(wallet.circle_wallet_id);  // live Circle API
```

This costs ~300-800ms per call and burns Circle API quota for data we could trivially cache.

### 4.2 The V3.5 model

- New columns on `agent_wallets`:
  - `balance_cache jsonb default '{}'` — `{"USDC": "47.50", "EURC": "12.00", "cirBTC": "0"}`
  - `balance_cache_updated_at timestamptz`
- Circle webhook (already exists for transaction confirmation) is extended to update `balance_cache` whenever any token balance changes for an agent wallet.
- The interpret route reads `balance_cache` instead of calling Circle.

### 4.3 The trust caveat (from v4 doc, still applies)

The cache is **eventually consistent**. It can lag the chain by seconds. So:

- Use the cache for **prompt injection** (LLM's first-filter judgment). Stale by seconds is fine for "do you have ~$50 to send?".
- Do NOT use the cache as the final spend gate. The deterministic precheck at spend time (V4 work) must still hit Circle live. For V3.5, this means: where we currently check balance at spend time, keep doing that with the live source.

**V3.5 only touches the prompt injection path.** Spend-time gates are untouched.

## 5. `RETRIEVE_TRANSACTIONS` skill

### 5.1 Why

Today the agent cannot answer "what did I send last week?" The data lives in `agent_spend_log` but the agent has no skill to query it. We don't want to dump 1000 rows into every prompt — that's why it's a skill (on-demand), not always-injected context.

### 5.2 Param shape

```ts
{
  since?: "yesterday" | "last_week" | "last_month" | ISO date,
  until?: ISO date,
  token?: "USDC" | "EURC" | "cirBTC" | "BTC",   // includes bridge events
  recipient?: string,                            // .arc name or 0x
  direction?: "in" | "out" | "both",             // default "both"
  limit?: number,                                 // default 20, max 50
}
```

The LLM picks the filter dimension upfront from the user message:
- "how much did I send last week?" → `{since: "last_week", direction: "out"}`
- "how much BTC came in last week?" → `{since: "last_week", token: "cirBTC", direction: "in"}`
- "how much have I tipped sara?" → `{recipient: "sara.arc", direction: "out"}`

### 5.3 Return shape

```ts
{
  ok: true,
  transactions: [/* ≤50 rows, newest first */],
  aggregate: {
    count: number,
    total_in_usdc: number,
    total_out_usdc: number,
    by_token: { USDC: {in, out}, EURC: {in, out}, cirBTC: {in, out} }
  }
}
```

The aggregate lets the LLM answer the *number* question ("you sent $42 last week") without listing every row when the user didn't ask for the list.

### 5.4 Properties

| Property | Value |
|---|---|
| `category` | `"READ"` |
| `affectsFunds` | `false` |
| `requiresPin` | `false` |
| `precheck` | none (read-only) |

Zero added latency to the spend path. Read skills don't precheck.

## 6. Skill catalog — pure semantic routing via pgvector

### 6.1 Why

V3 ships the full prose of all 14 skills (~800 tokens) on every interpret call. This is dead weight for 90% of messages. The future requires more skills (Solana, DeFi, x402, etc.). The same approach at 50+ skills is prompt-bloating to the point of failure.

### 6.2 The model

- New Supabase table `skill_embeddings` (extension `vector`, pgvector).
- One row per skill. Each row stores the skill name, its full description prose, category, `affects_funds`, and a 1536-dim embedding.
- Embeddings are computed at deploy/seed time using OpenAI `text-embedding-3-small`.
- On every interpret call:
  1. Embed the user message (~50ms, $0.000002).
  2. `SELECT skill_name, description FROM skill_embeddings ORDER BY embedding <=> $query LIMIT K`.
  3. Inject only those K skill descriptions into the prompt.

### 6.3 K and the fallback rule

- Default `K = 6`.
- **No safety floor.** Every call routes purely. If the router picks badly, we learn from it.
- **One fallback** (insurance, not preference): if every top-K result has cosine < 0.4, the message didn't semantically match any skill confidently. In that case, inject the full catalog so we don't gamble. Treated as "I genuinely don't know what they're asking" insurance — logged with the user message so we can grow the catalog or tune the threshold from real data.

### 6.4 Why this is also the pitch story

> *"Devs ship skills into a registry. We embed each description once. Every call routes semantically. As the catalog grows from 14 to 140, the prompt does not grow. No manual whitelist, no curation step."*

True, demonstrable, defensible.

## 7. What's deferred (do not touch in V3.5)

### 7.1 Structured-habit injection (superseded — the `user_memory` plan)

The original V3.5 plan was to **stop injecting `user_memory` into the prompt** while keeping the table as an un-injected counter store. **This was superseded and is now shipped differently:** `user_memory` was **dropped (mig 0017)** and split into `agent_contact_mem` (deterministic contact counters, webhook-written) + the `user_profile` card. Contact counters ARE surfaced to the LLM now — but **intent-gated** (only on SEND intents), not always-on, and never written by the LLM. See §1 rows 9 / 9b and `ARCHITECTURE.md` §9.

### 7.2 Behavior summary

A SQL-aggregated paragraph describing the user's spend behavior. Currently does not exist anywhere. The intended model (still under research):

- Generated by deterministic SQL aggregation from `agent_contact_mem` + `agent_spend_log`. Not by an LLM.
- Stored in **MemWal** as a tagged fact (e.g. `[behavior-summary] ...`).
- Refreshed every N spend events or every M hours.
- Retrieved by tag, not by semantic match. Always relevant.

### 7.3 The bigger memwal question

The open question — whether all "learned facts about the user" should consolidate into MemWal — has been **resolved in the shipped stack:** free-form learned facts live in **MemWal**; deterministic counters live in **`agent_contact_mem`** (never LLM-written); durable style/prefs live in the **`user_profile`** card. `user_memory` no longer exists. Part II remains the design target for the broader multi-table behavioral vision.

## 8. V5 future vision (not in scope for V3.5)

- **Conditional data injection.** Today wallet state, policies, and limits are injected on every call. For casual messages ("how are you?") they may be unnecessary. The counter-argument: the AI uses the dashboard to proactively help even in casual chat. V5 will test this with real data.
- **Two-call subconscious model.** First LLM call selects relevant memory and stats; pgvector selects relevant skills in parallel; second LLM call reasons over everything. Only worth doing once instrumentation shows the single-call model is failing on context selection.
- **Active vector routing tier promotion.** Skills that consistently win the router get a tier-1 cache; the rest pay full vector cost. Premature now.

## 9. Failure modes — what happens when each thing breaks

| Failure | Fallback |
|---|---|
| `profiles.arc_name` is null | Skip the identity line. Agent still works. |
| Webhook hasn't populated `balance_cache` yet (new wallet) | One-time fallback to live Circle call; cache result. |
| `balance_cache_updated_at` is older than threshold (e.g. 10 min) | Treat as suspect; log; still inject but flag staleness in `combined_confirmation_message` if spend is involved. |
| Embedding API down (skill router) | Fall back to injecting full catalog. Log and continue. |
| pgvector query slow / errors | Fall back to injecting full catalog. Log and continue. |
| Memwal recall fails | Skip Layer C block. Agent still works without episodic memory. |
| `agent_spend_log` empty for `RETRIEVE_TRANSACTIONS` | Return `{ok: true, transactions: [], aggregate: {count: 0, ...}}` — let the LLM say "you have no matching transactions". |

**Rule:** memory/context failures are never fatal. The agent always falls back to a working state, possibly with reduced personalization.

## 10. Open questions tracked

1. Should the skill router's low-confidence fallback log to a dedicated table (`skill_router_misses`) so we can tune the threshold and grow the catalog from real data?
2. When `balance_cache` is stale, do we silently refresh in the background, or only refresh on the next webhook?
3. Behavior summary regeneration cadence (deferred).

---

# PART II — Extended Behavioral + Episodic Memory Model (vision)

*The broader multi-chain Pasion design. A hybrid memory engine of two layers — structured behavioral memory (Supabase) + episodic memory (MemWal/Walrus) — working together on every turn. Not all implemented; this is the target the V3.5 stack grows into.*

## The three memory tiers

- **Tier 1 — Core Identity (Static).** Hardcoded into the system prompt. Never changes per user. (= Part I §3.1.)
- **Tier 2 — Live State (Working Memory).** Fetched fresh at execution time — balances, prices, positions. Never stored in memory tables because it changes every block. (= Part I §4, the balance cache is the pragmatic version.)
- **Tier 3 — Archived Context (Long-Term Memory).** Split into:
  - **3A — Behavioral Profiles** → Supabase. Structured, queryable, injected by deterministic middleware.
  - **3B — Episodic Summaries** → MemWal. Natural-language session snapshots stored on Walrus.

## Layer 3A — Supabase behavioral memory

**Design philosophy:** stores **only past behavior** — no live balances, no active positions, no raw transaction logs. Everything is a pre-aggregated snapshot. When the user acts again, the existing row is **updated, not duplicated**. Keeps tables small, fast, and injection-ready.

### The 7 memory tables

**1. `contact_mem` — who you've dealt with** *(shipped as `agent_contact_mem`, migration 0015)*
```sql
CREATE TABLE contact_mem (
    user_address    TEXT NOT NULL,
    counterparty_address TEXT NOT NULL,
    counterparty_alias   TEXT,             -- 'David', 'Alice', or resolved .arc name
    send_count           INT DEFAULT 0,
    receive_count        INT DEFAULT 0,
    total_sent_usd       NUMERIC DEFAULT 0,
    total_received_usd   NUMERIC DEFAULT 0,
    last_interacted_at   TIMESTAMPTZ,
    PRIMARY KEY (user_address, counterparty_address)
);
```
> Chain is not stored here — the counterparty address is chain-specific by nature. David's Solana and Sui addresses are two separate rows.

**2. `swap_mem` — where you swap** — `(user_address, chain, protocol)`; `interaction_count`, `total_volume_usd`, `top_pair`, `last_used_at`.

**3. `yield_mem` — where you put money to work** — `(user_address, chain, protocol)`; `preferred_action` (supply/stake/borrow), `interaction_count`, `total_deposited_usd` (historical total, NOT live balance), `last_used_at`.

**4. `bridge_mem` — how you move across chains** — `(user_address, from_chain, to_chain, provider)`; `top_token`, `interaction_count`, `last_used_at`.

**5. `pred_mem` — where you bet** — `(user_address, chain, protocol)`; `top_sector`, `total_staked_usd`, `wins_count`/`losses_count` (need an outcome feed to populate), `interaction_count`, `last_used_at`.

**6. `token_prefs` — what you've explicitly configured** — `(user_address, token_symbol)`; `custom_slippage`, `is_watchlist`. User commands, not observations.

**7. `token_mem` — how you behave with tokens** — `(user_address, token_symbol)`; `interaction_count`, `volume_traded_usd`, `volume_sent_usd`, `volume_received_usd`, `last_used_at`. Observed patterns.

**Why `token_prefs` and `token_mem` are separate:** `token_prefs` is written by user command (guardrails — corruption loses user settings); `token_mem` is written by the agent observer on every transaction (intelligence — corruption just rebuilds).

### The update pipeline

A **background update job** fires at end of every session and after every completed transaction. It reads the session and upserts (increments) the right rows. Example:
```typescript
async function updateSwapMem(userId, chain, protocol, volumeUsd, pair) {
  await supabase.from('swap_mem').upsert({
    user_address: userId, chain, protocol,
    interaction_count: supabase.raw('interaction_count + 1'),
    total_volume_usd: supabase.raw(`total_volume_usd + ${volumeUsd}`),
    top_pair: pair, last_used_at: new Date().toISOString()
  }, { onConflict: 'user_address, chain, protocol' });
}
```

### The deterministic middleware

Sits **between the user's message and the LLM call**. No AI, no vectors — just keyword matching + SQL. Figures out what memory is relevant, fetches it, injects it before the LLM sees anything.

**Flow:** extract action word → which table? · extract chain word → filter by chain? · extract entity word → filter by name/protocol/token? → indexed SQL lookup → format into a memory block → single LLM call.

**Decision tree:**
```
Action word? (swap, send, bridge, stake, bet, contact, yield)
  YES → pick table → chain word? (filter or pull top across chains) → entity? (add filter or category overview) → query → format → inject
  NO  → price/balance question? → route to live RPC layer (NOT the memory tables)
```

**Worked examples (specific → abstract → out-of-scope):**
- *"Send 50 USDC to David"* → `contact_mem` by alias → *"'David' resolves to 0x74f…e2a. Sent 9 times. Last: June 22."* → executes without asking who David is.
- *"I want to make a swap"* (no chain) → top-3 `swap_mem` by volume → lists habits, prompts for chain.
- *"Man, I barely trade on Ethereum right?"* → `swap_mem WHERE chain='ethereum'` → zero rows → *"You have zero swap history on Ethereum."*
- *"What's the price of SUI right now?"* → no table matches → route to live price feed, never the behavior tables.

## Layer 3B — MemWal episodic memory

**What gets stored:** everything that doesn't fit a structured table — expressed preferences ("I hate Cetus fees"), implicit habits ("always picks the fastest option"), unfinished business ("wanted to check Navi yields but never did"), communication style ("impatient, short messages").

**When written:** at the **end of every session**, one background job: (1) reads the full conversation, (2) calls the LLM with a strict summarization prompt, (3) writes a structured packet to MemWal, (4) updates the relevant Supabase behavior tables from the same session data. One job, two writes, no redundancy.

**Session summary format:**
```markdown
### SESSION SNAPSHOT — [DATE]
**ACTIONS TAKEN** — completed transactions only (feeds the Supabase update job)
**PREFERENCES EXPRESSED** — behavioral signals, likes/dislikes (episodic gold)
**OPEN LOOPS** — mentioned but not completed (makes the agent feel intelligent on return)
**TONE SIGNAL** — one sentence on communication style (shapes next session's response length)
```

**Summarization prompt rules:** declarative, third person, max 3 bullets per section, `NONE` if empty, and — critically — **never invent details not explicitly in the conversation.** A hallucinated preference stored permanently silently corrupts every future session.

**Memory degradation problem:** over months MemWal accumulates hundreds of snapshots; old irrelevant sessions dilute semantic retrieval. **Planned mitigation:** a periodic compression job that rolls old snapshots into a meta-summary, keeping the episodic store lean.

## How both layers work together — full turn

User: *"Swap my USDC to SOL"*
1. **Middleware extracts:** action=swap, token=SOL, chain=solana (inferred).
2. **Supabase query:** top `swap_mem` for solana → Jupiter, $125k. `token_prefs` for SOL → no custom slippage.
3. **MemWal fetch (parallel):** semantic search "solana swap preference" → *"Prefers speed over cost on Solana. Never complained about Jupiter fees."*
4. **Prompt assembled:** [Core Identity] + [Live Balance from RPC] + [Behavior Memory] + [Episodic Memory] + [User Message].
5. **Single LLM call:** routes to Jupiter, executes with default slippage, no questions asked.

## What this architecture is NOT

- Does not store raw transaction logs, live balances, or active positions.
- Does not require vector databases for behavior retrieval (keyword + SQL).
- Does not make multiple LLM calls per user turn.
- Does not ask the user to repeat themselves across sessions.

## Implementation roadmap

| Phase | Task |
|---|---|
| V1 | Create the 7 Supabase tables · middleware keyword extractor · prompt assembler · end-of-session update job |
| V2 | MemWal write after each session · MemWal semantic fetch in middleware · summarization prompt + validator |
| V3 | Memory compression / eviction strategy · wins/losses outcome feed for `pred_mem` |

*Part II reflects the design session of June 23–25, 2026. v1 — built to iterate on real usage data.*
