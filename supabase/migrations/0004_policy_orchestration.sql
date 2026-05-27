-- =====================================================================
-- DotArc — Policy Orchestration Schema
-- =====================================================================
-- Adds the three-part policy model (trigger + action + stop conditions)
-- to agent_policies, and backfills existing RECURRING_PAYMENT rows.
--
-- New columns:
--   trigger_type, trigger_params, action_skill, action_params,
--   execution_mode, cooldown_seconds, stop_conditions,
--   execution_count, total_spent_usdc, last_executed_at,
--   policy_summary, policy_category
--
-- Backfill: existing rows where skill = 'RECURRING_PAYMENT' are migrated
--   trigger_type   = 'time'
--   trigger_params = { frequency }
--   action_skill   = 'SEND_USDC'
--   action_params  = { recipient, amount }
--   execution_mode = 'repeat'
--   stop_conditions = []
-- =====================================================================

-- ── 1. Add new orchestration columns ────────────────────────────────

alter table public.agent_policies
  add column if not exists trigger_type    text,
  add column if not exists trigger_params  jsonb not null default '{}',
  add column if not exists action_skill    text,
  add column if not exists action_params   jsonb not null default '{}',
  add column if not exists execution_mode  text,
  add column if not exists cooldown_seconds int  default 3600,
  add column if not exists stop_conditions  jsonb not null default '[]',
  add column if not exists execution_count  int  default 0,
  add column if not exists total_spent_usdc numeric(20,6) default 0,
  add column if not exists last_executed_at timestamptz,
  add column if not exists policy_summary   text,
  add column if not exists policy_category  text,
  add column if not exists hmac_version     int  default 1;

-- ── 2. Backfill existing RECURRING_PAYMENT rows ─────────────────────

update public.agent_policies
set
  trigger_type   = 'time',
  trigger_params  = jsonb_build_object('frequency', frequency),
  action_skill    = 'SEND_USDC',
  action_params   = jsonb_build_object(
    'recipient', coalesce(recipient_arc_name, recipient_address),
    'amount', amount_usdc
  ),
  execution_mode  = 'repeat',
  stop_conditions = '[]'::jsonb,
  policy_summary  = 'Recurring payment: ' ||
    coalesce(recipient_arc_name, recipient_address) ||
    ' — ' || amount_usdc || ' USDC ' ||
    coalesce(frequency, ''),
  policy_category = 'recurring'
where skill = 'RECURRING_PAYMENT'
  and trigger_type is null;

-- ── 3. Backfill any remaining rows that still lack trigger_type ─────
-- (defensive — should be zero rows if the above covered everything)

update public.agent_policies
set
  trigger_type   = 'time',
  trigger_params  = '{}',
  action_skill    = skill,
  action_params   = params,
  execution_mode  = 'once',
  stop_conditions = '[]'::jsonb,
  policy_summary  = skill || ' policy',
  policy_category = 'other'
where trigger_type is null;

-- ── 4. Add NOT NULL constraints now that everything is backfilled ───

alter table public.agent_policies
  alter column trigger_type   set not null,
  alter column action_skill   set not null,
  alter column execution_mode set not null;

-- ── 5. Indices for cron runner queries ──────────────────────────────

-- Cron loads: active policies where next_run <= now()
-- with trigger_type filter for efficient scheduling

create index if not exists agent_policies_cron_idx
  on public.agent_policies(next_run, trigger_type, active)
  where active = true and next_run is not null;

-- ── 6. Policy summary index for LLM context lookups ────────────────

create index if not exists agent_policies_summary_idx
  on public.agent_policies(user_id, active, policy_summary)
  where active = true;

-- ── 7. Comment for future developers ───────────────────────────────

comment on column public.agent_policies.skill is
  'DEPRECATED: legacy skill name. Use action_skill + trigger_type instead.';

comment on column public.agent_policies.params is
  'DEPRECATED: legacy params blob. Use action_params + trigger_params instead.';

comment on column public.agent_policies.frequency is
  'DEPRECATED: use trigger_params->>frequency instead.';

comment on column public.agent_policies.recipient_arc_name is
  'DEPRECATED: use action_params->>recipient instead.';

comment on column public.agent_policies.recipient_address is
  'DEPRECATED: use action_params->>recipient or resolve at execution time.';
