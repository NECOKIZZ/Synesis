-- =====================================================================
-- DotArc / Synesis — Contact Memory (typed behavioral aggregate)
-- =====================================================================
-- "Who you've dealt with." One row per (user, counterparty) holding
-- aggregated relationship stats: how many times you've sent/received,
-- total USD volume each way, a per-token breakdown, recency, and the last
-- action taken with them.
--
-- WHERE THIS SITS IN THE MEMORY STACK
--   - agent_spend_log  → the immutable raw ledger (source of truth).
--   - agent_contact_mem → THIS: a materialized AGGREGATE of that ledger,
--                          shaped for fast injection + ranking.
--   - user_memory       → unstructured EAV facts (preference / note).
--   - Walrus            → episodic prose (tone, open loops, likes/dislikes).
--
--   Because this table is a pure aggregate of agent_spend_log, it is fully
--   REBUILDABLE at any time (see the backfill at the bottom). That is the
--   property that lets us keep the schema minimal today: when the product
--   goes cross-chain, we drop + rebuild this table with a chain-aware key
--   from the (by then multi-chain) ledger, rather than doing a painful
--   in-place primary-key migration now. The ledger is the safety net.
--
-- HOW IT STAYS ACCURATE (deterministic, never LLM-driven)
--   A post-skill updater (lib/memory/contact-mem.ts) calls
--   record_contact_interaction() exactly once per SUCCESSFUL transfer:
--     - outbound (SEND_USDC / SEND_TOKEN) from the executor
--       (app/api/agent/confirm-policy/route.ts)
--     - inbound  (RECEIVE) from the Circle webhook, only on a genuinely
--       new row (idempotent via the spend-log's unique circle_tx_id)
--   Counters NEVER come from the LLM session summary — only prose does.
--
-- DENOMINATION
--   total_*_usd are USD rollups (scalar, indexed → fast ranking).
--   by_token carries native per-token detail so we can say "maya usually
--   gets EURC". Single-chain today: USD ≈ USDC; non-USDC sends are valued
--   at a display rate at write time (good enough for relationship stats —
--   this is never a spend gate).
--
-- Reversibility: purely additive. Rolling back leaves the table unused.
-- =====================================================================

-- ── Table ──────────────────────────────────────────────────────────────

create table if not exists public.agent_contact_mem (
  user_id              uuid not null references public.profiles(id) on delete cascade,
  counterparty_address text not null,                       -- canonical lower-case 0x
  counterparty_alias   text,                                 -- .arc name (bare) / first name; mutable label
  send_count           int  not null default 0,
  receive_count        int  not null default 0,
  total_sent_usd       numeric(20,6) not null default 0,     -- scalar rollup, for ORDER BY ranking
  total_received_usd   numeric(20,6) not null default 0,
  by_token             jsonb not null default '{}'::jsonb,   -- {"USDC":{"sent":120,"recv":0,"count":9},"EURC":{…}}
  last_skill           text,                                 -- last action with them (SEND_USDC / SEND_TOKEN / RECEIVE)
  first_interacted_at  timestamptz,
  last_interacted_at   timestamptz,
  primary key (user_id, counterparty_address)
);

-- Ranking + lookup indexes (the three injection/query patterns):
--   1. top contacts by recency   2. top by frequency   3. by volume   4. alias resolution
create index if not exists agent_contact_mem_recent_idx
  on public.agent_contact_mem(user_id, last_interacted_at desc nulls last);
create index if not exists agent_contact_mem_freq_idx
  on public.agent_contact_mem(user_id, send_count desc);
create index if not exists agent_contact_mem_volume_idx
  on public.agent_contact_mem(user_id, total_sent_usd desc);
create index if not exists agent_contact_mem_alias_idx
  on public.agent_contact_mem(user_id, counterparty_alias);

-- ── RLS (read own; writes are service-role only, mirrors user_memory) ───

alter table public.agent_contact_mem enable row level security;

drop policy if exists "users read own contact mem" on public.agent_contact_mem;
create policy "users read own contact mem"
  on public.agent_contact_mem for select
  using (auth.uid() = user_id);
-- No insert/update policy → writes go through the security-definer RPC
-- (service role), exactly like record_user_memory.

-- ── Atomic upsert-with-increment RPC ───────────────────────────────────
-- One call per successful transfer. Increments the correct direction's
-- count + USD total, merges the per-token bucket, advances recency, and
-- records the last skill. security definer so it runs regardless of the
-- caller's RLS context; every write is still scoped to the passed user_id.
--
-- p_direction: 'out' (we sent) | 'in' (we received).

create or replace function public.record_contact_interaction(
  p_user_id   uuid,
  p_address   text,
  p_alias     text,
  p_direction text,
  p_token     text,
  p_amount_usd numeric,
  p_skill     text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_addr   text := lower(trim(p_address));
  v_token  text := upper(coalesce(nullif(trim(p_token), ''), 'USDC'));
  v_usd    numeric := coalesce(p_amount_usd, 0);
  v_is_out boolean := (p_direction = 'out');
  v_send_d int := case when v_is_out then 1 else 0 end;
  v_recv_d int := case when v_is_out then 0 else 1 end;
  v_sent_d numeric := case when v_is_out then v_usd else 0 end;
  v_recv_usd numeric := case when v_is_out then 0 else v_usd end;
begin
  if v_addr is null or v_addr = '' then
    return;
  end if;

  insert into public.agent_contact_mem as cm (
    user_id, counterparty_address, counterparty_alias,
    send_count, receive_count, total_sent_usd, total_received_usd,
    by_token, last_skill, first_interacted_at, last_interacted_at
  )
  values (
    p_user_id, v_addr, nullif(trim(p_alias), ''),
    v_send_d, v_recv_d, v_sent_d, v_recv_usd,
    jsonb_build_object(
      v_token,
      jsonb_build_object('sent', v_sent_d, 'recv', v_recv_usd, 'count', 1)
    ),
    p_skill, now(), now()
  )
  on conflict (user_id, counterparty_address) do update set
    counterparty_alias = coalesce(nullif(trim(p_alias), ''), cm.counterparty_alias),
    send_count         = cm.send_count + v_send_d,
    receive_count      = cm.receive_count + v_recv_d,
    total_sent_usd     = cm.total_sent_usd + v_sent_d,
    total_received_usd = cm.total_received_usd + v_recv_usd,
    by_token = jsonb_set(
      coalesce(cm.by_token, '{}'::jsonb),
      array[v_token],
      jsonb_build_object(
        'sent',  coalesce((cm.by_token -> v_token ->> 'sent')::numeric, 0) + v_sent_d,
        'recv',  coalesce((cm.by_token -> v_token ->> 'recv')::numeric, 0) + v_recv_usd,
        'count', coalesce((cm.by_token -> v_token ->> 'count')::int, 0) + 1
      ),
      true
    ),
    last_skill         = p_skill,
    last_interacted_at = now();
end;
$$;

grant execute on function public.record_contact_interaction(uuid, text, text, text, text, numeric, text)
  to service_role;

-- No backfill: the product has no users yet, so every row is written
-- forward by the webhook on confirmed transfers. The table being a pure
-- aggregate of agent_spend_log means a backfill remains available later
-- (a single GROUP BY) if we ever need to rebuild — but there is nothing
-- to seed today.

-- ── Comments ───────────────────────────────────────────────────────────

comment on table public.agent_contact_mem is
  'Synesis contact memory: materialized aggregate of agent_spend_log, one row per (user, counterparty). Injected as the always-on contact digest and queried on-demand. Rebuildable from the ledger — see migration backfill.';
comment on function public.record_contact_interaction(uuid, text, text, text, text, numeric, text) is
  'Atomic upsert-with-increment for agent_contact_mem. Called once per successful transfer (outbound from the executor, inbound from the webhook). Never LLM-driven.';

-- =====================================================================
-- Verification (paste into SQL editor after running):
--   select count(*) from agent_contact_mem;
--   select counterparty_alias, send_count, total_sent_usd, by_token
--     from agent_contact_mem order by total_sent_usd desc limit 10;
-- =====================================================================
