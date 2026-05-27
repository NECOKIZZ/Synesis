-- =====================================================================
-- DotArc — profiles table
-- =====================================================================
-- Run this once in: Supabase dashboard → SQL Editor → New query → Run.
--
-- One row per user. Linked 1:1 to auth.users via id (cascade-deletes on
-- account removal). The .arc name is unique across the whole table so
-- we can fast-lookup wallets by name without going on-chain.
-- =====================================================================

create table if not exists public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  email           text not null,
  arc_name        text unique,                          -- "alice" (no .arc suffix). NULL until registered.
  arc_name_tx     text,                                 -- on-chain registration tx hash
  circle_user_id  text not null,                        -- "dotarc-<sha256(email)>"
  wallet_address  text not null,                        -- 0x... ARC-TESTNET wallet from Circle
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists profiles_circle_user_id_idx on public.profiles(circle_user_id);
create index if not exists profiles_wallet_address_idx on public.profiles(wallet_address);

-- ---------------------------------------------------------------------
-- Auto-update updated_at on every UPDATE
-- ---------------------------------------------------------------------
create or replace function public.handle_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function public.handle_updated_at();

-- ---------------------------------------------------------------------
-- Row-level security: a user can only read/insert/update their own row.
-- ---------------------------------------------------------------------
alter table public.profiles enable row level security;

drop policy if exists "users read own profile" on public.profiles;
create policy "users read own profile"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "users insert own profile" on public.profiles;
create policy "users insert own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

drop policy if exists "users update own profile" on public.profiles;
create policy "users update own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);
