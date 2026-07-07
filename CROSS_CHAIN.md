# Synesis — Cross-Chain Integration

**Status:** Working reference for all cross-chain work. Consolidates three prior docs.
**Last updated:** 2026-07-01
**Consolidates:** `BRIDGE_AND_YIELD_FIX_PLAN.md` (EVM bridge + Arbitrum yield), `SOLANA_INTEGRATION_PLAN.md` (Solana build plan), `solana-integration.md` (Solana feasibility research).

Three tracks, in priority order:

- **Part I — EVM Bridge + Cross-Chain Yield (Arc → Arbitrum).** The high-leverage track: fix the failing `BRIDGE_USDC` skill, then build `INVEST_YIELD` on AAVE v3. EVM chains share one address inside Circle custody.
- **Part II — Solana Integration Plan.** The active build: add Solana program-call capability via Circle's Signing API (build → Circle signs → we broadcast). Devnet first.
- **Part III — Solana Feasibility Research.** The reference behind Part II: what Circle DCW actually provides on Solana, the exact flow, gotchas, and the "defer vs proceed" analysis.

> **Sequencing rule:** EVM bridge is the gate. Nothing in Part I §6 (yield) or the Solana tracks matters until a plain Arc→Base_Sepolia bridge succeeds.

---

# PART I — EVM Bridge Fix + Cross-Chain Yield

**Scope:** (1) Fix the failing `BRIDGE_USDC` skill. (2) Establish the cross-chain wallet model. (3) Add `INVEST_YIELD` / `WITHDRAW_YIELD` on top of the fixed bridge.
Verified against Arc docs + the **installed** `@circle-fin/app-kit@1.6.1` typings.

## 0. TL;DR — why the bridge always fails

Five concrete defects, any one enough to fail every time on Arc Testnet:

| # | Defect | Symptom | Severity |
|---|--------|---------|----------|
| **1** | **No `maxFee` / `transferSpeed` / minimum-amount guard.** Arc Testnet's CCTPv2 **Fast** max fee is **~1.4 USDC**. Bridging ≤ that fee **reverts** with `"Max fee must be less than amount"`. | Burn reverts on small amounts | 🔴 #1 suspect |
| **2** | **`useForwarder: true` passed *with* a destination `adapter`**, but the Circle Wallets adapter has **no wallet on the destination chain** → mint can't be signed. Correct custodial mode: **omit destination adapter**, pass `recipientAddress` + `useForwarder: true`. | Mint fails / "no signer for destination" | 🔴 High |
| **3** | **No retry.** CCTP `fetchAttestation` / `mint` are *soft* errors on testnet. SDK ships `kit.retryBridge(result, …)` for this. | Intermittent attestation timeouts kill every run | 🟠 Medium |
| **4** | **Raw chain-name passthrough.** `asChain(toChain)` casts whatever the LLM emits. `"Arbitrum"`, `"arbitrum-sepolia"` → unsupported-chain failure. | "Chain not supported by CCTP" | 🟠 Medium |
| **5** | **Forwarder success mis-detection.** With `useForwarder` on, the mint step's `txHash`/`data` is `undefined` — success comes from IRIS API (`forwardState === 'CONFIRMED'`), not an on-chain receipt. Code keying off `mintStep?.txHash` misreads success as failure. | Successful bridges reported failed | 🟡 Low–Med |

**The fix is a rewrite of the `kit.bridge()` call + result handling — not a config tweak.**

## 1. What we currently have (verified)

