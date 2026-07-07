-- =====================================================================
-- DotArc / Synesis — Drop user_memory (consolidate learned memory to MemWal)
-- =====================================================================
-- user_memory (migration 0010) became redundant. Its history:
--   - The auto-derived habit kinds (contact / spending_pattern / token_pref)
--     were retired into the typed agent_contact_mem aggregate (0015).
--   - The only remaining kind, "note" (explicit "remember this"), is
--     unstructured, semantic-recall, user-stated text — i.e. exactly what
--     MemWal exists for. It now lives in MemWal as a dated [note] fact.
--
-- So nothing in the app writes or reads user_memory anymore (the interpret
-- route's remember/introspection/recall paths all route to MemWal). This
-- migration removes the now-dead table + its RPC.
--
-- NOTE ON ADDITIVITY: the project's migrations are normally additive-only.
-- This DROP is a deliberate, one-time cleanup performed pre-launch (zero
-- users, zero data) to avoid carrying a dead table. It is safe precisely
-- because there is no data to lose.
-- =====================================================================

drop function if exists public.record_user_memory(uuid, text, text, jsonb);
drop table if exists public.user_memory;

-- =====================================================================
-- Verification:
--   select to_regclass('public.user_memory');          -- expect NULL
--   select proname from pg_proc where proname = 'record_user_memory';  -- expect 0 rows
-- =====================================================================
