# DotArc — x402 & Future Integrations

This document captures the full x402 strategy, revenue model, and future integration thinking for DotArc Smart Wallet. It is a living document and sits alongside the Master Architecture.

---

## 1. What x402 Actually Is

x402 is an open protocol for internet-native payments. It resurrects HTTP status code 402 — "Payment Required" — which has existed in the internet's rulebook since 1991 but was never used. x402 finally makes it real.

The flow is simple:

```
Client requests a resource
  → Server responds: 402 Payment Required + payment instructions
  → Client signs a payment authorization (USDC, no blockchain tx yet)
  → Client retries the request with X-PAYMENT header
  → Server verifies via a facilitator (Circle Gateway)
  → Server delivers the resource
  → Gateway settles payments in batches onchain later
```

The key insight: **no accounts, no credit cards, no invoices, no API key management.** A wallet is the identity. USDC is the currency. The protocol handles everything else.

Circle Gateway acts as the facilitator — it verifies payments instantly and settles batches onchain, which means thousands of micropayments can happen without clogging the blockchain or paying gas on every single one.

---

## 2. Why x402 Is the Right Revenue Model for DotArc

Most wallets charge subscription fees or take a percentage cut on transfers. Both of these create friction — subscriptions are a commitment, and percentage cuts punish high-value users.

x402 enables a different model: **pay exactly for what you use, automatically, from the agent wallet the user already funded.**

This works for DotArc because:

- Users already fund an agent wallet to activate Smart Agent
- That wallet holds USDC and is developer-controlled (your backend can sign)
- Every intelligent action the agent takes has a real cost (LLM call, external data)
- x402 lets you recover that cost per-use without a subscription

The user experience stays clean — they fund their agent, they get smart payments. Behind the scenes, micro-costs are covered automatically by the protocol.

---

## 3. DotArc's Two x402 Revenue Streams

### Stream 1 — LLM Interpretation (Agent Wallet Pays Per Use)

Every time a user gives the agent a natural language instruction, your backend calls Claude to interpret it. That call costs you real money. With x402, the agent wallet covers it automatically.

```
User: "send 1 ETH to maya every Friday"
  → Agent wallet signs x402 payment: $0.005
  → Your backend calls Claude: costs you $0.003
  → You keep: $0.002 margin
  → Policy stored, no further LLM calls until user changes it
```

The pricing config (one file, one place):

```javascript
export const X402_PRICES = {
  llm_interpretation: "$0.005",   // per natural language instruction
  bridge_execution:   "$0.02",    // per cross-chain bridge
  swap_execution:     "$0.02",    // per token swap
  // orchestration: parked — revisit at scale
  // name_resolution: FREE — always, for developers
}
```

This means users are literally paying for their own AI. You never subsidize their usage.

### Stream 2 — External Data & APIs (Agent Pays As It Goes)

This stream is about your agent being a buyer — paying for premium external services when the user's instruction requires them.

Real examples:

- User says "send ETH to maya only if ETH is below $3,000 today" → agent calls a paid price oracle ($0.002), pays automatically, gets the price, proceeds or waits
- User says "bridge when gas on Ethereum is cheapest" → agent calls a gas tracking API ($0.001), pays, gets optimal timing
- User says "check if this wallet is safe before sending" → agent calls a compliance/screening API ($0.005), pays, gets risk report

None of this requires you to pre-integrate or contract with those APIs. Any service that speaks x402 is instantly usable by your agents. The ecosystem grows and your agents get smarter without you doing extra work.

These costs come out of the agent wallet balance, covered by the user's initial funding.

---

## 4. The Registry — Stays Free, Always

The `.arc` name resolution API is **never** put behind x402. This is a deliberate strategic decision.

DotArc is in the adoption phase of a developer platform. The single most important thing during this phase is getting developers to integrate `.arc` resolution into their products. Charging even $0.001 per resolution call will kill adoption before it starts.

The correct model, learned from Stripe, Twilio, and ENS:

```
Registry integration: FREE
  → More apps integrate .arc resolution
  → More places .arc names work
  → More value in owning a .arc name
  → More users want a DotArc wallet
  → More users paying for Smart Agent features
  → That's where you earn
```

The registry being free is not a missed revenue opportunity. It is the competitive moat. Every app that integrates `.arc` resolution becomes a distribution channel for DotArc wallets — for free.

Revisit registry pricing only after `.arc` names are so deeply embedded in the Arc ecosystem that developers have no viable alternative. That is leverage. Charge then, not now.

---

## 5. The Orchestration Layer — Parked for Now

The multi-skill coordination flow (BRIDGE → SWAP → RESOLVE → SEND) has real value that other developers would pay for. The vision:

```
POST /api/agent/execute
x402: $0.05 per orchestration

{
  "instruction": "send 1 ETH to maya.arc",
  "from_wallet": "0x...",
  "from_token": "USDC"
}
```

Any app, any agent, anywhere on the internet calls this and pays $0.05. You run the full skill chain — balance check, name resolution, bridge, swap, send — and they get the result. DotArc becomes infrastructure, not just a wallet.

**This is parked.** The right time to build this is after:
- Phase 1 and 2 are live and stable
- Real users are using the skill chain daily
- External developers are already asking for API access

Do not build it speculatively. Build it when someone asks for it and is willing to pay.

---

## 6. The LLM Cost & Scale Problem — Solved

### The Cost Problem

