/**
 * Skill: SEND_TOKEN
 *
 * Send any supported Arc Testnet token (USDC, EURC) from the agent wallet
 * to a recipient. Uses kit.send() from App Kit — handles any ERC-20 by
 * contract address or alias, replacing the manual USDC-only transfer path.
 *
 * Trigger examples:
 *   "send 5 EURC to sara.arc"
 *   "transfer 10 EURC to 0x848f…"
 *   "pay maya.arc 2 EURC"
 *   "send USDC 20 to john.arc"        ← USDC routes here too
 *
 * Required params: { token: string, recipient: string, amount: number }
 *
 * Arc Testnet token registry (from docs.arc.io/arc/references/contract-addresses):
 *   USDC  0x3600000000000000000000000000000000000000  (native stablecoin)
 *   EURC  0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a  (Circle euro stablecoin)
 */

import "server-only";
import { isAddress, formatUnits } from "ethers";
import { AppKit } from "@circle-fin/app-kit";
import { getCircleAdapter } from "@/lib/circleAdapter";
import { readUsdcBalanceWei, circleDev, circleRead } from "@/lib/circle";
import { resolveRecipient, normalizeName } from "@/lib/ans";
import {
  checkSpendLimits,
  startOfDayUTC,
  startOfWeekUTC,
  startOfMonthUTC,
  executeAgentSendToken,
} from "@/lib/agent";
import type { SkillHandler, SkillContext, SkillOutput } from "./types";

// ── Arc Testnet token registry ───────────────────────────────────────
// Aliases: USDC, EURC, USDT, USDe, DAI, PYUSD, cirBTC, NATIVE
// Source: docs.arc.io/app-kit/references/supported-blockchains-and-tokens

type TokenInfo = {
  address: string | null;  // null = alias-only token (cirBTC) — App Kit knows it internally
  alias: string;           // App Kit alias — always prefer alias in kit.send()
  decimals: number;
  usdRate: number;         // approximate USD rate for spend-limit accounting
};

const ARC_TOKENS: Record<string, TokenInfo> = {
  USDC: {
    address: "0x3600000000000000000000000000000000000000",
    alias:   "USDC",
    decimals: 6,
    usdRate: 1.0,
  },
  EURC: {
    address: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
    alias:   "EURC",
    decimals: 6,
    usdRate: 1.08,   // ~1 EUR ≈ $1.08 USD
  },
  CIRBTC: {
    address: null,   // contract address not in public docs; alias works
    alias:   "cirBTC",
    decimals: 8,     // Bitcoin denominated
    usdRate: 100000, // ~$100k USD/BTC — conservative for spend-limit accounting
  },
};

type SwapChain = Parameters<InstanceType<typeof AppKit>["send"]>[0]["from"]["chain"];
function asChain(s: string): SwapChain { return s as SwapChain; }

