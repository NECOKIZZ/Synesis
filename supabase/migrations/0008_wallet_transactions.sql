-- =====================================================================
-- Migration 0008: wallet_transactions (main wallet activity log)
--
-- Why a new table instead of reusing agent_spend_log:
--   - agent_spend_log is gated by the Smart Agent invite system; non-
--     invited users would never see their main wallet activity if it
--     piggy-backed on that table.
--   - Semantic clarity: "agent" rows describe LLM-driven skill executions
--     (with a `policy_id`, `skill`, etc.). Main wallet rows describe
--     plain user-initiated transfers. Mixing them in one table forced
--     confusing nullable columns and per-row branching everywhere.
--   - Easier to evolve each independently (different lifecycle, different
--     UI, different retention policy long-term).
--
-- The Activity tab in the UI unifies both tables into one feed via the
-- /api/wallet/activity endpoint; rows carry a `source` flag so the UI
-- can badge them as "wallet" vs "agent".
-- =====================================================================

-- ── Table ────────────────────────────────────────────────────────────

create table if not exists public.wallet_transactions (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references public.profiles(id) on delete cascade,

  -- Direction of value flow relative to the user's main wallet.
  direction                text not null check (direction in ('SEND', 'RECEIVE', 'WITHDRAW')),

  counterparty_address     text,
  counterparty_arc_name    text,

  -- Amount + token. Default USDC for now; EURC / cirBTC can land later
  -- without another migration.
  amount                   numeric(38, 18) not null default 0,
  token_symbol             text not null default 'USDC',

  -- Circle bookkeeping. circle_tx_id is the notification.id from Circle's
  -- webhook payload (NOT the challengeId used to create the tx — those
  -- are unrelated values). tx_hash is the on-chain hash, available once
  -- the tx clears.
  circle_tx_id             text,
  tx_hash                  text,

  status                   text not null default 'PENDING'
                                 check (status in ('PENDING', 'COMPLETE', 'FAILED')),
  error_message            text,

  executed_at              timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- ── Indexes ──────────────────────────────────────────────────────────

create index if not exists wallet_transactions_user_time_idx
  on public.wallet_transactions(user_id, executed_at desc);

-- Webhook lookup by Circle's notification id — fast O(log n) match.
create index if not exists wallet_transactions_circle_tx_id_idx
  on public.wallet_transactions(circle_tx_id)
  where circle_tx_id is not null;

-- "Find the most recent PENDING row for this user without a circle_tx_id
-- yet" matcher used by the webhook to claim rows pre-inserted by
-- send-prepare.
create index if not exists wallet_transactions_user_pending_idx
  on public.wallet_transactions(user_id, executed_at desc)
  where status = 'PENDING' and circle_tx_id is null;

-- Idempotency on (circle_tx_id) so re-delivered webhooks don't dupe rows.
create unique index if not exists wallet_transactions_circle_tx_id_uniq
  on public.wallet_transactions(circle_tx_id)
  where circle_tx_id is not null;

-- ── RLS ──────────────────────────────────────────────────────────────

alter table public.wallet_transactions enable row level security;

drop policy if exists "users read own wallet tx" on public.wallet_transactions;
create policy "users read own wallet tx"
  on public.wallet_transactions for select
  using (auth.uid() = user_id);

drop policy if exists "users insert own wallet tx" on public.wallet_transactions;
create policy "users insert own wallet tx"
  on public.wallet_transactions for insert
  with check (auth.uid() = user_id);

-- Updates only by the service role (webhook uses service-role client to
-- claim the PENDING row → COMPLETE). Users don't need to update their
-- own rows, so we omit a user-facing update policy.

-- ── updated_at trigger ───────────────────────────────────────────────

create or replace function public.wallet_transactions_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_wallet_transactions_updated_at on public.wallet_transactions;
create trigger trg_wallet_transactions_updated_at
  before update on public.wallet_transactions
  for each row execute function public.wallet_transactions_set_updated_at();

-- ── Realtime publication ─────────────────────────────────────────────

do $$
begin
  alter publication supabase_realtime add table public.wallet_transactions;
exception when duplicate_object then null;
end $$;

-- ── Verification ─────────────────────────────────────────────────────
--
--   select column_name, data_type from information_schema.columns
--     where table_name = 'wallet_transactions' order by ordinal_position;
--
--   select schemaname, tablename from pg_publication_tables
--     where pubname = 'supabase_realtime' and tablename = 'wallet_transactions';
-- =====================================================================
