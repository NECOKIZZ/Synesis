-- Migration 0005: add recipient_arc_name to agent_spend_log
--
-- Stores the pre-resolution .arc label (e.g. "bob", not "bob.arc") so the
-- activity log can display the human-readable name without an on-chain
-- reverse-lookup RPC call on every status page load.
--
-- Nullable — plain-address sends have no name to store.

ALTER TABLE agent_spend_log
  ADD COLUMN IF NOT EXISTS recipient_arc_name text;
