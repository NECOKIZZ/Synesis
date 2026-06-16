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
};

export type {
  SkillHandler,
  SkillContext,
  SkillOutput,
  AgentPolicy,
  SkillCategory,
} from "./types";
