/**
 * Skill: BRIDGE_USDC
 *
 * Bridge USDC from one chain to another via Circle App Kit (CCTP).
 * Uses the Circle Wallets adapter — no kit key needed for bridge.
 *
 * Trigger examples:
 *   "bridge 20 USDC from Arc to Base"
 *   "send 50 USDC to Polygon"
 *   "move 10 USDC from Arc Testnet to Ethereum Sepolia"
 *
 * Required params: { amount: number, toChain: string }
 * Optional params: { fromChain?: string, toAddress?: string }
 *
 * fromChain defaults to Arc_Testnet (where the agent wallet lives).
 * toAddress defaults to the user's main wallet address.
 */

import "server-only";
import { isAddress } from "ethers";
import { AppKit } from "@circle-fin/app-kit";
import { getCircleAdapter } from "@/lib/circleAdapter";
import { checkBalanceSufficient, checkSpendLimits, startOfDayUTC, startOfWeekUTC, startOfMonthUTC } from "@/lib/agent";
import { normalizeName } from "@/lib/ans";
import { normalizeBridgeChain, SUPPORTED_BRIDGE_CHAINS } from "./chains";
import type { SkillHandler, SkillContext, SkillOutput } from "./types";

type BridgeChain = Parameters<InstanceType<typeof AppKit>["bridge"]>[0]["from"]["chain"];
function asChain(s: string): BridgeChain { return s as BridgeChain; }

