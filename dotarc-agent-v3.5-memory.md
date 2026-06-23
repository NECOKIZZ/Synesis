# DotArc Agent — V3.5 Memory & Injection Architecture

**Status:** Reference doc. Source of truth for what the LLM sees, where it comes from, and when.
**Scope:** V3.5 is a focused upgrade of V3. It does NOT change the execution engine, the JSON envelope, the validation guard, the idempotency layer, or `withUserLock`. V3.5 changes ONLY what the LLM is shown and how that information is sourced.
**Last updated:** 2026-06-23

---

## 0. The principle

> **What to inject, when to inject, what holds what.**

Three questions answered once, applied to every piece of context the LLM sees.

**The split that drives every other decision:**

- **Hardcoded / structured facts** (identity, balances, limits, policies, skill catalog) → Supabase. Exact lookup or vector retrieval. Always reliable.
- **Agent personality / how it thinks** → hardcoded in the system prompt. Constant. Never learned, never drifts.
- **Learned facts about the user** (preferences, episodic memory, behavior summary) → Memwal. Semantic. Personality-bearing. (Detailed model deferred — see §7.)

**Agent identity ≠ User identity.** The agent's *persona* is hardcoded. The *user's name* is a one-line lookup. These are not the same thing.

---

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
| 9 | Layer B — structured habits | `user_memory` | Supabase (exact lookup) | **NOT INJECTED in V3.5** (deferred) | 0 |
| 10 | Layer C — episodic / session summaries | Memwal (Walrus) | external semantic store | always — top-3 semantic | ~0-150 |
| 11 | Behavior summary | (deferred — see §7) | (TBD: Memwal as tagged fact) | (deferred) | 0 |

**Items 9 and 11 are explicitly out of scope for V3.5.** They're documented here so the deferral is intentional, not forgotten.

---

## 2. The four V3.5 changes

| # | Change | Item touched |
|---|---|---|
| **A** | Inject `arc_name` from `profiles` (one line, always) | #2 |
| **B** | Move wallet state from "live Circle API call" to "read `balance_cache`, fed by webhook" | #3 |
| **C** | New skill: `RETRIEVE_TRANSACTIONS` (on-demand history queries with smart filters) | new |
| **D** | Move skill catalog from hardcoded prose to `skill_embeddings` (pgvector), semantically routed every call | #7 |

Everything else in §1 is unchanged from V3.

---

## 3. Agent identity vs User identity

### 3.1 Agent identity (hardcoded, never moves)

The agent's persona — *"You are DotArc's smart wallet agent. You are financially-minded. You return JSON. You never speculate on prices. You stay financial."* — lives in `lib/agent-core-v3.ts:104-153`. It is a constant. Memwal does not learn it. Supabase does not store it. It travels with the code.

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

---

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

---

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

---

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

---

## 7. What's deferred (do not touch in V3.5)

Documented so the deferral is intentional.

### 7.1 Layer B injection (currently `user_memory`)

In V3.5 we **stop injecting `user_memory` into the prompt**. The table stays — it's the atomic counter store (`hit_count`, etc.) — but the LLM doesn't see its rows directly.

### 7.2 Behavior summary

A SQL-aggregated paragraph describing the user's spend behavior. Currently does not exist anywhere. The intended model (still under research):

- Generated by deterministic SQL aggregation from `user_memory` + `agent_spend_log`. Not by an LLM.
- Stored in **Memwal** as a tagged fact (e.g. `[behavior-summary] ...`).
- Refreshed every N spend events or every M hours.
- Retrieved by tag, not by semantic match. Always relevant.

### 7.3 The bigger memwal question

The user is researching whether all "learned facts about the user" should consolidate into memwal — making `user_memory` purely an internal counter, never directly seen by the LLM. That decision is reserved for after V3.5 ships.

---

## 8. V5 future vision (not in scope for V3.5)

For context. Not building any of this now.

- **Conditional data injection.** Today wallet state, policies, and limits are injected on every call. For casual messages ("how are you?") they may be unnecessary. The counter-argument: the AI uses the dashboard to proactively help even in casual chat. V5 will test this with real data.
- **Two-call subconscious model.** First LLM call selects relevant memory and stats; pgvector selects relevant skills in parallel; second LLM call reasons over everything. Only worth doing once instrumentation shows the single-call model is failing on context selection.
- **Active vector routing tier promotion.** Skills that consistently win the router get a tier-1 cache; the rest pay full vector cost. Premature now.

---

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

---

## 10. Open questions tracked

1. Should the skill router's low-confidence fallback log to a dedicated table (`skill_router_misses`) so we can tune the threshold and grow the catalog from real data? (Pitch story benefit; small ops surface.)
2. When `balance_cache` is stale, do we silently refresh in the background, or only refresh on the next webhook? (Affects how long staleness can persist on idle wallets.)
3. Behavior summary regeneration cadence (deferred).

*This doc is the reference. Build instructions live in `dotarc-agent-v3.5-implementation.md`.*