export const SendToken: SkillHandler = {
  category: "TRANSFER",
  version: 1,
  affectsFunds: true,

  idempotencyKey(params): string | null {
    const token     = String(params.token     ?? "").toUpperCase().trim();
    const recipient = String(params.recipient ?? "").toLowerCase().trim();
    const amount    = Number(params.amount);
    if (!token || !recipient || !isFinite(amount) || amount <= 0) return null;
    return `SEND_TOKEN:${token}:${recipient}:${amount.toFixed(6)}`;
  },

  async execute(ctx: SkillContext): Promise<SkillOutput> {
    const {
      supabase, serviceSupabase, supabaseUserId,
      agentWallet, limits, params, getSpentSince,
    } = ctx;

    const tokenSymbolRaw = String(params.token ?? "").trim();
    // Normalize to registry key: "cirBTC" / "cirbtc" / "CIRBTC" → "CIRBTC", others uppercase
    const tokenSymbol = tokenSymbolRaw.replace(/^cirbtc$/i, "CIRBTC").toUpperCase();
    const recipient   = String(params.recipient ?? "").trim();
    const rawAmount   = Number(params.amount);
    const chain       = String(params.chain ?? "Arc_Testnet");

    // ── Validate inputs ───────────────────────────────────────────────
    const tokenInfo = ARC_TOKENS[tokenSymbol];
    if (!tokenInfo) {
      return {
        ok: false,
        error: `Unsupported token: ${tokenSymbol}. Supported on Arc Testnet: ${Object.keys(ARC_TOKENS).join(", ")}`,
        status: 400,
      };
    }
    if (!recipient) {
      return { ok: false, error: "recipient is required (.arc name or 0x address)", status: 400 };
    }
    if (isNaN(rawAmount) || rawAmount <= 0) {
      return { ok: false, error: "amount must be a positive number", status: 400 };
    }

    const amount = parseFloat(rawAmount.toFixed(6));

    // ── Balance check ─────────────────────────────────────────────────
    // Tokens with known contract addresses → query on-chain via ethers
    // Alias-only tokens (cirBTC) → query via Circle API getWalletTokenBalance
    let currentBalance: number;
    try {
      if (tokenInfo.address) {
        const raw = await readUsdcBalanceWei(agentWallet.circle_wallet_address, tokenInfo.address);
        currentBalance = parseFloat(formatUnits(raw, tokenInfo.decimals));
      } else {
        // Circle API returns all token balances including alias-only tokens
        if (!circleDev) throw new Error("Circle client not configured");
        const res = await circleRead("getWalletTokenBalance(send-token)", () =>
          circleDev!.getWalletTokenBalance({ id: agentWallet.circle_wallet_id }),
        );
        const balances = res.data?.tokenBalances ?? [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entry = balances.find((b: any) =>
          (b.token?.symbol ?? "").toUpperCase() === tokenSymbol ||
          (b.token?.symbol ?? "").toLowerCase() === tokenInfo.alias.toLowerCase()
        ) as { amount?: string } | undefined;
        currentBalance = parseFloat(entry?.amount ?? "0");
      }
    } catch {
      return { ok: false, error: "Couldn't check your token balance right now. Please try again.", status: 500 };
    }

    if (amount > currentBalance) {
      return {
        ok: false,
        error: `Not enough ${tokenInfo.alias}. Agent wallet has ${currentBalance.toFixed(4)} ${tokenInfo.alias}, transfer needs ${amount}.`,
        status: 400,
      };
    }

    // ── Resolve recipient (ANS → 0x address) ─────────────────────────
    let recipientAddress: string;
    try {
      recipientAddress = await resolveRecipient(recipient);
    } catch (err) {
      const msg = err instanceof Error ? err.message : `Could not resolve: ${recipient}`;
      return { ok: false, error: msg, status: 400 };
    }

    if (!isAddress(recipientAddress)) {
      return { ok: false, error: "Resolved recipient address failed isAddress() check", status: 400 };
    }
    if (recipientAddress.toLowerCase() === agentWallet.circle_wallet_address.toLowerCase()) {
      return { ok: false, error: "Cannot send to own agent wallet", status: 400 };
    }

    // ── Spend limits (in USDC-equivalent terms) ───────────────────────
    const amountUsd = amount * tokenInfo.usdRate;
    const [spentToday, spentThisWeek, spentThisMonth] = await Promise.all([
      getSpentSince(startOfDayUTC()),
      getSpentSince(startOfWeekUTC()),
      getSpentSince(startOfMonthUTC()),
    ]);

    const check = checkSpendLimits({
      amountUsdc: amountUsd,
      limits,
      spentTodayUsdc:    spentToday,
      spentThisWeekUsdc: spentThisWeek,
      spentThisMonthUsdc: spentThisMonth,
    });
    if (!check.allowed) {
      return { ok: false, error: check.reason, status: 400 };
    }

    // ── Log PENDING before touching Circle ───────────────────────────
    const { data: logRow, error: logErr } = await supabase
      .from("agent_spend_log")
      .insert({
        user_id:            supabaseUserId,
        wallet_type:        "agent",
        skill:              "SEND_TOKEN",
        recipient_address:  recipientAddress,
        recipient_arc_name: recipient.startsWith("0x") ? null : normalizeName(recipient),
        amount_usdc:        amountUsd,   // USDC-equivalent for limit accounting
        status:             "PENDING",
      })
      .select("id")
      .single();

    if (logErr || !logRow?.id) {
      console.error("[send-token] PENDING log insert failed:", logErr);
      return {
        ok: false,
        error: "Something went wrong before we could process your transfer. No tokens have moved. Please try again.",
        status: 500,
      };
    }

    // ── Execute: Circle contract execution for known-address tokens, App Kit for alias-only
    let txHash: string;
    try {
      if (tokenInfo.address) {
        // EURC, USDC — use Circle createContractExecutionTransaction (ERC-20 transfer).
        // App Kit kit.send() does not support EURC on Arc Testnet.
        const result = await executeAgentSendToken({
          agentWalletId:    agentWallet.circle_wallet_id,
          recipientAddress,
          amountDecimal:    amount.toFixed(6),
          tokenAddress:     tokenInfo.address,
          decimals:         tokenInfo.decimals,
        });
        txHash = result.txHash;
      } else {
        // cirBTC — alias-only token, App Kit resolves it internally
        const kit     = new AppKit();
        const adapter = getCircleAdapter();
        const result  = await kit.send({
          from: { adapter, chain: asChain(chain), address: agentWallet.circle_wallet_address },
          to:     recipientAddress,
          amount: amount.toFixed(8),
          token:  tokenInfo.alias,
        });
        if (result.state !== "success") {
          throw new Error(result.errorMessage ?? `Send ended in state: ${result.state}`);
        }
        txHash = result.txHash!;
      }
      console.log("[send-token]", tokenSymbol, amount, "→", recipientAddress, "txHash:", txHash);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Token send failed";
      await serviceSupabase
        .from("agent_spend_log")
        .update({ status: "FAILED", error_message: msg })
        .eq("id", logRow.id);

      console.error("[send-token] error:", msg);
      return { ok: false, error: mapSendError(msg, tokenSymbol), status: 502 };
    }

    // ── Mark COMPLETE ─────────────────────────────────────────────────
    await serviceSupabase
      .from("agent_spend_log")
      .update({ status: "COMPLETE", tx_hash: txHash })
      .eq("id", logRow.id);

    return {
      ok: true,
      result: {
        txHash,
        recipientAddress,
        amount,
        token: tokenSymbol,
        explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
      },
    };
  },
};

function mapSendError(raw: string, token: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("insufficient") || lower.includes("balance")) {
    return `Your agent wallet doesn't have enough ${token} to complete this transfer.`;
  }
  if (lower.includes("timeout") || lower.includes("etimedout")) {
    return "The transfer timed out. No tokens have left your wallet. Please try again.";
  }
  return "The transfer didn't go through. No tokens have left your wallet. You can try again.";
}
