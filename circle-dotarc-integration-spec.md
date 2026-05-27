# Circle Wallets × .arc Name Service — Full Integration Spec

> **Audience:** Builder working on [dotarc.vercel.app](https://dotarc.vercel.app) infrastructure  
> **Goal:** Seamlessly create Circle wallets for new users and auto-register a `.arc` name — no MetaMask required, no USDC upfront from the user  
> **Chain:** Arc Testnet (Chain ID: 5042002)  
> **Registry:** `0xf5e0E328119D16c75Fb4a001282a3a7b733EF6db`  
> **USDC Token:** `0x3600000000000000000000000000000000000000`

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Wallet Type Decision Matrix](#2-wallet-type-decision-matrix)
3. [Phase 1 — The Core Integration (Gmail → .arc Wallet)](#3-phase-1--the-core-integration-gmail--arc-wallet)
4. [Phase 2 — Agent Wallets](#4-phase-2--agent-wallets)
5. [Phase 3 — Modular / Passkey Wallets (Premium)](#5-phase-3--modular--passkey-wallets-premium)
6. [The Registration Fee Problem + Solutions](#6-the-registration-fee-problem--solutions)
7. [Fee Recovery Strategies](#7-fee-recovery-strategies)
8. [Backend API Routes to Build](#8-backend-api-routes-to-build)
9. [Database Schema](#9-database-schema)
10. [Frontend Changes to dotarc](#10-frontend-changes-to-dotarc)
11. [Environment Variables & Setup](#11-environment-variables--setup)
12. [Full Code Walkthrough](#12-full-code-walkthrough)
13. [Future Upgrades & Ideas](#13-future-upgrades--ideas)
14. [Security Checklist](#14-security-checklist)
15. [Deployment Checklist](#15-deployment-checklist)

---

## 1. Architecture Overview

```
User (Gmail / Email OTP)
        │
        ▼
  dotarc Frontend
        │
        ▼
  dotarc Backend (Next.js API Routes)
   ┌─────────────────────────────────────────┐
   │  1. Authenticate user (Google / Email)  │
   │  2. Call Circle API → create wallet     │
   │  3. Get wallet address (0x...)          │
   │  4. TREASURY SIGNER pays 5 USDC fee    │
   │  5. Register name.arc on-chain          │
   │  6. Store (userId, walletId, arcName)   │
   │  7. Return name.arc to frontend         │
   └─────────────────────────────────────────┘
        │
        ▼
  ARC Name Registry (on-chain)
  name.arc → 0x... (Circle wallet address)
```

**The key architectural insight:** dotarc's existing flow requires the user to already have a wallet to pay the 5 USDC registration fee. With Circle, we flip this: a **Treasury Signer** (a Circle dev-controlled wallet you fund) pays the fee on the user's behalf and registers the name pointing to the user's newly created Circle wallet. Fee recovery happens passively over time (see Section 7).

---

## 2. Wallet Type Decision Matrix

| User Type | Circle Wallet Type | Auth Method | Who Pays Gas | .arc Suffix | When to Use |
|---|---|---|---|---|---|
| Regular consumer | User-Controlled (EOA) | Google / Email OTP | Treasury Signer (at signup) | none — `maya.arc` | Default for all new sign-ups |
| Power user / premium | Modular (MSCA) | Passkey (Face ID, fingerprint) | Circle Paymaster (gasless) | none — `maya.arc` | Opt-in upgrade |
| AI Agent | Dev-Controlled (EOA or SCA) | None — programmatic | Treasury Signer or Gas Station | must end in `-agent` | Developer-created bots |
| Payment App | Dev-Controlled | None — programmatic | Treasury Signer | must end in `-usdc` | Partner integrations |

---

## 3. Phase 1 — The Core Integration (Gmail → .arc Wallet)

This is the MVP. Ship this first. It unlocks "sign in with Google, get a .arc name instantly."

### 3.1 Prerequisites

- Circle Developer Account: [console.circle.com](https://console.circle.com)
- Circle API Key (save as `CIRCLE_API_KEY`)
- Circle App ID (save as `CIRCLE_APP_ID`) — needed for User-Controlled SDK
- A funded **Treasury Wallet** on Arc Testnet with at least 50 USDC (to pay registration fees on behalf of users)
- Entity Secret generated and registered with Circle (for the Treasury dev-controlled wallet)

### 3.2 What "User-Controlled Wallet" Means

Circle creates the wallet. The user controls the private key via 2-of-2 MPC — you (dotarc) never touch the key. The user authenticates with Google or email OTP. They approve transactions from your UI. Circle's infrastructure handles signing and broadcasting.

### 3.3 Sign-Up Flow — Step by Step

```
Step 1:  User clicks "Continue with Google" on dotarc
Step 2:  Your OAuth handler gets the user's Google ID token
Step 3:  Backend calls Circle API to create a User Token for this user
Step 4:  Backend calls Circle API to create a wallet for this user
Step 5:  Circle returns: walletId, walletAddress (0x...)
Step 6:  Backend checks name availability on ANS: ans.isAvailable(desiredName)
Step 7:  Treasury Signer calls ansWrite.register(desiredName, walletAddress)
          ↳ "desiredName" resolves to walletAddress (the user's Circle wallet)
          ↳ Treasury Signer's own address is the owner (or transfer to user later)
Step 8:  Store in DB: { userId, circleWalletId, walletAddress, arcName, registeredAt }
Step 9:  Return { arcName: "maya.arc", walletAddress: "0x..." } to frontend
Step 10: Frontend shows "Welcome, maya.arc 🎉"
```

### 3.4 Name Selection Logic

Users pick their preferred name during onboarding. Build a flow with these rules:

```typescript
// Name suggestion waterfall
async function suggestName(userEmail: string, preferredName?: string): Promise<string> {
  const base = preferredName 
    ?? userEmail.split("@")[0].toLowerCase().replace(/[^a-z0-9-]/g, "")

  // Try exact name
  if (await ans.isAvailable(base) && base.length >= 3) return base

  // Try with number suffix
  for (let i = 1; i <= 99; i++) {
    const candidate = `${base}${i}`
    if (await ans.isAvailable(candidate)) return candidate
  }

  // Fallback: random 8-char name
  return generateRandomName()
}
```

The frontend should show a live availability checker as the user types (the `useANSAvailability` hook is already in the dotarc SDK — wire it up).

### 3.5 Name Ownership: Two Options

**Option A (Simpler): Treasury owns the name, resolves to user's wallet**

The Treasury Signer registers the name and is the owner. The resolved address points to the user's Circle wallet. This means the user cannot transfer/renew the name independently — your backend controls it.

```typescript
// Treasury signer is the tx sender and owner
// But the name resolves to the user's wallet address
const txHash = await ansWrite.register(desiredName, userWalletAddress)
// register(name, resolvedAddress?) — resolvedAddress is separate from owner
```

**Option B (Better Long-Term): Transfer ownership to user after registration**

Register with Treasury, then immediately call `transferName` to the user's Circle wallet address. Now the user truly owns the name. They can renew, transfer, update it themselves.

```typescript
const txHash = await ansWrite.register(desiredName, userWalletAddress)
await ansWrite.transferName(desiredName, userWalletAddress)
// Now user owns it. They need USDC to renew next year.
```

**Recommendation:** Use Option A for MVP (simpler, you keep control for recovery purposes). Build Option B as an upgrade — give users the option to "take ownership" once they have USDC in their wallet.

---

## 4. Phase 2 — Agent Wallets

### 4.1 Architecture

Agent wallets use Circle's **Dev-Controlled** product. Your backend creates and controls them entirely — no user interaction needed.

```
Developer calls POST /api/agents/create
        │
        ▼
Backend generates agent wallet via Circle API
        │
        ▼
Register agentname-agent.arc → agent wallet address
        │
        ▼
Store policy: { dailyLimit: 25, allowedRecipients: ["supplier-agent.arc"], approvalThreshold: 10 }
        │
        ▼
Agent transacts: resolve recipient → check policy → execute via Circle API
```

### 4.2 Policy Engine (Build This)

Store agent policies in your DB. Check before every Circle API call:

```typescript
interface AgentPolicy {
  agentId: string
  arcName: string          // "research-agent.arc"
  dailySpendLimit: number  // USDC amount
  allowedRecipients: string[] // ["supplier-agent.arc", "data-agent.arc"] — empty = all allowed
  requireApprovalAbove: number // USDC — human approval required above this
  active: boolean
}

async function executeAgentPayment(agentId: string, recipientName: string, amount: number) {
  const policy = await getAgentPolicy(agentId)
  
  // Check daily spend
  const todaySpend = await getDailySpend(agentId)
  if (todaySpend + amount > policy.dailySpendLimit) throw new Error("Daily limit exceeded")
  
  // Check allowed recipients
  if (policy.allowedRecipients.length > 0 && !policy.allowedRecipients.includes(recipientName)) {
    throw new Error("Recipient not in allowlist")
  }
  
  // Check approval threshold
  if (amount > policy.requireApprovalAbove) {
    await requestHumanApproval(agentId, recipientName, amount)
    return { status: "pending_approval" }
  }
  
  // Resolve name → address
  const recipientAddress = await ans.resolve(recipientName.replace(".arc", ""))
  if (!recipientAddress) throw new Error("Recipient name not found")
  
  // Execute via Circle API
  return await circleTransfer(agentId, recipientAddress, amount)
}
```

### 4.3 The `-agent` Naming Rule

The dotarc registry enforces `-agent` suffix for AI agents. Your backend must validate this:

```typescript
function validateAgentName(name: string): boolean {
  return name.endsWith("-agent") && name.length >= 9 && name.length <= 32
}
// "research-agent" ✅
// "mybot" ❌ — missing suffix
// "x-agent" ❌ — too short (must be 3+ chars before suffix, total 3-32)
```

---

## 5. Phase 3 — Modular / Passkey Wallets (Premium)

This is the "power user" tier. Offer as an upgrade or for users who want maximum security.

### 5.1 What's Different

- Authentication: WebAuthn passkeys (Face ID, Touch ID, Windows Hello) instead of Google
- Wallet type: Modular Smart Contract Account (MSCA) instead of EOA
- Gas: Gasless via Circle's Paymaster — user pays zero gas, ever
- Account features: Social recovery, spending modules, session keys (future)

### 5.2 Integration Points

```typescript
// Modular wallet creation — server side
const response = await fetch("https://api.circle.com/v1/w3s/wallets", {
  method: "POST",
  headers: { 
    "Authorization": `Bearer ${CIRCLE_API_KEY}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    idempotencyKey: crypto.randomUUID(),
    accountType: "SCA",          // Smart Contract Account
    blockchains: ["ARC-TESTNET"],
    userId: circleUserId,
    // Passkey auth is configured in Circle Console
  })
})
```

Then register the `.arc` name the same way as Phase 1 — Treasury pays, name resolves to MSCA address.

### 5.3 Gasless Transactions (Paymaster)

Enable Circle's Paymaster so the MSCA user never needs to hold gas:

```typescript
// In Circle Console: enable Gas Station for your app
// In your transaction calls, add:
{
  "feeLevel": "MEDIUM",
  "gasless": true,        // Circle Paymaster covers this
  "walletId": userWalletId
}
```

### 5.4 Upgrade Path for Existing Users

Existing EOA users can migrate to Modular wallets:
1. Create a new MSCA for them
2. They send their funds from old wallet to new wallet (or you sweep it server-side with their approval)
3. Update the `.arc` name's resolved address: `ansWrite.updateResolvedAddress(name, newMSCAAddress)`
4. Old wallet becomes inactive

---

## 6. The Registration Fee Problem + Solutions

**The problem:** dotarc's `register()` function requires 5 USDC (or 50 for ≤4 char names) paid by the transaction signer. New users coming from Gmail have no USDC — they just signed up.

**The solution: Treasury Signer Model**

Your backend runs a funded "Treasury" dev-controlled wallet. When a new user signs up, the Treasury pays the 5 USDC registration fee and registers the name pointing to the user's Circle wallet address.

```
Treasury Wallet (funded by you, the dotarc operator)
├── Receives USDC from fee recovery (see Section 7)
├── Pays 5 USDC per new standard name registration
├── Pays 50 USDC per premium (≤4 char) name registration
└── Needs monitoring: alert when balance < 50 USDC
```

### 6.1 Treasury Wallet Setup

```typescript
// 1. Create Treasury dev-controlled wallet via Circle
// Do this ONCE manually or via a setup script:
POST https://api.circle.com/v1/w3s/wallets
{
  "idempotencyKey": "treasury-wallet-v1",
  "accountType": "EOA",
  "blockchains": ["ARC-TESTNET"]
}

// 2. Fund it with USDC on Arc Testnet
// Use Circle faucet: https://faucet.circle.com

// 3. Store TREASURY_WALLET_ID and TREASURY_WALLET_ADDRESS in env vars

// 4. Create an ARCNames instance with the treasury signer
// This requires ethers.js + the treasury's private key or Circle signing API
```

### 6.2 Treasury Signer via Circle API (No Raw Private Keys)

Because the Treasury is a Circle dev-controlled wallet, you never handle raw private keys. Instead, Circle signs transactions for you when you call the API with your Entity Secret:

```typescript
// The Treasury "signer" is an ethers-compatible wrapper around Circle's API
// You use Circle's transaction API to send the USDC approval + register call

// Step 1: Approve USDC spend for registry contract
POST /v1/w3s/transactions
{
  "walletId": TREASURY_WALLET_ID,
  "contractAddress": "0x3600000000000000000000000000000000000000", // USDC
  "abiFunctionSignature": "approve(address,uint256)",
  "abiParameters": [
    "0xf5e0E328119D16c75Fb4a001282a3a7b733EF6db", // Registry
    "5000000" // 5 USDC in 6 decimals
  ]
}

// Step 2: Call register on the Registry
POST /v1/w3s/transactions
{
  "walletId": TREASURY_WALLET_ID,
  "contractAddress": "0xf5e0E328119D16c75Fb4a001282a3a7b733EF6db",
  "abiFunctionSignature": "register(string,address)",
  "abiParameters": [
    "maya",             // the name label
    "0x<USER_WALLET_ADDRESS>"  // the Circle wallet we just created
  ]
}
```

> **Note for builder:** Check the exact ABI signature from the deployed ARC Registry contract. The `register(name, resolvedAddress)` overload must exist in the contract. If it doesn't, you'll call `register(name)` as Treasury (Treasury becomes owner AND resolved address), then immediately call `updateResolvedAddress(name, userWalletAddress)` in a second transaction.

### 6.3 Commit-Reveal Mode

The dotarc SDK auto-detects whether commit-reveal is active. If it is, `register()` becomes a two-step process:

```typescript
// SDK handles this automatically, but be aware of the timing:
// Step 1: submitCommitment(name) — tx 1, wait for it to confirm
// Step 2: register(name, resolvedAddress) — tx 2, must happen within 1 day of commitment

// For Treasury-paid flows, both transactions come from Treasury wallet
// The SDK's register() auto-detects and calls both steps
const txHash = await ansWrite.register("maya", userWalletAddress)
// ↑ This may send 1 or 2 on-chain transactions depending on commit-reveal mode
```

---

## 7. Fee Recovery Strategies

You're fronting 5 USDC per new user. Here are all the ways to recover this cost. **Implement at least two of these.**

### Strategy 1: x402 Micro-Payment on Premium Features (Recommended)

The HTTP 402 payment protocol lets you gate specific API calls behind a USDC micro-payment. Users pay small amounts automatically when they use premium features.

**How it works:**
- When a user calls a premium API endpoint (e.g., `/api/send`, `/api/profile/premium`), your server responds with `HTTP 402` + payment details
- The client (or a middleware) automatically pays the required amount in USDC to your treasury
- The server processes the request after payment confirmation

```typescript
// Middleware on premium routes
async function x402Gate(req, res, next) {
  const paymentHeader = req.headers["x-payment"]
  
  if (!paymentHeader) {
    return res.status(402).json({
      error: "Payment Required",
      paymentDetails: {
        amount: "0.10",        // $0.10 USDC per premium API call
        currency: "USDC",
        recipient: TREASURY_WALLET_ADDRESS,
        chain: "ARC-TESTNET",
        memo: `dotarc-api-${req.userId}`
      }
    })
  }
  
  // Verify payment on-chain
  const verified = await verifyUSDCPayment(paymentHeader, req.userId)
  if (!verified) return res.status(402).json({ error: "Invalid payment" })
  
  next()
}

// Apply to premium routes:
app.post("/api/send", x402Gate, sendHandler)           // 0.10 USDC per send
app.get("/api/profile/:name/premium", x402Gate, ...)   // 0.10 USDC for premium profile
app.post("/api/agents/create", x402Gate, ...)           // 1.00 USDC per agent wallet
```

**Recovery math:**
- Each user costs you 5 USDC to register
- If they use "send" 50 times at $0.10 each → you break even
- After that → pure revenue

### Strategy 2: Annual Renewal Fee Collection

When a name is about to expire (30-day grace period), require the user to pay 5 USDC to renew. This is the natural dotarc pricing — you're just deferring it by one year.

```typescript
// Cron job: check expiring names daily
async function checkExpiringNames() {
  const expiringSoon = await db.query(`
    SELECT * FROM arc_names 
    WHERE expiry < NOW() + INTERVAL '45 days'
    AND renewal_notified = false
  `)
  
  for (const record of expiringSoon) {
    // Send renewal email/notification
    await sendRenewalNotice(record.userId, record.arcName, record.expiry)
    
    // If user has USDC in their Circle wallet, offer 1-click renewal:
    // Check balance → if >= 5 USDC, show "Renew for 5 USDC" button
    const balance = await getCircleWalletBalance(record.circleWalletId)
    if (balance >= 5_000_000) { // 5 USDC in 6 decimals
      await offerAutoRenewal(record.userId)
    }
    
    await db.update({ id: record.id, renewal_notified: true })
  }
}
```

**Recovery math:**
- Year 1: You paid 5 USDC, user paid 0
- Year 2: User pays 5 USDC renewal → you're even
- Year 3+: User pays 5 USDC/year → pure revenue

### Strategy 3: Fee-on-Send (Transaction Tax)

Collect a small protocol fee on every USDC transfer made through dotarc's send interface.

```typescript
// In your send flow, add a protocol fee:
async function dotarcSend(fromName: string, toName: string, amount: number) {
  const PROTOCOL_FEE_BPS = 50 // 0.5% fee
  const protocolFee = Math.floor(amount * PROTOCOL_FEE_BPS / 10000)
  const recipientAmount = amount - protocolFee
  
  const recipientAddress = await ans.resolve(toName)
  
  // Send to recipient
  await circleTransfer(fromWalletId, recipientAddress, recipientAmount)
  
  // Send fee to treasury
  await circleTransfer(fromWalletId, TREASURY_WALLET_ADDRESS, protocolFee)
  
  return { sent: recipientAmount, fee: protocolFee }
}
```

**Recovery math:**
- User sends 200 USDC → you collect 1 USDC
- After 5 sends of 200 USDC → registration fee recovered
- This is transparent and industry-standard

### Strategy 4: Premium Name Tier

Keep free name registration (5–32 chars) subsidized. For premium short names (3–4 chars), charge the user directly *before* you register for them:

```typescript
// Premium names (≤4 chars) require upfront payment via Circle
// User must have 50 USDC in their wallet OR pay via credit card (Circle on-ramp)
async function registerPremiumName(userId: string, name: string) {
  if (name.length <= 4) {
    // Check if user has enough USDC
    const balance = await getCircleWalletBalance(userId)
    if (balance < 50_000_000) {
      throw new Error("Premium names require 50 USDC. Standard names (5+ chars) are free.")
    }
    // Deduct 50 USDC from user wallet, send to treasury
    await circleTransfer(userWalletId, TREASURY_WALLET_ADDRESS, 50_000_000)
  }
  
  // Proceed with registration
  await registerArcName(userId, name)
}
```

### Strategy 5: Staggered Treasury Draw (Auto-Deduct)

When a user's Circle wallet accumulates enough USDC (say, 10+ USDC), automatically deduct the registration cost:

```typescript
// Background job: recover registration fees from funded wallets
async function recoverRegistrationFees() {
  const unfunded = await db.query(`
    SELECT * FROM user_wallets 
    WHERE registration_fee_recovered = false
    AND created_at < NOW() - INTERVAL '7 days'
  `)
  
  for (const user of unfunded) {
    const balance = await getCircleWalletBalance(user.circleWalletId)
    const RECOVERY_THRESHOLD = 10_000_000 // 10 USDC — recover when they have at least this
    
    if (balance >= RECOVERY_THRESHOLD) {
      // User-controlled wallet: need user approval for this transfer
      // Option A: Add this to your ToS and use a scheduled payment module
      // Option B: Show a "Complete your registration" prompt in the UI
      // Option C: Deduct at next send transaction as an added fee
      
      await markForRecovery(user.id, 5_000_000) // Queue 5 USDC deduction
    }
  }
}
```

> **Legal note:** For user-controlled wallets, you cannot withdraw from the user's wallet without their approval (that's the whole point of user custody). Options B and C above are the ethical paths. For dev-controlled wallets (agents), you can deduct freely since you control the wallet.

### Strategy 6: Fiat Onboarding Fee (Circle Payments)

If you integrate Circle's Payments product for fiat onboarding (credit card → USDC), charge a small on-ramp fee that covers the registration:

```typescript
// User buys USDC with credit card:
// You charge $6 and give them $5 USDC — $1 spread covers your costs
// OR: charge $5, give $5 USDC, pay registration from your margin on the FX
```

---

## 8. Backend API Routes to Build

Build these as Next.js API routes or a separate Express/Fastify service.

### `POST /api/auth/circle-signup`

Creates a Circle user, wallet, and registers a `.arc` name in one atomic flow.

```typescript
// Request body:
{
  googleIdToken?: string,
  emailOTP?: string,
  preferredName?: string
}

// Response:
{
  arcName: "maya.arc",
  walletAddress: "0x...",
  circleUserId: "...",
  walletId: "..."
}

// Internal steps:
// 1. Verify Google token / Email OTP
// 2. Create Circle user identifier
// 3. Create Circle user-controlled wallet
// 4. Suggest / validate arc name
// 5. Treasury pays 5 USDC + registers name
// 6. Save to DB
// 7. Return result
```

### `POST /api/auth/circle-signin`

For returning users — returns their existing wallet + name.

```typescript
// Verify auth, lookup DB record, return arc info
```

### `POST /api/wallets/send`

Send USDC from user's Circle wallet to a `.arc` name or `0x` address.

```typescript
// Request:
{ fromUserId: string, to: string, amount: number } // to = "maya.arc" or "0x..."

// Steps:
// 1. Resolve "maya.arc" → 0x... (if name, not address)
// 2. Check user wallet balance
// 3. Apply protocol fee (optional, see Strategy 3)
// 4. Call Circle API to initiate transfer (user must approve)
// 5. Return tx hash

// NOTE: User-controlled wallet requires USER APPROVAL via Circle SDK
// This is not a silent backend transfer — the user must tap "Confirm"
```

### `GET /api/wallets/balance`

```typescript
// Returns user's USDC balance from Circle API
// Cache for 30s to avoid rate limits
GET https://api.circle.com/v1/w3s/wallets/{walletId}/balances
```

### `POST /api/agents/create`

Creates a dev-controlled agent wallet + registers `-agent.arc` name.

```typescript
// Request:
{ agentName: string, policy: AgentPolicy, createdByUserId: string }

// Steps:
// 1. Validate agentName ends with "-agent"
// 2. Create dev-controlled wallet via Circle
// 3. Treasury registers agentname-agent.arc → wallet address
// 4. Save policy to DB
// 5. Return { arcName, walletId, walletAddress }
```

### `POST /api/names/check`

Live availability check — wraps dotarc's `isAvailable` for the frontend.

```typescript
GET /api/names/check?name=maya
// Returns: { available: true, price: 5, priceUSDC: "5.00" }
```

### `POST /api/names/transfer-ownership`

After MVP: lets a user take true ownership of their name (Option B from Section 3.5).

```typescript
// Requires user to have USDC in wallet for future gas
// Calls ansWrite.transferName(name, userWalletAddress)
```

### `GET /api/treasury/health`

Internal monitoring endpoint.

```typescript
// Returns Treasury wallet balance — alert if < 50 USDC
{ balance: 240_000_000, usdcFormatted: "240.00", namesCanRegister: 48 }
```

---

## 9. Database Schema

Add these tables to your existing schema. Use Postgres or PlanetScale.

```sql
-- Circle user identifiers
CREATE TABLE circle_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  circle_user_id VARCHAR(255) UNIQUE NOT NULL,  -- Circle's userId
  auth_type VARCHAR(50) NOT NULL,               -- "google", "email", "pin"
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Circle wallets
CREATE TABLE circle_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  circle_wallet_id VARCHAR(255) UNIQUE NOT NULL,  -- Circle's walletId
  wallet_address VARCHAR(42) UNIQUE NOT NULL,
  wallet_type VARCHAR(50) NOT NULL,    -- "user_controlled", "dev_controlled", "modular"
  account_type VARCHAR(10) NOT NULL,   -- "EOA" or "SCA"
  blockchain VARCHAR(50) DEFAULT 'ARC-TESTNET',
  is_treasury BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ARC name registrations
CREATE TABLE arc_names (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID REFERENCES circle_wallets(id),
  user_id UUID REFERENCES users(id),
  arc_name VARCHAR(35) UNIQUE NOT NULL,     -- "maya.arc"
  label VARCHAR(32) NOT NULL,               -- "maya"
  resolved_address VARCHAR(42) NOT NULL,
  registration_tx VARCHAR(66),              -- tx hash
  expiry TIMESTAMPTZ NOT NULL,
  registration_fee_paid_by VARCHAR(20) DEFAULT 'treasury',  -- "treasury" or "user"
  registration_fee_recovered BOOLEAN DEFAULT false,
  renewal_notified BOOLEAN DEFAULT false,
  name_type VARCHAR(20) DEFAULT 'human',    -- "human", "agent", "payment"
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agent wallets (extends circle_wallets for agents)
CREATE TABLE agent_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_wallet_id VARCHAR(255) UNIQUE NOT NULL REFERENCES circle_wallets(circle_wallet_id),
  arc_name VARCHAR(35) UNIQUE NOT NULL,
  created_by_user_id UUID REFERENCES users(id),
  daily_spend_limit_usdc DECIMAL(18, 6) DEFAULT 25.00,
  require_approval_above_usdc DECIMAL(18, 6) DEFAULT 10.00,
  allowed_recipients TEXT[] DEFAULT '{}',   -- array of .arc names, empty = all allowed
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Fee recovery tracking
CREATE TABLE fee_recovery_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  arc_name VARCHAR(35) NOT NULL,
  amount_recovered_usdc DECIMAL(18, 6) NOT NULL,
  recovery_method VARCHAR(50) NOT NULL,    -- "send_fee", "renewal", "x402", "premium_name"
  tx_hash VARCHAR(66),
  recovered_at TIMESTAMPTZ DEFAULT NOW()
);

-- Treasury health log
CREATE TABLE treasury_balance_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  balance_usdc DECIMAL(18, 6) NOT NULL,
  names_can_register INTEGER NOT NULL,
  checked_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 10. Frontend Changes to dotarc

The existing dotarc frontend needs these additions/modifications.

### 10.1 New Onboarding Screen

Replace the current "Connect Wallet" gate with a two-path entry:

```
┌─────────────────────────────────────────────┐
│            Get Your .arc Name               │
│                                             │
│  ┌─────────────────────────────────────┐   │
│  │  🌐 Continue with Google            │   │  ← NEW: Circle user-controlled wallet
│  └─────────────────────────────────────┘   │
│                                             │
│  ┌─────────────────────────────────────┐   │
│  │  📧 Continue with Email             │   │  ← NEW: Circle email OTP wallet
│  └─────────────────────────────────────┘   │
│                                             │
│  ─────────────── or ─────────────────────  │
│                                             │
│  ┌─────────────────────────────────────┐   │
│  │  🦊 Connect Existing Wallet         │   │  ← KEEP existing MetaMask flow
│  └─────────────────────────────────────┘   │
│                                             │
│  New users: Get a free .arc name + wallet   │
│  (5 USDC registration covered for you)     │
└─────────────────────────────────────────────┘
```

### 10.2 Name Picker Component

```tsx
// During Google/Email onboarding, show a name picker step
function NamePickerStep({ suggestedName, onConfirm }) {
  const [name, setName] = useState(suggestedName)
  const { available, isChecking } = useANSAvailability(name)

  return (
    <div>
      <h2>Choose your .arc name</h2>
      <input
        value={name}
        onChange={e => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
        placeholder="yourname"
      />
      <span>.arc</span>
      {isChecking && <span>Checking...</span>}
      {!isChecking && available && <span>✅ Available — free for you</span>}
      {!isChecking && !available && <span>❌ Taken — try another</span>}
      <button 
        disabled={!available || isChecking || name.length < 3}
        onClick={() => onConfirm(name)}
      >
        Claim {name}.arc
      </button>
      <small>Registration fee (5 USDC) is covered for new users</small>
    </div>
  )
}
```

### 10.3 Navbar — Show .arc Name Instead of Address

The dotarc docs already have this pattern. Wire it to the Circle wallet address:

```tsx
import { useANSReverse } from "@arcnames/sdk-react"

function Navbar({ user }) {
  const { arcName } = useANSReverse(user?.walletAddress, {
    rpcUrl: "https://rpc.testnet.arc.network",
    registryAddress: "0xf5e0E328119D16c75Fb4a001282a3a7b733EF6db"
  })

  return (
    <nav>
      <span>{arcName ?? user?.arcName ?? `${user?.walletAddress?.slice(0, 6)}...`}</span>
    </nav>
  )
}
```

### 10.4 Send Flow — Circle Approval Modal

For user-controlled wallets, sending USDC requires user approval via Circle's SDK. The user must tap "Confirm" in Circle's UI:

```tsx
import { CircleW3sClient } from "@circle-fin/user-controlled-wallets"

async function handleSend(from, to, amount) {
  // 1. Call your backend to initiate the transfer
  const { challengeId } = await fetch("/api/wallets/send", {
    method: "POST",
    body: JSON.stringify({ from, to, amount })
  }).then(r => r.json())
  
  // 2. Show Circle's confirmation UI (they tap "Confirm")
  const w3sClient = new CircleW3sClient({ appId: CIRCLE_APP_ID })
  await w3sClient.execute(challengeId)
  
  // 3. Show success
}
```

### 10.5 Dashboard — Wallet Balance Widget

```tsx
function WalletWidget({ circleWalletId }) {
  const [balance, setBalance] = useState(null)
  
  useEffect(() => {
    fetch(`/api/wallets/balance?walletId=${circleWalletId}`)
      .then(r => r.json())
      .then(d => setBalance(d.balance))
  }, [circleWalletId])
  
  return (
    <div>
      <span>{balance ? `${balance} USDC` : "Loading..."}</span>
      <button onClick={handleSend}>Send</button>
      <button onClick={handleReceive}>Receive</button>
    </div>
  )
}
```

---

## 11. Environment Variables & Setup

Add these to your `.env.local` and your deployment environment:

```bash
# Circle API
CIRCLE_API_KEY=your_circle_api_key_here
CIRCLE_APP_ID=your_circle_app_id_here         # From Circle Console → Apps
CIRCLE_ENTITY_SECRET=your_entity_secret_here  # Generated ONCE, never rotated without Circle process

# Treasury Wallet (dev-controlled, YOU fund this)
TREASURY_WALLET_ID=circle_wallet_id_here
TREASURY_WALLET_ADDRESS=0x...

# Arc Network
ARC_RPC_URL=https://rpc.testnet.arc.network
ARC_CHAIN_ID=5042002
ANS_REGISTRY_ADDRESS=0xf5e0E328119D16c75Fb4a001282a3a7b733EF6db
USDC_CONTRACT_ADDRESS=0x3600000000000000000000000000000000000000

# Fee recovery
PROTOCOL_FEE_BPS=50          # 0.5% — adjust as needed
RECOVERY_THRESHOLD_USDC=10   # Attempt recovery when user has ≥10 USDC
```

### Circle Console Setup Steps

1. Go to [console.circle.com](https://console.circle.com)
2. Create a new project
3. Enable "User-Controlled Wallets" and "Developer-Controlled Wallets"
4. Under Apps: create an App ID for your web app (needed for frontend SDK)
5. Generate your Entity Secret (follow Circle's guide — store it encrypted, never in git)
6. Enable Arc Testnet in Supported Blockchains
7. Create and fund your Treasury wallet
8. (Optional, Phase 3) Enable Gas Station and Paymaster

---

## 12. Full Code Walkthrough

### 12.1 Complete Sign-Up Handler

```typescript
// /api/auth/circle-signup.ts
import { ARCNames } from "@arcnames/sdk"
import { ethers } from "ethers"

export async function POST(req: Request) {
  const { googleIdToken, emailOTP, preferredName } = await req.json()

  // ── Step 1: Verify auth ───────────────────────────────────────────
  let email: string
  if (googleIdToken) {
    email = await verifyGoogleToken(googleIdToken) // use google-auth-library
  } else if (emailOTP) {
    email = await verifyEmailOTP(emailOTP)
  } else {
    return Response.json({ error: "No auth provided" }, { status: 400 })
  }

  // ── Step 2: Check if user already exists ─────────────────────────
  const existingUser = await db.findUserByEmail(email)
  if (existingUser?.arcName) {
    return Response.json({ arcName: existingUser.arcName, walletAddress: existingUser.walletAddress })
  }

  // ── Step 3: Create Circle user + wallet ──────────────────────────
  const circleUser = await createCircleUser(email)
  const circleWallet = await createCircleUserWallet(circleUser.userId)
  const walletAddress = circleWallet.address

  // ── Step 4: Pick a name ───────────────────────────────────────────
  const arcName = await suggestName(email, preferredName)
  // (arcName is the label without ".arc", e.g. "maya")

  // ── Step 5: Register the name via Treasury ───────────────────────
  const txHash = await treasuryRegisterName(arcName, walletAddress)

  // ── Step 6: Store in DB ───────────────────────────────────────────
  await db.createUser({
    email,
    circleUserId: circleUser.userId,
    circleWalletId: circleWallet.walletId,
    walletAddress,
    arcName: `${arcName}.arc`,
    registrationTx: txHash
  })

  return Response.json({
    arcName: `${arcName}.arc`,
    walletAddress,
    txHash
  })
}

// ── Treasury registration helper ─────────────────────────────────────
async function treasuryRegisterName(label: string, resolvedAddress: string): Promise<string> {
  // 1. Approve USDC spend via Circle API (Treasury wallet)
  await circleContractCall({
    walletId: process.env.TREASURY_WALLET_ID!,
    contractAddress: process.env.USDC_CONTRACT_ADDRESS!,
    abi: ["function approve(address spender, uint256 amount)"],
    functionName: "approve",
    args: [process.env.ANS_REGISTRY_ADDRESS!, "5000000"]  // 5 USDC
  })

  // 2. Call register on ANS Registry
  const txHash = await circleContractCall({
    walletId: process.env.TREASURY_WALLET_ID!,
    contractAddress: process.env.ANS_REGISTRY_ADDRESS!,
    abi: ["function register(string label, address resolvedAddress)"],
    functionName: "register",
    args: [label, resolvedAddress]
  })

  return txHash
}

// ── Circle contract call wrapper ─────────────────────────────────────
async function circleContractCall({ walletId, contractAddress, abi, functionName, args }) {
  const iface = new ethers.Interface(abi)
  const calldata = iface.encodeFunctionData(functionName, args)

  const response = await fetch("https://api.circle.com/v1/w3s/transactions/contractExecution", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.CIRCLE_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      idempotencyKey: crypto.randomUUID(),
      walletId,
      contractAddress,
      calldata,
      fee: { type: "EIP1559", config: { maxFee: "1000000", priorityFee: "1000000" } }
    })
  })

  const data = await response.json()
  if (!response.ok) throw new Error(data.message ?? "Circle API error")

  // Poll for completion
  return await waitForTransaction(data.data.transaction.id)
}
```

### 12.2 Circle User + Wallet Creation

```typescript
async function createCircleUser(email: string) {
  const response = await fetch("https://api.circle.com/v1/w3s/users", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.CIRCLE_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      userId: `dotarc-${email.replace("@", "-at-").replace(/[^a-z0-9-]/g, "-")}`,
    })
  })
  return (await response.json()).data.user
}

async function createCircleUserWallet(circleUserId: string) {
  // First, get a user token for this user
  const tokenResponse = await fetch("https://api.circle.com/v1/w3s/users/token", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.CIRCLE_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ userId: circleUserId })
  })
  const { userToken, encryptionKey } = (await tokenResponse.json()).data

  // Then initialize and create the wallet
  // NOTE: User must complete the auth challenge (Google/email OTP via Circle SDK)
  // This is handled on the frontend via CircleW3sClient
  // The backend just creates the wallet after auth is confirmed

  const walletResponse = await fetch("https://api.circle.com/v1/w3s/user/wallets", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.CIRCLE_API_KEY}`,
      "X-User-Token": userToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      idempotencyKey: crypto.randomUUID(),
      accountType: "EOA",
      blockchains: ["ARC-TESTNET"]
    })
  })

  const wallet = (await walletResponse.json()).data.wallets[0]
  return {
    walletId: wallet.id,
    address: wallet.address
  }
}
```

---

## 13. Future Upgrades & Ideas

These are not in scope for the initial build but are strong candidates for v2/v3.

### 13.1 Passkey-First Mobile App

Build a React Native app where the Circle Modular wallet is the default. Face ID creates the wallet. No passwords, no seed phrases. `.arc` name is the only identity the user ever sees.

### 13.2 dotarc Pay — QR Code Payments

The dotarc `/qr/:name` endpoint already generates a QR code. Combine with Circle's user-controlled wallet to build a Cash App-style "show your QR, get paid" flow. Very low engineering lift.

### 13.3 Multi-Name Support

Let users register multiple `.arc` names — e.g., `personal.arc` and `business.arc` — all pointing to the same Circle wallet or different ones. Business accounts pay for their own names.

### 13.4 Name Lending / Marketplace

Since you're the owner of treasury-registered names (Option A, Section 3.5), you could build a marketplace where users bid for premium short names. The auction proceeds go to treasury.

### 13.5 Agent Dashboard

A UI where developers can create, monitor, and manage agent wallets — see their `.arc` names, daily spend, policy settings, transaction history. This is a paid product for developers building AI workflows.

### 13.6 Circle Gas Station Integration

Enable Circle's Gas Station so that even standard EOA wallets can transact without the user needing to hold gas. Gas fees are charged to your app account, and you recover via the fee strategies above.

```typescript
// In Circle Console: enable Gas Station
// Then in all transaction calls:
{ fee: { type: "GAS_STATION" } }  // instead of EIP1559
```

### 13.7 Cross-Chain Name Resolution

When Arc Mainnet launches and potentially other chains become available, `.arc` names can be resolved across chains. The Circle wallet already supports unified EVM addressing (same address on all EVM chains). The ANS registry may need an upgrade for multi-chain resolution.

### 13.8 Social Recovery for Circle Wallets

Circle's Modular wallet supports adding recovery modules. You could build a "3-of-5 guardian" recovery for premium users, where their `.arc` name stays intact even if they lose their device.

### 13.9 dotarc for Teams / DAOs

Treasury workflow: a team creates a shared `.arc` name (e.g., `design-team.arc`) backed by a multisig Circle dev-controlled wallet. The team owner controls the wallet; members get payroll via the name.

### 13.10 Webhook-Driven Treasury Monitoring

Set up Circle webhooks to receive notifications when:
- A user's wallet receives USDC (trigger fee recovery check)
- Treasury balance drops below threshold (trigger top-up alert)
- An agent exceeds spend policy (trigger human approval flow)

---

## 14. Security Checklist

- [ ] **Entity Secret:** Generated once, stored encrypted (not in git, not in logs). Use AWS Secrets Manager or equivalent.
- [ ] **Treasury Wallet ID:** Stored in env vars, never exposed to frontend
- [ ] **Treasury Address:** Can be public (it's a receive address), but gate all write operations server-side
- [ ] **Rate limiting:** Apply to `/api/auth/circle-signup` — max 3 attempts per IP per hour to prevent wallet spam
- [ ] **Name validation:** Server-side enforce 3–32 chars, lowercase, no reserved names, correct suffix for agents
- [ ] **USDC approval amounts:** Use exact amounts (not `uint256.MAX`) for Treasury approvals. Approve exactly 5 USDC per registration.
- [ ] **Commit-reveal:** Let the dotarc SDK handle this automatically — don't manually bypass it
- [ ] **User wallet privacy:** Never log or expose user wallet private keys (Circle handles this — you never have them anyway)
- [ ] **Transfer validation:** Always resolve `.arc` names server-side before executing Circle transfers — never trust client-side resolved addresses
- [ ] **Fee recovery transparency:** Document in your ToS that a 0.5% protocol fee applies to sends and that treasury paid the registration fee

---

## 15. Deployment Checklist

### Before Going Live (Testnet)

- [ ] Circle developer account created, API keys generated
- [ ] Entity Secret generated and registered with Circle
- [ ] Treasury wallet created and funded with ≥50 USDC on Arc Testnet
- [ ] Test full sign-up flow: Google auth → wallet created → name registered
- [ ] Test send flow: user A sends to user B by `.arc` name
- [ ] Test agent creation: dev creates agent, registers `-agent.arc` name
- [ ] Treasury balance monitoring working (alert at <50 USDC)
- [ ] Name expiry job running (cron daily check)
- [ ] DB migrations applied

### Before Mainnet (when Arc Mainnet launches)

- [ ] Circle mainnet credentials configured separately
- [ ] Treasury funded with real USDC
- [ ] Gas Station enabled (optional but recommended)
- [ ] Fee recovery strategies active (at minimum: renewal fee + send fee)
- [ ] Security audit of treasury signing logic
- [ ] Legal review of ToS regarding fee collection

---

## Reference Links

| Resource | URL |
|---|---|
| dotarc app | https://dotarc.vercel.app |
| dotarc docs | https://dotarc.vercel.app/docs |
| Circle Console | https://console.circle.com |
| Circle Wallets docs | https://developers.circle.com/wallets |
| Circle Dev-Controlled | https://developers.circle.com/wallets/dev-controlled |
| Circle User-Controlled | https://developers.circle.com/wallets/user-controlled |
| Circle Modular Wallets | https://developers.circle.com/wallets/modular |
| Circle Gas Station | https://developers.circle.com/wallets/gas-station |
| Circle Paymaster | https://developers.circle.com/paymaster |
| Arc Testnet Explorer | https://testnet.arcscan.app |
| Circle Testnet Faucet | https://faucet.circle.com |
| @arcnames/sdk (npm) | https://www.npmjs.com/package/@arcnames/sdk |
| ANS Registry Contract | `0xf5e0E328119D16c75Fb4a001282a3a7b733EF6db` (Arc Testnet) |

---

*Spec version: 1.0 — May 2026*  
*Covers: Arc Testnet + Circle Testnet. Update RPC, contract addresses, and Circle endpoints when Arc Mainnet launches.*
