/**
 * Phase 0 — Bonus Step
 *
 * Approves the ANS Registry to spend USDC from the treasury wallet (max amount).
 * Run ONCE after funding the treasury. Without this, every name registration
 * would need two Circle transactions (approve + register) instead of one.
 *
 * Uses Circle's createContractExecutionTransaction — no private key needed.
 *
 * Usage:
 *   node --env-file=.env.local scripts/treasury-approve-usdc.mjs
 */

import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { Interface, MaxUint256 } from "ethers";

const {
  CIRCLE_API_KEY: apiKey,
  CIRCLE_ENTITY_SECRET: entitySecret,
  CIRCLE_TREASURY_WALLET_ID: walletId,
  NEXT_PUBLIC_USDC_TOKEN_ADDRESS: usdcAddress,
  NEXT_PUBLIC_ANS_REGISTRY_ADDRESS: registryAddress,
} = process.env;

const required = { apiKey, entitySecret, walletId, usdcAddress, registryAddress };
for (const [k, v] of Object.entries(required)) {
  if (!v) {
    console.error(`❌ Missing env var: ${k}`);
    process.exit(1);
  }
}

const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

const usdcInterface = new Interface([
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const callData = usdcInterface.encodeFunctionData("approve", [
  registryAddress,
  MaxUint256,
]);

console.log("Submitting USDC approval to Circle...");
console.log(`  Treasury wallet: ${walletId}`);
console.log(`  USDC contract:   ${usdcAddress}`);
console.log(`  Spender:         ${registryAddress}`);
console.log(`  Amount:          MaxUint256 (unlimited)\n`);

let txId;
try {
  const response = await client.createContractExecutionTransaction({
    walletId,
    contractAddress: usdcAddress,
    callData,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });

  txId = response.data?.id;
  if (!txId) throw new Error("No transaction id returned");
  console.log(`✓ Transaction queued: ${txId}`);
  console.log("\nPolling for completion (up to 60 seconds)...");
} catch (error) {
  console.error("❌ Failed to submit approval:");
  console.error(error?.response?.data ?? error?.message ?? error);
  process.exit(1);
}

const POLL_INTERVAL_MS = 3000;
const MAX_ATTEMPTS = 20;
let lastState = "";

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

  try {
    const txResponse = await client.getTransaction({ id: txId });
    const tx = txResponse.data?.transaction;
    const state = tx?.state ?? "UNKNOWN";

    if (state !== lastState) {
      console.log(`  [${attempt}/${MAX_ATTEMPTS}] state: ${state}`);
      lastState = state;
    }

    if (state === "COMPLETE" || state === "CONFIRMED") {
      console.log("\n╔════════════════════════════════════════════════════════════════╗");
      console.log("║  ✅ USDC APPROVAL COMPLETE                                     ║");
      console.log("╚════════════════════════════════════════════════════════════════╝\n");
      console.log(`On-chain tx hash: ${tx.txHash}`);
      console.log(`Explorer:         https://testnet.arcscan.app/tx/${tx.txHash}\n`);
      console.log("The treasury can now register names without per-tx approval.");
      console.log("Phase 0 is complete. You can move on to Phase 1.\n");
      process.exit(0);
    }

    if (state === "FAILED" || state === "CANCELLED" || state === "DENIED") {
      console.error(`\n❌ Transaction ${state.toLowerCase()}.`);
      if (tx?.errorReason) console.error(`Reason: ${tx.errorReason}`);
      console.error("\nCommon causes:");
      console.error("  - Treasury has no USDC for gas (Arc charges gas in USDC)");
      console.error("  - Fund the treasury at https://faucet.circle.com");
      process.exit(1);
    }
  } catch (error) {
    console.error(`  [${attempt}] poll error: ${error?.message ?? error}`);
  }
}

console.error("\n⏱  Timed out waiting for confirmation.");
console.error(`Check status manually: tx id = ${txId}`);
process.exit(1);
