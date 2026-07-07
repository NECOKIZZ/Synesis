-- =====================================================================
-- DotArc / Synesis — User Profile (durable always-on personalization)
-- =====================================================================
-- The always-injected personalization core: ONE curated card per user
-- capturing communication style + standing preferences. This is the layer
-- that MemWal's semantic recall cannot guarantee — a durable fact like
-- "terse, wants execution not explanation" must be present on EVERY turn,
-- but it won't semantically match "send 5 to bob", so it needs an always-on
-- home, injected right after the identity line.
--
-- WHERE THIS SITS
--   - profiles.arc_name        → identity (who) — always injected (Track 3)
--   - user_profile.profile_card → THIS: durable style + standing prefs —
--                                  always injected
--   - agent_contact_mem        → relationship stats — intent-gated
--   - MemWal                   → episodic learned facts — semantic recall
--
-- CURATED, NOT APPENDED
--   One row per user, UPDATED in place. The session-end job merges new
--   durable facts into the existing card (dedupe, drop stale) so it sharpens
--   over time instead of growing — the discipline that keeps an agent's
--   memory high-signal. Never written by an interpret call; only by the
--   session-end merge (service role).
--
-- Reversibility: purely additive.
-- =====================================================================

create table if not exists public.user_profile (
  user_id      uuid primary key references public.profiles(id) on delete cascade,
  profile_card text not null default '',
  updated_at   timestamptz not null default now()
);

-- ── RLS: read own; writes are service-role only (session-end merge) ─────
alter table public.user_profile enable row level security;

drop policy if exists "users read own profile" on public.user_profile;
create policy "users read own profile"
  on public.user_profile for select
  using (auth.uid() = user_id);
-- No insert/update policy → only the service role (session-end) writes.

comment on table public.user_profile is
  'Durable always-on personalization. One curated card per user (communication style + standing preferences), merged in place by the session-end job and injected on every interpret call after the identity line.';

-- =====================================================================
-- Verification:
--   select user_id, length(profile_card), updated_at from user_profile;
-- =====================================================================
