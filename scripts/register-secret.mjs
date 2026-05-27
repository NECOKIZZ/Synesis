/**
 * Phase 0 — Step 2 of 3
 *
 * Registers your CIRCLE_ENTITY_SECRET ciphertext with Circle.
 * Run ONCE after generate-secret.mjs and after pasting the secret into .env.local.
 *
 * Prints a recovery file. SAVE IT OFFLINE (encrypted USB, password manager,
 * printed paper). It is the ONLY way to recover the treasury wallet if
 * CIRCLE_ENTITY_SECRET is ever lost.
 *
 * Usage:
 *   node --env-file=.env.local scripts/register-secret.mjs
 */

import { registerEntitySecretCiphertext } from "@circle-fin/developer-controlled-wallets";

const apiKey = process.env.CIRCLE_API_KEY;
const entitySecret = process.env.CIRCLE_ENTITY_SECRET;

if (!apiKey) {
  console.error("❌ CIRCLE_API_KEY is not set in .env.local");
  process.exit(1);
}
if (!entitySecret) {
  console.error("❌ CIRCLE_ENTITY_SECRET is not set in .env.local");
  console.error("   Run generate-secret.mjs first and paste the value into .env.local");
  process.exit(1);
}
if (entitySecret.length !== 64) {
  console.error("❌ CIRCLE_ENTITY_SECRET must be 64 hex characters (32 bytes)");
  console.error(`   Yours is ${entitySecret.length} characters.`);
  process.exit(1);
}

console.log("Registering entity secret with Circle...\n");

try {
  const result = await registerEntitySecretCiphertext({
    apiKey,
    entitySecret,
  });

  const recoveryFile = result.data?.recoveryFile;

  if (!recoveryFile) {
    console.error("❌ Circle returned no recovery file. Response:");
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║  ✅ ENTITY SECRET REGISTERED — SAVE THE RECOVERY FILE BELOW    ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");
  console.log("───── BEGIN RECOVERY FILE ─────");
  console.log(recoveryFile);
  console.log("───── END RECOVERY FILE ─────\n");
  console.log("⚠️  Save the content between BEGIN/END to a file named");
  console.log("    'circle-recovery-file.dat' and store it OFFLINE.");
  console.log("⚠️  Without it, losing CIRCLE_ENTITY_SECRET means losing the treasury.");
  console.log("⚠️  Do NOT commit this file. Do NOT email it to yourself unencrypted.\n");
} catch (error) {
  console.error("❌ Registration failed:");
  if (error?.response?.data) {
    console.error(JSON.stringify(error.response.data, null, 2));
  } else {
    console.error(error?.message ?? error);
  }
  console.error("\nCommon causes:");
  console.error("  - CIRCLE_API_KEY is invalid or revoked");
  console.error("  - Entity secret was already registered (Circle allows only one per account)");
  console.error("  - Network unreachable");
  process.exit(1);
}
