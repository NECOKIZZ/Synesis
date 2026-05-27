# DotArc — Bridge & Swap Skill Integration

> Arc App Kit integration guide using Circle Wallets adapter (developer-controlled wallets).
> No new credentials required beyond what is already in your `.env`.

---

## Prerequisites

### New credential — Kit Key (Swap only)
Get a free Kit Key from [console.circle.com](https://console.circle.com).
Bridge does not need it. Add it to `.env`:

```
KIT_KEY=YOUR_KIT_KEY_FROM_CIRCLE_CONSOLE
```

### Installation

```bash
# Full kit — Bridge + Swap in one package
npm install @circle-fin/app-kit @circle-fin/adapter-circle-wallets
```

Or install only what you need:

```bash
npm install @circle-fin/swap-kit @circle-fin/adapter-circle-wallets
npm install @circle-fin/bridge-kit @circle-fin/adapter-circle-wallets
```

---

## Shared Adapter Setup

Both skills use the same Circle Wallets adapter. Wire it up once in a shared utility:

```typescript
// lib/circleAdapter.ts
import { createCircleWalletsAdapter } from "@circle-fin/adapter-circle-wallets";

export function getCircleAdapter() {
  return createCircleWalletsAdapter({
    apiKey: process.env.CIRCLE_API_KEY!,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
  });
}
```

This is server-side only. Never import this in frontend code.

---

## SWAP_TOKENS Skill

### What it does
Swaps one token for another on Arc Testnet. Arc Testnet supports USDC, EURC, and cirBTC only.

### Supported token pairs on Arc Testnet
- USDC → EURC
- EURC → USDC
- USDC → cirBTC
- cirBTC → USDC

### Implementation

```typescript
// lib/skills/swapTokens.ts
import { AppKit } from "@circle-fin/app-kit";
import { getCircleAdapter } from "@/lib/circleAdapter";

const kit = new AppKit();

interface SwapParams {
  agentWalletAddress: string;
  tokenIn: "USDC" | "EURC" | "cirBTC";
  tokenOut: "USDC" | "EURC" | "cirBTC";
  amountIn: string; // human-readable e.g. "10.00"
}

export async function executeSwap(params: SwapParams) {
  const { agentWalletAddress, tokenIn, tokenOut, amountIn } = params;

  const adapter = getCircleAdapter();

  const result = await kit.swap({
    from: {
      adapter,
      chain: "Arc_Testnet",
      address: agentWalletAddress,
    },
    tokenIn,
    tokenOut,
    amountIn,
    config: {
      kitKey: process.env.KIT_KEY!,
    },
  });

  // result shape:
  // {
  //   tokenIn, tokenOut, chain,
  //   amountIn, amountOut,
  //   fromAddress, toAddress,
  //   txHash, explorerUrl,
  //   fees: [{ token, amount, type }]
  // }
  return result;
}
```

### API Route

```typescript
// app/api/agent/swap/route.ts
import { NextRequest, NextResponse } from "next/server";
import { executeSwap } from "@/lib/skills/swapTokens";
import { validateAgentPolicy } from "@/lib/policyEngine";
import { getUserFromJWT } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const user = getUserFromJWT(req);
  const { tokenIn, tokenOut, amountIn } = await req.json();

  // Policy check — same pattern as SEND_USDC
  const policy = await validateAgentPolicy({
    userId: user.id,
    action: "SWAP_TOKENS",
    amount: amountIn,
    token: tokenIn,
  });

  if (!policy.approved) {
    return NextResponse.json({ error: policy.reason }, { status: 403 });
  }

  const result = await executeSwap({
    agentWalletAddress: user.agentWalletAddress,
    tokenIn,
    tokenOut,
    amountIn,
  });

  // Log to transactions table
  await logTransaction({
    userId: user.id,
    type: "swap",
    tokenIn,
    tokenOut,
    amountIn,
    amountOut: result.amountOut,
    txHash: result.txHash,
    explorerUrl: result.explorerUrl,
  });

  return NextResponse.json(result);
}
```

### Claude Skill Definition

Add to the skill list sent to `/api/agent/interpret`:

```typescript
{
  name: "SWAP_TOKENS",
  description: "Swap one token for another on Arc. Available tokens: USDC, EURC, cirBTC.",
  parameters: {
    token_in: "string",   // USDC | EURC | cirBTC
    token_out: "string",  // USDC | EURC | cirBTC
    amount: "string",     // human-readable amount e.g. "10.00"
  },
  examples: [
    "swap 10 USDC to EURC",
    "convert my 5 USDC to cirBTC",
    "exchange 20 EURC for USDC",
  ],
}
```

### Confirmation Card

Show this before executing — same pattern as SEND_USDC confirmation:

```
┌─────────────────────────────────┐
│  Swap                           │
│                                 │
│  10.00 USDC  →  ~9.93 EURC      │
│                                 │
│  Fee: 0.001 USDC                │
│  Network: Arc Testnet           │
│                                 │
│  [Confirm]   [Cancel]           │
└─────────────────────────────────┘
```

Use `kit.swap()` with `dryRun: true` (or call a rate estimate endpoint) to populate the `~9.93 EURC` before the user confirms.

---

## BRIDGE_USDC Skill

### What it does
Moves USDC from another chain into Arc (or out of Arc to another chain).
Uses CCTP under the hood — App Kit handles the burn → attestation → mint flow automatically.

### Two contexts in DotArc

| Context | Direction | Who signs | How |
|---|---|---|---|
| User funds wallet from another chain | Ethereum → Arc | User (browser wallet) | Frontend: `createViemAdapterFromProvider` |
| Agent withdraws to another chain | Arc → Ethereum | Backend (MPC) | Backend: `createCircleWalletsAdapter` |

### Implementation — Backend (Agent Wallet, developer-controlled)

This is Phase 4: CCTP cross-chain withdrawals from the agent wallet.

```typescript
// lib/skills/bridgeUsdc.ts
import { AppKit } from "@circle-fin/app-kit";
import { getCircleAdapter } from "@/lib/circleAdapter";

const kit = new AppKit();

interface BridgeParams {
  fromChain: string;         // "Arc_Testnet"
  toChain: string;           // "Ethereum_Sepolia"
  fromAddress: string;       // agent wallet address on Arc
  toAddress: string;         // destination address on target chain
  amount: string;            // human-readable e.g. "50.00"
}

export async function executeBridge(params: BridgeParams) {
  const { fromChain, toChain, fromAddress, toAddress, amount } = params;

  const adapter = getCircleAdapter();

  const result = await kit.bridge({
    from: {
      adapter,
      chain: fromChain,
      address: fromAddress,
    },
    to: {
      adapter,
      chain: toChain,
      address: toAddress,
    },
    amount,
  });

  // result.steps — array of CCTP steps (approve, burn, attest, mint)
  // Each step has: name, state, txHash, explorerUrl
  return result;
}
```

### Implementation — Frontend (User Wallet, user-controlled)

For the "Deposit from another chain" flow in the main wallet UI. The user connects their external wallet (MetaMask etc.) and bridges USDC into their `maya.arc` address on Arc.

```typescript
// This runs in the browser — NOT in an API route
import { AppKit } from "@circle-fin/app-kit";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";

const kit = new AppKit();

export async function bridgeUserFunds({
  destinationAddress, // maya.arc resolved to 0x address
  amount,
}: {
  destinationAddress: string;
  amount: string;
}) {
  if (!window.ethereum) throw new Error("No wallet found");

  // User signs via their connected external wallet
  const adapter = await createViemAdapterFromProvider({
    provider: window.ethereum,
  });

  const result = await kit.bridge({
    from: { adapter, chain: "Ethereum_Sepolia" },
    to: { adapter, chain: "Arc_Testnet", address: destinationAddress },
    amount,
  });

  return result;
}
```

> Note: Install `@circle-fin/adapter-viem-v2 viem` for the frontend path.

### API Route (backend bridge only)

```typescript
// app/api/agent/bridge/route.ts
import { NextRequest, NextResponse } from "next/server";
import { executeBridge } from "@/lib/skills/bridgeUsdc";
import { validateAgentPolicy } from "@/lib/policyEngine";
import { getUserFromJWT } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const user = getUserFromJWT(req);
  const { toChain, toAddress, amount } = await req.json();

  const policy = await validateAgentPolicy({
    userId: user.id,
    action: "BRIDGE_USDC",
    amount,
    token: "USDC",
  });

  if (!policy.approved) {
    return NextResponse.json({ error: policy.reason }, { status: 403 });
  }

  const result = await executeBridge({
    fromChain: "Arc_Testnet",
    toChain,
    fromAddress: user.agentWalletAddress,
    toAddress,
    amount,
  });

  await logTransaction({
    userId: user.id,
    type: "bridge",
    fromChain: "Arc_Testnet",
    toChain,
    amount,
    steps: result.steps,
  });

  return NextResponse.json(result);
}
```

### Claude Skill Definition

```typescript
{
  name: "BRIDGE_USDC",
  description: "Bridge USDC from Arc to another blockchain, or initiate a cross-chain withdrawal.",
  parameters: {
    to_chain: "string",    // "Ethereum_Sepolia", "Base_Sepolia", etc.
    to_address: "string",  // destination wallet address on target chain
    amount: "string",      // human-readable e.g. "50.00"
  },
  examples: [
    "withdraw 50 USDC to my Ethereum wallet 0xABC...",
    "bridge 100 USDC to Base",
    "move 25 USDC out to Sepolia",
  ],
}
```

---

## Supported Chains (App Kit + Circle Wallets Adapter)

| Chain | Bridge | Swap |
|---|---|---|
| Arc Testnet | ✓ | ✓ (USDC, EURC, cirBTC only) |
| Ethereum Sepolia | ✓ | ✗ |
| Base Sepolia | ✓ | ✗ |
| Solana Devnet | ✓ | ✗ |

Full list: [docs.arc.io/app-kit/references/supported-blockchains](https://docs.arc.io/app-kit/references/supported-blockchains)

---

## Build Order

```
Phase 3 (now)
  □ Install @circle-fin/app-kit + adapter
  □ Get Kit Key from console.circle.com
  □ Add KIT_KEY to .env
  □ Add SWAP_TOKENS to Claude skill list
  □ Implement /api/agent/swap route
  □ Add swap confirmation card to UI
  □ Add swap entries to transactions table (type: 'swap')

Phase 4
  □ Implement BRIDGE_USDC backend skill (agent → external chain)
  □ Add /api/agent/bridge route
  □ Add bridge UI flow for user deposits (frontend adapter)
  □ Add bridge entries to transactions table (type: 'bridge')
```

---

## Errors to Handle

```typescript
// Swap
"INSUFFICIENT_BALANCE"     // agent wallet has less than amountIn
"UNSUPPORTED_TOKEN_PAIR"   // token pair not available on Arc
"SLIPPAGE_EXCEEDED"        // price moved too much — retry or increase tolerance
"KIT_KEY_INVALID"          // check console.circle.com

// Bridge
"CCTP_ATTESTATION_TIMEOUT" // attestation took too long — check result.steps for last step
"INSUFFICIENT_BALANCE"     // not enough USDC on source chain
"UNSUPPORTED_CHAIN"        // chain not in supported list
```

For bridge errors, check [docs.arc.io/app-kit/references/bridge-error-recovery](https://docs.arc.io/app-kit/references/bridge-error-recovery) — CCTP failures are recoverable and App Kit documents the retry path.
