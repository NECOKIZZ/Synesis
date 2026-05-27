# DotArc Smart Wallet — Master Architecture Document

This document is the single source of truth for the DotArc Smart Wallet product. It covers every architectural decision, system layer, data model, security design, and feature specification. It is written for both the owner and the builder.

---

## 1. What DotArc Smart Wallet Is

### The Naming Infrastructure (DotArc)
DotArc is a naming registry built on Arc Testnet. It is infrastructure, not a product. It maps human-readable names to wallet addresses — `maya.arc` resolves to `0xABC...`. Think of it as ENS for Arc. It is not a dApp. It is a registry that any product or developer on Arc can integrate with.

### The Product (DotArc Smart Wallet)
DotArc Smart Wallet is a separate product built by the same team, on top of the naming infrastructure. It is a USDC-native wallet where the user's identity is their `.arc` name. The wallet address exists on-chain but is never shown to the user. No seed phrases. No private keys. No `0x` anything — unless the user deliberately seeks it out.

The product has two modes that live inside one app:

**Main Wallet** — everyone gets this on signup. A clean, simple USDC wallet identified only by a name and a QR code.

**Smart Agent** — an optional upgrade activated from inside the main wallet. An AI-powered autonomous payment agent the user funds and gives instructions to in plain English.

### The One-Sentence Description

> DotArc Smart Wallet is a USDC wallet where your identity is your name — no addresses, no seed phrases, no crypto complexity — and an optional AI agent that handles your payments autonomously while you live your life.

---

## 2. The Core Design Principle — No Crypto Complexity Visible

This principle governs every UI decision in the product. If a design choice exposes blockchain infrastructure to the user without them asking for it, it is wrong.

```
NEVER show by default:        ALWAYS show instead:
─────────────────────         ────────────────────
0x wallet addresses     →     maya.arc
Seed phrases            →     Google login
Private keys            →     Transaction PIN
Gas fees                →     Nothing (USDC is gas on Arc)
Network names           →     Nothing
Contract addresses      →     Nothing
Chain IDs               →     Nothing
```

The QR code encodes the 0x address underneath — that is how blockchain payments work technically. But the user never reads it. They show it, someone scans it, money arrives. The address is invisible infrastructure.

For power users or developers who need the raw address, it is available under Settings → Advanced → Show Wallet Address. It is never surfaced otherwise.

---

## 3. The Two Modes — One App

```
┌─────────────────────────────────────────────────────┐
│              DOTARC SMART WALLET                     │
│                                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │           MAIN WALLET                        │   │
│  │           (everyone gets this)               │   │
│  │                                             │   │
│  │   maya.arc                                  │   │
│  │   ─────────────────────────                 │   │
│  │   [QR Code]                                 │   │
│  │   Balance: 150 USDC                         │   │
│  │                                             │   │
│  │   [Send]  [Receive]  [History]              │   │
│  │                                             │   │
│  │   ─────────────────────────                 │   │
│  │   ✦ Activate Smart Agent                    │   │
│  │     Let AI handle payments for you          │   │
│  └─────────────────────────────────────────────┘   │
│                                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │           SMART AGENT                        │   │
│  │           (optional, activated by user)      │   │
│  │                                             │   │
│  │   maya-agent.arc                            │   │
│  │   Agent Balance: 100 USDC  [Top Up]         │   │
│  │                                             │   │
│  │   "What should your agent do?"             │   │
│  │   [text / voice input]                      │   │
│  │                                             │   │
│  │   Active Policies:                          │   │
│  │   → netflix.arc  15 USDC  monthly           │   │
│  │   → sara.arc     50 USDC  weekly            │   │
│  │                                             │   │
│  │   Recent Activity:                          │   │
│  │   ✓ Paid sara.arc 50 USDC — today           │   │
│  │   ✓ Paid netflix 15 USDC — May 8            │   │
│  └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

---

## 4. The Two Wallet Types

There are exactly two wallet types in this system. This distinction governs every signing and custody decision.

| Wallet | Circle Type | Who Signs | When |
|---|---|---|---|
| `maya.arc` — main wallet | User-Controlled | Maya, with her PIN | When Maya chooses to send |
| `maya-agent.arc` — smart agent | Developer-Controlled | Your backend automatically | When the agent's policy triggers |

**User-controlled wallets** — Circle's MPC infrastructure requires the user's PIN or biometric to authorise every transaction. Your backend never sees the key. You only ever store the wallet address. The user has full custody.

**Developer-controlled wallets** — your backend holds signing authority via the entity secret combined with Circle's key share (MPC). No PIN required at execution time. The user authorises rules once; the backend executes those rules autonomously forever after.

---

## 5. The Three Developer-Controlled Wallets

Under your one Circle account and entity secret, there are three categories of developer-controlled wallet, each in its own wallet set.

```
Your Circle Account
  │
  ├── Wallet Set: DotArc Treasury
  │     └── treasury.arc
  │           → Pays 5 USDC .arc registration fee for every new user
  │           → Funded by you (the platform owner)
  │           → Never touches user funds
  │           → Invisible to users entirely
  │
  └── Wallet Set: DotArc Agents
        ├── maya-agent.arc    → Maya's smart agent wallet
        ├── bob-agent.arc     → Bob's smart agent wallet
        └── ...one per user who activates Smart Agent
              → Funded by the user
              → Executes only within that user's defined policies
              → Your backend signs, user's rules govern
