-- =====================================================================
-- DotArc — Skill executor infrastructure: idempotency + audit log
-- =====================================================================
-- Run in: Supabase dashboard → SQL Editor → New query → Run.
--
-- Tables:
--   agent_idempotency — short-lived dedupe keys to neutralize double-submits
--                       on PIN-confirmed skill calls. Each row represents
--                       one (user, intent) within a TTL window.
--
--   agent_audit_log   — structured per-call log of every skill execution.
--                       Captures category / affectsFunds / sanitized params
--                       / outcome / duration so we can answer "what did the
--                       agent do for this user, and when" without scraping
--                       agent_spend_log (which only covers TRANSFER skills).
--
-- Both tables are owned by the server. Users get SELECT only via RLS so
-- the dashboard can show history; INSERT/UPDATE happen exclusively from
-- the service role inside confirm-policy.
-- =====================================================================

-- ── agent_idempotency ────────────────────────────────────────────────

create table if not exists public.agent_idempotency (
  user_id          uuid        not null references auth.users(id) on delete cascade,
  idempotency_key  text        not null,
  skill            text        not null,
  status           text        not null check (status in ('PENDING','COMPLETE','FAILED')),
  result_json      jsonb,
  http_status      smallint,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  primary key (user_id, idempotency_key)
);

create index if not exists agent_idempotency_expires_at_idx
  on public.agent_idempotency (expires_at);

alter table public.agent_idempotency enable row level security;

drop policy if exists "idempotency select own" on public.agent_idempotency;
create policy "idempotency select own"
  on public.agent_idempotency for select
  using (user_id = auth.uid());

-- Intentionally NO insert/update/delete policies. All writes go through
-- the service role from confirm-policy.

-- ── agent_audit_log ──────────────────────────────────────────────────

create table if not exists public.agent_audit_log (
  id             uuid        primary key default gen_random_uuid(),
  user_id        uuid        not null references auth.users(id) on delete cascade,
  skill          text        not null,
  category       text        not null check (category in ('READ','TRANSFER','CONFIG','POLICY')),
  affects_funds  boolean     not null,
  params         jsonb,                      -- sanitized in code before insert
  ok             boolean     not null,
  http_status    smallint    not null,
  error          text,
  duration_ms    integer,
  replayed       boolean     not null default false,
  created_at     timestamptz not null default now()
);

create index if not exists agent_audit_log_user_created_idx
  on public.agent_audit_log (user_id, created_at desc);

create index if not exists agent_audit_log_skill_idx
  on public.agent_audit_log (skill);

alter table public.agent_audit_log enable row level security;

drop policy if exists "audit select own" on public.agent_audit_log;
create policy "audit select own"
  on public.agent_audit_log for select
  using (user_id = auth.uid());

-- Same as idempotency: no user-side writes. Service role only.
