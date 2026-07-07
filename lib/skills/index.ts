/**
 * lib/skills/index.ts — Skill registry
 *
 * Maps every SkillName to its handler.
 * To add a skill: create the file, implement SkillHandler, add it here.
 * Nothing else needs to change.
 */

import "server-only";
import type { SkillHandler } from "./types";
import { CheckBalance }      from "./check-balance";
import { SendUsdc }          from "./send-usdc";
import { CreatePolicy }      from "./create-policy";
import { ListPolicies }      from "./list-policies";
import { SetLimit }          from "./set-limit";
import { CancelPolicy }      from "./cancel-policy";
import { Withdraw }          from "./withdraw";
import { SwapUsdc }          from "./swap-usdc";
import { BridgeUsdc }        from "./bridge-usdc";
import { PayX402 }           from "./pay-x402";
import { SendToken }         from "./send-token";
import { GetPrice }          from "./get-price";
import { IKnow }             from "./iknow";
import { RetrieveTransactions } from "./retrieve-transactions";
import { SendSolanaUsdc }    from "./send-solana-usdc";

// V3.5 Track 2 — RETRIEVE_TRANSACTIONS is opt-in via env flag. Reading at
// module load means flipping the flag requires a process restart, which is
// the desired behaviour: the validator's VALID_LEAF_SKILLS set and this
// registry must agree, so the catalog the LLM sees and the registry it
// resolves against stay in lock-step within a single boot.
const RETRIEVE_TX_ENABLED = process.env.RETRIEVE_TRANSACTIONS_ENABLED === "true";

// Solana skills are opt-in via SOLANA_ENABLED (same restart-to-flip contract as
// RETRIEVE_TRANSACTIONS: registry + VALID_LEAF_SKILLS + LLM catalog stay in
// lock-step within a single boot). Off by default — additive.
const SOLANA_ENABLED = process.env.SOLANA_ENABLED === "true";

export const skillRegistry: Record<string, SkillHandler> = {
  CHECK_BALANCE:      CheckBalance,
  SEND_USDC:          SendUsdc,
  CREATE_POLICY:      CreatePolicy,
  LIST_POLICIES:      ListPolicies,
  SET_LIMIT:          SetLimit,
  CANCEL_POLICY:      CancelPolicy,
  WITHDRAW:           Withdraw,
  SWAP_USDC:          SwapUsdc,
  BRIDGE_USDC:        BridgeUsdc,
  PAY_X402:           PayX402,
  SEND_TOKEN:         SendToken,
  GET_PRICE:          GetPrice,
  IKNOW:              IKnow,
  ...(RETRIEVE_TX_ENABLED ? { RETRIEVE_TRANSACTIONS: RetrieveTransactions } : {}),
  ...(SOLANA_ENABLED ? { SEND_SOLANA_USDC: SendSolanaUsdc } : {}),
};

export type {
  SkillHandler,
  SkillContext,
  SkillOutput,
  AgentPolicy,
  SkillCategory,
} from "./types";
