-- =====================================================================
-- DotArc — V3 Task Model (multi-intent + composite triggers)
-- =====================================================================
-- The agent is moving from a single-action-per-policy model to a model
-- where each policy can describe ONE TASK with N steps. The trigger
-- shape also gains a composite "and" type so a policy can fire on
-- e.g. (Tuesday AND balance > 70).
--
-- Schema changes:
--
--   1. Add `steps jsonb null` to `agent_policies`. Populated for compound
--      policies (length >= 2). For simple policies it stays NULL and the
--      cron continues to use action_skill + action_params (unchanged).
--      For compound policies, action_skill is set to the literal string
--      'COMPOUND' as a sentinel and action_params is `{}` — the actual
--      step payload lives in `steps`. The cron checks `steps IS NOT NULL`
--      first and dispatches to executePlan() in that case.
--
--   2. Latent V2 bug — In V2, lib/skills/create-policy.ts already wrote
--      compound policies with action_skill = 'COMPOUND' but the cron has
--      no skill named 'COMPOUND' in its registry, so on first fire it
--      called `deactivate(reason='Unknown action skill: COMPOUND')`.
--      Any compound policy ever stored was secretly broken. We
--      defensively set them inactive here so they don't suddenly start
--      firing under V3 with their old (untrusted) parameters.
--
-- No HMAC version bump is needed. The orchestration HMAC v2 already
-- JSON-stringifies a record of the canonical fields; adding an optional
-- `steps` key inside `action_params` (V2 behaviour) or alongside it (V3)
-- both produce stable, verifiable hashes. New V3 rows use a fresh hash
-- computed at insert time over the new shape — there's nothing to
-- backfill on the HMAC side.
--
-- "and" composite triggers — stored as:
--   trigger_type   = 'and'
--   trigger_params = { conditions: [<sub-trigger>, <sub-trigger>, ...] }
-- Each sub-trigger is one of the existing primitives (time / price /
-- balance_above). The cron loads `trigger_params.conditions` and ANDs
-- the per-condition evaluators. No schema change needed for this — the
-- text column already accepts arbitrary values, and `trigger_params` is
-- jsonb. We just document the convention here for future readers.
-- =====================================================================

-- ── 1. Add steps column ──────────────────────────────────────────────
alter table public.agent_policies
  add column if not exists steps jsonb;

comment on column public.agent_policies.steps is
  'V3: jsonb array of PlanStep ({skill, params, description}) for compound policies. NULL for simple single-action policies (use action_skill + action_params). When set, action_skill is the sentinel ''COMPOUND''.';

comment on column public.agent_policies.trigger_type is
  'One of: time | price | balance_above | and | now (legacy: never stored — "now" tasks execute immediately and never become policies). For "and" composite triggers, trigger_params.conditions holds the sub-trigger array.';

comment on column public.agent_policies.trigger_params is
  'Per-trigger payload. time: { frequency, day_of_week?, day_of_month?, last_day_of_month? }. price: { asset, direction, threshold }. balance_above: { threshold_usdc }. and: { conditions: [<sub-trigger>, ...] }.';

-- ── 2. Deactivate orphaned V2 compound policies ──────────────────────
-- These never executed correctly under V2's cron (no 'COMPOUND' handler
-- in skillRegistry). Any row in this state is either a) a new row from
-- V2 that hasn't ticked yet — guaranteed to break on first tick, or
-- b) a row that already broke and got auto-deactivated. Either way,
-- preserving them across the V3 cutover is dangerous: their
-- action_params shape doesn't match the new executor's expectations.
-- We mark them inactive with a clear reason so users can reconstruct
-- them under V3 if they want.
update public.agent_policies
   set active       = false,
       pause_reason = coalesce(pause_reason, 'Pre-V3 compound policy invalidated during task model upgrade')
 where action_skill = 'COMPOUND'
   and active        = true
   and steps         is null;  -- belt-and-braces: a row with new-style steps shouldn't be touched

-- ── 3. Index hint for cron filtering by trigger_type ─────────────────
-- The cron loads policies ordered by next_run; for "and" composite
-- triggers we may want a secondary scan across all active policies
-- regardless of next_run (when a non-time sub-trigger like balance_above
-- can fire mid-day). Keep this lightweight — small table, no need to
-- be aggressive yet.
create index if not exists agent_policies_trigger_type_active_idx
  on public.agent_policies(trigger_type, active)
  where active = true;
