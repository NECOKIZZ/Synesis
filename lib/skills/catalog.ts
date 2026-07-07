/**
 * lib/skills/catalog.ts — structured skill descriptions for the V3.5 router.
 *
 * Source of truth for what the LLM sees about each skill. The seed script
 * (scripts/seed-skill-embeddings.ts) embeds these descriptions; the router
 * picks top-K by cosine; the prompt builder renders only the selected
 * subset.
 *
 * Why a structured registry (vs. parsing the prompt prose)
 *   - Seed script needs one description per skill; parsing template
 *     literals is fragile.
 *   - Lets the router return entries by name and the prompt builder
 *     render them deterministically.
 *   - Keeps the description text close to (or identical to) the V3 prose
 *     so SKILL_ROUTER_ENABLED=true → false → true round-trips cleanly.
 *
 * V3 fallback contract
 *   When SKILL_ROUTER_ENABLED=false the prompt builder uses its existing
 *   hardcoded prose block instead of rendering from this file. Both must
 *   stay in sync; the rendered output of `renderSkillCatalog(ALL_ENTRIES)`
 *   should be ≈ byte-identical to the hardcoded block. See the V3.5
 *   memory doc §6 for the routing contract.
 */

import "server-only";
import type { SkillName } from "@/lib/agent-types";
import type { SkillCategory } from "@/lib/skills/types";

export type SkillCatalogEntry = {
  skill_name: SkillName;
  description: string;
  category: SkillCategory;
  affects_funds: boolean;
};

// ── Entries ────────────────────────────────────────────────────────────
// One per registered leaf skill. Order mirrors the V3 prose block so a
// full-render (router off OR every skill selected) reads identically to
// the historical prompt.

