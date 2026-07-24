/**
 * Minimal ANS registry helpers. Inlined from @arcnames/sdk so this project
 * has zero dependencies on the .arc monorepo.
 *
 * If the SDK is ever published to npm, swap these helpers for the package.
 */

import "server-only";
import { Contract, JsonRpcProvider } from "ethers";
import { AppError } from "./errors";
import { withResilience } from "./resilience";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

const RPC_URL =
  process.env.NEXT_PUBLIC_ARC_RPC_URL || "https://rpc.testnet.arc.network";
const REGISTRY_ADDRESS =
  process.env.NEXT_PUBLIC_ANS_REGISTRY_ADDRESS ||
  "0xf5e0E328119D16c75Fb4a001282a3a7b733EF6db";

const ABI = [
  "function isAvailable(string label) view returns (bool)",
  "function resolve(string label) view returns (address)",
  "function reverseLookup(address) view returns (string)",
];

const provider = new JsonRpcProvider(RPC_URL);
const registry = new Contract(REGISTRY_ADDRESS, ABI, provider);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Normalise a name input. Strips any `.arc` suffix, lowercases, trims.
 */
export function normalizeName(name: string): string {
  let label = name.toLowerCase().trim();
  if (label.endsWith(".arc")) label = label.slice(0, -4);
  return label;
}

export async function isAvailable(label: string): Promise<boolean> {
  return await registry.isAvailable(label);
}

/**
 * DB fallback for forward resolution (name → address).
 *
 * `profiles.arc_name` (UNIQUE) is the SOURCE OF TRUTH while the on-chain ANS
 * registry is unavailable — the schema was designed for exactly this ("fast-
 * lookup wallets by name without going on-chain", 0001_profiles.sql). Uses the
 * service-role client because RLS on `profiles` otherwise limits reads to the
 * signed-in user's own row, and recipient resolution is inherently cross-user.
 *
 * `label` must already be normalized (lowercased, no `.arc` suffix) — the same
 * form `setArcNameForCurrentUser` writes. Returns null if no user owns the
 * label or on ANY DB/config error (never throws — callers fall back on-chain).
 */
export async function resolveNameViaDb(label: string): Promise<string | null> {
  try {
    const supabase = createSupabaseServiceClient();
    const { data, error } = await supabase
      .from("profiles")
      .select("wallet_address")
      .eq("arc_name", label)
      .maybeSingle();
    if (error || !data?.wallet_address) return null;
    return data.wallet_address as string;
  } catch {
    return null;
  }
}

export async function resolveName(label: string): Promise<string | null> {
  // DB-first: reliable + instant while on-chain ANS is unavailable.
  const dbAddr = await resolveNameViaDb(label);
  if (dbAddr) return dbAddr;
  try {
    const addr: string = await registry.resolve(label);
    if (!addr || addr === ZERO_ADDRESS) return null;
    return addr;
  } catch {
    return null;
  }
}

