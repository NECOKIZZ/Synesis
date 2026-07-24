import { NextResponse } from "next/server";
import { Contract, JsonRpcProvider, formatUnits } from "ethers";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * GET /api/wallet/balance
 *
 * Server-side read of the signed-in user's main-wallet token balances on Arc.
 *
 * Why server-side: the wallet page previously read balances directly from the
 * browser via ethers against the Arc RPC. Browser→RPC calls are subject to CORS
 * and network flakiness, and every failure path silently fell back to "0" — so
 * a perfectly funded wallet could show a blank/zero balance. Reading here (same
 * RPC the server already uses for the over-spend guard) is reliable and lets us
 * surface a real error instead of a silent zero.
 */

const ARC_RPC_URL =
  process.env.NEXT_PUBLIC_ARC_RPC_URL || "https://rpc.testnet.arc.network";
const USDC_ADDRESS =
  process.env.NEXT_PUBLIC_USDC_TOKEN_ADDRESS ||
  "0x3600000000000000000000000000000000000000";
const EURC_ADDRESS = process.env.NEXT_PUBLIC_EURC_TOKEN_ADDRESS || "";
const CIRBTC_ADDRESS = process.env.NEXT_PUBLIC_CIRBTC_TOKEN_ADDRESS || "";

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

// Display-only USD rates (not used for money math).
const TOKEN_USD_RATES: Record<string, number> = {
  USDC: 1.0,
  EURC: 1.08,
  cirBTC: 100_000,
};

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const owner = session.walletAddress;

  const tokens = [
    { symbol: "USDC", name: "USD Coin", address: USDC_ADDRESS },
    ...(EURC_ADDRESS ? [{ symbol: "EURC", name: "Euro Coin", address: EURC_ADDRESS }] : []),
    ...(CIRBTC_ADDRESS ? [{ symbol: "cirBTC", name: "Circle BTC", address: CIRBTC_ADDRESS }] : []),
  ];

  const provider = new JsonRpcProvider(ARC_RPC_URL);
  let anyError = false;

  const tokenBalances = await Promise.all(
    tokens.map(async (t) => {
      try {
        const c = new Contract(t.address, ERC20_ABI, provider);
        const [raw, decimals] = await Promise.all([
          c.balanceOf(owner) as Promise<bigint>,
          c.decimals() as Promise<bigint>,
        ]);
        const amount = formatUnits(raw, decimals);
        return {
          symbol: t.symbol,
          name: t.name,
          address: t.address,
          amount,
          decimals: Number(decimals),
          usdValue: parseFloat(amount) * (TOKEN_USD_RATES[t.symbol] ?? 0),
        };
      } catch (err) {
        anyError = true;
        console.error(`[wallet/balance] ${t.symbol} read failed:`, err instanceof Error ? err.message : err);
        return {
          symbol: t.symbol,
          name: t.name,
          address: t.address,
          amount: "0",
          decimals: 6,
          usdValue: 0,
        };
      }
    })
  );

  const usdc = tokenBalances.find((b) => b.symbol === "USDC");

  return NextResponse.json({
    address: owner,
    balanceUsdc: usdc?.amount ?? "0",
    tokenBalances,
    // True only when every configured token read failed — lets the client
    // decide whether to fall back to its own direct RPC read.
    stale: anyError && tokenBalances.every((b) => b.amount === "0"),
  });
}
