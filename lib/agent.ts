/**
 * Synesis Smart Agent — server-only helpers.
 *
 * Covers:
 *  - PIN hashing / verification (Node crypto scrypt, no extra packages)
 *  - Policy HMAC signing / verification (prevents DB-only compromise)
 *  - Circle developer-controlled agent wallet creation + USDC execution
 *  - OpenRouter (Claude) instruction interpretation
 *  - Spend-limit validation
 *  - Auth helper: requireAgentSession (Synesis JWT + Supabase UUID cross-check)
 */

import "server-only";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { Interface, parseUnits } from "ethers";
import { circleDev, waitForCircleTx, circleRead, circleWrite } from "@/lib/circle";
import { requireSession, type Session } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// ── Types (shared from agent-types.ts + server-only extensions) ───────

import type {
  SkillName,
  PlanStep,
  SpendLimits,
  AgentTokenBalance,
  ActivePolicy,
  Task,
  Trigger,
  InterpretResult,
} from "@/lib/agent-types";

export type {
  SkillName,
  PlanStep,
  SpendLimits,
  AgentTokenBalance,
  ActivePolicy,
  Task,
  Trigger,
  InterpretResult,
};

export type AgentSession = {
  session: Session;
  supabaseUserId: string;
};

// ── Auth: require both Synesis JWT + Supabase user ─────────────────────

/**
 * Layer 1 + ownership check guard for every agent API route.
 *
 * Validates:
 *  1. Valid Synesis JWT session (requireSession)
 *  2. Valid Supabase auth user exists in the same request context
 *  3. Email in the JWT matches the Supabase user email (prevents session swap)
 *
 * Returns the Synesis session plus the Supabase UUID needed for DB FKs.
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

/**
 * Throws a 403 Response if the user does not have Smart Agent access.
 * Call this AFTER `requireAgentSession()` in any agent mutation route.
 *
 * The status route (/api/agent/status) is the only exception — it checks
 * the flag itself and returns `{ activated: false, gated: true }` so the
 * UI can show a "coming soon" state without flagging the call as an error.
 */