```

The treasury and agent wallets are in separate wallet sets. A problem in one cannot affect the other.

---

## 6. The MPC Security Model

Circle uses Multi-Party Computation for all developer-controlled wallets.

```
Your side:      Entity Secret     (your server, never exposed)
Circle's side:  Key share         (Circle's HSM infrastructure)

To sign any transaction, BOTH are required simultaneously.
Neither party alone can sign anything.
An attacker who steals your entity secret still cannot
move funds — they would also need to breach Circle's
infrastructure at the same time.
```

The entity secret is the most sensitive credential in the system. It must be stored offline, backed up in a recovery file, and never appear in frontend code, logs, or version control.

---

## 7. Full System Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                          USER                                 │
│   Google login / email OTP / voice / text / QR scan          │
└────────────────────────────┬─────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────┐
│                        FRONTEND                               │
│   Next.js — DotArc Smart Wallet app                          │
│                                                              │
│   /onboard      signup, name claim, wallet creation          │
│   /wallet       main wallet — balance, send, receive, QR     │
│   /agent        smart agent — conversation, policies, feed   │
│   /history      full transaction history                     │
│   /settings     PIN, limits, advanced (show address)         │
│   /n/<name>     public profile — shareable payment page      │
│                                                              │
│   Circle User-Controlled SDK (@circle-fin/w3s-pw-web-sdk)    │
│   Handles user wallet creation and PIN setup                 │
│   Only Circle SDK code lives here — no signing keys          │
└──────────┬───────────────────────────────┬───────────────────┘
           │                               │
           ▼                               ▼
┌──────────────────────┐     ┌─────────────────────────────────┐
│   CLAUDE API         │     │         YOUR BACKEND             │
│   Interpretation     │     │         Next.js API Routes       │
│   Layer Only         │     │                                 │
│                      │     │   Onboarding:                   │
│   Receives:          │     │   /api/create-user-session       │
│   User text +        │     │   /api/get-user-wallet           │
│   wallet context +   │     │   /api/register-name            │
│   skill list         │     │                                 │
│                      │     │   Agent:                        │
│   Returns:           │     │   /api/agent/interpret          │
│   Structured JSON    │     │   /api/agent/confirm-policy     │
│   mapped to a skill  │     │   /api/agent/cancel-policy      │
│                      │     │   /api/agent/balance            │
│   Called ONCE per    │     │                                 │
│   user instruction   │     │   Circle Dev SDK                │
│   Never for errors   │     │   ANS SDK (@arcnames/sdk)        │
│   Never for cron     │     │   ethers.js (calldata encoding) │
└──────────────────────┘     └──────────────┬──────────────────┘
                                            │
                    ┌───────────────────────┼────────────────────┐
                    │                       │                    │
                    ▼                       ▼                    ▼
        ┌───────────────────┐  ┌────────────────────┐  ┌──────────────────┐
        │    DATABASE       │  │    CIRCLE API       │  │   ARC TESTNET    │
        │    (Postgres)     │  │                    │  │                  │
        │                   │  │  User wallets      │  │  ANS Registry    │
        │  users            │  │  Agent wallets     │  │  0xf5e0E...      │
        │  user_security    │  │  Treasury wallet   │  │                  │
        │  user_spend_limits│  │  MPC signing       │  │  USDC Token      │
        │  agent_wallets    │  │  Transaction API   │  │  0x36000...      │
        │  agent_policies   │  │                    │  │                  │
        │  agent_spend_log  │  └────────────────────┘  └──────────────────┘
        │  payment_requests │
        └───────────────────┘
                    │
                    ▼
        ┌───────────────────┐
        │    CRON JOB       │
        │  (Vercel Cron)    │
        │                   │
        │  Runs hourly      │
        │  Finds due        │
        │  policies         │
        │  Executes them    │
        │  Notifies user    │
        └───────────────────┘
```

