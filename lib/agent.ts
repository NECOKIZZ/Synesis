/**
 * DotArc Smart Agent — server-only helpers.
 *
 * Covers:
 *  - PIN hashing / verification (Node crypto scrypt, no extra packages)
 *  - Policy HMAC signing / verification (prevents DB-only compromise)
 *  - Circle developer-controlled agent wallet creation + USDC execution
 *  - OpenRouter (Claude) instruction interpretation
 *  - Spend-limit validation
 *  - Auth helper: requireAgentSession (DotArc JWT + Supabase UUID cross-check)
 */

import "server-only";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { Interface, parseUnits } from "ethers";
import { circleDev, waitForCircleTx } from "@/lib/circle";
import { requireSession, type Session } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// ── Types (shared from agent-types.ts + server-only extensions) ───────

import type {
  SkillName,
  TaskType,
  PlanStep,
  PolicyAction,
  ImmediateTaskResult,
  CompoundTaskResult,
  RecurringTaskResult,
  ConditionalTaskResult,
  AnyTaskResult,
  SpendLimits,
  AgentTokenBalance,
  ActivePolicy,
  // backward-compat aliases
  SkillResult,
  PlanResult,
  AnySkillResult,
} from "@/lib/agent-types";

export type {
  SkillName,
  TaskType,
  PlanStep,
  PolicyAction,
  ImmediateTaskResult,
  CompoundTaskResult,
  RecurringTaskResult,
  ConditionalTaskResult,
  AnyTaskResult,
  SpendLimits,
  AgentTokenBalance,
  ActivePolicy,
  SkillResult,
  PlanResult,
  AnySkillResult,
};

export type AgentSession = {
  session: Session;
  supabaseUserId: string;
};

// ── Auth: require both DotArc JWT + Supabase user ─────────────────────

/**
 * Layer 1 + ownership check guard for every agent API route.
 *
 * Validates:
 *  1. Valid DotArc JWT session (requireSession)
 *  2. Valid Supabase auth user exists in the same request context
 *  3. Email in the JWT matches the Supabase user email (prevents session swap)
 *
 * Returns the DotArc session plus the Supabase UUID needed for DB FKs.
 */
