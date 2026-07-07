-- =====================================================================
-- DotArc / Synesis — Multi-token precision on the spend log
-- =====================================================================
-- agent_spend_log historically tracked USDC only (amount_usdc). As real
-- EURC / cirBTC sends arrive, we need to know WHICH token each row moved so
-- contact memory can value non-USDC transfers correctly (e.g. a 10 EURC
-- send is ~$10.80, not $10).
--
-- The send skills (lib/skills/send-usdc.ts, send-token.ts) write this column
-- when they insert the PENDING row. The Circle webhook reads it off the
-- claimed row when bumping agent_contact_mem on confirmation, so the
-- aggregate's by_token bucket + USD rollup stay accurate per token.
--
-- Default 'USDC': every existing row (and any caller that doesn't set it)
-- is USDC, matching the table's history. Purely additive.
-- =====================================================================

alter table public.agent_spend_log
  add column if not exists token_symbol text not null default 'USDC';

comment on column public.agent_spend_log.token_symbol is
  'Token moved by this row (USDC | EURC | cirBTC | …). Default USDC. Read by the Circle webhook to value non-USDC transfers into agent_contact_mem.';

-- =====================================================================
-- Verification:
--   select skill, token_symbol, count(*) from agent_spend_log
--     group by skill, token_symbol order by skill;
-- =====================================================================