---

## 8. The User Journey — Main Wallet

This is the complete sequence from landing on the app to having a working wallet. No technical knowledge required at any step.

```
1. User opens DotArc Smart Wallet app
   Sees: "Your wallet. Your name. Nothing else."

2. Taps "Get Started"
   Signs in with Google (or email OTP)
   No password to remember

3. "Choose your name"
   Types: maya
   App checks availability live
   Available → green checkmark
   Taken → suggests maya1, maya-pay, etc.

4. Taps "Claim maya.arc"
   Behind the scenes (user sees none of this):
     → Circle creates user-controlled wallet
     → Backend registers maya.arc via treasury
     → Treasury pays 5 USDC registration fee
     → Name resolves to user's wallet address
     → User record saved to database

5. User sees:
   "Welcome, maya.arc"
   [QR Code]
   Balance: 0 USDC
   [Add USDC]  [Share my name]

6. User shares "maya.arc" with anyone
   They send USDC to maya.arc
   It arrives. No address exchanged. Ever.
```

---

## 9. The User Journey — Sending USDC

```
User taps [Send]

"Who are you paying?"
Types: bob

App resolves bob.arc silently → 0xBOB_ADDRESS
Shows: "Sending to bob.arc"
Never shows 0xBOB_ADDRESS

"How much?"
Types: 50

Confirmation:
┌──────────────────────────────┐
│  Sending 50 USDC to bob.arc  │
│  Your balance after: 100 USDC│
│                              │
│  [Confirm]      [Cancel]     │
└──────────────────────────────┘

User enters transaction PIN
Transaction executes
"Sent. bob.arc received 50 USDC."
```

If the user types a raw 0x address instead of a name — the app accepts it but displays it as-is. The system supports both. Names are just the preferred and promoted interface.

---

## 10. The User Journey — Activating the Smart Agent

This is an optional upgrade from within the main wallet. One button. No new app. No new login.

```
Main wallet dashboard
User sees: "✦ Activate Smart Agent"
Taps it

"Your Smart Agent"
─────────────────────────────────
Your agent is a separate wallet you
fund and give instructions to.
It acts on your behalf automatically.

You stay in control. You set the rules.

[Set Agent PIN]   ← 4-6 digits, separate from main PIN
         ↓
PIN set. Agent wallet created silently.
maya-agent.arc registered silently.

"Fund your agent"
─────────────────────────────────
Transfer USDC from your main wallet
to start your agent.

[50 USDC]  [100 USDC]  [Custom]
         ↓
"Your agent is ready."
"What should it do?"
```

From this point the user is in the conversation interface. They type or speak. The agent interprets, confirms, and executes.

---

## 11. The Smart Agent — How It Works

The agent has three layers. Each layer has one job and does not cross into another layer's job.

### Layer 1 — Interpretation (Claude)

Claude receives the user's instruction plus context. It maps the instruction to a skill from a fixed list. It returns structured JSON. That is all it does. It never executes anything. It never sees errors. It never touches money.