export async function enforceAgentGate(supabaseUserId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("agent_enabled")
    .eq("id", supabaseUserId)
    .maybeSingle();

  if (error) {
    throw new Response(
      JSON.stringify({ error: "Profile lookup failed", code: "PROFILE_ERROR" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!data?.agent_enabled) {
    throw new Response(
      JSON.stringify({
        error: "Smart Agent is invite-only. Join the waitlist for early access.",
        code: "AGENT_GATED",
      }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }
}

/**
 * Non-throwing variant of `enforceAgentGate`. Returns true if the user has
 * Smart Agent access. Used by /api/agent/status to differentiate gated vs
 * unactivated states cleanly.
 */
export async function isAgentEnabled(supabaseUserId: string): Promise<boolean> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("profiles")
    .select("agent_enabled")
    .eq("id", supabaseUserId)
    .maybeSingle();
  return Boolean(data?.agent_enabled);
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

// ── HMAC v2 (orchestration — full policy intent) ──────────────────────
// Signs everything that, if tampered, would change behaviour:
// trigger, action, execution_mode, cooldown, stop_conditions.
// These rows have hmac_version = 2.
//
// Note: HMAC v1 (legacy RECURRING_PAYMENT) was removed on 2026-06-07
// along with the RECURRING_PAYMENT skill. The cron route now rejects any
// row with hmac_version !== 2.

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
  /**
   * V3: optional array of plan steps for compound policies.
   * - NULL/undefined for simple single-action policies (legacy V2 shape).
   * - Populated when action_skill === "COMPOUND".
   * Forwards-compatible: when omitted, JSON.stringify drops the key, so
   * existing V2 rows continue to verify against their stored hashes.
   */
  steps?: Array<Record<string, unknown>> | null;
};

/**
 * Deterministic JSON serialization with recursively sorted object keys.
 *
 * CRITICAL: the plain `JSON.stringify` we used before preserved JS object
 * insertion order. But `action_params` / `trigger_params` / `stop_conditions`
 * / `steps` are stored as Postgres `jsonb`, which re-sorts keys by (length,
 * bytewise) on write. So the cron read keys back in a DIFFERENT order than
 * they were signed in (e.g. `{recipient, amount}` → `{amount, recipient}`),
 * producing a different hash and failing verification on EVERY policy.
 *
 * Sorting keys here makes the canonical bytes independent of storage
 * reordering, so sign-time and verify-time always agree. Arrays keep their
 * order (semantically significant — e.g. compound `steps`); only object keys
 * are sorted.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",");
  return `{${body}}`;
}

function signOrchestrationHmac(fields: OrchestrationHmacFields): string {
  // Canonical payload. Key order no longer matters — `stableStringify`
  // sorts keys recursively so the hash is stable across the jsonb round-trip.
  // We only include `steps` when it's a non-empty array, which keeps
  // backwards compatibility with V2 rows that never had this key.
  const canonical: Record<string, unknown> = {
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
  };
  if (fields.steps && fields.steps.length > 0) {
    canonical.steps = fields.steps;
  }

  return crypto
    .createHmac("sha256", getHmacSecret())
    .update(stableStringify(canonical))
    .digest("hex");
}

// ── Public dispatchers ──────────────────────────────────────────────
//
// V2 (orchestration) is the only supported HMAC version. The `version`
// parameter is retained on the public signatures for forward-compat —
// future incompatible changes will introduce a v3 here.

/** Sign a v2 (orchestration) policy. */
export function signPolicyHmac(
  fields: OrchestrationHmacFields & { version: 2 }
): string {
  const { version: _version, ...rest } = fields;
  void _version;
  return signOrchestrationHmac(rest);
}

/** Verify a stored policy HMAC. Returns false (not throws) on mismatch. */
export function verifyPolicyHmac(
  fields: OrchestrationHmacFields,
  storedHmac: string,
  version: number = 2
): boolean {
  if (version !== 2) return false; // v1 was removed with RECURRING_PAYMENT
  const expected = signOrchestrationHmac(fields);
  const expectedBuf = Buffer.from(expected, "hex");
  const storedBuf = Buffer.from(storedHmac, "hex");
  if (expectedBuf.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, storedBuf);
}

// ── Circle agent wallet ────────────────────────────────────────────────

/**
 * Create a new Circle developer-controlled wallet in the agent wallet set.
 * Requires CIRCLE_AGENT_WALLET_SET_ID to be set.
 *
 * `blockchain` defaults to ARC-TESTNET (the EVM agent wallet). Pass SOL-DEVNET
 * to provision the agent's Solana wallet — a SEPARATE base58 address (Solana is
 * EOA-only; no SCA). Both live in the same wallet set.
 */
export async function createAgentWalletInCircle(
  blockchain: "ARC-TESTNET" | "SOL-DEVNET" = "ARC-TESTNET",
): Promise<{
  walletId: string;
  address: string;
}> {
  if (!circleDev) throw new Error("Circle dev client not configured");
  const walletSetId = process.env.CIRCLE_AGENT_WALLET_SET_ID;
  if (!walletSetId) throw new Error("CIRCLE_AGENT_WALLET_SET_ID not set");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await (circleDev as any).createWallets({
    blockchains: [blockchain],
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
  const res = await circleRead("getWalletTokenBalance(agent)", () =>
    circleDev!.getWalletTokenBalance({ id: agentWalletId }),
  );
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

// Tokens we always surface to the model, even at zero balance, so SMART
// BALANCE INFERENCE sees the full portfolio. Shared by the live path
// (getAgentAllBalances) and the cache path (readBalanceCache) so the two
// can never drift. Upper-case canonical form.
const SUPPORTED_BALANCE_SYMBOLS = ["USDC", "EURC", "CIRBTC"] as const;

export async function getAgentAllBalances(agentWalletId: string): Promise<AgentTokenBalance[]> {
  if (!circleDev) throw new Error("Circle dev client not configured");
  const res = await circleRead("getWalletTokenBalance(agent-all)", () =>
    circleDev!.getWalletTokenBalance({ id: agentWalletId }),
  );
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
  const presentSymbols = new Set(fromCircleDeduped.map((t) => t.symbol.toUpperCase()));
  const zeroBalances: AgentTokenBalance[] = SUPPORTED_BALANCE_SYMBOLS
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

// ── Cache-backed balance reader (V3.5 Track 1) ─────────────────────────
//
// The webhook (app/api/webhooks/circle/route.ts) maintains
// agent_wallets.balance_cache as a { symbol: amountString } jsonb blob.
// This is the read-side counterpart to getAgentAllBalances(): it converts
// that blob into the SAME AgentTokenBalance[] shape the live path returns
// — reusing DISPLAY_USD_RATES and the zero-balance injection — so the
// interpret prompt sees an identical portfolio regardless of source.
//
// Pure + synchronous: the interpret route already fetches the agent_wallets
// row, so it passes the columns straight in rather than paying a second DB
// round-trip. Never throws; returns null when the cache can't be trusted
// (missing/empty blob or unusable timestamp) so the caller falls back to
// the live Circle read.
//
// TRUST MODEL: eventually consistent — the LLM's first-filter ONLY.
// Spend-time gates MUST still read Circle live (see checkBalanceSufficient).

export type BalanceCacheRead = {
  balances: AgentTokenBalance[];
  ageSeconds: number;
};

export function readBalanceCache(
  cache: unknown,
  cacheAt: string | null | undefined,
): BalanceCacheRead | null {
  // No freshness stamp → can't reason about staleness → don't trust it.
  if (!cacheAt) return null;
  const ts = Date.parse(cacheAt);
  if (Number.isNaN(ts)) return null;

  if (!cache || typeof cache !== "object") return null;
  const entries = Object.entries(cache as Record<string, unknown>);
  // Empty blob ({}) is "webhook hasn't populated yet" — fall back to live.
  if (entries.length === 0) return null;

  const deduped = new Map<string, AgentTokenBalance>();
  for (const [rawSymbol, rawAmount] of entries) {
    const symbol = String(rawSymbol);
    const amount =
      typeof rawAmount === "string" ? rawAmount : String(rawAmount ?? "0");
    const amountNumber = parseFloat(amount);
    if (!isFinite(amountNumber)) continue;
    const rate = DISPLAY_USD_RATES[symbol.toUpperCase()] ?? 0;
    deduped.set(symbol.toUpperCase(), {
      symbol,
      amount,
      amountNumber,
      tokenAddress: null, // cache doesn't persist token addresses
      approxUsdValue: amountNumber * rate,
    });
  }

  // Inject zero balances for any supported token the cache omitted —
  // identical to getAgentAllBalances() so the prompt shape is stable.
  for (const symbol of SUPPORTED_BALANCE_SYMBOLS) {
    if (!deduped.has(symbol)) {
      deduped.set(symbol, {
        symbol,
        amount: "0",
        amountNumber: 0,
        tokenAddress: null,
        approxUsdValue: 0,
      });
    }
  }

  const ageSeconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  return {
    balances: Array.from(deduped.values()).sort(
      (a, b) => b.approxUsdValue - a.approxUsdValue,
    ),
    ageSeconds,
  };
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

  const txRes = await circleWrite("createContractExecutionTransaction(agent-usdc)", () =>
    circleDev!.createContractExecutionTransaction({
      walletId: args.agentWalletId,
      contractAddress: usdcAddress,
      callData,
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    }),
  );

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

  const txRes = await circleWrite("createContractExecutionTransaction(agent-token)", () =>
    circleDev!.createContractExecutionTransaction({
      walletId: args.agentWalletId,
      contractAddress: args.tokenAddress,
      callData,
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    }),
  );

  const circleTxId = txRes.data?.id;
  if (!circleTxId) throw new Error("Circle returned no transaction id for token send");

  const txHash = await waitForCircleTx(circleTxId, 15, 2000);
  return { txHash, circleTxId };
}

// ── Re-exports from agent-core (pure logic) ────────────────────────────

export {
  computeNextRun,
  checkSpendLimits,
  startOfDayUTC,
  startOfWeekUTC,
  startOfMonthUTC,
  getLivePrices,
  fmtUsdc,
} from "./agent-core";

export type { LivePrices, SpendCheckResult } from "./agent-core";
