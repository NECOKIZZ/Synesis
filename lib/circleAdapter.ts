/**
 * lib/circleAdapter.ts — shared Circle Wallets adapter factory.
 *
 * Server-side only. Never import this in frontend/client code.
 * Both SWAP_USDC and BRIDGE_USDC skills use this adapter.
 */

import "server-only";
import { createCircleWalletsAdapter } from "@circle-fin/adapter-circle-wallets";

export function getCircleAdapter() {
  const apiKey       = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;

  if (!apiKey || !entitySecret) {
    throw new Error("CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET must be set");
  }

  return createCircleWalletsAdapter({ apiKey, entitySecret });
}