**Input to Claude:**
```json
{
  "user_message": "pay sara 50 USDC every Friday",
  "context": {
    "agent_name": "maya-agent.arc",
    "agent_balance": 150,
    "active_policies": [],
    "available_skills": [
      "SEND_USDC", "RECURRING_PAYMENT", "BATCH_PAYMENT",
      "CANCEL_POLICY", "PAYMENT_REQUEST", "x402_PAYMENT",
      "CHECK_BALANCE", "SET_SPEND_LIMIT", "WITHDRAW",
      "REGISTER_NAME"
    ]
  }
}
```

**Output from Claude:**
```json
{
  "understood": true,
  "skill": "RECURRING_PAYMENT",
  "parameters": {
    "recipient": "sara.arc",
    "amount": 50,
    "frequency": "weekly",
    "day": "friday"
  },
  "confirmation_text": "Pay sara.arc 50 USDC every Friday",
  "clarification_needed": null
}
```

### Layer 2 — Confirmation (Frontend)

The frontend renders a confirmation card from Claude's JSON. The user reads it, enters their agent PIN, and taps Confirm. Nothing has happened on-chain yet. This step is mandatory for every new instruction.

```
┌──────────────────────────────────────┐
│  Your agent will:                    │
│                                      │
│  → Pay sara.arc                      │
│  → 50 USDC every Friday              │
│  → Starting this Friday              │
│  → From maya-agent.arc               │
│  → Agent balance after: 100 USDC     │
│                                      │
│  Enter agent PIN to confirm          │
│  [● ● ● ●]                          │
│                                      │
│  [Confirm]           [Cancel]        │
└──────────────────────────────────────┘
```

### Layer 3 — Execution (Policy Engine + Cron)

After confirmation the policy engine validates and saves. The cron job executes on schedule. Claude is never involved again after the confirmation step. Errors are handled by the policy engine and communicated directly to the frontend — never routed back through Claude.

---

## 12. The Agent Skill System

Claude maps every user instruction to one of these ten skills. If it cannot map to any skill it tells the user what the agent can and cannot do. Skills are added to Claude's system prompt as they are built — the agent only knows about skills that are actually implemented in the policy engine.

| Skill | What It Does | Execution Type |
|---|---|---|
| SEND_USDC | One-time transfer to a recipient | Immediate |
| RECURRING_PAYMENT | Repeated transfer on a schedule | Deferred (cron) |
| BATCH_PAYMENT | Send to multiple recipients at once | Immediate (loop) |
| CANCEL_POLICY | Stop a recurring payment | Database update |
| PAYMENT_REQUEST | Generate a payment link or QR | Database + URL |
| x402_PAYMENT | Authorise agent to pay API calls | Policy + event-driven |
| CHECK_BALANCE | Return balance and spend summary | Immediate read |
| SET_SPEND_LIMIT | Update spending caps | Database update |
| WITHDRAW | Move USDC from agent back to main wallet | Immediate |
| REGISTER_NAME | Register a new .arc name | Immediate |

---

## 13. The Policy Engine

Receives confirmed JSON from the frontend. Validates everything. Executes or saves. Returns success or an error code. Claude is never involved at this layer.

### Validation Checks (Run Before Every Execution)

```
1. Valid authenticated session?        → No  = reject
2. User owns this agent wallet?        → No  = reject
3. Agent PIN verified for request?     → No  = reject
4. Recipient resolvable?               → No  = NAME_NOT_FOUND
5. Agent wallet has enough balance?    → No  = INSUFFICIENT_BALANCE
6. Amount within per-tx limit?         → No  = LIMIT_EXCEEDED
7. Within daily/weekly/monthly limit?  → No  = LIMIT_EXCEEDED
```

All seven pass → execute.

### Error Codes and User-Facing Messages

