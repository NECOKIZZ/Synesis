/**
 * Skill: PAY_X402
 *
 * Access an x402-enabled HTTP API endpoint using USDC micropayments.
 *
 * Flow:
 *   1. Fetch the URL — if 200 (free), return the response immediately.
 *   2. If 402, parse X-Payment-Options to get recipient, amount, network.
 *   3. Execute USDC transfer from the agent wallet to the payment address.
 *   4. Retry the request with X-Payment header containing the payment proof.
 *   5. Return the API response to the user.
 *
 * Trigger examples:
 *   "check the BTC price from the Arc price oracle"
 *   "call https://api.example.arc/data and pay for it"
 *   "access https://oracle.dotarc.app/rate (max $0.01)"
 *
 * Required params: { url: string }
 * Optional params: { method?: "GET"|"POST", data?: object, maxAmountUsdc?: number }
 */

import "server-only";
import { isAddress } from "ethers";
import { executeAgentSendUsdc, checkBalanceSufficient } from "@/lib/agent";
import type { SkillHandler, SkillContext, SkillOutput } from "./types";

const DEFAULT_MAX_USDC = 1.0;  // refuse to pay more than $1 without explicit override

type PaymentOption = {
  scheme: string;
  network: string;
  asset: string;
  maxAmountRequired: string;
  payTo: string;
};

function parsePaymentOptions(header: string): PaymentOption[] {
  try {
    const parsed = JSON.parse(header);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function isUsdcOption(opt: PaymentOption): boolean {
  const asset = String(opt.asset ?? "").toUpperCase();
  return (
    asset === "USDC" ||
    asset.startsWith("0x") ||
    opt.scheme === "exact"
  );
}

export const PayX402: SkillHandler = {
  category: "TRANSFER",
  version: 1,
  affectsFunds: true,

  idempotencyKey(params): string | null {
    const url = String(params.url ?? "").trim();
    if (!url) return null;
    return `PAY_X402:${url}:${Date.now()}`;
  },

  async execute(ctx: SkillContext): Promise<SkillOutput> {
    const { agentWallet, params } = ctx;

    const url           = String(params.url    ?? "").trim();
    const method        = String(params.method ?? "GET").toUpperCase();
    const maxAmountUsdc = Number(params.maxAmountUsdc ?? DEFAULT_MAX_USDC);
    const data          = params.data as Record<string, unknown> | undefined;

    if (!url) {
      return { ok: false, error: "url is required", status: 400 };
    }
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return { ok: false, error: "url must start with http:// or https://", status: 400 };
    }
    if (isNaN(maxAmountUsdc) || maxAmountUsdc <= 0 || maxAmountUsdc > 100) {
      return { ok: false, error: "maxAmountUsdc must be between 0 and 100", status: 400 };
    }

    const fetchOptions: RequestInit = {
      method,
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      ...(data && method !== "GET" ? { body: JSON.stringify(data) } : {}),
    };

    // ── Step 1: Initial fetch ──────────────────────────────────────────
    let response: Response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (err) {
      return { ok: false, error: `Network error reaching ${url}: ${err instanceof Error ? err.message : String(err)}`, status: 502 };
    }

    if (response.status !== 402) {
      const text = await response.text();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      return {
        ok: response.ok,
        ...(response.ok
          ? { result: { status: response.status, data: parsed, paid: false } }
          : { error: `API returned ${response.status}: ${text.slice(0, 200)}`, status: response.status }),
      } as SkillOutput;
    }

    // ── Step 2: Parse X-Payment-Options ───────────────────────────────
    const optionsHeader = response.headers.get("X-Payment-Options") ?? response.headers.get("x-payment-options");
    if (!optionsHeader) {
      return { ok: false, error: "API returned 402 but no X-Payment-Options header", status: 502 };
    }

    const options = parsePaymentOptions(optionsHeader);
    const usdcOption = options.find(isUsdcOption);

    if (!usdcOption) {
      return { ok: false, error: `API requires payment in an unsupported asset. Options: ${options.map((o) => o.asset).join(", ")}`, status: 400 };
    }

    const payTo         = String(usdcOption.payTo ?? "").trim();
    const amountStr     = String(usdcOption.maxAmountRequired ?? "0");
    const paymentAmount = parseFloat(amountStr);

    if (!payTo || !isAddress(payTo)) {
      return { ok: false, error: `API payment address is invalid: ${payTo}`, status: 502 };
    }
    if (isNaN(paymentAmount) || paymentAmount <= 0) {
      return { ok: false, error: `API payment amount is invalid: ${amountStr}`, status: 502 };
    }
    if (paymentAmount > maxAmountUsdc) {
      return {
        ok: false,
        error: `API requires ${paymentAmount} USDC but your limit for this request is ${maxAmountUsdc} USDC. Increase maxAmountUsdc if you want to proceed.`,
        status: 400,
      };
    }

    // ── Step 3: Balance check ──────────────────────────────────────────
    const balanceCheck = await checkBalanceSufficient(agentWallet.circle_wallet_id, paymentAmount);
    if (!balanceCheck.sufficient) {
      return { ok: false, error: balanceCheck.error, status: 400 };
    }

    // ── Step 4: Pay ────────────────────────────────────────────────────
    let txHash: string;
    try {
      const result = await executeAgentSendUsdc({
        agentWalletId:    agentWallet.circle_wallet_id,
        recipientAddress: payTo,
        amountDecimal:    paymentAmount.toFixed(6),
      });
      txHash = result.txHash;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Payment transfer failed";
      console.error("[pay-x402] payment error:", msg);
      return { ok: false, error: `Payment failed: ${msg}`, status: 502 };
    }

    console.log("[pay-x402] paid", paymentAmount, "USDC to", payTo, "txHash:", txHash);

    // ── Step 5: Retry with X-Payment proof ────────────────────────────
    const paymentProof = Buffer.from(JSON.stringify({
      x402Version:  1,
      scheme:       usdcOption.scheme ?? "exact",
      network:      usdcOption.network ?? "arc-testnet",
      payload: {
        txHash,
        from:   agentWallet.circle_wallet_address,
        to:     payTo,
        amount: paymentAmount.toFixed(6),
      },
    })).toString("base64");

    let paidResponse: Response;
    try {
      paidResponse = await fetch(url, {
        ...fetchOptions,
        headers: {
          ...fetchOptions.headers as Record<string, string>,
          "X-Payment": paymentProof,
        },
      });
    } catch {
      return {
        ok: true,
        result: {
          paid:       true,
          amountUsdc: paymentAmount,
          txHash,
          payTo,
          warning:    "Payment sent but retried request failed. Your tx hash is the proof of payment.",
        },
      };
    }

    const responseText = await paidResponse.text();
    let responseData: unknown;
    try { responseData = JSON.parse(responseText); } catch { responseData = responseText; }

    return {
      ok: paidResponse.ok,
      ...(paidResponse.ok
        ? {
          result: {
            paid:       true,
            amountUsdc: paymentAmount,
            txHash,
            payTo,
            status:     paidResponse.status,
            data:       responseData,
          },
        }
        : {
          error: `Paid ${paymentAmount} USDC (tx: ${txHash}) but API returned ${paidResponse.status}. ${responseText.slice(0, 200)}`,
          status: paidResponse.status,
        }),
    } as SkillOutput;
  },
};