- **Packages** (`package.json`): `@circle-fin/app-kit@^1.6.1`, `@circle-fin/adapter-circle-wallets@^1.3.1`, `@circle-fin/developer-controlled-wallets@^7.0.0`, `@circle-fin/user-controlled-wallets@^4.0.0`. Everything needed for bridge is present. **No `KIT_KEY` needed for bridge** (only swap needs it).
- **Adapter** (`lib/circleAdapter.ts`): `createCircleWalletsAdapter({ apiKey, entitySecret })` — correct.
- **Agent wallet:** a Circle developer-controlled wallet on **`ARC-TESTNET` only** (`lib/circle.ts`) — the crux of the cross-chain problem (§5).
- **Current call** (`lib/skills/bridge-usdc.ts:137`) passes destination `adapter` + `useForwarder` together (defect #2, #4), no `maxFee`/min (#1), no retry / txHash-keyed success (#3, #5).

## 2. Ground truth from docs + installed typings

1. **Arc Testnet min amount** — amount must exceed the CCTPv2 max fee (~1.4 USDC) or the burn reverts with `Max fee must be less than amount`. (`/app-kit/tutorials/bridge/configure-transfer-speed`)
2. **`config.maxFee` / `config.transferSpeed`** are valid `BridgeParams`. `transferSpeed: "SLOW"` = Standard Transfer (0% protocol fee, slower); `"FAST"` (default) incurs the ~1.4 USDC max fee on Arc.
3. **Forwarder custodial mode** — when you have no wallet on the destination chain, **omit the destination adapter and pass `recipientAddress` with `useForwarder: true`**. Mint confirmation comes from IRIS; the mint step's `data` is `undefined`. (`/app-kit/tutorials/bridge/use-forwarding-service`)
4. **Retry** — `kit.retryBridge(result, { from, to })`; `to` optional for forwarder-only destinations.
5. **Circle Wallets adapter supports `Arc_Testnet` and `Arbitrum_Sepolia`** for bridge → Arc→Arbitrum is a supported route.
6. **Exact chain enums** (`chains.d.ts`): `Arc_Testnet`, `Arbitrum_Sepolia`, `Base_Sepolia`, `Ethereum_Sepolia`, `Avalanche_Fuji`, `Polygon_PoS_Amoy`, `Solana_Devnet` — mainnet `Arbitrum`, `Base`, `Ethereum`, `Polygon_PoS`, etc.

## 3. The corrected bridge pattern

**Decision:** always use **forwarder custodial mode**. The agent only controls a wallet on Arc; for every outbound bridge it has no signer on the destination → omit destination adapter, pass `recipientAddress`, set `useForwarder: true`. Also removes the need for destination-chain gas.

### 3.2 Corrected `kit.bridge()` call
```ts
const kit = new AppKit();
const adapter = getCircleAdapter();

let result = await kit.bridge({
  from: { adapter, chain: fromChainEnum, address: agentWallet.circle_wallet_address },
  to:   { recipientAddress: toAddress, chain: toChainEnum, useForwarder: true }, // NO adapter
  amount: amount.toFixed(6),
  config: { transferSpeed: "FAST", maxFee: BRIDGE_MAX_FEE }, // e.g. "1.50" — must be < amount on Arc
});

if (result.state === "error") {
  result = await kit.retryBridge(result, { from: adapter }); // forwarder-only → omit `to`
}
```

### 3.3 Minimum-amount guard (defect #1)
```ts
const ARC_MIN_BRIDGE_USDC = Number(process.env.ARC_MIN_BRIDGE_USDC ?? "2.00");
if (fromChainEnum === "Arc_Testnet" && amount < ARC_MIN_BRIDGE_USDC) {
  return { ok: false, status: 400,
    error: `Bridging from Arc requires at least ${ARC_MIN_BRIDGE_USDC} USDC (CCTP fast-transfer fee is ~1.4 USDC and must be less than the amount).` };
}
```
> Alternative for tiny amounts: `transferSpeed: "SLOW"` (0% fee, minutes-slow). Recommendation: keep the floor for FAST UX, expose SLOW behind a param later.

### 3.4 Chain-name normalizer (defect #4) — `lib/skills/chains.ts`
```ts
import { Blockchain } from "@circle-fin/app-kit/chains";
const TESTNET_ALIASES: Record<string, string> = {
  arc: "Arc_Testnet", arc_testnet: "Arc_Testnet",
  arbitrum: "Arbitrum_Sepolia", arb: "Arbitrum_Sepolia", arbitrum_sepolia: "Arbitrum_Sepolia",
  base: "Base_Sepolia", base_sepolia: "Base_Sepolia",
  ethereum: "Ethereum_Sepolia", eth: "Ethereum_Sepolia", ethereum_sepolia: "Ethereum_Sepolia",
  polygon: "Polygon_PoS_Amoy", avalanche: "Avalanche_Fuji",
};
export function normalizeBridgeChain(input: string): string | null {
  const key = input.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const mapped = TESTNET_ALIASES[key] ?? key;
  return (Object.values(Blockchain) as string[]).includes(mapped) ? mapped : null;
}
```
On `null`, return 400 listing supported chains. Also feed the system prompt: tell Claude to emit only `Arbitrum_Sepolia` / `Base_Sepolia` / `Ethereum_Sepolia` on testnet.

### 3.5 Forwarder-aware success detection (defect #5)
```ts
// SUCCESS = result.state === "success". Do NOT require mintStep.txHash —
// in forwarder mode the mint is submitted by Circle's relayer and txHash is undefined.
const burnStep = steps.find((s) => s.name === "burn");   // the burn the user paid for (always present)
const mintStep = steps.find((s) => s.name === "mint");   // txHash null under forwarder — expected
if (result.state !== "success") { /* mark FAILED, surface failedStep.error */ }
```
The full drop-in `execute()` body keeps the existing auth/PIN/spend-limit/idempotency/logging scaffolding — only the `try { … }` block changes (bridge call + `retryBridge` + forwarder-aware success + `markFailed`/`markComplete` helpers around `agent_spend_log`).

## 4. Bridge fix — checklist
- [ ] Add `lib/skills/chains.ts` with `normalizeBridgeChain()`.
- [ ] Rewrite the `try` block of `bridge-usdc.ts` (forwarder custodial mode + `maxFee` + `retryBridge` + forwarder-aware success).
- [ ] Add the Arc min-amount guard.
- [ ] Update the `BRIDGE_USDC` system-prompt block in `lib/agent.ts` (+ `lib/skills/catalog.ts`): valid testnet chain enums only; min ≈ 2 USDC; clarify it bridges off Arc.
- [ ] Add env: `BRIDGE_MAX_FEE=1.50`, `ARC_MIN_BRIDGE_USDC=2.00`.
- [ ] **Manual test (most important):** from a funded Arc agent wallet, bridge **2 USDC Arc→Base_Sepolia** to the user's own address. Confirm `result.state === "success"` and the burn tx on `testnet.arcscan.app`.
- [ ] Re-seed skill embeddings if catalog text changed: `npm run seed:skills`.

## 5. Cross-chain wallet integration (what the yield skill needs)

### 5.1 The core fact
A Circle wallet set is a **hierarchical-deterministic (HD) wallet**: one index → **the same address on every EVM chain**. No raw `AGENT_PRIVATE_KEY` needed; you do NOT get a different address on Arbitrum. "Same address on both chains" is achievable *within Circle custody*.

**Catch:** signing on a chain requires a **wallet *record*** at that address on that chain. The agent wallet was created pinned to `ARC-TESTNET` only (`lib/agent.ts:319` → `blockchains: ["ARC-TESTNET"]`), so today there is no Arbitrum record to sign `approve()` / `supply()`. Materialize one with a single server-side call — no new key, no new address.

### 5.2 Two ways to get a signer at the same address on Arbitrum

| | **Path A — companion wallet on `ARB-SEPOLIA` (recommended)** | **Path B — single `EVM-TESTNET` multichain wallet** |
|---|---|---|
| What it is | Second wallet **record** at the **same address**, same wallet set | One record whose address signs any EVM testnet chain |
| Create | New: `createWallets({ blockchains: ["ARC-TESTNET","ARB-SEPOLIA"], walletSetId, accountType:"EOA", count:1 })` → shared address. Existing: backfill via **`PUT /wallets/{id}/blockchains/{blockchain}`** (Derive Wallet) | `createWallets({ blockchains:["EVM-TESTNET"], … })` |
| Who broadcasts AAVE tx | **Circle** — native `createContractExecutionTransaction` on `ARB-SEPOLIA` | **You** — sign via Circle Sign API, broadcast yourself via Arbitrum RPC |
| SDK support (v7) | `createWallets` ✅. Derive endpoint **not wrapped in SDK v7** → raw REST to backfill | `EVM`/`EVM-TESTNET` + Sign API in SDK ✅ |
| Complexity | Low — reuse existing `createContractExecutionTransaction` + `waitForCircleTx` | Higher — hand-build, sign, broadcast, confirm with ethers |

> **Why not raw `AGENT_PRIVATE_KEY`?** Dropped — second custody model outside Circle for no benefit now that unified addressing gives the same address inside Circle.

### 5.3 Recommended model (Path A)
```
Arc agent wallet (Circle, ARC-TESTNET, USDC) ── address 0xAGENT
   │ 1. kit.bridge() forwarder → recipientAddress = 0xAGENT (same address on Arbitrum)
   ▼
Arbitrum wallet record (Circle, ARB-SEPOLIA, 0xAGENT, USDC)
   │ 2. Circle createContractExecutionTransaction → USDC.approve(aavePool, amt)
   │ 3. Circle createContractExecutionTransaction → aavePool.supply(usdc, amt, 0xAGENT, 0)
   ▼
0xAGENT on Arbitrum holds aUSDC (earning AAVE v3 yield)
```

### 5.4 ⚠️ Gas gotcha — same address does NOT fix this
**Arbitrum Sepolia gas is ETH, not USDC.** The Arbitrum record still needs native ETH or `approve`/`supply` revert. Options: pre-fund ~0.01 Sepolia ETH from treasury (simplest); or SCA wallet + Circle **Gas Station** paymaster on `ARB-SEPOLIA` (SCA changes account type — decide *before* creating wallets); or (demo shortcut) pre-fund one shared agent address and gate yield to it.

### 5.5 Provisioning steps
- **New agents:** `createAgentWalletInCircle()` (`lib/agent.ts:318`) → `blockchains: ["ARC-TESTNET", "ARB-SEPOLIA"]` (same address both).
- **Existing agents:** backfill the Arbitrum record at the same address via Derive Wallet REST `PUT /wallets/{id}/blockchains/ARB-SEPOLIA` (entity-secret-ciphertext auth; not in SDK v7 → REST directly). One-time migration script.
- Persist `circle_wallet_id_arb` on the agent row (address is the same; you mainly need the Arbitrum *wallet id*). Migration `0019_agent_arb_wallet.sql`.
- Confirm a trivial Circle contract-execution on `ARB-SEPOLIA` (e.g. USDC self-transfer) **before** building yield.

## 6. The yield skill (`INVEST_YIELD` / `WITHDRAW_YIELD`)

**Files:** `lib/skills/invest-yield.ts` (bridge → approve → supply), `lib/skills/yield-types.ts` (`YieldProtocol` enum + per-protocol config), later `lib/skills/withdraw-yield.ts` (AAVE `withdraw()` → bridge back). Migration `0020_agent_yield_positions.sql`.

**`INVEST_YIELD.execute()` flow (Path A):**
1. Validate `amount` (≥ Arc min bridge), `protocol === "AAVE_V3"`. Enforce spend limits + PIN.
2. `PENDING` row in `agent_spend_log`.
3. **Bridge** Arc→`Arbitrum_Sepolia`, forwarder mode, `recipientAddress = agent's own address`. **Extract the bridge logic into a shared `lib/skills/bridge-core.ts` so both skills reuse it.**
4. **Wait for USDC to land** on the Arbitrum record (poll balance — forwarder mint isn't a receipt you hold).
5. **Approve:** Circle `createContractExecutionTransaction(arbWalletId, USDC, approve(aavePool, amountWei))`; `waitForCircleTx`.
6. **Supply:** Circle `createContractExecutionTransaction(arbWalletId, aavePool, supply(usdc, amountWei, agentAddress, 0))`; `waitForCircleTx`.
7. Mark `COMPLETE`; insert `agent_yield_positions`; return APR + tx hashes.

**Live APR (read-only `CHECK_YIELD`):** read `getReserveData(usdc).liquidityRate` from the AAVE DataProvider (RAY units, `/1e27*100`). Never hardcode. Use an `ethers` `JsonRpcProvider(ARBITRUM_RPC_URL)` (no signing).

**Partial-failure handling (critical):** bridge + supply are independent. If bridge lands but supply fails, USDC sits on the Arb wallet. Leave the log `FAILED`; make `INVEST_YIELD` **idempotent + resumable** — on retry, if the Arb wallet already holds ≥ amount, **skip the bridge** and go straight to approve+supply.

**Registration:** `lib/skills/index.ts` (flag-gate `YIELD_ENABLED`) · `lib/agent.ts` (`SkillName` + `VALID_SKILLS` + prompt block) · `lib/skills/catalog.ts` (+ re-seed embeddings) · `wallet-shell.tsx` (yield card renderer).

**Env:**
```bash
ARBITRUM_RPC_URL=https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY
ARBITRUM_AAVE_POOL=0x...
ARBITRUM_AAVE_DATA_PROVIDER=0x...
ARBITRUM_USDC_ADDRESS=0x...        # CCTP-minted USDC on Arb Sepolia
YIELD_ENABLED=false
```

## 7. Sequencing (do not skip the order)
1. **Fix + manually verify the bridge** (§3–§4). **This is the gate.**
2. **Provision the Arbitrum agent wallet** + solve the **gas gotcha** (§5.3–§5.4). Verify a trivial Circle contract-execution on Arb.
3. **Extract `bridge-core.ts`** so the yield skill reuses the proven bridge.
4. **Build `INVEST_YIELD`** (§6), test the handler in isolation before wiring UI.
5. **Add `WITHDRAW_YIELD`** + `CHECK_YIELD`.

## 8. Open questions before coding §6
- Gas model on Arbitrum Sepolia: pre-fund ETH per wallet, shared wallet, or SCA + Gas Station? (SCA-vs-EOA must be decided *before* creating wallets.)
- Path A vs Path B (§5.2). Recommendation: Path A.
- Existing-agent backfill: write the Derive-Wallet REST migration, or only support new agents?
- Confirm AAVE v3 is live on Arbitrum Sepolia; grab current Pool + DataProvider + CCTP-USDC addresses (verify, don't trust example addresses).
- FAST vs SLOW default for standalone `BRIDGE_USDC` (fee vs latency).

---

# PART II — Solana Integration Plan

**Status:** In progress. Devnet · heavy `signTransaction` track · fund wallets with SOL.
**Scope:** Add Solana program-interaction via Circle's Signing API (we build → Circle signs → we broadcast → we confirm). Prove on devnet with a real program call (SPL USDC transfer + idempotent ATA). Jupiter/pred-market swaps are a mainnet-gated Phase 2 on the same engine.

## 0. Why this differs from EVM
On EVM, Circle does `createContractExecutionTransaction` — build + sign + broadcast in one call. **Solana has no equivalent.** The only path is the **Signing API**: *we* build the tx, Circle signs, *we* broadcast and confirm. A whole transaction engine — but the **installed SDKs already support it** (no mandatory upgrades). See Part III for the full research.

## 1. Verified ground truth (installed versions)
- `@circle-fin/developer-controlled-wallets@7.3.0` exposes **`signTransaction({ walletId, rawTransaction, memo? }) → { data: { signature, signedTransaction, txHash? } }`**. `rawTransaction` is **base64** for Solana; SDK auto-injects `entitySecretCiphertext` like existing `createContractExecutionTransaction` calls in `lib/circle.ts`. Blockchain enum includes `SOL` / `SOL-DEVNET`.
- `@solana/web3.js@1.98.4`, `@solana/kit@5.5.1`, `@circle-fin/adapter-solana-kit@1.4.10` resolvable. App Kit@1.6.1 `bridge()` supports `Solana_Devnet`.

**Decisions:**
- Use **raw `circleDev.signTransaction`** (not adapter-solana-kit) — matches existing `circleDev` usage, avoids the @solana/kit paradigm and the version skew where `usdckit` bundles DCW v10.
- Use **legacy `Transaction`** (not `VersionedTransaction`) for the first skill — supports `serialize({ requireAllSignatures:false })` cleanly. VersionedTransaction deferred to the Jupiter phase.

## 2. Engine — `lib/solana/` (server-only)
| Module | Responsibility |
|---|---|
| `config.ts` | `SOLANA_RPC_URL` (default devnet), devnet USDC mint + decimals, priority-fee + confirm-timeout knobs. Env-driven. |
| `connection.ts` | Singleton `Connection` (commitment `confirmed`), mirrors the Arc provider in `lib/circle.ts`. |
| `fees.ts` | `ComputeBudgetProgram` priority-fee ixs + `assertSolForFees(address)` — reads native SOL, throws a clear "needs SOL" below a floor. |
| `sign.ts` | Core `signAndBroadcast(walletId, buildIxs, feePayer)`: fresh blockhash → build legacy tx → serialize unsigned base64 → `circleDev.signTransaction` → decode → `sendRawTransaction` → `confirmTransaction`. **Bounded rebuild-on-stale-blockhash retry.** Reuses `withTimeout` from `lib/circle.ts`. |
| `spl.ts` | `buildUsdcTransferIxs({ from, to, amount })`: idempotent recipient-ATA creation + `createTransferCheckedInstruction`. |

## 3. Schema — `supabase/migrations/0019_solana_wallet.sql`
- `agent_wallets`: add `blockchain text not null default 'ARC-TESTNET'`; drop `UNIQUE(user_id)`; add `UNIQUE(user_id, blockchain)`. Non-breaking backfill.
- `agent_spend_log`: add `blockchain text not null default 'ARC-TESTNET'`. Solana rows stamp `'SOL-DEVNET'`.

## 4. Wallet provisioning
- `createAgentWalletInCircle(blockchain = "ARC-TESTNET")` (`lib/agent.ts`) — pass blockchain to `createWallets({ blockchains:[blockchain], accountType:"EOA", walletSetId })`. Solana is **EOA-only**.
- New route `app/api/agent/activate-solana/route.ts` (mirrors `activate/route.ts`): create the `SOL-DEVNET` wallet, persist row `blockchain:'SOL-DEVNET'`, idempotent.
- **SOL funding (devnet):** attempt airdrop + document treasury-SOL top-up fallback. `assertSolForFees` gates every signing attempt.

## 5. SkillContext
- `AgentWallet` (`lib/skills/types.ts`): add `blockchain?: string`.
- `SkillContext`: add `agentSolanaWallet?: AgentWallet | null`.
- `confirm-policy/route.ts`: load **all** agent_wallets rows, split into `agentWallet` (ARC-TESTNET) + `agentSolanaWallet` (SOL-DEVNET), inject both. Solana skills fail clearly if `agentSolanaWallet` is null ("activate Solana first").

## 6. First skill — `SEND_SOLANA_USDC` (`lib/skills/send-solana-usdc.ts`)
Mirrors `send-usdc.ts` + `bridge-usdc.ts`:
- `category:"TRANSFER"`, `affectsFunds:true`, `requiresPin:true`, `requiresBalanceCheck:true`.
- params `{ recipient: base58, amount }`. Validate via `new PublicKey()` (not EVM `isAddress`).
- `PENDING` log (`blockchain:'SOL-DEVNET'`) before signing → `COMPLETE`/`FAILED` finalize.
- `assertSolForFees` → `buildUsdcTransferIxs` → `signAndBroadcast` → return `{ txHash, explorerUrl, amount, recipient }`.
- `idempotencyKey`: `SEND_SOLANA_USDC:<recipient>:<amount>:<dayUTC>`.

## 7. Registration touch-points
`lib/skills/index.ts` (flag-gate `SOLANA_ENABLED`) · `lib/agent-types.ts` (SkillName) · `lib/agent.ts` (VALID_SKILLS) · `lib/agent-core-v3.ts` (prose) · `lib/skills/catalog.ts` (catalog) · `.env.example` (`SOLANA_ENABLED`, `SOLANA_RPC_URL`, `SOLANA_USDC_MINT`). Re-seed embeddings if `SKILL_ROUTER_ENABLED=true`.

## 8. Phase 2 (Jupiter / pred-market — mainnet-gated, NOT now)
Reuses `signAndBroadcast`. Jupiter returns a base64 `VersionedTransaction`: deserialize, can't `.sign()` → re-serialize the unsigned **message** and Circle-sign. Gotchas: `VersionedTransaction.serialize()` has no `requireAllSignatures:false` (work at message level); ALT fetching; ~1232-byte / `SignTransactionRawTransactionTooLarge` cap; Jupiter Ultra partial-signing (MM adds 2nd sig in `/execute`). Liquidity ⇒ **mainnet only**.

## 9. Devnet verification
1. Apply migration `0019`; `agent_wallets` accepts a 2nd row per user.
2. `POST /api/agent/activate-solana` → SOL-DEVNET wallet row.
3. Fund with devnet SOL + devnet USDC; `assertSolForFees` passes.
4. `SOLANA_ENABLED=true`; interpret *"send 1 USDC to `<base58>` on solana"* → confirm → PIN → execute. Watch build→sign→broadcast→confirm.
5. Verify on `explorer.solana.com/...?cluster=devnet`; recipient ATA created if missing.
6. `agent_spend_log`: `blockchain='SOL-DEVNET'`, `COMPLETE`, `tx_hash` set. Re-run same day → idempotency.
7. Negative: drain SOL → clean "needs SOL" failure.

## 10. Risks
- **SOL funding (High):** USDC ≠ fees; `assertSolForFees` makes it explicit; devnet airdrop flaky → treasury fallback.
- **Blockhash expiry (Med):** bounded rebuild-on-stale retry in `sign.ts`.
- **Devnet RPC (Med):** `SOLANA_RPC_URL` override (Helius/QuickNode).
- **Dep skew (Low):** sign with root `circleDev` v7.3.0, never `usdckit`'s DCW.
- Additive + flag-gated (`SOLANA_ENABLED=false` default). No commits until the full track is verified.

---

# PART III — Solana Feasibility Research (reference)

**Research date:** June 26–27, 2026. **Status:** Possible, with significant engineering overhead vs. EVM. This is the analysis behind Part II's decisions.

## 1. Executive verdict
**Yes — technically possible.** Circle DCW supports Solana through the `signTransaction` Signing API. Circle signs any raw Solana transaction you build. But unlike EVM (`createContractExecutionTransaction` = build + sign + broadcast in one call), the Solana path requires you to: (1) build the entire tx yourself, (2) serialize unsigned to base64, (3) send to Circle for signing, (4) receive signed tx, (5) broadcast via your own RPC, (6) handle confirmation, retries, blockhash expiry. **The delta is architectural, not marginal.**

## 2. What Circle actually provides
| Capability | EVM | Solana |
|---|---|---|
| `createContractExecutionTransaction` (build+sign+broadcast) | ✅ | ❌ **Not available** |
| `signTransaction` (you build, Circle signs, **you broadcast**) | ✅ (hex) | ✅ (base64) — supports `SOL`, `SOL-DEVNET` |
| `createTransaction` (simple transfer) | ✅ | ✅ (native SOL only) |
| `toSolanaSigner` adapter | N/A | ✅ subpath export |
| SCA support | ✅ | ❌ EOA only |
| Gas Station (sponsored gas) | ✅ | ✅ (still need SOL for non-sponsored) |

## 3. The exact flow
1. **Build yourself** — `@solana/web3.js`, add instructions, fetch recent blockhash, set fee payer, `serialize({ requireAllSignatures: false, verifySignatures: false })` (essential — tx is unsigned because Circle holds the key).
2. **Send to Circle** — `client.signTransaction({ walletId, rawTransaction: raw.toString("base64") })` → `{ signature, signedTransaction (base64), txHash }`. base64 is REQUIRED for Solana (hex for EVM; enforced per-chain).
3. **Broadcast yourself** — `connection.sendRawTransaction(Buffer.from(signedTransaction, "base64"))`. You own broadcast, retry, confirm.

**SDK adapters:** DCW v10.6.0+ ships two opt-in Solana signer subpath adapters (`@solana/web3.js` and `@solana/kit`), both `createTransactionSigner(...)` delegating to the Signing API. Root import pulls in no Solana code. *(Part II opts to use raw `signTransaction` on v7.3.0 instead, to avoid version skew.)*

## 4. Smart-contract interaction — what works
Solana txs are atomic bundles of instructions (`programId`, `accounts`, `data`). If you can construct the instruction (manually, via Anchor IDL, or a protocol SDK), Circle can sign it. Working patterns: native SOL transfer (System Program), SPL transfer (`createTransferCheckedInstruction` + ATA), Jupiter swap (API returns pre-built tx), USDC bridge via CCTP (`MessageTransmitterV2`/`TokenMessengerMinterV2`), memo, custom program calls.

## 5. EVM vs Solana — engineering burden
On Solana **you** handle everything Circle abstracts on EVM: instruction/account construction, `recentBlockhash` (no nonce), `ComputeBudgetProgram` fees, manual/Anchor ABI encoding, ATA creation, ~1232-byte legacy tx size cap (ALTs raise it), broadcasting, confirmation polling, and blockhash-expiry retry loops. Solana fails atomically — no partial success, no revert reason string.

## 6. Case study — Jupiter swap
Normal flow: `/swap` → base64 `VersionedTransaction` → deserialize → `.sign([keypair])` → broadcast. **Circle DCW flow:** you can't `.sign()` (no key), so re-serialize the **unsigned** VersionedTransaction. **Gotcha:** `VersionedTransaction.serialize()` doesn't accept `{ requireAllSignatures: false }` — work at the `MessageV0` level or use the Circle adapter. **Partial-signing gotcha:** Jupiter Ultra returns txs needing partial signing — your wallet signs, then a market maker adds its signature in `/execute`. Circle signs your portion but doesn't participate in `/execute`; you'd send the partially-signed tx to Jupiter's `/execute` for the MM's final sig. Theoretically possible, untested with Circle — a live integration risk.

## 7. Hard limitations
- **`createContractExecutionTransaction` = EVM only.** Biggest architectural delta.
- **EOA only.** No SCAs on Solana.
- **`SignTransactionRawTransactionTooLarge`.** Circle rejects txs over the size limit (~1232 bytes legacy; ALTs help but bounded). Complex multi-hop Jupiter swaps approach this.
- **Blockhash expiry is your problem.** Blockhash ages out in ~45–90s; if Circle's async round-trip is slow, the signed tx is dead on arrival → fetch new blockhash, rebuild, re-sign. No auto-retry in Circle's API.
- **No automatic ATA setup.** Recipient must have an ATA for the mint; bundle `createAssociatedTokenAccountIdempotent` before the transfer. Circle doesn't create ATAs.
- **Address Lookup Tables (ALTs).** Versioned txs reference ALTs you must fetch and include — significant complexity over legacy `Transaction`.

## 8. The SOL funding problem (critical)
Circle DCW creates a Solana address; by default it holds **USDC**, but Solana txs need **SOL** for fees. 100 USDC + 0 SOL = can't execute anything, not even a USDC SPL transfer. Options: devnet airdrop (`requestAirdrop`, devnet only); fund from treasury (manual, needs monitoring — the mainnet answer); can't wrap USDC→SOL without a swap; Jupiter-swap a small amount to SOL (adds a prerequisite before every user's first tx). **On mainnet you need an operational pipeline keeping every Solana agent wallet topped up with SOL.** Invisible on EVM where Circle abstracts gas.

## 9. Final recommendation
**Possible? Yes.** Any instruction buildable with `@solana/web3.js` can be Circle-signed and self-broadcast.
**Worth it right now? Defer behind EVM.** Reasons: (1) EVM is the high-leverage fix — derive the existing `walletSet` to Arbitrum/Base in one call, unlocking AAVE/Uniswap via the `createContractExecutionTransaction` path you already know (Part I). (2) Jupiter alone is a full project track (VersionedTransaction, partial signing, blockhash, compute budget, broadcast retries). (3) No existing Solana memory tables. (4) SOL funding is an ongoing operational dependency.

**If you proceed:** Phase 1 SPL transfer POC (devnet, prove build→sign→broadcast) → Phase 2 native SOL + blockhash handling → Phase 3 single-hop Jupiter (devnet) → Phase 4 Jupiter production (multi-hop, partial signing, ALTs, mainnet) → Phase 5 memory & skills. **Bottom line: fix EVM multichain first; Solana is a parallel track, not a quick add-on.**

## Key sources
Circle: [Sign Transactions on Solana](https://developers.circle.com/wallets/sign-tx-solana) · [Sign Transactions (general)](https://developers.circle.com/wallets/sign-transactions) · [signTransaction API ref](https://developers.circle.com/api-reference/wallets/developer-controlled-wallets/sign-transaction) · [Dev-Controlled Wallets](https://developers.circle.com/wallets/dev-controlled) · [solana-cctp-contracts](https://github.com/circlefin/solana-cctp-contracts). Solana: [Transactions](https://solana.com/docs/core/transactions) · [Versioned Transactions](https://solana.com/developers/guides/advanced/versions). Jupiter: [Order & Execute](https://developers.jup.ag/docs/swap/order-and-execute). Helius: [Jupiter Swap via Sender](https://www.helius.dev/docs/sending-transactions/jupiter-swap-api-via-sender).
