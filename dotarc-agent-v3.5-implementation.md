# DotArc Agent — V3.5 Implementation Plan

**Status:** Ready to execute.
**Companion doc:** `dotarc-agent-v3.5-memory.md` (the architecture reference).
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
-- DotArc — Wallet balance cache (V3.5)
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
-- DotArc — Skill embeddings (V3.5, pgvector)
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
| 3.3 | `lib/agent-core-v3.ts:104-153` — the WHO YOU ARE section | When `AGENT_IDENTITY_INJECT=true` and `userArcName` is present, add one line after "You are DotArc's smart wallet agent.": `You are talking to <name>.arc.` If null, omit. |
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
