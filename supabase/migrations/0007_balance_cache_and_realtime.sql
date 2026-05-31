-- =====================================================================
-- DotArc — Balance cache + Realtime publication
-- =====================================================================
-- Purpose
--   1. Add `balance_cache_usdc` to `profiles` so the main-wallet UI can
--      paint instantly on cold start. The agent wallet already has the
--      equivalent columns on `agent_wallets` from migration 0002.
--
--   2. Add `wallet_type` to `agent_spend_log` so the UI can split
--      activity feeds for the main wallet vs the agent wallet.
--      ('main' = user-controlled wallet, 'agent' = dev-controlled
--      wallet that runs the Smart Agent.)
--
--   3. Add `idempotency_key` to `agent_spend_log` so the webhook handler
--      can match outbound transactions deterministically (the current
--      "most recent PENDING within 10 min" matcher is fragile under
--      concurrent sends).
--
--   4. Enable Supabase Realtime on the three tables the UI subscribes
--      to: `profiles`, `agent_wallets`, `agent_spend_log`.
--
-- Run in: Supabase dashboard → SQL Editor → New query → Run.
-- =====================================================================

-- ── 1. profiles: balance cache ────────────────────────────────────────

alter table public.profiles
  add column if not exists balance_cache_usdc text not null default '0',
  add column if not exists balance_cache_at   timestamptz;

-- ── 2. agent_spend_log: wallet_type + idempotency_key ─────────────────

alter table public.agent_spend_log
  add column if not exists wallet_type     text not null default 'main',
  add column if not exists idempotency_key text;

-- Constrain wallet_type so a typo can't sneak in.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'agent_spend_log_wallet_type_check'
  ) then
    alter table public.agent_spend_log
      add constraint agent_spend_log_wallet_type_check
      check (wallet_type in ('main', 'agent'));
  end if;
end $$;

-- Unique index on idempotency_key so re-delivered webhooks don't insert
-- the same row twice. Partial index — null keys are allowed and skipped.
create unique index if not exists agent_spend_log_idempotency_key_uniq
  on public.agent_spend_log(idempotency_key)
  where idempotency_key is not null;

-- Helpful index for the home/agent activity tabs.
create index if not exists agent_spend_log_user_wallet_time_idx
  on public.agent_spend_log(user_id, wallet_type, executed_at desc);

-- Also index circle_tx_id so webhook lookups by Circle's tx ID are O(log n).
create index if not exists agent_spend_log_circle_tx_id_idx
  on public.agent_spend_log(circle_tx_id)
  where circle_tx_id is not null;

-- ── 3. Realtime publication ──────────────────────────────────────────
-- Supabase Realtime listens to a Postgres logical replication slot
-- bound to the `supabase_realtime` publication. Adding our tables here
-- is what lets the browser subscribe to row changes.
--
-- `do $$ ... exception ... end $$` blocks make this idempotent — re-runs
-- won't fail if the table is already in the publication.

do $$
begin
  alter publication supabase_realtime add table public.profiles;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.agent_wallets;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.agent_spend_log;
exception when duplicate_object then null;
end $$;

-- =====================================================================
-- Verification queries (paste into SQL editor after running):
--
--   select column_name from information_schema.columns
--     where table_name = 'profiles' and column_name like 'balance_cache%';
--
--   select column_name from information_schema.columns
--     where table_name = 'agent_spend_log'
--     and column_name in ('wallet_type', 'idempotency_key');
--
--   select schemaname, tablename from pg_publication_tables
--     where pubname = 'supabase_realtime'
--     and tablename in ('profiles', 'agent_wallets', 'agent_spend_log');
-- =====================================================================
