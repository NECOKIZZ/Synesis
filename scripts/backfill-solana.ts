/**
 * scripts/backfill-solana.ts — provision a Solana (SOL-DEVNET) agent wallet for
 * EVERY existing user who already has an EVM (ARC-TESTNET) agent wallet but no
 * Solana one yet. Idempotent: users who already have a SOL-DEVNET row are skipped.
 *
 * This is the "existing users" half of Solana activation. New users are handled
 * automatically inside POST /api/agent/activate (when SOLANA_ENABLED=true).
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/backfill-solana.ts            # DRY RUN (lists who would be provisioned)
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/backfill-solana.ts --yes      # actually creates + persists wallets
 *
 * After it runs, each printed base58 address must be funded with devnet SOL
 * (>= 0.005, for fees) + devnet USDC before that agent can send on Solana.
 *
 * Env required: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and the
 * Circle vars the app uses (CIRCLE_AGENT_WALLET_SET_ID, entity secret, etc.).
 */

import "./_env"; // MUST be first — loads .env.local before lib/* reads env
import { createClient } from "@supabase/supabase-js";
import { PublicKey } from "@solana/web3.js";

function serviceSupabaseOrNull() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function main(): Promise<void> {
  const apply = process.argv.slice(2).includes("--yes");

  const supabase = serviceSupabaseOrNull();
  if (!supabase) {
    console.error(
      "✗ Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — cannot run backfill."
    );
    process.exit(1);
  }

  // Every user that HAS an EVM agent wallet (the prerequisite for Solana).
  const { data: evmWallets, error: evmErr } = await supabase
    .from("agent_wallets")
    .select("user_id")
    .eq("blockchain", "ARC-TESTNET");
  if (evmErr) {
    console.error("✗ Failed to read EVM agent wallets:", evmErr.message);
    process.exit(1);
  }

  // Users that ALREADY have a Solana wallet (skip these).
  const { data: solWallets, error: solErr } = await supabase
    .from("agent_wallets")
    .select("user_id")
    .eq("blockchain", "SOL-DEVNET");
  if (solErr) {
    console.error("✗ Failed to read Solana agent wallets:", solErr.message);
    process.exit(1);
  }

  const alreadyHasSol = new Set((solWallets ?? []).map((w) => w.user_id as string));
  const targets = Array.from(
    new Set((evmWallets ?? []).map((w) => w.user_id as string))
  ).filter((uid) => !alreadyHasSol.has(uid));

  console.log(`EVM-wallet users:     ${new Set((evmWallets ?? []).map((w) => w.user_id)).size}`);
  console.log(`Already have Solana:  ${alreadyHasSol.size}`);
  console.log(`To provision:         ${targets.length}`);
  if (!apply) {
    console.log("\n(DRY RUN) Re-run with --yes to create + persist these wallets:");
    targets.forEach((uid) => console.log(`  - ${uid}`));
    return;
  }

  // Lazy import — only the real run needs Circle wallet creation.
  const { createAgentWalletInCircle } = await import("../lib/agent");

  let ok = 0;
  let failed = 0;
  for (const userId of targets) {
    try {
      const { walletId, address } = await createAgentWalletInCircle("SOL-DEVNET");
      // Validate it's a real base58 Solana pubkey (throws on an EVM 0x address).
      // eslint-disable-next-line no-new
      new PublicKey(address);
      const { error } = await supabase.from("agent_wallets").insert({
        user_id: userId,
        blockchain: "SOL-DEVNET",
        circle_wallet_id: walletId,
        circle_wallet_address: address,
      });
      if (error) throw new Error(error.message);
      ok++;
      console.log(`  ✓ ${userId} → ${address}   (fund with devnet SOL + USDC)`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${userId}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`\nDone. Provisioned ${ok}, failed ${failed}.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("✗ Backfill failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