export async function reverseLookup(address: string): Promise<string | null> {
  try {
    const name: string = await registry.reverseLookup(address);
    return name && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/**
 * Distinguish a TRANSIENT RPC/transport failure (node unreachable, timeout,
 * connection reset) from a definitive contract-level answer. This is the crux
 * of F-17: `resolveName` above catches every error and returns null, so a
 * network blip looked identical to "this name has no owner" — and the user was
 * told a perfectly valid recipient "is not registered". A transient failure
 * must be retryable and phrased as "couldn't verify, try again", never terminal.
 */
export function isTransientRpcError(err: unknown): boolean {
  const e = err as {
    code?: string;
    message?: string;
    error?: { code?: string };
    cause?: { code?: string };
  };
  const ethersCode = String(e?.code ?? "").toUpperCase();
  // ethers v6 transport-layer error codes → transient.
  if (ethersCode === "NETWORK_ERROR" || ethersCode === "TIMEOUT" || ethersCode === "SERVER_ERROR") {
    return true;
  }
  // A contract revert is a definitive answer, NOT a transport failure.
  if (ethersCode === "CALL_EXCEPTION") return false;
  // Node-level connection error codes, sometimes nested under cause/error.
  const nested = String(e?.error?.code ?? e?.cause?.code ?? "").toUpperCase();
  if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(nested)) {
    return true;
  }
  const msg = String(e?.message ?? err ?? "").toLowerCase();
  return /timeout|timed out|etimedout|econnreset|econnrefused|enotfound|eai_again|fetch failed|socket hang up|could not detect network|network error/.test(
    msg,
  );
}

/**
 * Resolve a recipient string (0x address or .arc name) to a validated 0x address.
 * Throws a typed AppError:
 *   - RECIPIENT_NOT_FOUND (terminal)   — bad address, malformed name, or the
 *                                        registry definitively has no owner.
 *   - NETWORK (retryable, transient)   — the RPC lookup itself failed; we do
 *                                        NOT know whether the name exists (F-17).
 * Used server-side before executing any agent transfer.
 */
export async function resolveRecipient(input: string): Promise<string> {
  const { isAddress } = await import("ethers");
  const trimmed = input.trim();

  if (trimmed.startsWith("0x")) {
    if (!isAddress(trimmed)) {
      throw new AppError("RECIPIENT_NOT_FOUND", `Invalid wallet address: ${trimmed}`);
    }
    return trimmed;
  }

  const label = normalizeName(trimmed);
  if (!/^[a-z0-9-]{3,32}$/.test(label)) {
    throw new AppError("RECIPIENT_NOT_FOUND", `Invalid .arc name: ${trimmed}`);
  }

  // DB-FIRST resolution: profiles.arc_name is the source of truth while the
  // on-chain ANS registry is unavailable. This is the demo-critical path
  // (agent SEND_USDC → resolveRecipient) — a DB read is fast, reliable, and
  // never subject to the Arc RPC flakiness that plagues the on-chain call.
  const dbAddress = await resolveNameViaDb(label);
  if (dbAddress) return dbAddress;

  // Resolve DIRECTLY (not via resolveName's catch-all→null) so a transient RPC
  // failure can be told apart from a genuine "no owner" (F-17).
  //
  // D5: wrap the RPC read in withResilience — a single transient blip now
  // self-heals with one bounded retry before we ever surface an error, and a
  // sustained outage trips the shared "arc-rpc" breaker (which ANS + any other
  // Arc RPC reader can share) so we fail fast instead of hanging per call. The
  // retry predicate is `isTransientRpcError` (ethers-code aware), NOT the
  // generic message matcher — a CALL_EXCEPTION (contract revert) is a
  // definitive answer and must NOT be retried.
  let address: string;
  try {
    address = await withResilience(() => registry.resolve(label) as Promise<string>, {
      label: `ans/resolve(${label})`,
      breakerKey: "arc-rpc",
      timeoutMs: Number(process.env.ANS_TIMEOUT_MS ?? 8_000),
      retries: Number(process.env.ANS_MAX_RETRIES ?? 1),
      isRetryable: isTransientRpcError,
    });
  } catch (err) {
    // withResilience only reaches here after retries are exhausted (transient)
    // or immediately on a non-transient error. Re-derive the terminal/transient
    // split from the ORIGINAL cause so the message + retryable stay F-17-correct.
    const cause = err instanceof AppError ? err.originalCause ?? err : err;
    if (isTransientRpcError(cause) || (err instanceof AppError && err.retryable)) {
      throw new AppError(
        "NETWORK",
        `Couldn't verify ${label}.arc right now — the network is flaky. Try again in a moment.`,
        { retryable: true, cause },
      );
    }
    // Contract-level failure (revert etc.) → the name has no valid resolution.
    throw new AppError("RECIPIENT_NOT_FOUND", `${label}.arc is not registered`, { cause });
  }
  if (!address || address === ZERO_ADDRESS) {
    throw new AppError("RECIPIENT_NOT_FOUND", `${label}.arc is not registered`);
  }
  return address;
}
