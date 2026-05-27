/**
 * Phase 0 — Utility
 *
 * Prints the treasury wallet's USDC and native gas balance on Arc Testnet.
 * Run anytime to check if the treasury needs topping up.
 *
 * Usage:
 *   node --env-file=.env.local scripts/treasury-balance.mjs
 */

import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const {
  CIRCLE_API_KEY: apiKey,
  CIRCLE_ENTITY_SECRET: entitySecret,
  CIRCLE_TREASURY_WALLET_ID: walletId,
} = process.env;

if (!apiKey || !entitySecret || !walletId) {
  console.error("❌ CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_TREASURY_WALLET_ID must all be set");
  process.exit(1);
}

const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

try {
  const walletResponse = await client.getWallet({ id: walletId });
  const wallet = walletResponse.data?.wallet;

  const balancesResponse = await client.getWalletTokenBalance({ id: walletId });
  const balances = balancesResponse.data?.tokenBalances ?? [];

  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║  TREASURY WALLET STATUS                                        ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");
  console.log(`Address:  ${wallet?.address}`);
  console.log(`Network:  ${wallet?.blockchain}`);
  console.log(`State:    ${wallet?.state}\n`);

  if (balances.length === 0) {
    console.log("⚠️  No token balances. Treasury is empty.");
    console.log("    Fund at https://faucet.circle.com (choose Arc Testnet)\n");
  } else {
    console.log("Balances:");
    for (const b of balances) {
      const symbol = b.token?.symbol ?? "???";
      const amount = b.amount ?? "0";
      console.log(`  ${symbol.padEnd(8)} ${amount}`);
    }
    console.log();
  }
} catch (error) {
  console.error("❌ Failed to read treasury wallet:");
  console.error(error?.response?.data ?? error?.message ?? error);
  process.exit(1);
}
