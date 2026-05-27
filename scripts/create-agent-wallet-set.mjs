/**
 * Creates the "DotArc Agent Wallets" wallet set in Circle.
 * Run ONCE — prints CIRCLE_AGENT_WALLET_SET_ID, paste it into .env.local.
 *
 * Usage:
 *   node --env-file=.env.local scripts/create-agent-wallet-set.mjs
 */

import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const apiKey = process.env.CIRCLE_API_KEY;
const entitySecret = process.env.CIRCLE_ENTITY_SECRET;

if (!apiKey || !entitySecret) {
  console.error("❌ CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET must both be set in .env.local");
  process.exit(1);
}

const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

try {
  const res = await client.createWalletSet({ name: "DotArc Agent Wallets" });
  const id = res.data?.walletSet?.id;
  if (!id) throw new Error("No wallet set ID returned");

  console.log("\n✅ Agent wallet set created!\n");
  console.log("Paste this into your .env.local:\n");
  console.log(`CIRCLE_AGENT_WALLET_SET_ID=${id}\n`);
} catch (err) {
  console.error("❌ Failed:", err?.response?.data ?? err?.message ?? err);
  process.exit(1);
}
