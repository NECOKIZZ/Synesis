/**
 * Skill: SWAP_USDC
 *
 * Swap one token for another on a single chain using Circle App Kit.
 * Routed through LiFi aggregator. Requires CIRCLE_KIT_KEY env var.
 *
 * Trigger examples:
 *   "swap 10 USDC to USDT"
 *   "convert 50 USDT to USDC on Arc"
 *   "exchange 5 USDC for WETH"
 *
 * Required params: { tokenIn: string, tokenOut: string, amount: number }
 * Optional params: { chain?: string }  (default: Arc_Testnet)
 */

import "server-only";
import { formatUnits } from "ethers";
import { AppKit } from "@circle-fin/app-kit";
import { getCircleAdapter } from "@/lib/circleAdapter";
import { readUsdcBalanceWei, circleDev, circleRead } from "@/lib/circle";
import type { SkillHandler, SkillContext, SkillOutput } from "./types";

type SwapChain = Parameters<InstanceType<typeof AppKit>["swap"]>[0]["from"]["chain"];
function asChain(s: string): SwapChain { return s as SwapChain; }

// Arc Testnet supports USDC, EURC, and cirBTC only.
// Other chains support a broader token set — extend this list if needed.
const SUPPORTED_TOKENS = ["USDC", "EURC", "cirBTC"] as const;

