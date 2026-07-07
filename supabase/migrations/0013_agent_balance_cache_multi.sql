-- =====================================================================
-- DotArc — Multi-token balance cache (V3.5, Track 1)
-- =====================================================================
-- Extends the existing balance cache on agent_wallets to hold ALL token
-- balances (USDC, EURC, cirBTC, ...) as a single jsonb blob.
--
-- Why
--   The V3 interpret route hits Circle live on every agent call via
--   getAgentAllBalances() because the existing balance_cache_usdc column
--   only stores USDC. That live call is the dominant latency cost in the
--   pre-LLM path. With a multi-token cache (webhook-maintained), interpret
--   becomes a fast DB read.
--
-- What this migration adds
--   1. agent_wallets.balance_cache (jsonb)
--      Shape: { "USDC": "47.500000", "EURC": "12.000000", "cirBTC": "0" }
--      Token symbol → decimal string (Circle's native amount string).
--      Stored verbatim from getAgentAllBalances() so callers can format
--      however they like.
--
--   2. (Reuses the existing agent_wallets.balance_cache_at timestamp —
--       no new column needed. The Circle webhook already updates that
--       column whenever it refreshes the USDC cache, and the V3.5 patch
--       will piggyback on the same code path to also update jsonb.)
--
-- What stays unchanged
--   - balance_cache_usdc (the existing text column) keeps being written
--     by the webhook. Other call sites (check-balance, agent status,
--     confirm-policy preflight) already read it. We do NOT touch them in
--     V3.5; backward compatibility is preserved.
--
-- Trust model
--   This cache is for the LLM's first-filter judgment (prompt injection).
--   It is eventually consistent — webhook delivery can lag the chain by
--   seconds. Spend-time gates MUST still consult Circle live; do not
--   replace deterministic balance checks with this cache.
--
-- Reversibility
--   Purely additive. Rolling back V3.5 leaves this column unused and the
--   rest of the system unaffected.
-- =====================================================================

alter table public.agent_wallets
  add column if not exists balance_cache jsonb not null default '{}'::jsonb;

comment on column public.agent_wallets.balance_cache is
  'V3.5 multi-token balance cache. Webhook-maintained. Shape: {"USDC":"47.5","EURC":"12","cirBTC":"0"}. Eventually consistent — never the final spend gate. The balance_cache_at column (existing) records freshness.';

-- =====================================================================
-- Verification (paste into SQL editor after running):
--
--   select column_name, data_type
--     from information_schema.columns
--     where table_name = 'agent_wallets'
--     and column_name in ('balance_cache', 'balance_cache_at', 'balance_cache_usdc');
--
--   -- Expect three rows: balance_cache (jsonb), balance_cache_at
--   -- (timestamp with time zone), balance_cache_usdc (text).
-- =====================================================================
