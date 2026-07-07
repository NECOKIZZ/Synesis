/**
 * Env loader for standalone scripts (seed, one-off tools).
 *
 * Imported as a SIDE EFFECT and FIRST, before any lib/* module, so process.env
 * is populated before modules that read env at load time (e.g. lib/embeddings).
 * Loads .env.local first (where Next.js keeps real local secrets), then .env as
 * a fallback — mirroring Next's resolution order so scripts see the same vars
 * the app does.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config(); // .env fallback (does not override already-set vars)