```
INSUFFICIENT_BALANCE  → "Not enough USDC in your agent wallet.
                         Top it up to continue."
NAME_NOT_FOUND        → "We couldn't find that .arc name.
                         Check the spelling and try again."
LIMIT_EXCEEDED        → "This exceeds your spend limit.
                         Update your limits in settings."
WALLET_NOT_FUNDED     → "Fund your agent wallet to get started."
DUPLICATE_POLICY      → "You already have a similar payment running."
AUTH_FAILED           → "Please log in again."
INVALID_PIN           → "Incorrect PIN. X attempts remaining."
PIN_LOCKED            → "Too many attempts. Try again in 15 minutes."
```

---

## 14. The Cron Job

Runs every hour via Vercel Cron. Reads the database. Executes due policies. Claude is never called. No human involvement.

```javascript
// vercel.json
{
  "crons": [
    {
      "path": "/api/agent/execute-due-policies",
      "schedule": "0 * * * *"
    }
  ]
}
```

### Execution Sequence Per Policy

```
1. Re-run all seven validation checks
   (balance may have changed since policy was created)

2. If any check fails:
   → Pause the policy (set active = false)
   → Save failure reason
   → Send push notification: "Agent payment paused — top up needed"
   → Stop. Do not call Circle.

3. If all checks pass:
   → Resolve recipient .arc name → 0x address
   → Build USDC transfer calldata
   → Call Circle createContractExecutionTransaction
   → Wait for on-chain confirmation
   → Insert row into agent_spend_log
   → Update next_run to next occurrence
   → Send push notification: "Agent paid sara.arc 50 USDC"
```

---

## 15. Security Architecture

### Transaction PIN

- Set separately for main wallet and agent wallet
- 4 or 6 digits, or biometric alternative
- Stored as bcrypt hash — raw PIN never saved anywhere
- Required to confirm any new instruction
- Not required for automated cron executions
- 3 wrong attempts → 15 minute lockout
- 5 wrong attempts → locked until email verification

```javascript
// Storing the PIN — never save the raw number
const hash = await bcrypt.hash(userPin, 12)
// Save hash only

// Verifying the PIN
const match = await bcrypt.compare(enteredPin, storedHash)
// true = proceed, false = increment attempts
```

### Biometrics

Face ID or fingerprint as PIN alternative on mobile. If biometrics fail, falls back to PIN entry.

### Default Spend Limits

Applied automatically to every new agent wallet. User can increase with PIN confirmation.

```
max_per_transaction:   50 USDC
max_per_day:          200 USDC
max_per_week:         500 USDC
max_per_month:       1000 USDC
large_tx_alert:       100 USDC
```

### Large Transaction Alerts

Any single transaction above the alert threshold sends a push notification requiring user confirmation before execution. Catches unusual high-value activity.

### Agent Wallet Ownership Enforcement

Every API route touching an agent wallet checks that the authenticated `user_id` matches the `owner_user_id` in the database. No exceptions. A user can never instruct another user's agent wallet.

---

## 16. Database Schema

### users
```
id                    PRIMARY KEY
email
auth_method           google / email_otp
circle_wallet_id      user-controlled wallet ID (Circle)
wallet_address        on-chain address (stored, never shown)
arc_name              e.g. maya.arc
created_at
updated_at
```

### user_security
```
user_id               FOREIGN KEY → users.id
main_pin_hash         bcrypt hash for main wallet
agent_pin_hash        bcrypt hash for agent wallet
biometrics_enabled    boolean
pin_attempts          integer, resets on success
pin_locked_until      timestamp, null if not locked
created_at
updated_at
```

### user_spend_limits
```
id                    PRIMARY KEY
user_id               FOREIGN KEY → users.id
agent_wallet_id       FOREIGN KEY → agent_wallets.id
max_per_transaction
max_per_day
max_per_week
max_per_month
large_tx_alert_threshold
created_at
updated_at
```

### agent_wallets
```
id                    PRIMARY KEY
user_id               FOREIGN KEY → users.id
circle_wallet_id      developer-controlled wallet ID (Circle)
wallet_address        on-chain address (stored, never shown)
arc_name              e.g. maya-agent.arc
balance_cache         updated after each transaction
active                boolean
created_at
updated_at
```

