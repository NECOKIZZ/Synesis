/**
 * Circle SDK clients + helpers (server-only).
 *
 * Two clients:
 *  - `circleDev`  → developer-controlled wallets (treasury signing)
 *  - `circleUser` → user-controlled wallets (signup, wallet lookup)
 *
 * Both use the same API key. The dev client additionally needs the entity secret.
 */

import "server-only";
import {
  initiateDeveloperControlledWalletsClient,
  type CircleDeveloperControlledWalletsClient,
} from "@circle-fin/developer-controlled-wallets";
import {
  initiateUserControlledWalletsClient,
  type CircleUserControlledWalletsClient,
} from "@circle-fin/user-controlled-wallets";
import { Interface, JsonRpcProvider, Contract, randomBytes, solidityPackedKeccak256 } from "ethers";
import crypto from "node:crypto";

const apiKey = process.env.CIRCLE_API_KEY;
const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
const treasuryWalletId = process.env.CIRCLE_TREASURY_WALLET_ID;
const registryAddress = process.env.NEXT_PUBLIC_ANS_REGISTRY_ADDRESS;
const arcRpcUrl = process.env.NEXT_PUBLIC_ARC_RPC_URL || "https://rpc.testnet.arc.network";

export const circleConfigured = Boolean(
  apiKey && entitySecret && treasuryWalletId && registryAddress
);

export const circleDev: CircleDeveloperControlledWalletsClient | null =
  apiKey && entitySecret
    ? initiateDeveloperControlledWalletsClient({ apiKey, entitySecret })
    : null;

export const circleUser: CircleUserControlledWalletsClient | null =
  apiKey ? initiateUserControlledWalletsClient({ apiKey }) : null;

// ── Encoders ─────────────────────────────────────────────────────────

const registryInterface = new Interface([
  "function register(string label, address resolvedAddress)",
  "function submitCommitment(bytes32 commitment)",
  "function registerWithCommit(string label, address resolvedAddress, bytes32 salt)",
  "function commitRevealRequired() view returns (bool)",
  "function isAvailable(string label) view returns (bool)",
]);

