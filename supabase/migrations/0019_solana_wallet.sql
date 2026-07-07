-- =====================================================================
-- DotArc / Synesis — Solana wallet support (multi-chain agent wallets)
-- =====================================================================
-- The agent has always held exactly one Circle wallet, on ARC-TESTNET, so
-- agent_wallets enforced UNIQUE(user_id). Solana is a SEPARATE base58 wallet
-- (not derivable from the EVM address), so a user now needs a second row.
--
-- This migration is purely additive + backward-compatible: every existing
-- row backfills to blockchain='ARC-TESTNET' and the per-user uniqueness moves
-- to (user_id, blockchain) so each user can hold one EVM + one Solana wallet.
--
-- See SOLANA_INTEGRATION_PLAN.md §3.
-- =====================================================================

-- ── agent_wallets: add blockchain, re-key uniqueness ──────────────────
alter table public.agent_wallets
  add column if not exists blockchain text not null default 'ARC-TESTNET';

comment on column public.agent_wallets.blockchain is
  'Circle blockchain identifier for this wallet (ARC-TESTNET | SOL-DEVNET | …). '
  'A user holds at most one wallet per blockchain.';

-- Move uniqueness from (user_id) → (user_id, blockchain).
alter table public.agent_wallets
  drop constraint if exists agent_wallets_one_per_user;

alter table public.agent_wallets
  add constraint agent_wallets_one_per_user_chain unique (user_id, blockchain);

-- ── agent_spend_log: tag which chain each row moved value on ───────────
alter table public.agent_spend_log
  add column if not exists blockchain text not null default 'ARC-TESTNET';

comment on column public.agent_spend_log.blockchain is
  'Chain this spend executed on (ARC-TESTNET | SOL-DEVNET | …). Default '
  'ARC-TESTNET for backward compat; Solana skills stamp SOL-DEVNET.';

-- =====================================================================
-- Verification:
--   select user_id, blockchain, circle_wallet_address from agent_wallets
--     order by user_id;
--   -- a user with Solana activated shows two rows: ARC-TESTNET + SOL-DEVNET
-- =====================================================================