### agent_policies
```
id                    PRIMARY KEY
user_id               FOREIGN KEY → users.id
agent_wallet_id       FOREIGN KEY → agent_wallets.id
skill                 RECURRING_PAYMENT / x402_PAYMENT etc
recipient             .arc name (stored as-is)
recipient_address     resolved 0x (cached at creation)
amount
frequency             daily / weekly / monthly / null
day                   friday / 1 / null
next_run              timestamp
pin_verified_at       when user confirmed with PIN
active                boolean
pause_reason          null or error code if auto-paused
created_at
updated_at
```

### agent_spend_log
```
id                    PRIMARY KEY
user_id               FOREIGN KEY → users.id
agent_wallet_id       FOREIGN KEY → agent_wallets.id
policy_id             FOREIGN KEY → agent_policies.id (null if manual)
skill
amount
recipient             .arc name shown to user
tx_hash               on-chain transaction hash
executed_at
status                success / failed / pending
failure_reason        null or error code
```

### payment_requests
```
id                    PRIMARY KEY
user_id               FOREIGN KEY → users.id
amount
reason
payment_url           unique shareable link
qr_data
expires_at
paid_at               null until paid
paid_by_address       null until paid
tx_hash               null until paid
created_at
```

---

## 17. The Public Profile Page

Every `.arc` name gets a public profile page at `/n/maya`. This is the shareable artifact — a landing page anyone can send USDC to without knowing anything about blockchain.

```
dotarcwallet.app/n/maya

┌────────────────────────────────┐
│                                │
│         maya.arc               │
│                                │
│         [QR Code]              │
│                                │
│   [Send USDC to maya.arc]      │
│                                │
│   Powered by DotArc            │
└────────────────────────────────┘
```

No 0x address shown. No wallet infrastructure visible. Anyone can scan the QR or tap the send button to pay maya. The sender does not need a `.arc` wallet — they just need USDC on Arc.

---

## 18. x402 and the Circle Agent Marketplace

`agents.circle.com` is Circle's marketplace of services that accept USDC payments via the x402 protocol. The x402 protocol lets AI agents pay for API calls automatically — no signup, no credit card, just USDC.

### DotArc as a Buyer
Agent wallets can pay for any service listed on the marketplace. The user authorises the x402_PAYMENT skill with a max spend per call. When the agent calls a paid API and receives a 402 response, the policy engine checks the authorisation and pays automatically.

### DotArc as a Seller
The DotArc name resolution API can be listed on the marketplace. Any agent anywhere pays a small USDC fee to resolve `.arc` names. This creates platform revenue and positions DotArc Smart Wallet as infrastructure for the broader Arc agent ecosystem.

```javascript
// Ten lines to become a seller
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server"

const gateway = createGatewayMiddleware({
  sellerAddress: TREASURY_WALLET_ADDRESS,
  facilitatorUrl: "https://gateway-api-testnet.circle.com"
})

app.get("/resolve/:name", gateway.require("$0.001"), resolveHandler)
```

---

## 19. Feature Roadmap

### Phase 1 — Core Wallet
- [ ] Google / email OTP authentication
- [ ] Circle user-controlled wallet creation (no 0x shown)
- [ ] .arc name registration via treasury (silent, backend)
- [ ] Main wallet dashboard — balance, QR, name
- [ ] Send USDC by .arc name (0x address hidden)
- [ ] Receive via QR and shareable name
- [ ] Transaction history
- [ ] Public profile page at /n/<name>
- [ ] HashPay payment link generation

### Phase 2 — Smart Agent Foundation
- [ ] Agent wallet creation (one button activation)
- [ ] Separate agent PIN setup and bcrypt storage
- [ ] Default spend limits on creation
- [ ] Agent conversation UI — text input, confirmation card
- [ ] Claude interpretation endpoint
- [ ] Policy engine with all validation checks
- [ ] SEND_USDC skill
- [ ] CHECK_BALANCE skill
- [ ] CANCEL_POLICY skill
- [ ] WITHDRAW skill (agent → main wallet)

### Phase 3 — Agent Intelligence
- [ ] RECURRING_PAYMENT skill + Vercel cron job
- [ ] BATCH_PAYMENT skill
- [ ] SET_SPEND_LIMIT skill
- [ ] PAYMENT_REQUEST skill
- [ ] Voice input (speech-to-text into existing pipeline)
- [ ] Push notifications for all agent activity
- [ ] Large transaction alerts
- [ ] Agent activity feed and policy management UI