export const BridgeUsdc: SkillHandler = {
  category: "TRANSFER",
  version: 1,
  affectsFunds: true,
  // Burns USDC on the source chain; amount is in USDC → gate on balance.
  requiresBalanceCheck: true,
  // PIN required ONLY when bridging to a third party. If toAddress is
  // empty (defaults to the user's main wallet) or matches mainWalletAddress,
  // funds stay under the user's control and we skip the PIN dialog.
  requiresPin(params, { mainWalletAddress }) {
    const to = String(params.toAddress ?? "").trim().toLowerCase();
    if (!to) return false;
    return to !== mainWalletAddress.toLowerCase();
  },

  idempotencyKey(params): string | null {
    const amount    = Number(params.amount);
    const fromChain = String(params.fromChain ?? "Arc_Testnet");
    const toChain   = String(params.toChain   ?? "");
    const toAddress = String(params.toAddress ?? "");
    if (!toChain || !isFinite(amount) || amount <= 0) return null;
    return `BRIDGE_USDC:${fromChain}:${toChain}:${toAddress.toLowerCase()}:${amount.toFixed(6)}`;
  },

  async execute(ctx: SkillContext): Promise<SkillOutput> {
    const {
      supabase, serviceSupabase, supabaseUserId,
      agentWallet, mainWalletAddress, limits, params, getSpentSince,
    } = ctx;

    const rawAmount    = Number(params.amount);
    const fromChainRaw = String(params.fromChain ?? "Arc_Testnet");
    const toChainRaw   = String(params.toChain   ?? "").trim();
    const toAddress    = String(params.toAddress ?? mainWalletAddress).trim() || mainWalletAddress;

    if (!toChainRaw) {
      return { ok: false, error: "toChain is required (e.g. Base, Ethereum, Arbitrum)", status: 400 };
    }
    if (isNaN(rawAmount) || rawAmount <= 0) {
      return { ok: false, error: "amount must be a positive number", status: 400 };
    }
    if (toAddress.startsWith("0x") && !isAddress(toAddress)) {
      return { ok: false, error: "toAddress is not a valid EVM address", status: 400 };
    }

    // Normalize free-form chain names ("base", "Arbitrum") → the exact App Kit
    // Blockchain enum the SDK requires. Fail fast on anything unrecognised.
    const fromChain = normalizeBridgeChain(fromChainRaw);
    const toChain   = normalizeBridgeChain(toChainRaw);
    if (!fromChain || !toChain) {
      const bad = !toChain ? toChainRaw : fromChainRaw;
      return {
        ok: false,
        status: 400,
        error: `Unsupported chain "${bad}". Supported: ${SUPPORTED_BRIDGE_CHAINS.join(", ")}.`,
      };
    }
    if (fromChain === toChain) {
      return { ok: false, error: "fromChain and toChain must be different", status: 400 };
    }

    const amount = parseFloat(rawAmount.toFixed(6));

    // Arc's CCTP fast-transfer max fee is ~1.4 USDC and MUST be smaller than
    // the bridged amount, or the burn step reverts with
    // "Max fee must be less than amount". Reject sub-fee amounts up front so
    // the user gets a clear message instead of a cryptic on-chain revert.
    const arcMinBridge = Number(process.env.ARC_MIN_BRIDGE_USDC ?? "2");
    if (fromChain === "Arc_Testnet" && amount < arcMinBridge) {
      return {
        ok: false,
        status: 400,
        error: `Bridging from Arc needs at least ${arcMinBridge} USDC — the CCTP fast-transfer fee (~1.4 USDC) must be smaller than the amount. Try a larger amount.`,
      };
    }

    const balanceCheck = await checkBalanceSufficient(agentWallet.circle_wallet_id, amount);
    if (!balanceCheck.sufficient) {
      return { ok: false, error: balanceCheck.error, status: 400 };
    }

    // ── If bridging to a third party, enforce spend limits + audit ─────
    const isBridgeToThirdParty = toAddress.toLowerCase() !== mainWalletAddress.toLowerCase();
    if (isBridgeToThirdParty) {
      const [spentToday, spentThisWeek, spentThisMonth] = await Promise.all([
        getSpentSince(startOfDayUTC()),
        getSpentSince(startOfWeekUTC()),
        getSpentSince(startOfMonthUTC()),
      ]);
      const check = checkSpendLimits({
        amountUsdc: amount,
        limits,
        spentTodayUsdc:    spentToday,
        spentThisWeekUsdc: spentThisWeek,
        spentThisMonthUsdc: spentThisMonth,
      });
      if (!check.allowed) {
        return { ok: false, error: check.reason, status: 400 };
      }
    }

    // ── Log PENDING before touching Circle (bridge-to-third-party only) ──
    let logRowId: string | null = null;
    if (isBridgeToThirdParty) {
      const { data: logRow, error: logErr } = await supabase
        .from("agent_spend_log")
        .insert({
          user_id:           supabaseUserId,
          wallet_type:       "agent",
          skill:             "BRIDGE_USDC",
          recipient_address: toAddress,
          recipient_arc_name: String(params.toAddress ?? "").startsWith("0x")
            ? null
            : normalizeName(String(params.toAddress ?? "")),
          amount_usdc:       amount,
          status:            "PENDING",
        })
        .select("id")
        .single();
      if (logErr || !logRow?.id) {
        return {
          ok: false,
          error: "Something went wrong before we could process the bridge. No funds have moved.",
          status: 500,
        };
      }
      logRowId = logRow.id;
    }

    try {
      const kit     = new AppKit();
      const adapter = getCircleAdapter();

      // Custodial / forwarder mode: the agent has no signer on the destination
      // chain, so we OMIT the destination adapter and pass recipientAddress +
      // useForwarder. Circle's Orbit relayer fetches the attestation and
      // submits the mint. maxFee is pinned because Arc's default fast-transfer
      // fee floor can otherwise revert the burn ("Max fee must be less than
      // amount").
      let result = await kit.bridge({
        from: {
          adapter,
          chain: asChain(fromChain),
          address: agentWallet.circle_wallet_address,
        },
        to: {
          recipientAddress: toAddress,
          chain: asChain(toChain),
          useForwarder: true,
        },
        amount: amount.toFixed(6),
        config: {
          transferSpeed: "FAST",
          maxFee: process.env.BRIDGE_MAX_FEE ?? "1.50",
        },
      });

      // Soft errors (attestation timeout, RPC blip) are common on testnet and
      // recoverable. Retry once before giving up. Forwarder-only destination →
      // omit `to` in the retry context (Circle's relayer handles the mint).
      if (result.state === "error") {
        const firstErr = (result.steps as Array<{ state: string; error?: string }> | undefined)
          ?.find((s) => s.state === "error")?.error;
        console.warn("[bridge-usdc] soft error, retrying once:", firstErr);
        try {
          result = await kit.retryBridge(result, { from: adapter });
        } catch (retryErr) {
          console.warn("[bridge-usdc] retry threw:", retryErr instanceof Error ? retryErr.message : retryErr);
        }
      }

      const steps = (result.steps ?? []) as Array<{ name: string; state: string; txHash?: string; explorerUrl?: string; error?: string }>;
      const burnStep   = steps.find((s) => s.name === "burn");
      const mintStep   = steps.find((s) => s.name === "mint");
      const failedStep = steps.find((s) => s.state === "error");

      console.log("[bridge-usdc] state:", result.state, "burn:", burnStep?.txHash, "(forwarded)");

      // Success is keyed off result.state ONLY. Under the forwarder the mint is
      // submitted by Circle's relayer, so mintStep.txHash is undefined even on
      // a fully successful bridge — never gate success on it.
      if (result.state !== "success") {
        if (logRowId) {
          await serviceSupabase.from("agent_spend_log").update({ status: "FAILED", error_message: failedStep?.error ?? "unknown" }).eq("id", logRowId);
        }
        return {
          ok: false,
          error: `Bridge failed at step "${failedStep?.name ?? "unknown"}": ${failedStep?.error ?? "unknown error"}`,
          status: 502,
        };
      }

      if (logRowId) {
        await serviceSupabase.from("agent_spend_log").update({ status: "COMPLETE", tx_hash: burnStep?.txHash ?? null }).eq("id", logRowId);
      }

      return {
        ok: true,
        result: {
          amount:       result.amount,
          fromChain,
          toChain,
          toAddress,
          burnTxHash:   burnStep?.txHash   ?? null,
          mintTxHash:   mintStep?.txHash   ?? null,   // null under forwarder — expected
          explorerUrl:  burnStep?.explorerUrl ?? null,
          forwarded:    true,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Bridge failed";
      console.error("[bridge-usdc] error:", msg);
      if (logRowId) {
        await serviceSupabase.from("agent_spend_log").update({ status: "FAILED", error_message: msg }).eq("id", logRowId);
      }
      if (msg.includes("CCTP_ATTESTATION_TIMEOUT") || msg.includes("attestation")) {
        return { ok: false, error: "Bridge timed out waiting for attestation. The burn transaction may have gone through — check your wallet before retrying.", status: 504 };
      }
      if (msg.includes("INSUFFICIENT_BALANCE")) {
        return { ok: false, error: "Insufficient USDC balance on source chain.", status: 400 };
      }
      if (msg.includes("UNSUPPORTED_CHAIN") || msg.includes("unsupported")) {
        return { ok: false, error: `Chain not supported by CCTP: ${toChain}. Check docs.arc.io for the full chain list.`, status: 400 };
      }
      return { ok: false, error: `Bridge failed: ${msg}`, status: 502 };
    }
  },
};
