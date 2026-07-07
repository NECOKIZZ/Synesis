# Synesis — Pitch Deck

> The agentic USDC wallet that understands you. Speak or type plain English; it navigates the blockchain on your behalf — safely.

---

## Slide 1 — The One-Liner

**Synesis turns natural language into on-chain action.**

You say *"send 5 USDC to sara every Monday"* or *"swap 20 to EURC and bridge it to Base"* — and a developer-controlled agent wallet on **Arc** interprets, confirms, and executes. No seed phrases to manage, no contract calls to write, no chains to bridge by hand.

One PIN. One sentence. The agent does the rest.

---

## Slide 2 — The Problem

- **Crypto UX is hostile.** Sending a token means addresses, gas, chains, approvals, slippage — a checklist most people get wrong.
- **Agents are dangerous with money.** Letting an LLM touch a wallet directly = one hallucination away from a drained account.
- **Cross-chain DeFi is expert-only.** Bridging USDC to a yield protocol is a 3-step, multi-chain dance with partial-failure landmines.
- **Wallets have no memory.** Every interaction starts from zero — they don't know who you pay, what you prefer, or what you asked yesterday.

---

## Slide 3 — The Solution

A wallet with an agent in front of it, built on a hard security boundary:

```
  Claude decides WHAT to do.        The executor decides IF it's ALLOWED and HOW.
  (never touches keys)              (auth → PIN → spend limits → balance)
```

**Three-step pipeline, every single time:**

```
User message (voice or text)
        │
   INTERPRET   →  Claude parses intent → structured JSON task(s)
        │
   CONFIRM     →  User sees a ConfirmCard, enters PIN (if funds move)
        │
   EXECUTE     →  Skill handler signs tx, logs spend, returns result
```

The LLM never gets the keys. That separation is the whole security model.

---

## Slide 4 — Live Capabilities (13 skills live + 2 flag-gated)

| | Skill | What it does |
|---|---|---|
| 💸 | **SEND_USDC / SEND_TOKEN** | Send USDC or EURC to a `.arc` name or address |
| 🔁 | **SWAP_USDC** | In-wallet swaps via Circle App Kit (USDC ↔ EURC ↔ cirBTC) |
| 🌉 | **BRIDGE_USDC** | Cross-chain USDC via Circle CCTP (Arc → Base, Ethereum, Arbitrum, Optimism, Polygon, Avalanche — all Sepolia/testnet) |
| 💳 | **PAY_X402** | Pay-per-call access to x402 APIs in USDC (no API keys, no accounts) |
| 📊 | **CHECK_BALANCE / GET_PRICE** | Cached balance reads + oracle prices |
| ⏰ | **CREATE / CANCEL / LIST_POLICY** | Recurring & conditional automation ("every Monday", "when BTC < X") |
| 🔒 | **SET_LIMIT** | Per-tx / daily / weekly / monthly USDC spend caps |
| 🎲 | **IKNOW** | Match a belief to live prediction-market odds |
| 📜 | **RETRIEVE_TRANSACTIONS** *(flag-gated)* | Query spend log by date, token, recipient, direction |
| ◎ | **SEND_SOLANA_USDC** *(flag-gated, devnet)* | SPL-USDC transfer on Solana via Circle's Signing API — the newest chain surface |

**13 skills always registered + 2 flag-gated = 15 defined.** **Categories** — `READ` (no PIN), `TRANSFER` (PIN + spend limits where value leaves custody), `CONFIG` / `POLICY` (configure the agent). Category dictates which security layers fire.

> **On the roadmap, not yet live:** cross-chain **yield** (bridge to Arbitrum → supply AAVE v3 → earn live APR). The bridge groundwork and the full build plan exist (`CROSS_CHAIN.md` Part I); the `INVEST_YIELD` skill is not shipped. Presented honestly on Slide 8.

---

## Slide 5 — Voice-Native

Talk to your wallet. **Zero external dependency, zero cost, zero latency.**

- **Speech-to-Text** — browser-native `SpeechRecognition`, live interim transcripts as you speak
- **Text-to-Speech** — browser-native `SpeechSynthesis`, reads agent replies aloud, auto-selects natural voices
- **On-device** — no ElevenLabs, no Whisper, no audio upload, no API keys. Self-hides gracefully where unsupported.

