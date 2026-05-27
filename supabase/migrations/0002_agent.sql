-- =====================================================================
-- DotArc — Smart Agent tables
-- =====================================================================
-- Run in: Supabase dashboard → SQL Editor → New query → Run.
--
-- Tables:
--   agent_wallets     — one Circle dev-controlled wallet per user (the agent)
--   user_security     — agent PIN hash + lockout state
--   user_spend_limits — per-user guardrails the policy engine enforces
--   agent_policies    — scheduled/recurring instructions (HMAC-signed rows)
--   agent_spend_log   — append-only audit trail of every agent execution
-- =====================================================================

-- ── Helpers ───────────────────────────────────────────────────────────

create or replace function public.handle_updated_at_generic()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ── agent_wallets ─────────────────────────────────────────────────────

create table if not exists public.agent_wallets (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.profiles(id) on delete cascade,
  circle_wallet_id      text not null,
  circle_wallet_address text not null,
  arc_name              text unique,   -- optional "alice-agent" label, no .arc suffix
  arc_name_tx           text,          -- on-chain registration tx hash
  active                boolean not null default true,
  balance_cache_usdc    text not null default '0',
  balance_cache_at      timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint agent_wallets_one_per_user unique (user_id)
);

create index if not exists agent_wallets_user_id_idx on public.agent_wallets(user_id);

drop trigger if exists agent_wallets_updated_at on public.agent_wallets;
create trigger agent_wallets_updated_at
  before update on public.agent_wallets
  for each row execute function public.handle_updated_at_generic();

alter table public.agent_wallets enable row level security;

drop policy if exists "users read own agent wallet" on public.agent_wallets;
create policy "users read own agent wallet"
  on public.agent_wallets for select
  using (auth.uid() = user_id);

drop policy if exists "users insert own agent wallet" on public.agent_wallets;
create policy "users insert own agent wallet"
  on public.agent_wallets for insert
  with check (auth.uid() = user_id);

drop policy if exists "users update own agent wallet" on public.agent_wallets;
create policy "users update own agent wallet"
  on public.agent_wallets for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── user_security ─────────────────────────────────────────────────────

create table if not exists public.user_security (
  user_id          uuid primary key references public.profiles(id) on delete cascade,
  agent_pin_hash   text,          -- null = PIN not set yet (scrypt derived key)
  pin_attempts     int not null default 0,
  pin_locked_until timestamptz,   -- null = not locked
  updated_at       timestamptz not null default now()
);

drop trigger if exists user_security_updated_at on public.user_security;
create trigger user_security_updated_at
  before update on public.user_security
  for each row execute function public.handle_updated_at_generic();

alter table public.user_security enable row level security;

drop policy if exists "users read own security" on public.user_security;
create policy "users read own security"
  on public.user_security for select
  using (auth.uid() = user_id);

drop policy if exists "users insert own security" on public.user_security;
create policy "users insert own security"
  on public.user_security for insert
  with check (auth.uid() = user_id);

drop policy if exists "users update own security" on public.user_security;
create policy "users update own security"
  on public.user_security for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── user_spend_limits ─────────────────────────────────────────────────

create table if not exists public.user_spend_limits (
  user_id                       uuid primary key references public.profiles(id) on delete cascade,
  max_per_transaction_usdc      numeric(20,6) not null default 50,
  max_daily_usdc                numeric(20,6) not null default 100,
  max_weekly_usdc               numeric(20,6) not null default 300,
  max_monthly_usdc              numeric(20,6) not null default 500,
  large_tx_alert_threshold_usdc numeric(20,6) not null default 25,
  updated_at                    timestamptz not null default now()
);

drop trigger if exists user_spend_limits_updated_at on public.user_spend_limits;
create trigger user_spend_limits_updated_at
  before update on public.user_spend_limits
  for each row execute function public.handle_updated_at_generic();

alter table public.user_spend_limits enable row level security;

drop policy if exists "users read own limits" on public.user_spend_limits;
create policy "users read own limits"
  on public.user_spend_limits for select
  using (auth.uid() = user_id);

drop policy if exists "users insert own limits" on public.user_spend_limits;
create policy "users insert own limits"
  on public.user_spend_limits for insert
  with check (auth.uid() = user_id);

drop policy if exists "users update own limits" on public.user_spend_limits;
create policy "users update own limits"
  on public.user_spend_limits for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── agent_policies ────────────────────────────────────────────────────

create table if not exists public.agent_policies (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.profiles(id) on delete cascade,
  skill                 text not null,
  params                jsonb not null default '{}',
  recipient_arc_name    text,
  recipient_address     text,
  amount_usdc           numeric(20,6),
  frequency             text,   -- 'daily' | 'weekly' | 'monthly' | null (one-off)
  next_run              timestamptz,
  last_run              timestamptz,
  last_resolved_address text,   -- cached for hijack detection; cron pauses if it changes
  active                boolean not null default true,
  pause_reason          text,
  policy_hmac           text not null,  -- HMAC-SHA256 over canonical policy fields
  confirmed_at          timestamptz not null default now(),
  created_at            timestamptz not null default now()
);

create index if not exists agent_policies_user_active_idx
  on public.agent_policies(user_id, active);
create index if not exists agent_policies_next_run_idx
  on public.agent_policies(next_run)
  where active = true;

alter table public.agent_policies enable row level security;

drop policy if exists "users read own policies" on public.agent_policies;
create policy "users read own policies"
  on public.agent_policies for select
  using (auth.uid() = user_id);

drop policy if exists "users insert own policies" on public.agent_policies;
create policy "users insert own policies"
  on public.agent_policies for insert
  with check (auth.uid() = user_id);

drop policy if exists "users update own policies" on public.agent_policies;
create policy "users update own policies"
  on public.agent_policies for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── agent_spend_log ───────────────────────────────────────────────────

create table if not exists public.agent_spend_log (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  policy_id         uuid references public.agent_policies(id) on delete set null,
  skill             text not null,
  recipient_address text,
  amount_usdc       numeric(20,6) not null default 0,
  circle_tx_id      text,
  tx_hash           text,
  status            text not null default 'PENDING',  -- PENDING | COMPLETE | FAILED
  error_message     text,
  executed_at       timestamptz not null default now()
);

create index if not exists agent_spend_log_user_time_idx
  on public.agent_spend_log(user_id, executed_at desc);
create index if not exists agent_spend_log_policy_idx
  on public.agent_spend_log(policy_id);

alter table public.agent_spend_log enable row level security;

drop policy if exists "users read own spend log" on public.agent_spend_log;
create policy "users read own spend log"
  on public.agent_spend_log for select
  using (auth.uid() = user_id);

drop policy if exists "users insert own spend log" on public.agent_spend_log;
create policy "users insert own spend log"
  on public.agent_spend_log for insert
  with check (auth.uid() = user_id);