export const SwapUsdc: SkillHandler = {
  category: "TRANSFER",
  version: 1,
  affectsFunds: true,
  // No PIN: swap transforms tokens inside the agent wallet — nothing
  // moves to a third party.
  requiresPin: false,

  idempotencyKey(params): string | null {
    const tokenIn  = String(params.tokenIn  ?? "").toUpperCase().trim();
    const tokenOut = String(params.tokenOut ?? "").toUpperCase().trim();
    const amount   = Number(params.amount);
    if (!tokenIn || !tokenOut || !isFinite(amount) || amount <= 0) return null;
    return `SWAP_USDC:${tokenIn}:${tokenOut}:${amount.toFixed(6)}`;
  },

  async execute(ctx: SkillContext): Promise<SkillOutput> {
    const { agentWallet, params, serviceSupabase, supabaseUserId } = ctx;

    const tokenIn  = String(params.tokenIn  ?? "").toUpperCase().trim();
    const tokenOut = String(params.tokenOut ?? "").toUpperCase().trim();
    const rawAmount = Number(params.amount);
    const chain     = String(params.chain   ?? "Arc_Testnet");

    if (!tokenIn || !tokenOut) {
      return { ok: false, error: "tokenIn and tokenOut are required. On Arc Testnet: USDC, EURC, cirBTC", status: 400 };
    }
    if (!SUPPORTED_TOKENS.includes(tokenIn as typeof SUPPORTED_TOKENS[number])) {
      return { ok: false, error: `Unsupported tokenIn: ${tokenIn}. Arc Testnet supports: ${SUPPORTED_TOKENS.join(", ")}`, status: 400 };
    }
    if (!SUPPORTED_TOKENS.includes(tokenOut as typeof SUPPORTED_TOKENS[number])) {
      return { ok: false, error: `Unsupported tokenOut: ${tokenOut}. Arc Testnet supports: ${SUPPORTED_TOKENS.join(", ")}`, status: 400 };
    }
    if (tokenIn === tokenOut) {
      return { ok: false, error: "tokenIn and tokenOut must be different", status: 400 };
    }
    if (isNaN(rawAmount) || rawAmount <= 0) {
      return { ok: false, error: "amount must be a positive number", status: 400 };
    }

    const amount = parseFloat(rawAmount.toFixed(6));

    // ── Token-aware balance check ─────────────────────────────────────
    // Swap transforms value — it doesn't send to a third party — so spend
    // limits don't apply. We only need to confirm tokenIn is actually held.
    const TOKEN_INFO: Record<string, { address: string | null; decimals: number }> = {
      USDC:   { address: "0x3600000000000000000000000000000000000000", decimals: 6 },
      EURC:   { address: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a", decimals: 6 },
      CIRBTC: { address: null, decimals: 8 },
    };
    const tokenInInfo = TOKEN_INFO[tokenIn];
    let currentBalance: number;
    try {
      if (tokenInInfo?.address) {
        const raw = await readUsdcBalanceWei(agentWallet.circle_wallet_address, tokenInInfo.address);
        currentBalance = parseFloat(formatUnits(raw, tokenInInfo.decimals));
      } else {
        if (!circleDev) throw new Error("Circle client not configured");
        const res = await circleRead("getWalletTokenBalance(swap)", () =>
          circleDev!.getWalletTokenBalance({ id: agentWallet.circle_wallet_id }),
        );
        const balances = res.data?.tokenBalances ?? [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entry = balances.find((b: any) => (b.token?.symbol ?? "").toUpperCase() === tokenIn) as { amount?: string } | undefined;
        currentBalance = parseFloat(entry?.amount ?? "0");
      }
    } catch {
      return { ok: false, error: "Couldn't verify your token balance. Please try again.", status: 500 };
    }
    if (amount > currentBalance) {
      const decimals = tokenInInfo?.decimals === 8 ? 8 : 4;
      return {
        ok: false,
        error: `Not enough ${tokenIn}. Agent wallet has ${currentBalance.toFixed(decimals)} ${tokenIn}, swap needs ${amount}.`,
        status: 400,
      };
    }

    const kitKey = process.env.KIT_KEY;
    if (!kitKey) {
      return { ok: false, error: "KIT_KEY is not set — swap is not available. Add it from console.circle.com", status: 500 };
    }

    // Issue #25: Pre-insert a PENDING agent_spend_log row tagged with
    // skill='SWAP_USDC' BEFORE touching Circle. Without this, the Circle
    // webhook's claim-PENDING matcher finds nothing (because no row
    // exists yet) and falls through to the generic insert path which
    // hardcodes skill='AGENT_SEND'. By pre-inserting with the correct
    // skill name we either (a) finalize the row ourselves on success
    // below, or (b) let the webhook claim it by user_id + status=PENDING
    // — either way the row keeps its SWAP_USDC label.
    let logRowId: string | null = null;
    try {
      const { data: logRow, error: logErr } = await serviceSupabase
        .from("agent_spend_log")
        .insert({
          user_id:     supabaseUserId,
          wallet_type: "agent",
          skill:       "SWAP_USDC",
          // Swaps don't have a third-party recipient — store the agent's
          // own wallet so the row has a valid counterparty for the
          // activity feed, with metadata in description.
          recipient_address: agentWallet.circle_wallet_address,
          amount_usdc:       amount,
          status:            "PENDING",
        })
        .select("id")
        .single();
      if (logErr) {
        console.error("[swap-usdc] pending log insert failed:", logErr);
      } else if (logRow?.id) {
        logRowId = logRow.id as string;
      }
    } catch (logErr) {
      console.error("[swap-usdc] pending log threw:", logErr);
    }

    try {
      const kit     = new AppKit();
      const adapter = getCircleAdapter();

      const result = await kit.swap({
        from: {
          adapter,
          chain: asChain(chain),
          address: agentWallet.circle_wallet_address,
        },
        tokenIn,
        tokenOut,
        amountIn: amount.toFixed(6),
        config: {
          kitKey,
          slippageBps: 100,
        },
      });

      console.log("[swap-usdc] completed:", result.txHash, result.amountIn, "→", result.amountOut);

      // Finalize the row ourselves so we don't depend on a Circle webhook
      // arriving for the swap to show in the activity feed. The webhook,
      // if it does arrive, will idempotently update status + tx_hash.
      if (logRowId) {
        await serviceSupabase
          .from("agent_spend_log")
          .update({ status: "COMPLETE", tx_hash: result.txHash ?? null })
          .eq("id", logRowId);
      }

      return {
        ok: true,
        result: {
          txHash:     result.txHash     ?? null,
          explorerUrl: result.explorerUrl ?? null,
          amountIn:   result.amountIn,
          amountOut:  result.amountOut,
          tokenIn:    result.tokenIn,
          tokenOut:   result.tokenOut,
          chain:      result.chain,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Swap failed";
      console.error("[swap-usdc] error:", msg);
      if (logRowId) {
        await serviceSupabase
          .from("agent_spend_log")
          .update({ status: "FAILED", error_message: msg })
          .eq("id", logRowId);
      }
      if (msg.includes("Simulation failed") || msg.includes("Transaction reverted")) {
        return { ok: false, error: "Swap simulation failed: no liquidity for this pair on Arc Testnet, or price impact is too high. Try a smaller amount.", status: 502 };
      }
      if (msg.includes("SLIPPAGE_EXCEEDED") || msg.toLowerCase().includes("slippage")) {
        return { ok: false, error: "Swap failed: price moved too much. Try again or reduce the amount.", status: 502 };
      }
      if (msg.includes("KIT_KEY") || msg.includes("kit key") || msg.includes("Unauthorized")) {
        return { ok: false, error: "Swap failed: invalid Kit Key. Check KIT_KEY in your env.", status: 500 };
      }
      if (msg.includes("INSUFFICIENT_BALANCE")) {
        return { ok: false, error: "Insufficient balance in agent wallet.", status: 400 };
      }
      return { ok: false, error: `Swap failed: ${msg}`, status: 502 };
    }
  },
};
