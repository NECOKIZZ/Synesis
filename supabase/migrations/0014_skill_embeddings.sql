-- =====================================================================
-- DotArc — Skill embeddings (V3.5, Track 4)
-- =====================================================================
-- Semantic skill router. Every interpret call embeds the user message
-- and pulls top-K skill descriptions for prompt injection. Replaces the
-- ~800-token hardcoded skill catalog with a context-sized subset chosen
-- by cosine similarity against the message.
--
-- Why
--   The catalog grows every release (Solana, DeFi, x402, …). Shipping all
--   prose on every call is dead weight for 90% of messages and stops
--   scaling around 50+ skills. Routing semantically keeps prompts small
--   and demoable as "devs ship skills into a registry, system absorbs
--   them, no manual whitelist."
--
-- Tables created
--   skill_embeddings       — one row per registered skill, with its
--                            description prose, category, and a 1536-dim
--                            vector embedded via OpenAI
--                            text-embedding-3-small. Seeded by
--                            scripts/seed-skill-embeddings.ts; admin-only
--                            writes.
--
--   skill_router_misses    — every low-confidence routing decision logged
--                            here (top cosine < SKILL_ROUTER_MIN_COSINE).
--                            Read by us, not the LLM. Used to tune the
--                            threshold and discover catalog gaps (e.g.
--                            users repeatedly asking about staking when
--                            no STAKE skill exists yet).
--
-- Trust model
--   skill_embeddings is admin-curated (service role writes; authenticated
--   reads). The vector column is not a security-sensitive field — it
--   describes the agent's catalog, not user data. RLS is enabled mainly
--   for posture; the policy lets any authenticated user read.
--
-- Reversibility
--   Purely additive. Rolling back V3.5 leaves these tables unused.
--   The pgvector extension stays installed; that's harmless.
-- =====================================================================

create extension if not exists vector;

-- ── skill_embeddings ─────────────────────────────────────────────────

create table if not exists public.skill_embeddings (
  skill_name     text primary key,
  description    text not null,              -- the prose injected into the prompt
  category       text not null,              -- TRANSFER | READ | POLICY | CONFIG
  affects_funds  boolean not null default false,
  embedding      vector(1536) not null,      -- OpenAI text-embedding-3-small
  active         boolean not null default true,
  updated_at     timestamptz not null default now()
);

-- Useful when we filter rendered catalog by active=true.
create index if not exists skill_embeddings_active_idx
  on public.skill_embeddings(active) where active = true;

-- IVFFlat will outperform seqscan around ~1000 rows; with ~14 skills
-- seqscan is faster. Created anyway so it exists when we grow. `lists`
-- is tuned for a future range of ~50-500 skills; revisit if we cross
-- ~5000.
create index if not exists skill_embeddings_vec_idx
  on public.skill_embeddings using ivfflat (embedding vector_cosine_ops)
  with (lists = 10);

alter table public.skill_embeddings enable row level security;

drop policy if exists "authenticated read skill embeddings"
  on public.skill_embeddings;
create policy "authenticated read skill embeddings"
  on public.skill_embeddings for select to authenticated using (true);
-- Writes are via service role only (no policy → RLS blocks).

-- ── skill_router_misses ──────────────────────────────────────────────

create table if not exists public.skill_router_misses (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references public.profiles(id) on delete set null,
  message        text not null,
  top_cosine     double precision not null,
  fallback_used  boolean not null default true,
  created_at     timestamptz not null default now()
);

create index if not exists skill_router_misses_created_idx
  on public.skill_router_misses(created_at desc);

alter table public.skill_router_misses enable row level security;
-- No SELECT policy — only the service role reads this for ops/tuning.
-- No INSERT policy either — the router inserts via service role too,
-- since the route handler already authenticates the user.

-- ── match_skills RPC ─────────────────────────────────────────────────
-- Returns the top-N most semantically similar skills to a query
-- embedding, along with their cosine similarity. The router calls this
-- via supabase.rpc('match_skills', ...) because supabase-js can't express
-- the pgvector `<=>` distance operator in its query builder.
--
-- We return similarity as (1 - cosine_distance) so callers compare with
-- `>` against a threshold (intuitive: higher = more similar).

create or replace function public.match_skills(
  query_embedding vector(1536),
  match_count     int  default 6
)
returns table (
  skill_name    text,
  description   text,
  category      text,
  affects_funds boolean,
  similarity    double precision
)
language sql
stable
parallel safe
as $$
  select
    se.skill_name,
    se.description,
    se.category,
    se.affects_funds,
    1 - (se.embedding <=> query_embedding) as similarity
  from public.skill_embeddings se
  where se.active = true
  order by se.embedding <=> query_embedding
  limit greatest(match_count, 1);
$$;

-- Exposed to both authenticated (interpret route uses anon-keyed RLS
-- client) and service role callers.
grant execute on function public.match_skills(vector, int) to authenticated, service_role;

-- ── Comments ─────────────────────────────────────────────────────────

comment on table public.skill_embeddings is
  'V3.5 Track 4: pgvector store for the semantic skill router. One row per registered skill. Seeded by scripts/seed-skill-embeddings.ts.';

comment on table public.skill_router_misses is
  'V3.5 Track 4: low-confidence routing decisions. Used to tune SKILL_ROUTER_MIN_COSINE and discover catalog gaps. Service-role only.';

comment on function public.match_skills(vector, int) is
  'V3.5 Track 4: cosine-similarity search over skill_embeddings. Returns top N rows ordered by similarity (higher = more similar). Used by lib/skill-router.ts.';

-- =====================================================================
-- Verification queries (paste into SQL editor after running):
--
--   select extname, extversion from pg_extension where extname = 'vector';
--
--   select table_name from information_schema.tables
--     where table_name in ('skill_embeddings', 'skill_router_misses');
--
--   -- After running scripts/seed-skill-embeddings.ts:
--   select skill_name, category, active from skill_embeddings order by skill_name;
-- =====================================================================
