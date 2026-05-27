/**
 * Phase 0 — Step 3 of 3
 *
 * Creates the dotarc treasury wallet on Arc Testnet.
 *  - One wallet set named "DotArc Treasury"
 *  - One EOA wallet inside it on ARC-TESTNET
 *
 * Run ONCE after register-secret.mjs.
 *
 * Prints CIRCLE_TREASURY_WALLET_SET_ID, CIRCLE_TREASURY_WALLET_ID,
 * and the on-chain address. Paste the IDs into .env.local. Fund the
 * address from https://faucet.circle.com.
 *
 * Usage:
 *   node --env-file=.env.local scripts/create-treasury.mjs
 */

import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const apiKey = process.env.CIRCLE_API_KEY;
const entitySecret = process.env.CIRCLE_ENTITY_SECRET;

if (!apiKey || !entitySecret) {
  console.error("❌ CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET must both be set in .env.local");
  process.exit(1);
}

const client = initiateDeveloperControlledWalletsClient({
  apiKey,
  entitySecret,
});

console.log("Creating treasury wallet set...\n");

let walletSetId;
try {
  const walletSetResponse = await client.createWalletSet({
    name: "DotArc Treasury",
  });
  walletSetId = walletSetResponse.data?.walletSet?.id;
  if (!walletSetId) throw new Error("No wallet set id returned");
  console.log(`✓ Wallet set created: ${walletSetId}`);
} catch (error) {
  console.error("❌ Failed to create wallet set:");
  console.error(error?.response?.data ?? error?.message ?? error);
  process.exit(1);
}

console.log("\nCreating treasury wallet on Arc Testnet (this may take ~10 seconds)...\n");

try {
  const walletsResponse = await client.createWallets({
    walletSetId,
    blockchains: ["ARC-TESTNET"],
    accountType: "EOA",
    count: 1,
    metadata: [{ name: "DotArc Treasury", refId: "treasury-001" }],
  });

  const wallet = walletsResponse.data?.wallets?.[0];
  if (!wallet) throw new Error("No wallet returned");

  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║  ✅ TREASURY WALLET CREATED                                    ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");
  console.log("Paste these into your .env.local file:\n");
  console.log(`CIRCLE_TREASURY_WALLET_SET_ID=${walletSetId}`);
  console.log(`CIRCLE_TREASURY_WALLET_ID=${wallet.id}\n`);
  console.log("Treasury on-chain address (public, safe to share):");
  console.log(`  ${wallet.address}\n`);
  console.log("Next steps:");
  console.log("  1. Paste the two IDs into .env.local");
  console.log("  2. Fund the treasury address with testnet USDC:");
  console.log("     → https://faucet.circle.com");
  console.log("     → choose Arc Testnet, paste the address above");
  console.log("     → request the maximum (each signup costs 5 USDC)");
  console.log("  3. Run: node --env-file=.env.local scripts/treasury-approve-usdc.mjs");
  console.log(`  4. Verify the balance at:`);
  console.log(`     → https://testnet.arcscan.app/address/${wallet.address}\n`);
} catch (error) {
  console.error("❌ Failed to create treasury wallet:");
  console.error(error?.response?.data ?? error?.message ?? error);
  console.error("\nIf the error mentions 'ARC-TESTNET' is not supported,");
  console.error("contact Circle support to enable Arc Testnet on your account.");
  process.exit(1);
}
