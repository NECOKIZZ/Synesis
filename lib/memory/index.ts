/**
 * Synesis / Synesis Agent Memory — barrel.
 *
 * The memory stack after consolidation:
 *   - Hard facts / statistics  → typed Supabase tables (agent_contact_mem,
 *     and future per-domain stat tables). See ./contact-mem.
 *   - Intent-gated injection    → ./memory-injector (skill → bucket).
 *   - Learned & explicit memory → MemWal (semantic episodic store). See
 *     ./walrus-adapter. There is NO Supabase "notes" table anymore — the
 *     old user_memory layer was redundant with MemWal and was removed.
 *
 * Walrus lives behind its own adapter (./walrus-adapter) and is imported
 * directly where needed, not re-exported here, to keep the optional-SDK
 * isolation boundary explicit.
 */

import "server-only";

// Contact memory (typed aggregate, migration 0015): the deterministic
// post-skill updater + the Tier-1 always-inject contact digest.
export {
  recordContactInteraction,
  recallTopContacts,
} from "./contact-mem";
export type { ContactInteraction, ContactDirection } from "./contact-mem";

// Intent-gated injector: maps router-selected skills → memory buckets so we
// only inject memory the user's current intent actually needs.
export { selectIntentMemory } from "./memory-injector";
export type { IntentMemory, MemoryBucket } from "./memory-injector";

// User profile (migration 0018): the durable always-on personalization card.
export { getProfileCard, upsertProfileCard, PROFILE_CARD_MAX_CHARS } from "./user-profile";