Wired straight into the chat composer — voice is a first-class affordance, not a bolt-on.

---

## Slide 6 — The Memory Stack (the moat)

Most wallets are stateless. Synesis remembers — across **4 deliberately separated layers:**

| Layer | What it remembers | Store | When it fires |
|---|---|---|---|
| **1 · Contact Memory** | Who you deal with — send/receive counts, USD volumes, favorite token, recency | Supabase (deterministic) | Only on send intents |
| **2 · User Profile** | Your standing style & preferences (≤600 chars) | Supabase | Always injected |
| **3 · Walrus Episodic** | Learned + explicit facts, session summaries — semantically searchable | **Walrus** (decentralized) | Semantic recall every turn |
| **4 · Session History** | In-conversation transcript for follow-ups ("make it 20", "send her another 5") | Client-side, never persisted | Every message |

**Why it's clever:**
- **Deterministic vs. learned are separated** — counters never get confused with fuzzy facts.
- **Intent-gated injection** — "send to sara" surfaces your contact digest; "hello" surfaces nothing. No noise.
- **One embedding does double duty** — the same vector that routes skills also triggers memory. Recall is effectively *free*.
- **Walrus = decentralized memory** — per-user namespace, fire-and-forget writes, never blocks a transaction.

---

## Slide 7 — Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  CLIENT  ·  Next.js 15 / React 19 / Tailwind                       │
│  Chat UI  +  🎙 MicButton (STT)  +  🔊 SpeakButton (TTS)            │
└───────────────────────────────┬──────────────────────────────────┘
                                 │  POST /api/agent/interpret
                                 ▼
┌──────────────────────────────────────────────────────────────────┐
│  AGENT CORE v3  (lib/agent-core-v3.ts)                             │
│                                                                    │
│   1. Build context ──► balance · limits · profile · .arc name      │
│                        · Walrus recall · contact memory            │
│   2. Skill Router  ──► embed message → pgvector top-K skills       │
│                        (cosine ≥ 0.4, else full catalog fallback)  │
│   3. Claude (via OpenRouter) → JSON { tasks[], confirm_message }   │
│   4. JSON repair + validate → ConfirmCards                         │
└───────────────────────────────┬──────────────────────────────────┘
                                 │  user enters PIN
                                 ▼  POST /api/agent/confirm-policy
┌──────────────────────────────────────────────────────────────────┐
│  EXECUTOR  ·  Security Layers (auto, every TRANSFER)              │
│   Auth → PIN → Spend limits → Balance   then → Skill.execute()    │
│                                                                    │
│   Skill Registry ──► SEND · SWAP · BRIDGE · PAY_X402 · SOLANA …   │
│   Spend Log ──► PENDING → COMPLETE / FAILED  (audit + idempotent)  │
└──────────┬───────────────────────────────────┬───────────────────┘
           │                                    │
           ▼                                    ▼
┌─────────────────────┐            ┌──────────────────────────────┐
│  CIRCLE             │            │  ON-CHAIN                     │
│  Dev-Controlled Wlt │            │  Arc Testnet (USDC = gas)     │
│  User-Controlled    │            │  CCTP → Base/Eth/Arb/…        │
│  App Kit · CCTP     │            │  Solana devnet (Signing API)  │
│  Signing API (SOL)  │            │  AAVE v3 / Arbitrum (roadmap) │
│  Webhooks (ECDSA)   │            │                               │
└─────────────────────┘            └──────────────────────────────┘
           ▲
           │  Supabase (RLS) · Walrus (episodic) · pgvector (skill + memory embeddings)
```

---

## Slide 8 — Cross-Chain, Two Ways

**Shipped today — Solana (devnet).** EVM and Solana use different mechanics; Circle abstracts EVM (`createContractExecutionTransaction`) but Solana has no equivalent, so we built the harder path:

```
Arc agent wallet (Circle, EVM)        Solana agent wallet (Circle, devnet)
   │ SEND / SWAP / BRIDGE (CCTP)          │ 1. we build the SPL-USDC tx
   ▼                                      │ 2. Circle Signing API signs it
