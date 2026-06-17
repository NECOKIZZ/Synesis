-- =====================================================================
-- DotArc — Cron Run Claims (double-execution / double-payment guard)
-- =====================================================================
-- Fixes KNOWN_ISSUES 3.1 (no row-level claim/lock) and 3.2 (no cron
-- idempotency). Before this, two concurrent cron invocations — or a Vercel
-- retry after a timeout — could BOTH execute the same due policy and pay
-- twice. There was no claim, no dedupe key.
--
-- Mechanism: each policy fire claims a slot keyed by (policy_id,
-- scheduled_for). For time triggers scheduled_for is the policy's next_run
-- (deterministic per cycle); for price/balance triggers it's the current
-- minute bucket. The claim is atomic inside claim_cron_run():
--   - fresh slot           → claimed (true)
--   - slot held & fresh    → refused (false)  [concurrent invocation / retry]
--   - slot held but STALE  → re-claimed (true) [previous holder crashed]
--
-- The stale window (passed by the caller, ~5 min) lets a policy recover if a
-- prior invocation was killed mid-execution without releasing its claim. The
-- cron route also DELETEs the claim on a transient/retryable failure so the
-- next tick can retry immediately rather than waiting out the stale window.
--
-- Only the service role touches this table (via claim_cron_run). RLS is on
-- with NO policies; the security-definer function runs as owner.
-- =====================================================================

create table if not exists public.cron_runs (
  id            uuid primary key default gen_random_uuid(),
  policy_id     uuid not null references public.agent_policies(id) on delete cascade,
  scheduled_for timestamptz not null,
  claimed_at    timestamptz not null default now(),
  constraint cron_runs_policy_slot_uniq unique (policy_id, scheduled_for)
);

-- Supports an optional periodic cleanup of old claim rows (not required for
-- correctness — slots are unique per cycle and never re-evaluated).
create index if not exists cron_runs_claimed_at_idx on public.cron_runs(claimed_at);

alter table public.cron_runs enable row level security;
-- Intentionally no policies: deny all direct access. Writes happen only via
-- claim_cron_run() (security definer, service role) and the route's delete.

-- ── Atomic claim ──────────────────────────────────────────────────────
-- Returns true if the caller now holds the slot, false if a live invocation
-- already holds it. A stale claim (older than p_stale_seconds) is taken over.
create or replace function public.claim_cron_run(
  p_policy_id     uuid,
  p_scheduled_for timestamptz,
  p_stale_seconds int
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed boolean := false;
begin
  insert into public.cron_runs (policy_id, scheduled_for, claimed_at)
  values (p_policy_id, p_scheduled_for, now())
  on conflict on constraint cron_runs_policy_slot_uniq do update
    set claimed_at = now()
    where public.cron_runs.claimed_at < now() - make_interval(secs => p_stale_seconds)
  returning true into v_claimed;

  -- On a non-stale conflict the DO UPDATE's WHERE is false, so no row is
  -- returned and v_claimed stays null → someone else holds a fresh claim.
  return coalesce(v_claimed, false);
end;
$$;

comment on table public.cron_runs is
  'Per-cycle policy run claims. Prevents concurrent cron invocations / retries from double-executing a policy. Claimed via claim_cron_run() (security definer).';