export const SKILL_CATALOG: SkillCatalogEntry[] = [
  {
    skill_name: "SEND_USDC",
    category: "TRANSFER",
    affects_funds: true,
    description:
      "SEND_USDC — Send USDC to a recipient\n" +
      "  params: { recipient: string, amount: number }",
  },
  {
    skill_name: "CHECK_BALANCE",
    category: "READ",
    affects_funds: false,
    description:
      "CHECK_BALANCE — Look up balance and recent activity\n" +
      "  params: {}",
  },
  {
    skill_name: "GET_PRICE",
    category: "READ",
    affects_funds: false,
    description:
      "GET_PRICE — Look up the current live USD price of an asset\n" +
      "  params: { symbol: \"BTC\"|\"ETH\"|\"cirBTC\"|\"USDC\"|\"EURC\" }\n" +
      "  Use for any \"what's the price of X\" / \"how much is X right now\" question.\n" +
      "  trigger is always \"now\". The system calls a live oracle — never answer\n" +
      "  price questions from memory.",
  },
  {
    skill_name: "SET_LIMIT",
    category: "CONFIG",
    affects_funds: false,
    description:
      "SET_LIMIT — Update a spending limit\n" +
      "  params: { type: \"per_transaction\"|\"daily\"|\"monthly\", amount: number }",
  },
  {
    skill_name: "CANCEL_POLICY",
    category: "POLICY",
    affects_funds: false,
    description:
      "CANCEL_POLICY — Cancel an active policy\n" +
      "  params: { policy_ids: string[] } OR { cancel_all: true } OR { description: string }\n" +
      "  Match policies against the Active Policies list above before returning ids.",
  },
  {
    skill_name: "LIST_POLICIES",
    category: "READ",
    affects_funds: false,
    description:
      "LIST_POLICIES — Show active policies\n" +
      "  params: { include_paused?: boolean }",
  },
  {
    skill_name: "RETRIEVE_TRANSACTIONS",
    category: "READ",
    affects_funds: false,
    description:
      "RETRIEVE_TRANSACTIONS — Look up the agent wallet's recent transaction history\n" +
      "  params: {\n" +
      "    since?:      \"yesterday\" | \"last_week\" | \"last_month\" | ISO date,\n" +
      "    until?:      ISO date,\n" +
      "    token?:      \"USDC\" | \"EURC\" | \"cirBTC\" | \"BTC\",\n" +
      "    recipient?:  string,             // .arc name or 0x address\n" +
      "    direction?:  \"in\" | \"out\" | \"both\",   // default \"both\"\n" +
      "    limit?:      number              // default 20, max 50\n" +
      "  }\n" +
      "  Trigger is always \"now\". Use this — not CHECK_BALANCE — when the user\n" +
      "  asks about PAST activity (\"what did I send last week\", \"how much have I\n" +
      "  tipped sara\", \"show my recent transactions\", \"how much came in\"). The\n" +
      "  skill returns a row list AND an aggregate ({count, total_in_usdc,\n" +
      "  total_out_usdc, largest_in_usdc, largest_out_usdc, by_token}) so you can\n" +
      "  answer totals, counts, AND superlatives (\"the largest/biggest amount\")\n" +
      "  precisely. Pick the narrowest filter set you can from their message:\n" +
      "    \"what did I send last week\"        → { since: \"last_week\", direction: \"out\" }\n" +
      "    \"how much BTC came in last week\"   → { since: \"last_week\", token: \"cirBTC\", direction: \"in\" }\n" +
      "    \"how much have I tipped sara\"      → { recipient: \"sara.arc\", direction: \"out\" }\n" +
      "    \"largest amount I sent to sara\"    → { recipient: \"sara.arc\", direction: \"out\" }\n" +
      "    \"show my last 5 transactions\"      → { limit: 5 }\n" +
      "  Do not invent filters the user didn't imply.",
  },
  {
    skill_name: "WITHDRAW",
    category: "TRANSFER",
    affects_funds: true,
    description:
      "WITHDRAW — Move USDC from agent wallet back to main wallet\n" +
      "  params: { amount: number | \"all\" }",
  },
  {
    skill_name: "SEND_TOKEN",
    category: "TRANSFER",
    affects_funds: true,
    description:
      "SEND_TOKEN — Send EURC or cirBTC\n" +
      "  params: { token: \"EURC\"|\"cirBTC\", recipient: string, amount: number }",
  },
  {
    skill_name: "SWAP_USDC",
    category: "TRANSFER",
    affects_funds: true,
    description:
      "SWAP_USDC — Swap one token for another (USDC, EURC, cirBTC only)\n" +
      "  params: { tokenIn: string, tokenOut: string, amount: number, chain?: string }",
  },
  {
    skill_name: "BRIDGE_USDC",
    category: "TRANSFER",
    affects_funds: true,
    description:
      "BRIDGE_USDC — Bridge USDC from Arc to another chain via CCTP\n" +
      "  params: { amount: number, toChain: string, fromChain?: string, toAddress?: string }\n" +
      "  toChain must be one of: Base, Ethereum, Arbitrum, Avalanche, Optimism, Polygon\n" +
      "  (testnet targets resolve automatically). Minimum 2 USDC when bridging from\n" +
      "  Arc (the CCTP fee floor). toAddress defaults to the user's own wallet.",
  },
  {
    skill_name: "SEND_SOLANA_USDC",
    category: "TRANSFER",
    affects_funds: true,
    description:
      "SEND_SOLANA_USDC — Send USDC to a recipient on Solana (devnet)\n" +
      "  params: { recipient: string, amount: number }\n" +
      "  Use ONLY when the user explicitly says Solana / SOL. recipient is a\n" +
      "  Solana base58 address (not a .arc name or 0x address). For ordinary\n" +
      "  USDC sends on Arc use SEND_USDC, never this.",
  },
  {
    skill_name: "PAY_X402",
    category: "TRANSFER",
    affects_funds: true,
    description:
      "PAY_X402 — Pay an x402-enabled API\n" +
      "  params: { url: string, method?: \"GET\"|\"POST\", data?: object, maxAmountUsdc?: number }\n" +
      "  maxAmountUsdc defaults to 1.0 USDC.",
  },
  {
    skill_name: "IKNOW",
    category: "READ",
    affects_funds: false,
    description:
      "IKNOW — Find a prediction market matching the user's belief\n" +
      "  params: { belief: string }\n" +
      "  When the user expresses knowledge, certainty, or an opinion about a future\n" +
      "  event (sports, politics, crypto, etc.) using phrases like \"I know\", \"I think\",\n" +
      "  \"I believe\", or similar confidence indicators, call IKNOW with their exact\n" +
      "  statement as the belief. Do NOT paraphrase — pass the raw user text.\n" +
      "  The oracle extracts intent, searches Polymarket, and returns the best match.\n" +
      "  If success=true and a market is found, present the market title, yes/no odds,\n" +
      "  and a link so the user can bet on their conviction. Be playful:\n" +
      "  \"You can make money off that opinion — check out this market.\"\n" +
      "  If success=false with suggestions, list them and ask the user to pick one.\n" +
      "  If broad_summary, show the options and ask the user to narrow down.",
  },
];

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Render a list of skill entries into the catalog block format the V3
 * prompt expects. Used by:
 *   - The skill router (when SKILL_ROUTER_ENABLED=true): renders only the
 *     entries returned from pgvector.
 *   - The seed script: renders one description per row for embedding.
 *
 * Joined with a blank line between entries — same shape as the V3 prose.
 */
export function renderSkillCatalog(entries: SkillCatalogEntry[]): string {
  return entries.map((e) => e.description).join("\n\n");
}

/**
 * Return the catalog filtered by the current process's env flags. Mirrors
 * the registry gating in lib/skills/index.ts so the LLM never sees a skill
 * the executor can't dispatch.
 *
 * Today only RETRIEVE_TRANSACTIONS is flag-gated; pattern generalises.
 */
export function getActiveCatalog(): SkillCatalogEntry[] {
  const retrieveOn = process.env.RETRIEVE_TRANSACTIONS_ENABLED === "true";
  const solanaOn = process.env.SOLANA_ENABLED === "true";
  return SKILL_CATALOG.filter((e) => {
    if (e.skill_name === "RETRIEVE_TRANSACTIONS") return retrieveOn;
    if (e.skill_name === "SEND_SOLANA_USDC") return solanaOn;
    return true;
  });
}

/** Look up a catalog entry by skill name. Returns undefined when missing. */
export function findSkillEntry(name: string): SkillCatalogEntry | undefined {
  return SKILL_CATALOG.find((e) => e.skill_name === name);
}
