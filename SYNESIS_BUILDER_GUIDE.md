# Synesis Skill Builder Guide

How to build agent skills for Project Synesis — developer-controlled wallets on Arc that navigate the blockchain based on user intent. This guide uses the Cross-Chain Yield skill as the primary worked example, drawing from the [arc-cross-yield-agents](https://github.com/compassailabs/arc-cross-yield-agents) reference implementation.

---

## 1. Mental model

Every Synesis interaction follows the same three-step pipeline regardless of what the skill does:

```
User message (natural language)
        │
        ▼
  INTERPRET  →  Claude parses intent → returns structured JSON skill call
        │
        ▼
  CONFIRM    →  User sees ConfirmCard, enters PIN (if required)
        │
        ▼
  EXECUTE    →  Skill handler runs, signs tx, updates DB, returns result
```

The agent never gives Claude direct access to keys or wallets. Claude only decides *what* to do. The executor decides *whether it's allowed* and *how to do it*. This separation is the core security model.

---

## 2. What a skill is

A skill is a pair of things:

**A JSON definition** that Claude returns from the interpret step:

```json
{
  "skill": "INVEST_YIELD",
  "params": {
    "amount": "50.00",
    "protocol": "AAVE_V3"
  },
  "requires_confirmation": true,
  "confirmation_message": "Bridge 50 USDC from Arc to Arbitrum and supply to AAVE v3 (~4.27% APR)"
}
```

**A TypeScript handler** that the executor calls when the user confirms:

```typescript
export const InvestYieldSkill: SkillHandler = {
  category: "TRANSFER",   // READ | TRANSFER | POLICY
  affectsFunds: true,
  requiresPin: true,

  validate(params) { /* throw if params are invalid */ },

  async execute(ctx: SkillContext): Promise<SkillOutput> {
    // all the actual work happens here
  }
}
```

The JSON definition teaches Claude when and how to invoke the skill. The handler is what actually runs. They are kept separate so Claude can never bypass the executor's security checks.

---

## 3. Skill categories

Every skill belongs to one of three categories. The category determines what security layers apply before `execute()` is called.

| Category | PIN Required | Spend Limits Apply | Examples |
|---|---|---|---|
| `READ` | No | No | `CHECK_YIELD`, `GET_BALANCE` |
| `TRANSFER` | Yes | Yes | `SEND_USDC`, `INVEST_YIELD`, `WITHDRAW_YIELD` |
| `POLICY` | Yes | No (policy itself defines limits) | `CREATE_POLICY`, `SET_LIMITS` |

If your skill moves funds, it is `TRANSFER`. If it just reads state, it is `READ`. If it configures agent behaviour, it is `POLICY`.

---

## 4. The SkillHandler interface

Every skill implements this interface:

```typescript
interface SkillHandler {
  // Required
  category: "READ" | "TRANSFER" | "POLICY";
  affectsFunds: boolean;
  requiresPin: boolean;
  execute(ctx: SkillContext): Promise<SkillOutput>;

  // Optional but recommended
  version?: number;
  validate?(params: Record<string, unknown>): Record<string, unknown>;
  idempotencyKey?(params: Record<string, unknown>): string;
}
```

### SkillContext

The executor injects a context object into every `execute()` call. This is everything the skill needs to do its job:

```typescript
interface SkillContext {
  params: Record<string, unknown>;      // parsed from Claude's JSON output
  agentWallet: {
    circle_wallet_id: string;           // Circle wallet ID (for balance checks)
    circle_wallet_address: string;      // 0x address on Arc (and target chains)
  };
  supabaseUserId: string;               // authenticated user's Supabase UID
  supabase: SupabaseClient;             // user-scoped client (respects RLS)
  serviceSupabase: SupabaseClient;      // service role client (for writes skill needs to make)
  limits: Record<string, number>;       // user's configured spend limits
  getSpentSince(since: Date): Promise<number>; // rolling spend total helper
}
```

### SkillOutput

Every skill returns either success or failure:

```typescript
type SkillOutput =
  | { ok: true;  result: Record<string, unknown> }
  | { ok: false; error: string; status: number }
```

The `result` object is passed directly to the UI renderer in `wallet-shell.tsx`, so put anything the user should see in it.

---

## 5. Security layers

The executor runs four layers of checks before calling `execute()`. These are automatic for every `TRANSFER` skill — you do not implement them yourself, but you need to understand them.

```
Layer 1 — Auth          Is the request from a valid authenticated session?
Layer 2 — PIN           Did the user enter the correct PIN for this wallet?
Layer 3 — Spend limits  Would this transaction exceed per_tx / daily / weekly / monthly limits?
Layer 4 — Balance       Does the agent wallet have enough USDC?
```

Only after all four pass does your `execute()` get called. This means inside `execute()` you can trust that the user is authenticated, authorised, and has funds — but you should still do your own sanity checks.

For `READ` skills, only Layer 1 applies.

---

## 6. The spend log pattern

Every `TRANSFER` skill that moves funds must write to `agent_spend_log`. This is how spend limits are enforced across skills — without it, a user could bypass their daily limit by using multiple skills. The pattern is always:

```typescript
// 1. Insert PENDING before doing anything on-chain
const { data: row } = await ctx.serviceSupabase
  .from("agent_spend_log")
  .insert({ user_id, skill, amount_usdc, status: "PENDING", metadata: {...} })
  .select("id")
  .single();

const logId = row.id;

try {
  // 2. Do the on-chain work
  const result = await doChainWork();

  // 3. Mark COMPLETE
  await ctx.serviceSupabase
    .from("agent_spend_log")
    .update({ status: "COMPLETE", tx_hash: result.txHash })
    .eq("id", logId);

  return { ok: true, result };

} catch (err) {
  // 4. Mark FAILED — never leave rows as PENDING
  await ctx.serviceSupabase
    .from("agent_spend_log")
    .update({ status: "FAILED", error_message: err.message })
    .eq("id", logId);

  return { ok: false, error: err.message, status: 502 };
}
```

Never skip the `PENDING` insert. If you write it after the chain call and the chain call succeeds but the DB write fails, the spend is invisible to the limits system.

---

## 7. Writing the system prompt block

Claude learns about your skill from a block you add to `buildSystemPrompt()` in `lib/agent.ts`. This is the most important thing you write — it determines how reliably Claude routes user intent to your skill.

A good system prompt block has four parts:

### 7.1 Trigger description

Tell Claude exactly what user phrasings should activate this skill. Be specific and list edge cases:

```
### INVEST_YIELD
Use when: user wants to earn yield, "invest USDC", "put money in AAVE",
"earn interest", "what's the best yield", "make my USDC work for me".
Do NOT use for: sending USDC to another person, swapping tokens.
```

### 7.2 The exact JSON shape

Show Claude the exact output format with realistic example values. Claude will pattern-match against this:

```json
{
  "skill": "INVEST_YIELD",
  "params": { "amount": "50.00", "protocol": "AAVE_V3" },
  "requires_confirmation": true,
  "confirmation_message": "Bridge 50 USDC from Arc to Arbitrum and supply to AAVE v3 to earn yield."
}
```

### 7.3 Parameter rules

Enumerate every constraint the handler enforces. If Claude produces invalid params, the skill will fail and the user gets a bad experience:

```
Rules:
- amount must be a positive number string, minimum "1.00"
- amount must not exceed the user's per_transaction limit
- protocol must be "AAVE_V3" (the only currently supported protocol)
- This bridges funds off Arc — make sure user understands that in confirmation_message
- NEVER output this skill if balance is insufficient
```

### 7.4 requires_confirmation

Set `requires_confirmation: false` only for `READ` skills. Everything that moves funds or changes configuration must be `true`. Claude controls this field — if you want to force it, add it to the rules list.

---

## 8. The cross-chain yield pattern in detail

The cross-chain yield skill is the most complex pattern in Synesis because it chains three distinct operations: bridge, approve, supply. Understanding the pattern lets you extend it to any cross-chain DeFi action.

### 8.1 The three-step chain

```
Arc agent wallet (USDC)
        │
        │  Step 1: Circle CCTP bridge (kit.bridge)
        │  Burns USDC on Arc, mints on Arbitrum
        ▼
Arbitrum agent wallet (USDC)
        │
        │  Step 2: ERC-20 approve
        │  Allows AAVE pool to pull USDC from agent wallet
        │
        │  Step 3: AAVE supply()
        │  AAVE pulls USDC, issues aUSDC receipt token back to agent wallet
        ▼
Arbitrum agent wallet (aUSDC — earns yield automatically)
```

### 8.2 Why the same address works on both chains

The agent wallet address on Arbitrum is the same 0x address as on Arc. This is because both use the same `AGENT_PRIVATE_KEY` — the address is derived from the key, not the chain. This means `bridgeToArbitrum(from: agentAddress, to: agentAddress)` is correct — you're bridging from yourself on Arc to yourself on Arbitrum.

### 8.3 The bridge call

```typescript
const result = await kit.bridge({
  from: { adapter, chain: "Arc_Testnet", address: agentAddress },
  to:   { adapter, chain: "Arbitrum_Sepolia", address: agentAddress },
  amount,  // human-readable USDC string, e.g. "50.00"
});
```

The App Kit handles the full CCTP flow internally:
1. Burn USDC on source chain (Arc)
2. Poll Circle attestation service until message is confirmed
3. Mint USDC on destination chain (Arbitrum)

`result.steps` is an array of the completed transactions. `result.steps[0].txHash` is the burn transaction on Arc.

### 8.4 The AAVE supply call

AAVE requires ERC-20 approval before you can supply. You must do both in order, waiting for each transaction to be mined:

```typescript
// 1. Approve
const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, signer);
const approveTx = await usdc.approve(aavePoolAddress, amountWei);
await approveTx.wait();  // must wait — supply will fail if approve isn't mined

// 2. Supply
const pool = new ethers.Contract(aavePoolAddress, AAVE_POOL_ABI, signer);
const supplyTx = await pool.supply(
  usdcAddress,
  amountWei,
  agentAddress,  // onBehalfOf — aUSDC goes to this address
  0              // referralCode — always 0 unless you have an AAVE referral
);
const receipt = await supplyTx.wait();
```

### 8.5 Reading live APR on-chain

Do not hardcode APR or pull from a third-party API. AAVE exposes it directly via the DataProvider contract. The `liquidityRate` field is in RAY units (1e27 = 100%):

```typescript
const reserveData = await dataProvider.getReserveData(usdcAddress);
const apr = (Number(reserveData.liquidityRate) / 1e27) * 100;
// e.g. "4.27%"
```

### 8.6 Partial failure handling

The bridge and supply are two separate on-chain operations. If the bridge succeeds but AAVE supply fails, funds are sitting in the Arbitrum wallet — not lost, but not earning yield. Handle this by:

- Keeping the `agent_spend_log` row in `FAILED` state (not COMPLETE)
- The next time the user says "invest in AAVE", the balance check will pass on Arbitrum (funds are already there)
- For a production system, add a `RESUME_INVEST_YIELD` skill that skips the bridge step if Arbitrum balance is sufficient

---

## 9. Database schema for new skills

If your skill needs persistent state (yield positions, scheduled jobs, policy configs), add a Supabase migration. Follow this pattern:

```sql
create table public.your_skill_table (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  -- ... your columns ...
  created_at  timestamptz not null default now()
);

-- Always enable RLS
alter table public.your_skill_table enable row level security;

-- Users can read their own rows
create policy "Users read own rows"
  on public.your_skill_table for select
  using (auth.uid() = user_id);

-- Writes go through service role only (your skill code)
-- No INSERT/UPDATE policy for users
```

The yield skill adds `agent_yield_positions` using this pattern. Writes use `ctx.serviceSupabase` (service role), reads in the UI use `ctx.supabase` (user-scoped, respects RLS).

---

## 10. Idempotency

For skills that move funds, implement `idempotencyKey()` to prevent double-execution if the user confirms twice or the request is replayed:

```typescript
idempotencyKey(params): string {
  // Should be stable for the same logical action
  const day = new Date().toISOString().slice(0, 10); // "2026-06-19"
  return `INVEST_YIELD:${params.protocol}:${params.amount}:${day}`;
}
```

The executor checks this key against `agent_spend_log` before running. If a COMPLETE row with the same key exists, it returns the original result without re-executing.

---

## 11. Registering a new skill

Four places need to be updated when you add a skill:

**lib/skills/index.ts** — add to the registry:
```typescript
import { MyNewSkill } from "./my-new-skill";

export const SKILL_REGISTRY = {
  // ... existing skills ...
  MY_NEW_SKILL: MyNewSkill,
};
```

**lib/agent.ts** — add to the SkillName type union:
```typescript
type SkillName =
  | "SEND_USDC"
  | "CHECK_YIELD"
  // ...
  | "MY_NEW_SKILL";  // add here
```

**lib/agent.ts** — add to VALID_SKILLS:
```typescript
const VALID_SKILLS = [
  "SEND_USDC",
  "CHECK_YIELD",
  // ...
  "MY_NEW_SKILL",  // add here
];
```

**lib/agent.ts** — add system prompt block to `buildSystemPrompt()`:
```typescript
function buildSystemPrompt(...) {
  return `
    ... existing skills ...

    ${MY_NEW_SKILL_SYSTEM_PROMPT_BLOCK}
  `;
}
```

**wallet-shell.tsx** — add a result renderer:
```typescript
case "MY_NEW_SKILL":
  return <MyNewSkillResultCard result={skillOutput.result} />;
```

---

## 12. Testing a skill

Before wiring up the full UI flow, test the handler in isolation:

```typescript
// scripts/test-skill.ts
import { InvestYieldSkill } from "../lib/skills/invest-yield";

const mockCtx: SkillContext = {
  params: { amount: "5.00", protocol: "AAVE_V3" },
  agentWallet: {
    circle_wallet_id: process.env.TEST_WALLET_ID!,
    circle_wallet_address: process.env.TEST_WALLET_ADDRESS!,
  },
  supabaseUserId: process.env.TEST_USER_ID!,
  supabase: createClient(/* ... */),
  serviceSupabase: createClient(/* ... service role ... */),
  limits: { per_transaction: 100, daily: 500, weekly: 1000, monthly: 3000 },
  getSpentSince: async () => 0,
};

const result = await InvestYieldSkill.execute(mockCtx);
console.log(JSON.stringify(result, null, 2));
```

Then test the interpret step by calling `POST /api/agent/interpret` directly with a test message and checking that Claude returns the right skill JSON.

---

## 13. Adding a new protocol

To add a second yield protocol (e.g. Compound v3 on Base):

**yield-types.ts** — extend the type and registry:
```typescript
export type YieldProtocol = "AAVE_V3" | "COMPOUND_V3";

export const YIELD_PROTOCOLS: YieldProtocolConfig[] = [
  { name: "AAVE_V3", chain: "Arbitrum_Sepolia", ... },
  { name: "COMPOUND_V3", chain: "Base_Sepolia", approximateApr: "~3-4%", ... },
];
```

**invest-yield.ts** — add a protocol branch:
```typescript
async execute(ctx) {
  const protocol = ctx.params.protocol as YieldProtocol;

  if (protocol === "AAVE_V3") {
    await bridgeToArbitrum(...);
    await supplyToAave(...);
  } else if (protocol === "COMPOUND_V3") {
    await bridgeToBase(...);       // new bridge target
    await supplyToCompound(...);   // new protocol helper
  }
}
```

**env** — add chain-specific vars:
```
BASE_RPC_URL=...
BASE_COMPOUND_COMET_ADDRESS=...
BASE_USDC_ADDRESS=...
```

**system prompt** — update the supported protocols line:
```
Supported protocols: AAVE_V3 (Arbitrum Sepolia, ~4-5%), COMPOUND_V3 (Base Sepolia, ~3-4%)
```

The `validate()` method will automatically reject unknown protocol values, so there is no risk of the old code trying to execute a new protocol it doesn't handle yet.

---

## 14. Environment variables reference

Variables the yield skill requires, on top of what Synesis already uses:

```bash
# Arbitrum Sepolia
ARBITRUM_RPC_URL=https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY
ARBITRUM_AAVE_POOL=0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951
ARBITRUM_AAVE_DATA_PROVIDER=0x927F584d4321C1dCcBf5e2902368124b02419a1E
ARBITRUM_USDC_ADDRESS=0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d

# Developer-controlled wallet key (server only, never in client bundle)
AGENT_PRIVATE_KEY=0x...
```

Addresses above are Arbitrum Sepolia testnet. Verify current addresses at [docs.aave.com/developers/deployed-contracts](https://docs.aave.com/developers/deployed-contracts/v3-testnet-addresses) before deploying to mainnet.

---

## 15. Common mistakes

**Not awaiting `approveTx.wait()` before calling supply**
The supply transaction will revert because the approval is not yet mined. Always `await tx.wait()` between dependent on-chain calls.

**Setting `requires_confirmation: false` on a TRANSFER skill**
Claude controls this flag in the JSON output. If you set it to `false` in the system prompt rules for a fund-moving skill, the user never sees the ConfirmCard and never enters a PIN — the executor will reject it. Always set `requires_confirmation: true` for TRANSFER skills.

**Writing to `agent_spend_log` after the on-chain call**
If the chain call succeeds but the DB write fails (network blip, Supabase timeout), the spend becomes invisible to the limits system. Always insert `PENDING` first.

**Using `ctx.supabase` for skill writes**
`ctx.supabase` is scoped to the authenticated user and respects RLS. Skill writes (spend log, yield positions) go through `ctx.serviceSupabase` (service role) so they can write to tables the user has no INSERT policy on.

**Hardcoding APR in the system prompt**
APR changes constantly. Put an approximate range in the system prompt (for natural language context) and always read the live rate from the DataProvider in `CHECK_YIELD`.

---

## 16. Reference: arc-cross-yield-agents

The [arc-cross-yield-agents](https://github.com/compassailabs/arc-cross-yield-agents) repo is the canonical reference for the bridge → deposit pattern. Key differences from the Synesis implementation:

| | arc-cross-yield-agents | Synesis |
|---|---|---|
| Language | Rust (axum backend) | TypeScript (Next.js) |
| Skill system | Chat → Rust agent → tx | Intent → JSON skill → executor |
| Contract | `AgentAccount.sol` (thin wrapper) | Direct pool calls via ethers.js |
| Bridge API | `BurnIntent` + CCTP endpoints directly | Circle App Kit `bridge()` |
| State | In-memory (stateless Rust service) | Supabase (`agent_yield_positions`) |
| Auth | API key | Supabase session + PIN |

The core on-chain flow is identical: bridge USDC via CCTP, approve AAVE pool, call `supply()`. The Synesis implementation adds the security layers, spend logging, and persistent position tracking that a production wallet agent requires.