// Used by user-controlled-wallet sends to encode `USDC.transfer(to, amount)`.
const erc20Interface = new Interface([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

const arcProvider = new JsonRpcProvider(arcRpcUrl);
const registryReadContract = registryAddress
  ? new Contract(registryAddress, registryInterface, arcProvider)
  : null;

let treasuryAddressCache: string | null = null;
async function getTreasuryAddress(): Promise<string> {
  if (treasuryAddressCache) return treasuryAddressCache;
  if (!circleDev || !treasuryWalletId) throw new Error("Circle dev client not configured");
  const res = await circleDev.getWallet({ id: treasuryWalletId });
  const addr = res.data?.wallet?.address;
  if (!addr) throw new Error("Could not resolve treasury address from Circle");
  treasuryAddressCache = addr;
  return addr;
}

let commitRevealRequiredCache: boolean | null = null;
async function commitRevealRequired(): Promise<boolean> {
  if (commitRevealRequiredCache !== null) return commitRevealRequiredCache;
  if (!registryReadContract) {
    commitRevealRequiredCache = false;
    return false;
  }
  try {
    const required = await registryReadContract.commitRevealRequired();
    commitRevealRequiredCache = Boolean(required);
  } catch {
    commitRevealRequiredCache = false;
  }
  return commitRevealRequiredCache;
}

// ── User ID helper ───────────────────────────────────────────────────

/**
 * Deterministic Circle userId from an email. Same email → same userId,
 * so a user always lands back in their own wallet on return.
 *
 * Two derivation modes (selected at deploy time):
 *  - If USER_ID_PEPPER is set: HMAC-SHA256(pepper, email) — the mapping
 *    email→userId cannot be enumerated offline by anyone who only knows
 *    emails. RECOMMENDED.
 *  - Otherwise: SHA-256(email) — legacy mode, kept for backward compat
 *    with existing testnet wallets that were created before the pepper
 *    was introduced. DO NOT remove without a wallet-migration plan.
 *
 * The format prefix `dotarc-` is preserved across both modes.
 */
export function userIdFromEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  const pepper = process.env.USER_ID_PEPPER;
  const hex = pepper
    ? crypto.createHmac("sha256", pepper).update(normalized).digest("hex")
    : crypto.createHash("sha256").update(normalized).digest("hex");
  return `dotarc-${hex.slice(0, 32)}`;
}

/**
 * Resolve the Circle userId for the currently signed-in Supabase user.
 *
 * Order of preference:
 *   1. `profiles.circle_user_id` from the database — pinned at first
 *      signup, never recomputed. This is the source of truth.
 *   2. Fresh derivation via `userIdFromEmail(verifiedEmail)` — used only
 *      for brand-new users who don't have a profile row yet.
 *
 * Why the DB is authoritative: if we always re-derived from email, then
 * rotating or losing USER_ID_PEPPER would silently re-route every
 * existing user to a brand-new (empty) Circle account, orphaning their
 * wallet + funds + .arc name. Pinning at signup decouples the pepper
 * from existing users — it only affects how *future* signups are keyed.
 *
 * Falls back to derivation if the profile read fails for any reason
 * (RLS, network, missing row) so the auth flow never blocks on it.
 */
export async function resolveCircleUserId(verifiedEmail: string): Promise<string> {
  try {
    // Lazy import to avoid pulling supabase into modules that don't need it.
    const { getMyProfile } = await import("@/lib/profile");
    const profile = await getMyProfile();
    if (profile?.circleUserId) return profile.circleUserId;
  } catch (err) {
    console.warn("[resolveCircleUserId] profile lookup failed, falling back to derivation:", err);
  }
  return userIdFromEmail(verifiedEmail);
}

// ── User wallet flow ─────────────────────────────────────────────────

export type InitUserResult = {
  userId: string;
  userToken: string;
  encryptionKey: string;
  challengeId?: string;
  alreadyOnboarded: boolean;
  /**
   * Populated when alreadyOnboarded === true. Lets the caller skip the
   * separate /api/circle/wallet lookup since we already have the address.
   */
  walletAddress?: string;
};

export async function initCircleUser(email: string): Promise<InitUserResult> {
  if (!circleUser) throw new Error("Circle user client not configured");
  // Prefer pinned profiles.circle_user_id over a fresh derivation so
  // rotating USER_ID_PEPPER doesn't lock existing users out of their wallet.
  const userId = await resolveCircleUserId(email);

  try {
    await circleUser.createUser({ userId });
  } catch (error: unknown) {
    const e = error as { response?: { status?: number; data?: { code?: number } } };
    const status = e?.response?.status;
    const code = e?.response?.data?.code;
    if (status !== 409 && code !== 155101) throw error;
  }

  const tokenRes = await circleUser.createUserToken({ userId });
  const userToken = tokenRes.data?.userToken;
  const encryptionKey = tokenRes.data?.encryptionKey;
  if (!userToken || !encryptionKey) throw new Error("Failed to create user token");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userScoped = initiateUserControlledWalletsClient({ apiKey: apiKey!, userToken } as any);
  let existingWalletAddress: string | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walletsRes = await userScoped.listWallets({ userId } as any);
    const wallets = walletsRes.data?.wallets ?? [];
    const arcWallet = wallets.find(
      (w: { blockchain: string; address?: string }) => w.blockchain === "ARC-TESTNET"
    );
    if (arcWallet?.address) existingWalletAddress = arcWallet.address;
  } catch (err) {
    // Non-fatal — but we MUST surface it, because if listWallets is failing
    // silently the fast-path will never engage for returning users.
    console.warn("[initCircleUser] listWallets failed:", err instanceof Error ? err.message : err);
  }

  if (existingWalletAddress) {
    // Returning user fast path: caller can skip the separate /wallet poll
    // because we already have the address in hand.
    return {
      userId,
      userToken,
      encryptionKey,
      alreadyOnboarded: true,
      walletAddress: existingWalletAddress,
    };
  }

  try {
    const challengeRes = await userScoped.createUserPinWithWallets({
      userId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      blockchains: ["ARC-TESTNET" as any],
      accountType: "EOA",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const challengeId = challengeRes.data?.challengeId;
    if (!challengeId) throw new Error("Failed to create wallet challenge");
    return { userId, userToken, encryptionKey, challengeId, alreadyOnboarded: false };
  } catch (error: unknown) {
    const e = error as { response?: { data?: { code?: number } } };
    if (e?.response?.data?.code === 155106) {
      return { userId, userToken, encryptionKey, alreadyOnboarded: true };
    }
    throw error;
  }
}

export async function getUserWallet(
  userId: string
): Promise<{ id: string; address: string; blockchain: string } | null> {
  if (!circleUser) throw new Error("Circle user client not configured");
  const tokenRes = await circleUser.createUserToken({ userId });
  const userToken = tokenRes.data?.userToken;
  if (!userToken) throw new Error("Failed to create user token for lookup");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userScoped = initiateUserControlledWalletsClient({ apiKey: apiKey!, userToken } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walletsRes = await userScoped.listWallets({ userId } as any);
  const wallet = walletsRes.data?.wallets?.find(
    (w: { blockchain: string }) => w.blockchain === "ARC-TESTNET"
  );
  if (!wallet) return null;

  return {
    id: wallet.id,
    address: wallet.address,
    blockchain: wallet.blockchain,
  };
}

// ── User send (USDC) ─────────────────────────────────────────────────

export type PrepareSendResult = {
  challengeId: string;
  userToken: string;
  encryptionKey: string;
};

/**
 * Build a USDC transfer challenge from the user's own wallet. The challenge
 * is signed in the browser via Circle's SDK (PIN dialog) — we never see the
 * PIN or any signing material here. We only ask Circle to prepare a
 * transaction; signing happens in the user's browser.
 *
 * SECURITY: callers MUST have already:
 *   - Verified the recipient (server-side .arc resolve or `isAddress` check)
 *   - Validated the amount is > 0 and within the user's balance
 *   - Confirmed `walletId` truly belongs to the verified user (via getUserWallet)
 *   - Ruled out self-sends
 *
 * This function trusts its inputs. Do not expose it as a public API.
 */
export async function prepareUserSendUsdc(args: {
  userId: string;
  walletId: string;
  tokenContractAddress: string; // USDC contract on Arc Testnet
  recipientAddress: string; // already-validated 0x address
  amountDecimal: string; // e.g. "5.00" — DECIMAL USDC, not wei. Circle handles decimals.
}): Promise<PrepareSendResult> {
  if (!circleUser) throw new Error("Circle user client not configured");

  // Issue a user token scoped to THIS userId. The userToken is what authorizes
  // SDK calls in the browser, so it gates ALL transaction signing for the user.
  const tokenRes = await circleUser.createUserToken({ userId: args.userId });
  const userToken = tokenRes.data?.userToken;
  const encryptionKey = tokenRes.data?.encryptionKey;
  if (!userToken || !encryptionKey) {
    throw new Error("Failed to create user token for send");
  }

  console.log("[circle.prepareUserSendUsdc]", {
    userId: args.userId,
    walletId: args.walletId,
    recipient: args.recipientAddress,
    amount: args.amountDecimal,
  });

  // Circle's high-level createTransaction handles the ERC-20 transfer for us
  // when we pass blockchain + tokenAddress (instead of tokenId). It encodes
  // USDC.transfer(to, amount) internally and returns a challengeId for the
  // browser SDK to sign.
  // NOTE: Circle's `createTransaction` accepts EITHER userToken OR userId, not
  // both. We pass userToken (which authenticates as this specific user) and
  // omit userId per the SDK's discriminated union.
  const challengeRes = await circleUser.createTransaction({
    userToken,
    walletId: args.walletId,
    destinationAddress: args.recipientAddress,
    amounts: [args.amountDecimal],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    blockchain: "ARC-TESTNET" as any,
    tokenAddress: args.tokenContractAddress,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  const challengeId = challengeRes.data?.challengeId;
  if (!challengeId) throw new Error("Circle returned no challengeId for send");

  return { challengeId, userToken, encryptionKey };
}

/**
 * Server-side read of a wallet's on-chain USDC balance. Used to guard against
 * over-spend before creating a Circle challenge (saves the user from paying
 * fees on a guaranteed-failing tx).
 */
export async function readUsdcBalanceWei(
  ownerAddress: string,
  tokenContractAddress: string
): Promise<bigint> {
  const token = new Contract(tokenContractAddress, erc20Interface, arcProvider);
  const raw: bigint = await token.balanceOf(ownerAddress);
  return raw;
}

// ── Treasury registration ────────────────────────────────────────────

export type RegisterResult = {
  txHash: string;
  circleTxId: string;
};

async function executeAndWait(
  contractAddress: string,
  callData: `0x${string}`
): Promise<{ txHash: string; circleTxId: string }> {
  if (!circleDev) throw new Error("Circle dev client not configured");
  if (!treasuryWalletId) throw new Error("CIRCLE_TREASURY_WALLET_ID not set");

  const txRes = await circleDev.createContractExecutionTransaction({
    walletId: treasuryWalletId,
    contractAddress,
    callData,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });

  const circleTxId = txRes.data?.id;
  if (!circleTxId) throw new Error("Circle returned no transaction id");

  const txHash = await waitForCircleTx(circleTxId);
  return { txHash, circleTxId };
}

/**
 * Treasury registers a name on behalf of a user.
 * Treasury pays the 5 USDC fee. Name resolves to `userAddress`, not the treasury.
 *
 * NOTE (CRITIQUE §5.2): This pattern means the TREASURY OWNS the name on-chain,
 * not the user. This is a known issue tracked in DOTARC_WALLET_CRITIQUE.md.
 * Future fix: registry-side `registerFor(name, owner)` OR treasury funds the
 * user's wallet which then calls register itself.
 */
export async function treasuryRegisterName(
  label: string,
  userAddress: string
): Promise<RegisterResult> {
  if (!registryAddress) throw new Error("ANS registry address not set");

  const useCommitReveal = await commitRevealRequired();
  console.log(`[treasury] registering ${label}.arc → ${userAddress} (commitReveal=${useCommitReveal})`);

  if (!useCommitReveal) {
    const callData = registryInterface.encodeFunctionData("register", [label, userAddress]) as `0x${string}`;
    return executeAndWait(registryAddress, callData);
  }

  const treasuryAddress = await getTreasuryAddress();
  const salt = randomBytes(32);
  const labelHash = solidityPackedKeccak256(["string"], [label]);
  const commitment = solidityPackedKeccak256(
    ["address", "bytes32", "bytes32"],
    [treasuryAddress, labelHash, salt]
  ) as `0x${string}`;

  const commitCalldata = registryInterface.encodeFunctionData("submitCommitment", [commitment]) as `0x${string}`;
  console.log("[treasury] submitting commitment…");
  const commitResult = await executeAndWait(registryAddress, commitCalldata);
  console.log(`[treasury] commitment confirmed: ${commitResult.txHash}`);

  const revealCalldata = registryInterface.encodeFunctionData(
    "registerWithCommit",
    [label, userAddress, salt]
  ) as `0x${string}`;
  console.log("[treasury] revealing registration…");
  const revealResult = await executeAndWait(registryAddress, revealCalldata);
  console.log(`[treasury] registration confirmed: ${revealResult.txHash}`);

  return revealResult;
}

/**
 * Poll Circle for a transaction to confirm.
 *
 * Defaults: 8 attempts × 3000ms = 24 s. Under the Vercel Pro 60s function
 * timeout with plenty of headroom for surrounding work. Tune via env vars
 * CIRCLE_TX_POLL_ATTEMPTS / CIRCLE_TX_POLL_INTERVAL_MS without redeploying.
 *
 * Callers that need a different policy (e.g. agent send uses 15×2000) can
 * still pass explicit values.
 */
export async function waitForCircleTx(
  id: string,
  maxAttempts = Number(process.env.CIRCLE_TX_POLL_ATTEMPTS ?? 8),
  intervalMs = Number(process.env.CIRCLE_TX_POLL_INTERVAL_MS ?? 3000)
): Promise<string> {
  if (!circleDev) throw new Error("Circle dev client not configured");

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const res = await circleDev.getTransaction({ id });
    const tx = res.data?.transaction;
    const state = tx?.state;

    if (state === "COMPLETE" || state === "CONFIRMED") {
      if (!tx?.txHash) throw new Error("Circle tx confirmed but no txHash returned");
      return tx.txHash;
    }
    if (state === "FAILED" || state === "CANCELLED" || state === "DENIED") {
      throw new Error(
        `Circle tx ${state.toLowerCase()}${tx?.errorReason ? `: ${tx.errorReason}` : ""}`
      );
    }
  }

  throw new Error(`Circle tx polling timed out (id: ${id})`);
}

// ── Treasury health ──────────────────────────────────────────────────

export async function getTreasuryBalance(): Promise<{
  address: string;
  state: string;
  tokens: Array<{ symbol: string; amount: string; tokenAddress: string | undefined }>;
}> {
  if (!circleDev) throw new Error("Circle dev client not configured");
  if (!treasuryWalletId) throw new Error("CIRCLE_TREASURY_WALLET_ID not set");

  const walletRes = await circleDev.getWallet({ id: treasuryWalletId });
  const wallet = walletRes.data?.wallet;
  if (!wallet) throw new Error("Treasury wallet not found");

  const balancesRes = await circleDev.getWalletTokenBalance({ id: treasuryWalletId });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tokens = (balancesRes.data?.tokenBalances ?? []).map((b: any) => ({
    symbol: b.token?.symbol ?? "?",
    amount: b.amount ?? "0",
    tokenAddress: b.token?.tokenAddress,
  }));

  return { address: wallet.address, state: wallet.state ?? "UNKNOWN", tokens };
}
