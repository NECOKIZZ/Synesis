-- =====================================================================
-- DotArc — Agent invite gate
-- =====================================================================
-- Adds an `agent_enabled` flag to profiles. Smart Agent features
-- (OpenRouter LLM calls, agent wallet creation, policy execution) are
-- expensive to run, so we gate them to manually invited users until
-- product-market fit is established.
--
-- To grant access: in the Supabase dashboard SQL editor, run:
--   update public.profiles set agent_enabled = true where email = '...';
-- =====================================================================

alter table public.profiles
  add column if not exists agent_enabled boolean not null default false;

-- Index for the gate lookup. Tiny table so this is mostly cosmetic, but
-- keeps the gate check sub-millisecond at scale.
create index if not exists profiles_agent_enabled_idx
  on public.profiles(agent_enabled)
  where agent_enabled = true;