export async function requireAgentSession(): Promise<AgentSession> {
  const session = await requireSession();

  const supabase = await createSupabaseServerClient();

  // Prefer getClaims() — validates the Supabase JWT locally (no network
  // round-trip to Supabase auth). Falls back to getUser() if claims are
  // unavailable for any reason. Cuts a real ~50-200ms off every agent
  // request and removes a hard uptime dependency on Supabase auth.
  let claimEmail: string | undefined;
  let claimUserId: string | undefined;
  try {
    const { data, error } = await supabase.auth.getClaims();
    if (!error && data?.claims) {
      const c = data.claims as Record<string, unknown>;
      const email = typeof c.email === "string" ? c.email : undefined;
      const sub = typeof c.sub === "string" ? c.sub : undefined;
      if (email && sub) {
        claimEmail = email;
        claimUserId = sub;
      }
    }
  } catch {
    // fall through to getUser below
  }

  if (!claimEmail || !claimUserId) {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();
    if (error || !user || !user.email) {
      throw new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    claimEmail = user.email;
    claimUserId = user.id;
  }

  if (claimEmail.toLowerCase() !== session.email.toLowerCase()) {
    throw new Response(JSON.stringify({ error: "Session mismatch" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  return { session, supabaseUserId: claimUserId };
}

// ── PIN hashing (bcryptjs) ────────────────────────────────────────────

const BCRYPT_ROUNDS = 12;

/**
 * Hash an agent PIN with bcrypt.  Returns a bcrypt hash string.
 */
export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, BCRYPT_ROUNDS);
}

/**
 * Verify a PIN against a bcrypt hash.  Constant-time safe.
 */
export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  return bcrypt.compare(pin, stored);
}

// ── Policy HMAC (Layer 4 tamper-proof DB rows) ─────────────────────────

function getHmacSecret(): string {
  const s = process.env.POLICY_HMAC_SECRET;
  if (!s) throw new Error("POLICY_HMAC_SECRET not configured");
  return s;
}

// ── HMAC v1 (legacy — narrow fields) ──────────────────────────────────
// Kept for backward compatibility with policies created before the
// orchestration model. These rows have hmac_version = 1.

export type LegacyHmacFields = {
  userId: string;
  policyId: string;
  skill: string;
  recipientAddress: string | null;
  amountUsdc: number | null;
  frequency: string | null;
  createdAt: string;
};

function signLegacyHmac(fields: LegacyHmacFields): string {
  const canonical = [
    fields.userId,
    fields.policyId,
    fields.skill,
    fields.recipientAddress ?? "",
    fields.amountUsdc?.toString() ?? "",
    fields.frequency ?? "",
    fields.createdAt,
  ].join("|");

  return crypto
    .createHmac("sha256", getHmacSecret())
    .update(canonical)
    .digest("hex");
}

// ── HMAC v2 (orchestration — full policy intent) ──────────────────────
// Signs everything that, if tampered, would change behaviour:
// trigger, action, execution_mode, cooldown, stop_conditions.
// These rows have hmac_version = 2.

export type OrchestrationHmacFields = {
  userId: string;
  policyId: string;
  actionSkill: string;
  actionParams: Record<string, unknown>;
  triggerType: string;
  triggerParams: Record<string, unknown>;
  executionMode: string;
  cooldownSeconds: number;
  stopConditions: Array<Record<string, unknown>>;
  createdAt: string;
};

function signOrchestrationHmac(fields: OrchestrationHmacFields): string {
  const canonical = JSON.stringify({
    userId: fields.userId,
    policyId: fields.policyId,
    actionSkill: fields.actionSkill,
    actionParams: fields.actionParams,
    triggerType: fields.triggerType,
    triggerParams: fields.triggerParams,
    executionMode: fields.executionMode,
    cooldownSeconds: fields.cooldownSeconds,
    stopConditions: fields.stopConditions,
    createdAt: fields.createdAt,
  });

  return crypto
    .createHmac("sha256", getHmacSecret())
    .update(canonical)
    .digest("hex");
}

// ── Public dispatchers ──────────────────────────────────────────────

/** Sign a policy. Pick the right HMAC version automatically. */
export function signPolicyHmac(
  fields: LegacyHmacFields | (OrchestrationHmacFields & { version: 2 })
): string {
  if ("version" in fields && fields.version === 2) {
    const { version: _version, ...rest } = fields;
    void _version;
    return signOrchestrationHmac(rest);
  }
  return signLegacyHmac(fields as LegacyHmacFields);
}

/** Verify a stored policy HMAC. Returns false (not throws) on mismatch. */
export function verifyPolicyHmac(
  fields: LegacyHmacFields | OrchestrationHmacFields,
  storedHmac: string,
  version: number = 1
): boolean {
  const expected =
    version === 2
      ? signOrchestrationHmac(fields as OrchestrationHmacFields)
      : signLegacyHmac(fields as LegacyHmacFields);

  const expectedBuf = Buffer.from(expected, "hex");
  const storedBuf = Buffer.from(storedHmac, "hex");
  if (expectedBuf.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, storedBuf);
}

// ── Circle agent wallet ────────────────────────────────────────────────

/**
 * Create a new Circle developer-controlled wallet in the agent wallet set.
 * Requires CIRCLE_AGENT_WALLET_SET_ID to be set.
 */
export async function createAgentWalletInCircle(): Promise<{
  walletId: string;
  address: string;
}> {
  if (!circleDev) throw new Error("Circle dev client not configured");
  const walletSetId = process.env.CIRCLE_AGENT_WALLET_SET_ID;
  if (!walletSetId) throw new Error("CIRCLE_AGENT_WALLET_SET_ID not set");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await (circleDev as any).createWallets({
    blockchains: ["ARC-TESTNET"],
    count: 1,
    walletSetId,
    accountType: "EOA",
  });

  const wallet = res?.data?.wallets?.[0];
  if (!wallet?.id || !wallet?.address) {
    throw new Error("Circle returned no agent wallet");
  }
  return { walletId: wallet.id, address: wallet.address };
}

/**
 * Read the USDC balance of the agent wallet from Circle.
 * Returns a decimal string (e.g. "12.500000").
 */
export async function getAgentBalance(agentWalletId: string): Promise<string> {
  if (!circleDev) throw new Error("Circle dev client not configured");
  const res = await circleDev.getWalletTokenBalance({ id: agentWalletId });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const balances: any[] = res.data?.tokenBalances ?? [];
  const usdcAddress = process.env.NEXT_PUBLIC_USDC_TOKEN_ADDRESS?.toLowerCase();

  const usdc = balances.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (b: any) =>
      b.token?.tokenAddress?.toLowerCase() === usdcAddress ||
      b.token?.symbol === "USDC"
  );
  return usdc?.amount ?? "0";
}

// ── All-token balance reader ───────────────────────────────────────────

// Approximate USD display rates — not for financial math, display only
const DISPLAY_USD_RATES: Record<string, number> = {
  USDC:   1.0,
  EURC:   1.08,
  CIRBTC: 100_000,
};

export async function getAgentAllBalances(agentWalletId: string): Promise<AgentTokenBalance[]> {
  if (!circleDev) throw new Error("Circle dev client not configured");
  const res = await circleDev.getWalletTokenBalance({ id: agentWalletId });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const balances: any[] = res.data?.tokenBalances ?? [];

  const fromCircle = balances
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((b: any) => {
      const symbol: string  = b.token?.symbol ?? "UNKNOWN";
      const amount: string  = b.amount ?? "0";
      const amountNumber    = parseFloat(amount);
      const rate            = DISPLAY_USD_RATES[symbol.toUpperCase()] ?? 0;
      return {
        symbol,
        amount,
        amountNumber,
        tokenAddress:   b.token?.tokenAddress ?? null,
        approxUsdValue: amountNumber * rate,
      };
    });

  // Circle may return the same token twice (e.g. native + gateway balance).
  // Deduplicate by symbol, keeping the entry with the highest amount.
  const deduped = new Map<string, AgentTokenBalance>();
  for (const t of fromCircle) {
    const key = t.symbol.toUpperCase();
    const existing = deduped.get(key);
    if (!existing || t.amountNumber > existing.amountNumber) {
      deduped.set(key, t);
    }
  }
  const fromCircleDeduped = Array.from(deduped.values());

  // Circle omits tokens with zero balance. Inject them so the model always
  // sees the full portfolio and can apply SMART BALANCE INFERENCE correctly.
  const supportedSymbols = ["USDC", "EURC", "CIRBTC"];
  const presentSymbols = new Set(fromCircleDeduped.map((t) => t.symbol.toUpperCase()));
  const zeroBalances: AgentTokenBalance[] = supportedSymbols
    .filter((s) => !presentSymbols.has(s))
    .map((symbol) => ({
      symbol,
      amount: "0",
      amountNumber: 0,
      tokenAddress: null,
      approxUsdValue: 0,
    }));

  return [...fromCircleDeduped, ...zeroBalances]
    .sort((a, b) => b.approxUsdValue - a.approxUsdValue);
}

// ── Balance sufficiency check (shared by every money-moving skill) ────

export type BalanceCheckResult =
  | { sufficient: true; currentBalanceUsdc: number }
  | { sufficient: false; error: string; currentBalanceUsdc?: number };

function fmtUsdc(n: number): string {
  // Strip trailing zeros for friendly display, keep up to 6 decimals.
  return n.toFixed(6).replace(/\.?0+$/, "");
}

/**
 * Check whether the agent wallet has enough USDC for a planned transfer.
 * This must be the FIRST external call in every money-moving skill,
 * before limit checks, before logging, before Circle.
 */
export async function checkBalanceSufficient(
  agentWalletId: string,
  requiredAmountUsdc: number,
): Promise<BalanceCheckResult> {
  let balanceStr: string;
  try {
    balanceStr = await getAgentBalance(agentWalletId);
  } catch {
    return {
      sufficient: false,
      error:
        "Couldn't check your balance right now — my connection to Circle is having a moment. " +
        "Please try again in a moment.",
    };
  }

  const currentBalanceUsdc = parseFloat(balanceStr);
  if (!isFinite(currentBalanceUsdc)) {
    return {
      sufficient: false,
      error: "Couldn't read your balance properly. Please try again in a moment.",
    };
  }

  if (currentBalanceUsdc < requiredAmountUsdc) {
    return {
      sufficient: false,
      error:
        `Your agent wallet only has ${fmtUsdc(currentBalanceUsdc)} USDC, ` +
        `but you're trying to send ${fmtUsdc(requiredAmountUsdc)}. ` +
        "Top up your agent wallet and try again.",
      currentBalanceUsdc,
    };
  }

  return { sufficient: true, currentBalanceUsdc };
}

// ── Agent USDC send (developer-controlled, no PIN dialog) ─────────────

const erc20Iface = new Interface([
  "function transfer(address to, uint256 amount) returns (bool)",
]);

/**
 * Execute a USDC transfer FROM the agent (dev-controlled) wallet.
 * No user PIN is needed — the policy engine is the auth gate.
 *
 * amountDecimal: human-readable USDC, e.g. "5.00"
 */
export async function executeAgentSendUsdc(args: {
  agentWalletId: string;
  recipientAddress: string;
  amountDecimal: string;
}): Promise<{ txHash: string; circleTxId: string }> {
  if (!circleDev) throw new Error("Circle dev client not configured");
  const usdcAddress = process.env.NEXT_PUBLIC_USDC_TOKEN_ADDRESS;
  if (!usdcAddress) throw new Error("NEXT_PUBLIC_USDC_TOKEN_ADDRESS not set");

  // Strict decimal validation, then exact BigInt conversion via ethers.
  // Avoids the float-rounding bug where parseFloat("0.123456")*1e6 is
  // 123455.99999… and Math.round can drift on the last unit at high values.
  if (!/^\d+(\.\d{1,6})?$/.test(args.amountDecimal)) {
    throw new Error("Invalid amount format (max 6 decimals)");
  }
  let amountWeiBig: bigint;
  try {
    amountWeiBig = parseUnits(args.amountDecimal, 6);
  } catch {
    throw new Error("Invalid amount");
  }
  if (amountWeiBig <= 0n) {
    throw new Error("Amount must be greater than zero");
  }
  const amountWei = amountWeiBig.toString();

  const callData = erc20Iface.encodeFunctionData("transfer", [
    args.recipientAddress,
    amountWei,
  ]) as `0x${string}`;

  const txRes = await circleDev.createContractExecutionTransaction({
    walletId: args.agentWalletId,
    contractAddress: usdcAddress,
    callData,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });

  const circleTxId = txRes.data?.id;
  if (!circleTxId) throw new Error("Circle returned no transaction id for agent send");

  const txHash = await waitForCircleTx(circleTxId, 15, 2000);
  return { txHash, circleTxId };
}

/**
 * Send any ERC-20 token from the agent wallet using Circle contract execution.
 * Works for EURC, USDC, or any token with a known contract address.
 * Uses the same ABI-encoded transfer() pattern as executeAgentSendUsdc.
 */
export async function executeAgentSendToken(args: {
  agentWalletId: string;
  recipientAddress: string;
  amountDecimal: string;
  tokenAddress: string;
  decimals: number;
}): Promise<{ txHash: string; circleTxId: string }> {
  if (!circleDev) throw new Error("Circle dev client not configured");

  let amountWeiBig: bigint;
  try {
    amountWeiBig = parseUnits(args.amountDecimal, args.decimals);
  } catch {
    throw new Error("Invalid token amount");
  }
  if (amountWeiBig <= 0n) throw new Error("Amount must be greater than zero");

  const callData = erc20Iface.encodeFunctionData("transfer", [
    args.recipientAddress,
    amountWeiBig.toString(),
  ]) as `0x${string}`;

  const txRes = await circleDev.createContractExecutionTransaction({
    walletId: args.agentWalletId,
    contractAddress: args.tokenAddress,
    callData,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });

  const circleTxId = txRes.data?.id;
  if (!circleTxId) throw new Error("Circle returned no transaction id for token send");

  const txHash = await waitForCircleTx(circleTxId, 15, 2000);
  return { txHash, circleTxId };
}

// ── Re-exports from agent-core (pure logic) ────────────────────────────

export {
  buildSystemPrompt,
  validateTaskResult,
  interpretInstruction,
  computeNextRun,
  checkSpendLimits,
  startOfDayUTC,
  startOfWeekUTC,
  startOfMonthUTC,
  getLivePrices,
  fmtUsdc,
} from "./agent-core";

export type { LivePrices, SpendCheckResult } from "./agent-core";
