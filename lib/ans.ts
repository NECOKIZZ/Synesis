/**
 * Minimal ANS registry helpers. Inlined from @arcnames/sdk so this project
 * has zero dependencies on the .arc monorepo.
 *
 * If the SDK is ever published to npm, swap these helpers for the package.
 */

import "server-only";
import { Contract, JsonRpcProvider } from "ethers";

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

export async function resolveName(label: string): Promise<string | null> {
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
 * Resolve a recipient string (0x address or .arc name) to a validated 0x address.
 * Throws if the input is invalid or the name is unregistered.
 * Used server-side before executing any agent transfer.
 */
export async function resolveRecipient(input: string): Promise<string> {
  const { isAddress } = await import("ethers");
  const trimmed = input.trim();

  if (trimmed.startsWith("0x")) {
    if (!isAddress(trimmed)) throw new Error(`Invalid wallet address: ${trimmed}`);
    return trimmed;
  }

  const label = normalizeName(trimmed);
  if (!/^[a-z0-9-]{3,32}$/.test(label)) {
    throw new Error(`Invalid .arc name: ${trimmed}`);
  }

  const address = await resolveName(label);
  if (!address) throw new Error(`${label}.arc is not registered`);
  return address;
}
