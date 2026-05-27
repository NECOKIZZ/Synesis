/**
 * Phase 0 — Step 1 of 3
 *
 * Generates a 32-byte entity secret used to secure the treasury wallet.
 * Run ONCE. Save the output to .env.local as CIRCLE_ENTITY_SECRET.
 * If you lose this secret, the treasury wallet is unrecoverable
 * (you will need the recovery file from step 2).
 *
 * Usage:
 *   node scripts/generate-secret.mjs
 */

import { randomBytes } from "node:crypto";

const entitySecret = randomBytes(32).toString("hex");

console.log("\n╔════════════════════════════════════════════════════════════════╗");
console.log("║  CIRCLE ENTITY SECRET GENERATED                                ║");
console.log("╚════════════════════════════════════════════════════════════════╝\n");
console.log("Copy this value into your .env.local file as CIRCLE_ENTITY_SECRET:\n");
console.log(`CIRCLE_ENTITY_SECRET=${entitySecret}\n`);
console.log("⚠️  This secret will NEVER be printed again.");
console.log("⚠️  If you lose it before running register-secret.mjs, generate a new one.");
console.log("⚠️  Once registered with Circle, losing it means losing the treasury wallet.\n");
