/**
 * check-skill-sync.ts — enforce the skill single-source-of-truth invariant.
 *
 * WHY THIS EXISTS: skill identity used to be re-listed in several independent
 * places that drifted (root cause D1 in fixplan.md). The worst instance was
 * F-14 — GET_PRICE was registered + in the catalog but missing from the
 * validator's hand-written VALID_LEAF_SKILLS, so every price task was rejected
 * post-LLM. VALID_LEAF_SKILLS is now DERIVED from the catalog, so those two can
 * no longer disagree. This script guards the remaining pair — the dispatch
 * registry vs. the LLM catalog — so a skill can't be registered without being
 * offered to the model (dead skill) or offered without being dispatchable.
 *
 * Run:  npm run check:skills
 * Exit: 0 = in sync, 1 = drift (prints the mismatch).
 *
 * The invariant, accounting for flag-gating (both the registry and
 * getActiveCatalog() read the same env at load, so they gate identically):
 *
 *     Object.keys(skillRegistry)  ==  catalog leaf skills  ∪  ENGINE_ONLY
 */
import "./_env"; // MUST be first — loads .env.local before lib/* reads env
import { skillRegistry } from "../lib/skills";
import { getActiveCatalog } from "../lib/skills/catalog";

// Skills that are dispatchable (in the registry) but intentionally NOT offered
// to the LLM as leaf skills — the engine synthesizes them (a non-"now" trigger
// becomes a CREATE_POLICY at dispatch; the model never emits it directly).
const ENGINE_ONLY = new Set<string>(["CREATE_POLICY"]);

const registryKeys = new Set<string>(Object.keys(skillRegistry));
// Widen to Set<string> so membership checks against registry keys (plain
// strings from Object.keys) don't trip TS2345 — we compare names, not types.
const catalogNames = new Set<string>(getActiveCatalog().map((e) => e.skill_name));

const errors: string[] = [];

// 1. Every catalog skill must be dispatchable — else the model is told it can
//    use a skill that has no handler (would fail at confirm).
for (const name of catalogNames) {
  if (!registryKeys.has(name)) {
    errors.push(`Catalog offers "${name}" but it is NOT in skillRegistry (LLM could emit an undispatchable skill).`);
  }
}

// 2. Every registered skill must be either offered to the LLM or engine-only —
//    else it is a dead skill the model is never told about.
for (const name of registryKeys) {
  if (!catalogNames.has(name) && !ENGINE_ONLY.has(name)) {
    errors.push(`skillRegistry has "${name}" but it is NOT in the catalog and not ENGINE_ONLY (dead skill — add a catalog entry or mark it engine-only).`);
  }
}

if (errors.length > 0) {
  console.error("✗ Skill sync check FAILED:\n");
  for (const e of errors) console.error("  - " + e);
  console.error(`\n  registry: ${[...registryKeys].sort().join(", ")}`);
  console.error(`  catalog:  ${[...catalogNames].sort().join(", ")}`);
  console.error(`  engine-only: ${[...ENGINE_ONLY].join(", ")}`);
  process.exit(1);
}

console.log(
  `✓ Skill sync OK — ${catalogNames.size} catalog leaf skills, ${registryKeys.size} registered ` +
    `(engine-only: ${[...ENGINE_ONLY].join(", ")}).`,
);
console.log("  VALID_LEAF_SKILLS derives from getActiveCatalog(), so validator↔catalog cannot drift.");