You cannot absorb LLM costs for 1 million users. The solution is x402 Stream 1 — the agent wallet pays per interpretation. You price it at a margin above your actual Anthropic cost. Users are paying for their own intelligence layer.

For users who want a predictable cost, offer a flat monthly Smart Agent fee that covers N interpretations per month. Under the hood it's the same mechanism — the agent wallet is pre-charged at subscription time.

### The Throughput Problem

One API key cannot handle 1 million simultaneous requests. But 1 million users does not mean 1 million simultaneous requests. The math:

| Users | Avg calls/day | Calls/second | Manageable? |
|---|---|---|---|
| 10,000 | 20,000 | ~0.2/sec | Trivially yes |
| 100,000 | 200,000 | ~2/sec | Yes |
| 1,000,000 | 2,000,000 | ~23/sec | Yes, with a queue |

The infrastructure solution is a job queue — not calling Claude synchronously:

```
User sends instruction
  → Queued instantly (user sees: "Got it, processing...")
  → Worker pulls from queue at controlled rate
  → Worker calls Claude
  → Result pushed back via websocket or notification
```

Workers scale horizontally. Rate is controlled. Spikes are absorbed.

### The Critical Optimization

Once a policy is interpreted and stored, **it never needs Claude again.** The cron job that executes "pay netflix.arc 15 USDC every month" reads the stored policy from the database and executes directly — no LLM call. Claude only runs when the user creates or changes a policy.

Real LLM call volume per user: 2–5 calls per month (when they set up or adjust policies). Not per transaction. This changes the scale math entirely.

---

## 7. The Full Revenue Picture

```
┌─────────────────────────────────────────────────────┐
│                  DOTARC REVENUE                      │
│                                                      │
│  Stream 1: LLM Interpretation                        │
│  ─────────────────────────────                       │
│  Who pays: agent wallets (your users)                │
│  When: every natural language instruction            │
│  How: x402 micro-charge per call                     │
│  Margin: ~$0.002 per call                            │
│                                                      │
│  Stream 2: External Data                             │
│  ────────────────────────                            │
│  Who pays: agent wallets (your users)                │
│  When: agent needs external data to execute          │
│  How: x402 buyer, agent wallet pays APIs directly    │
│  Margin: none (cost recovery, improves agent value)  │
│                                                      │
│  Stream 3: Orchestration API [PARKED]                │
│  ────────────────────────────────────                │
│  Who pays: external developers / agents              │
│  When: they need the full skill chain as a service   │
│  How: x402 on /api/agent/execute endpoint            │
│  Margin: ~$0.04 per orchestration                    │
│                                                      │
│  Registry: FREE — forever during adoption phase      │
│  ─────────────────────────────────────────────────   │
│  Strategic moat, not a revenue line                  │
└─────────────────────────────────────────────────────┘
```

---

## 8. What x402 Is NOT Inside DotArc

To be precise about where x402 sits in the architecture:

x402 is **not** inside the skill chain. When maya says "send 1 ETH to maya.arc," the flow:

```
CHECK_BALANCE → RESOLVE_NAME → BRIDGE → SWAP → SEND
```

...runs entirely through your own skills, your own Circle wallets, your own backend. None of that is x402. That is your product working as designed.

x402 operates at **two boundaries**:

1. **Inbound** — when you want to charge for your services (LLM interpretation, future orchestration API)
2. **Outbound** — when your agent needs to pay an external service for data it requires

The orchestration stays internal. x402 wraps it.

---

## 9. Build Order for x402

Follow the existing phase roadmap. x402 inserts as follows:

**Phase 4 (Ecosystem):**
- x402_PAYMENT skill — agent wallet as buyer, pays external data APIs
- Wrap `/api/agent/interpret` with x402 seller middleware — agent wallet pays per LLM call
- Configure pricing in `X402_PRICES` config file
- Set up Circle Gateway seller wallet for revenue collection
- Set up withdrawal flow from Gateway Balance to treasury

**After Phase 4 is stable:**
- Monitor which external x402 APIs are being called and how often
- Identify the highest-value data sources for your users
- Consider negotiating direct integrations with the top ones

**At scale (post Phase 5):**
- Evaluate orchestration API exposure
- Evaluate tiered pricing (free tier, paid tier, enterprise)
- Registry pricing decision — only with ecosystem leverage

---

## 10. Two New Environment Variables

```
# App Kit — required for Swap skill
KIT_KEY=

# Circle Gateway — x402 seller facilitator
CIRCLE_GATEWAY_FACILITATOR_URL=https://gateway-api-testnet.circle.com
```

These are the only new credentials x402 and App Kit require. Everything else uses your existing `CIRCLE_API_KEY` and `CIRCLE_ENTITY_SECRET`.

---

## 11. The Strategic Frame

> You are not building a wallet. You are building financial infrastructure with a wallet as the front door.

The `.arc` registry is a naming layer for Arc. The skill chain is an orchestration layer for cross-chain payments. The x402 seller endpoints are a monetization layer for the Arc agent ecosystem.

Each layer is independently valuable. Each layer makes the others more defensible.

- More developers integrate `.arc` → more valuable to have a `.arc` name → more wallet users
- More wallet users → more agent wallet activity → more x402 revenue
- More x402 revenue → more investment in skills → better orchestration → more developers integrate

This is a flywheel, not a feature list. Build the registry moat first. Let the revenue follow naturally.
