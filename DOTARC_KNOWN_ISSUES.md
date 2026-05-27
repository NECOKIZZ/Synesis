# DotArc — Known Issues & Architectural Debt

> Documented: 2026-05-27  
> Status: Open items tracked below. Closed items noted with ✅ fix date.

---

## 1. Missing cirBTC Contract Address

**Problem:** Circle App Kit chain definitions only expose `usdcAddress` and `eurcAddress` for Arc Testnet. `cirBTC` has no public contract address.

**Evidence:**
- `node_modules/@circle-fin/app-kit/chains.d.ts` → `ArcTestnet` has `eurcAddress` and `usdcAddress` only.
- `lib/skills/send-token.ts` hardcodes `CIRBTC: { address: null, alias: "cirBTC" }`
- `lib/skills/swap-usdc.ts` hardcodes `CIRBTC: { address: null, decimals: 8 }`

**Impact:**
- Main wallet cannot display cirBTC balance via public RPC (no address to query).
- Agent skill code falls back to Circle dev-wallet API (`getWalletTokenBalance`) which requires server-side API key.

**Workaround:** Leave `NEXT_PUBLIC_CIRBTC_TOKEN_ADDRESS=` blank in `.env`. Wallet gracefully skips it.

**Fix needed:** Get official Arc Testnet cirBTC contract address from Circle, then fill the env var.

---

## 2. Task Type Hierarchy Is Flat (Architectural)

**Problem:** `task_type` is a single enum: `"compound" | "recurring" | "conditional" | "immediate"`. This forces every task into one bucket, making it impossible to express a compound plan where some steps are immediate and others are scheduled.

**Evidence:**
- Complex test case: *"swap all EURC to USDC, send half to cryptolympus on Friday, withdraw remaining half instantly"*
- LLM returned `task_type: "compound"` with all steps immediate. "on Friday" was only in description text, not actionable.

**Root cause:** The data model assumes:
- Compound = all immediate
- Recurring = single scheduled action
- Never the two shall mix

**Correct model (when fixed):**
```
task_type: "compound" | "simple"
  compound_steps: Array<{
    skill: string;
    params: object;
    execution_mode: "immediate" | "recurring" | "conditional";
    schedule?: ScheduleConfig;
    condition?: ConditionConfig;
  }>
```

**Files to change when fixed:**
- `lib/agent-types.ts` — add `execution_mode` to `PlanStep`
- `app/api/agent/confirm-policy/route.ts` — route each step to right executor
- `lib/agent-core.ts` — update prompt to tag each step with mode
- `app/wallet/wallet-shell.tsx` (AgentTab) — render mixed timelines

**Status:** Acknowledged. Not urgent — flat model covers 90%+ of real usage.

---

## 3. Main Wallet Activity Not Captured

**Problem:** The Activity tab only shows `agent_spend_log` rows. Main wallet transactions (sends via SendModal) and ALL receives are invisible.

**Evidence:**
- `app/wallet/page.tsx` fetches `/api/agent/status` → maps `recentActivity` from `agent_spend_log` only.
- `app/wallet/send-modal.tsx` executes via Circle SDK in browser; nothing hits backend.
- No incoming transfer listener for either wallet.

**Gap table:**

| Transaction Type | Logged? | Source |
|------------------|---------|--------|
| Agent SEND_USDC  | ✅ Yes  | `agent_spend_log` |
| Agent WITHDRAW   | ✅ Yes  | `agent_spend_log` |
| Agent SWAP       | ✅ Yes  | `agent_spend_log` |
| Main wallet Send | ❌ No   | Browser SDK only |
| Any Receive      | ❌ No   | Not captured |

**Fix options:**
- **Path A:** On-chain polling via RPC (Transfer events). No backend needed. Works for sends + receives.
- **Path B:** New `wallet_transactions` table. Log sends after Circle challenge. Poll RPC for receives.

**Status:** Documented. User requested to defer fix.

---

## 4. Agent Partial Balance Prompt Deficiency (FIXED ✅ 2026-05-27)

**Problem:** LLM swapped full token amounts even when the wallet held partial balances. Example: wallet has 3 EURC, user wants to send 5 EURC → LLM tried to swap 5 EURC worth of USDC, ignoring the existing 3.

**Root cause:** System prompt lacked explicit stepwise logic for partial balance calculation.

**Fix applied:** Rewrote `SMART BALANCE INFERENCE` section in `lib/agent-core.ts`:
- Added explicit shortfall calculation: `shortfall = amount_needed - existing_balance`
- Added rule: swap only shortfall (+ slippage), never full amount
- Added critical warning: "Do NOT ignore the existing balance"

**Validation:**
- `test-cases/send-cryptolympus-eurc-partial.json` — passes, returns correct shortfall swap amount

---

## 5. Time Constraints Silently Dropped in Compound Tasks

**Problem:** When a compound instruction mixes scheduling ("on Friday") with immediacy ("instantly"), the LLM ignores the scheduling constraint and marks everything immediate.

**Evidence:**
- Complex test case: `complex-swap-split.json`
- Result: all 3 steps had `task_type: "compound"` (implicit immediate). "on Friday" only appeared in description text.

**Relation to Issue #2:** This is a symptom of the flat hierarchy. The LLM has no valid bucket for "compound + recurring", so it silently downgrades to compound immediate.

**Status:** Will resolve when Issue #2 is fixed.

---

## 6. Main Wallet Only Showed USDC (FIXED ✅ 2026-05-27)

**Problem:** Assets section hardcoded USDC only. EURC and cirBTC balances were invisible.

**Fix applied:**
- `app/wallet/page.tsx` — fetches all configured tokens in parallel via public RPC
- `app/wallet/wallet-shell.tsx` — dynamic `TokenRow` rendering with token-specific styling
- `.env.local` / `.env.example` — added `NEXT_PUBLIC_EURC_TOKEN_ADDRESS` and `NEXT_PUBLIC_CIRBTC_TOKEN_ADDRESS`

**Limitation:** EURC works (address from App Kit). cirBTC still needs official address.

---

## 7. Activity Page Shows Agent Log Only, No Full History

**Problem:** The Activity tab is labeled "Recent" but only surfaces agent actions. Users expect to see ALL transactions — main wallet sends, receives, agent actions.

**Evidence:**
- Empty-state text says: *"Send or receive USDC and your transactions will appear here."*
- But receives never appear. Main wallet sends never appear.

**Status:** Same as Issue #3 — deferred.

---

## 8. Agent Confirm-Policy Endpoint Logging Overgrowth

**Problem:** Trace ID logging was added extensively to `confirm-policy` and `interpret` routes for debugging. Some logs may expose internal state (e.g., parsed request body before PIN sanitization).

**Evidence:**
- `app/api/agent/confirm-policy/route.ts` logs `parsed` body directly.
- Security rules say: *"NEVER log Circle userToken, encryptionKey, JWT_SECRET, or full Circle API responses"*

**Mitigation:** Logs are development-only. Before production, audit all `console.log` in agent routes.

**Status:** Cleanup needed before mainnet.

---

## Summary Table

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | Missing cirBTC address | Medium | Blocked (need Circle) |
| 2 | Flat task type hierarchy | Medium | Acknowledged, deferred |
| 3 | Main wallet / receive logs missing | High | Deferred |
| 4 | Partial balance prompt bug | High | ✅ Fixed |
| 5 | Time constraints dropped | Medium | Blocked by #2 |
| 6 | USDC-only Assets display | Medium | ✅ Fixed |
| 7 | Activity tab incomplete | High | Deferred (same as #3) |
| 8 | Debug logging cleanup | Low | Pre-production task |