### Phase 4 — Ecosystem
- [ ] x402_PAYMENT skill
- [ ] List DotArc resolution API on Circle agent marketplace
- [ ] REGISTER_NAME as agent-callable skill
- [ ] Name renewal automation
- [ ] CCTP cross-chain withdrawals (pending Arc support)
- [ ] Link external wallets to .arc profile (for power users)

### Phase 5 — Scale (When Arc Matures)
- [ ] Yield on idle USDC in agent wallet
- [ ] Swap / DCA when DEX deploys on Arc
- [ ] Agent-to-agent payment flows
- [ ] On-chain spend policy enforcement via smart contracts

---

## 20. Environment Variables

```
# Circle — backend only, never in frontend, never in git
CIRCLE_API_KEY=
CIRCLE_ENTITY_SECRET=
CIRCLE_TREASURY_WALLET_SET_ID=
CIRCLE_TREASURY_WALLET_ID=
CIRCLE_AGENT_WALLET_SET_ID=

# Circle — safe to expose to frontend (public app identifier)
NEXT_PUBLIC_CIRCLE_APP_ID=

# Arc Testnet — fixed values
ARC_REGISTRY_ADDRESS=0xf5e0E328119D16c75Fb4a001282a3a7b733EF6db
ARC_RPC_URL=https://rpc.testnet.arc.network

# App
DATABASE_URL=
JWT_SECRET=
ANTHROPIC_API_KEY=
```

Note: There is no `TREASURY_PRIVATE_KEY`. Circle developer-controlled wallets use MPC — there is no exportable private key. Signing is done entirely via Circle's `createContractExecutionTransaction` API using the entity secret. This is by design.

---

## 21. Network Reference

| Property | Value |
|---|---|
| Chain | Arc Testnet |
| Chain ID | 5042002 |
| RPC URL | `https://rpc.testnet.arc.network` |
| ANS Registry Contract | `0xf5e0E328119D16c75Fb4a001282a3a7b733EF6db` |
| USDC Token Contract | `0x3600000000000000000000000000000000000000` |
| Block Explorer | `https://testnet.arcscan.app` |
| Gas Token | USDC — no ETH needed for any transaction |
| Standard Name Fee | 5 USDC per year |
| Short Name Fee | 50 USDC per year (4 chars or fewer) |
| Circle Faucet | `https://faucet.circle.com` |
| Circle Agent Marketplace | `https://agents.circle.com` |

---

## 22. Build Order for the Builder

Follow this exactly. Do not jump ahead. Each item unblocks the next.

```
WEEK 1 — Authentication and wallet creation
  □ Google OAuth / email OTP login
  □ /api/create-user-session
  □ /api/get-user-wallet
  □ Circle user-controlled wallet creation flow
  □ Name picker with live availability check
  □ /api/register-name (treasury pays silently)
  □ Main wallet dashboard (balance, QR, name only — no 0x)

WEEK 2 — Core wallet features
  □ Send USDC by .arc name (resolve silently, hide address)
  □ Receive QR generation
  □ Transaction history
  □ Public profile page /n/<name>
  □ HashPay payment link

WEEK 3 — Agent foundation
  □ Agent wallet activation flow (one button)
  □ Agent PIN setup (separate from main PIN)
  □ Default spend limits applied on creation
  □ /api/agent/interpret (Claude endpoint)
  □ Confirmation card UI
  □ /api/agent/confirm-policy (policy engine)
  □ SEND_USDC and CHECK_BALANCE skills end to end

WEEK 4 — Agent intelligence
  □ RECURRING_PAYMENT skill
  □ Vercel cron job
  □ CANCEL_POLICY and WITHDRAW skills
  □ Push notifications
  □ Agent activity feed

Everything after week 4 follows the Phase 3-5 roadmap.
Do not build Phase 3 features until Phase 1 and 2
work end to end and have been tested thoroughly.
```