Base / Ethereum / Arbitrum / …           │ 3. we broadcast + confirm on devnet
                                          ▼
                                   idempotent recipient ATA + transferChecked
```

- One agent, two custody surfaces (separate `agent_wallets` rows, chain-stamped spend log). An `.arc` name never leaks onto Solana; a base58 never leaks onto Arc.
- Honest gotcha we handle: the Solana wallet holds USDC but pays fees in **SOL** — `assertSolForFees` gates every signing attempt with a clear "needs SOL" message.

**On the roadmap — cross-chain yield (Arc → Arbitrum → AAVE v3).** The design is locked and the bridge groundwork is in place (`CROSS_CHAIN.md` Part I):

```
Arc wallet (USDC) ─CCTP forwarder→ Arbitrum wallet (same address) ─approve→ AAVE supply() → aUSDC (live APR)
```

- **APR read live on-chain** from AAVE's DataProvider — never hardcoded.
- **Partial-failure safe by design** — if the bridge lands but supply fails, funds aren't lost; the spend log stays `FAILED` and "invest" resumes idempotently from the existing balance.
- **Status:** `INVEST_YIELD` / `WITHDRAW_YIELD` are specced, not yet built. We show it as the next chain of the same engine, not as a live feature.

---

## Slide 9 — Why It's Safe

- **Keys never touch the LLM.** Claude outputs JSON; the executor holds the keys.
- **4 enforced security layers** on every fund-moving skill: Auth → PIN → Spend limits → Balance.
- **Spend log is the source of truth** — every transfer writes `PENDING` *before* the chain call, so limits can never be silently bypassed across skills.
- **Idempotency keys** prevent double-execution on double-confirm or replay.
- **Row-Level Security** — users read only their own data; skill writes go through a separate service role.
- **Webhooks ECDSA-verified** — Circle notifications are cryptographically authenticated before they touch state.
- **Graceful degradation everywhere** — Walrus down? Router fails? Embedding errors? The user is never blocked.

---

## Slide 10 — The Stack

| Layer | Tech |
|---|---|
| **Frontend** | Next.js 15 · React 19 · Tailwind · Web Speech API (voice) |
| **Agent brain** | Claude via OpenRouter · pgvector skill routing · JSON-repair pipeline |
| **Wallets** | Circle Developer-Controlled + User-Controlled · App Kit · CCTP · Signing API (Solana) |
| **Chains** | **Arc Testnet** (USDC = native gas) · Base / Ethereum / Arbitrum / Optimism / Polygon / Avalanche (CCTP testnets) · Solana devnet · *Arbitrum + AAVE = roadmap* |
| **Data** | Supabase (Postgres + RLS) · pgvector (skill + memory embeddings) |
| **Memory** | Walrus (decentralized episodic) · Supabase (contact + profile) |
| **Payments** | x402 micropayments · Circle webhooks |

---

## Slide 11 — Why Now / Why This Wins

- **USDC-native by design** — Arc makes USDC the gas token. No "buy ETH first" friction. The whole experience is dollars in, dollars out.
- **Agentic, but accountable** — we solve the thing everyone fears about AI + money: the agent proposes, the security layer disposes.
- **Memory is the durable moat** — a wallet that learns who you pay and what you prefer gets *better* with use. Competitors reset every session.
- **Composable skills** — 15 defined (13 live + 2 flag-gated), each a clean `SkillHandler`. Adding a protocol or chain is a contained, documented change, not a rewrite — Solana SPL and the semantic skill router both landed this way.

---

## Slide 12 — Ask / Vision

**Today:** A voice-native, memory-equipped agent wallet on Arc Testnet with send, swap, bridge (CCTP), Solana SPL transfers (devnet), recurring + conditional automation, pay-per-call x402 APIs, and prediction-market lookups — all behind one sentence and one PIN.

**Next:** Cross-chain yield (AAVE v3 on Arbitrum — designed, next to ship) · mainnet · more yield protocols · richer policy automation · a marketplace of community-built skills.

**The vision:** *Your money, spoken into action — safely.*
