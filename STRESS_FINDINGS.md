# Stress-Test Findings — Working Scratchpad

> **What this is:** the ephemeral working log for the current debugging/stress-test
> session. Low ceremony, append-as-we-go. Survives terminal close (it's a file on
> disk), but it is **not** the permanent record — once a finding is confirmed and
> understood, it graduates into `KNOWN_ISSUES.md` (bugs/debt) or `STRESS_TEST.md`
> (test verdicts) and can be trimmed from here.
>
> **Status legend:** 🔴 open · 🟡 needs-info · 🟢 fixed-this-session · ⚪ won't-fix/env
>
> **Entry schema:** `F-<n> · <title> · <status>` then Symptom / Root cause / Evidence /
> Action / Where.

Session started: 2026-07-03 · branch `v3.5-memory` · dev server on :3000

---

## ✅ PHASE 0 APPLIED (2026-07-03) — critical patches, tsc clean

The remediation plan's Phase 0 (critical unblock, patches only) is DONE and typechecks:

- **F-14 FIXED** — added `"GET_PRICE"` to `VALID_LEAF_SKILLS` (`lib/agent-core-v3.ts`). Price
  tasks are no longer rejected post-LLM.
- **F-4 FIXED** — stripped the em dash from both `X-Title` header literals in
  `app/api/agent/memory/session-end/route.ts` (`— Memory`/`— Profile` → `- Memory`/`- Profile`).
  Confirmed only these two carried it (interpret's `X-Title` at `agent-core-v3.ts:779` was
  already clean). Session-end memory writes (Profile + MemWal) no longer crash → those two
  memory layers can populate again.
- **F-11 FIXED** — `swap-usdc.ts`: canonical `SUPPORTED_TOKENS` now uppercase (`CIRBTC`) with a
  `SUPPORTED_TOKENS_DISPLAY` for user copy, so the case-mismatch is gone; added a null-address
  guard so cirBTC now fails honestly ("aren't available yet — no contract on Arc testnet")
  instead of a self-contradicting "unsupported" or a downstream App Kit crash.
- **F-13 FIXED** — tightened the numeric hazard in all three tables (`friendly-errors.ts`,
  `errors.ts`, `circle.ts`): 4xx/5xx/429 now require an `HTTP`/`status`/`status code` prefix, so
  bare numbers in prose ("max 500 chars", "550 USDC") are no longer misclassified/rewritten.
  Word alternates (`server error`, `unauthorized`, …) still catch real HTTP errors. Verified
  with a regex unit check.

**RE-VERIFIED AGAINST CODE 2026-07-04** (after a mid-session credit interruption): all four
Phase 0 patches are present and correct in the working tree — F-14 (`agent-core-v3.ts:45`),
F-4 (`session-end/route.ts:193,295` hyphenated X-Title), F-11 (`swap-usdc.ts:32-33`),
F-13 (`friendly-errors.ts:119` + `errors.ts:243` + `circle.ts:68`). The per-finding sections
below (F-4/F-11/F-13/F-14) were reconciled to 🟢 to match. **F-4 is fully closed** — its
earlier "still OPEN / summary-text" theory was superseded (the crash was the static X-Title
literal; LLM text never touches a header). See each finding for the corrected narrative.

## ✅ PHASE 1 APPLIED (2026-07-05) — Skill SSOT (kills D1), tsc + guard clean

- **`VALID_LEAF_SKILLS` derived from the catalog** (`agent-core-v3.ts:45`, via
  `getActiveCatalog()`) — no hand-list, so the validator can't drift from what the model is
  offered. This permanently closes the F-14 class (a leaf skill offered to the model is, by
  construction, the exact set the validator accepts).
- **Guard `scripts/check-skill-sync.ts`** enforces `registry == catalog ∪ {CREATE_POLICY}`
  (no dead skills, no undispatchable offers). Now wired: `npm run check:skills` + a
  `prebuild` hook (fails `next build` / Vercel on drift). **Negative-tested** — induced drift
  → red + exit 1; reverted → green. Also fixed a pre-existing TS2345 in the script.
- Client auto-confirm/formatter derivation deferred to Phase 2 (overlaps the D2 contract).

## ✅ PHASE 2 APPLIED (2026-07-05) — gating/display contract (kills D2), tsc + logic-verified

- **Server ships the gating authority, client stops re-deriving it.** `totalUpfrontUsdc` +
  new `batchAutoConfirm` live in the shared `pin-policy` SSOT; confirm-policy imports
  `totalUpfrontUsdc` (deleted its local copy). interpret ships `upfront_usdc` + `auto_confirm`
  (typed on `InterpretResult`).
- **F-7 fixed** — client `sumStepsUsdc` denylist deleted; balance pre-flight reads
  `interpret.upfront_usdc`. **F-8 fixed** — client `readOnlySkills` allowlist deleted (both
  surfaces); card decision reads `interpret.auto_confirm`. **F-12 fixed** — shared
  `lib/format-transactions.ts` formatter (both surfaces) + `largest_*` aggregate.
- **Verified:** tsc clean; logic harness (F-7 SET_LIMIT=0, F-8 auto-confirm matrix, F-12
  render) all pass; skill guard green.
- **Confirm w/ product:** auto-confirm now covers PAY_X402 (capped external micro-payment).
- **Ops follow-up:** re-run `npm run seed:skills` (edited RETRIEVE_TRANSACTIONS description).

Phases 3–4 (error-taxonomy adoption → F-17; shared resilience + observability → F-1/F-2)
are the remaining RESTRUCTURE work — not yet started, pending go-ahead.

---

## F-1 · OpenRouter interpret fails with `fetch failed` = **ETIMEDOUT** (network egress stall) · 🟡 env / flaky-network

- **CAUSE CONFIRMED (2026-07-03):** log now shows
  `OpenRouter error: fetch failed cause_code=ETIMEDOUT [AggregateError] { code: 'ETIMEDOUT' }`.
  ETIMEDOUT as an `AggregateError` = undici tried to `connect()` to every resolved
  IP for openrouter.ai and **all TCP connect attempts timed out**. This is a
  network-path problem from the dev process, not the code/key/service.
- **It's marginal, not fully down:** in the same window one interpret call *did*
  succeed — but took **26.7s** (`POST /api/agent/interpret 200 in 26681ms`), right up
  against the 30s abort. So outbound connections to openrouter.ai are intermittently
  slow/timing out (Wi-Fi / ISP / VPN / something throttling long-lived egress from the
  Node process). A fresh Node process connected in 2.5s, so it's transient.
- **RECURRED after a clean restart (2026-07-03):** same `cause_code=ETIMEDOUT`, and a
  sibling request succeeded but took **43s** (`200 in 43132ms`). This **rules out the
  "poisoned connection pool" theory** — a fresh Node process hits it too. Conclusion:
  it's the **machine's live network path to openrouter.ai** (Wi-Fi / ISP / VPN /
  throttling), not the dev process. Restarting will NOT reliably fix it.
- **Fix options (env, not code):** it's a network issue — check VPN/Wi-Fi/hotspot,
  try a different connection. Code-side, the only real mitigation is a shorter
  interactive timeout + retry (see F-2) so users get a fast, friendly failure instead
  of 15–50s hangs and 43s "successes". No code fix scheduled this session.
- **Was:** original 🟡 needs-info — now root-caused to ETIMEDOUT.

<details><summary>original F-1 note (kept)</summary>

### F-1 · OpenRouter interpret fails with `fetch failed` — only inside the Next dev process · (superseded above)

- **Symptom:** `POST /api/agent/interpret` returns 502 after a multi-second stall
  (observed 50s → 16s → 11s). Log line: `OpenRouter error: fetch failed`. UI shows
  the offline message. The price oracle (CoinGecko) fails in the *same* requests with
  the identical `fetch failed`.
- **Ruled out:**
  - Not the API key — a standalone Node POST with the real key (73 chars) to
    `chat/completions` returned **HTTP 200 in 2.5s**.
  - Not OpenRouter down — same 200.
  - Not machine network/DNS/firewall — `curl` to openrouter.ai and coingecko both
    returned 200 from this box.
- **So the failure is specific to the long-lived Next.js dev server process**, not
  the network, key, or service. Both outbound fetches (LLM + oracle) dying together
  points to a process-level transport fault (undici connection-pool state, IPv6/
  Happy-Eyeballs stall, or Next's fetch patch) rather than either endpoint.
- **Root cause:** NOT yet confirmed — the code logged only `err.message`
  (`"fetch failed"`) and threw away `err.cause`, where undici puts the real code
  (`UND_ERR_CONNECT_TIMEOUT` / `ECONNRESET` / `ENOTFOUND` / cert / abort).
- **Action taken:** added `err.cause` + `cause_code` logging to
  `app/api/agent/interpret/route.ts` catch. **Next step:** fire one interpret request
  and read the real `cause_code`. Also try restarting the dev server — a fresh Node
  process reaches OpenRouter fine, so a restart may clear a poisoned connection state
  (do this *after* capturing the cause).
- **Where:** `lib/agent-core-v3.ts:756-786` (the fetch); `app/api/agent/interpret/route.ts:428+` (catch).

</details>

## F-4 · 🟢 **ByteString / em-dash crash at session-end — FIXED (Phase 0, 2026-07-04)**

- **RESOLVED — root cause was the STATIC `X-Title` header literal, not summary text.**
  The crash char (8212 = em dash) sat at index 21 of the request header
  `X-Title: "Synesis Smart Wallet — Memory"` (`Synesis Smart Wallet ` = 21 chars → `—`),
  which matches the reported crash index exactly. Phase 0 hyphenated both literals
  (`session-end/route.ts:193` `- Memory`, `:295` `- Profile`) → no character >255 ever
  reaches a ByteString header. Verified in code 2026-07-04.
- **The "comes from the session summary / LLM text" hypothesis below was WRONG and is
  superseded.** LLM summary text is sent in the JSON **body** (`JSON.stringify`,
  unicode-safe), never a header — so no dynamic content can trigger this. The only
  header-bound strings on this path are static (`Content-Type`, `Authorization`,
  `HTTP-Referer`, `X-Title`), and all are now Latin-1 clean. The "sanitize/encode LLM
  text before it touches a header" follow-up is therefore **moot** — there is no such
  path. Memory Layer B (Profile) + Layer C (MemWal) can populate again.
- ⚠️ **Reconciles KNOWN_ISSUES 4.10**, whose stated root cause ("LLM writes summaries
  with em dashes → raw LLM output into a ByteString context") was the wrong theory. The
  v3-hardening "fix" (put LLM output in the body) was real but addressed a vector that
  wasn't the live crash; the static header literal was the actual culprit and is what
  Phase 0 closed.

<details><summary>original F-4 note (kept — its "still OPEN" conclusion is superseded above)</summary>

- **FIRED LIVE (2026-07-03).** Both session-end background writes crashed:
  ```
  [memory/session-end] LLM error: Cannot convert argument to a ByteString because
    the character at index 21 has a value of 8212 which is greater than 255.
  [memory/session-end] profile LLM error: (identical)
  ```
- **Char 8212 = em dash (—).** Something on the session-end path puts LLM/summary
  text into an **HTTP header** (ByteString = Latin-1 only, 0–255), and an em dash
  (>255) throws. Both the episodic summary (Layer C / MemWal) AND the profile
  (Layer B) writes died → **session-end memory was silently lost for that session.**
- **This is exactly R-9** from `STRESS_TEST.md`, which flagged the em-dash
  sanitization as "NOT found in current code — treat as OPEN." Confirmed open.
- **SCOPE IS BIGGER THAN ONE SESSION (confirmed via injection diagnostics 2026-07-03):**
  because session-end crashes on EVERY run, the Profile layer and the Episodic/MemWal
  layer NEVER get written → every interpret shows `profile=none` and
  `recalled=0 fact(s)`. So **2 of the 4 memory layers are effectively dead system-wide**,
  not "occasionally lossy." Only Identity + Router inject reliably; Contact-mem's gate
  works but has no data (needs a settled send webhook). This makes F-4 the highest-value
  fix — it silently disables half the memory stack. Fires independent of my (reverted)
  persona em dashes — the em dash comes from the session content / summary path itself.
- **⚠️ Self-disclosure / possible aggravation by my edit:** in a *separate* change
  this session I added em dashes (—) to the V3 system-prompt persona + greeting
  exemplar (`lib/agent-core-v3.ts`). The interpret path sends the prompt in the JSON
  **body** (unicode-safe), so that edit shouldn't itself trigger the header crash —
  BUT if a greeting reply containing my em-dash phrasing flows into the conversation
  history that session-end serialises into a header, it could become another trigger.
  **REVERTED (2026-07-03):** the em dashes I added to the persona + greeting in
  `lib/agent-core-v3.ts` are now plain hyphens/commas (lines 243, 271-281); greeting
  persona preserved. Pre-existing em dashes elsewhere in that file left as-is (they
  ride in the request body, not a header). The underlying F-4 header crash is still
  OPEN — that's a real fix for later, not this session.
- **Real fix (later, not now):** sanitize/encode any LLM text before it touches a
  header on the session-end + MemWal path (strip/replace non-Latin1, or send via
  body/base64). Where: `app/api/agent/memory/session-end/route.ts` + the MemWal
  relayer call in `lib/memory/walrus-adapter.ts`.

</details>

## F-2 · No visible timeout UX — interpret stalls up to 50s before failing · 🔴 open

- **Symptom:** on a transport failure the user waits up to the full 30s AbortController
  window (and observed 50s once — investigate whether the abort actually fires) before
  seeing an error. Bad UX even on a legitimate blip.
- **Root cause:** the 30s abort in `agent-core-v3.ts` may be too long for interactive
  use, and a 50s observed duration suggests the abort isn't cleanly bounding the call
  (possible retry/oracle stack-up before the LLM call).
- **Action:** consider a shorter interactive timeout + a fast, friendly "still
  thinking / try again" path. Not yet changed.
- **Where:** `lib/agent-core-v3.ts:756-757`.

## F-3 · Friendly-error copy leaked internals + double period · 🟢 fixed-this-session

- **Symptom:** UI showed `"The assistant is offline right now. Please try again in a
  moment.. Check OPENROUTER_API_KEY"` — leaked the internal env-var hint and had a
  stray `..`.
- **Root cause:** route returned `"AI interpretation failed. Check OPENROUTER_API_KEY."`
  and `friendlyError` does a *partial* (non-global) regex replace, so it swapped only
  the first clause and left the key hint + a doubled period.
- **Fix:** route now returns clean `"AI interpretation failed"` (real cause stays in
  logs); the friendly mapping + `AGENT_INTERPRET_FAILED` copy changed to the
  user-approved: *"Hey buddy, feeling a bit sick right now — I'll get back to you once
  I recover. Try again in a moment."*
- **Where:** `app/api/agent/interpret/route.ts:431`, `lib/friendly-errors.ts:70,151`.

---

## F-5 · "Not authenticated" 401 takes 21s — auth network-fallback hangs (symptom of F-1) · 🟡 network + stale-token

- **Symptom:** `whats my balance …` → UI shows "Not authenticated"; log:
  `POST /api/agent/interpret 401 in 21168ms`. A 21s auth check is the tell.
- **Path:** `requireAgentSession` (`lib/agent.ts:62`) passes `requireSession()` (Synesis
  JWT cookie OK), tries `getClaims()` (local, no network), then falls back to
  `getUser()` which **does a network round-trip to Supabase**. That fallback stalled
  ~21s on the ETIMEDOUT-degraded link (F-1) and failed → 401 at `lib/agent.ts:93-98`.
- **Root cause:** the Supabase access token likely expired, and the network refresh
  hung on the same bad connection. **Not a broken login.**
- **Action (no code):** refresh / re-login on a stable network. If it persists on a
  good connection, it's a genuine Supabase session expiry. Possible later hardening:
  bound `getUser()` with a timeout so an auth refresh can't hang 20s+.
- **Where:** `lib/agent.ts:62-101`.

## F-6 · Agent's capability self-knowledge is LLM-guessed from injected skills, not grounded · 🟢 works-as-configured (design note)

- **Observation:** asked "can you send tokens on solana?", the agent confidently said
  it CAN'T do Solana. That's **correct right now** — `SOLANA_ENABLED` is unset, so
  `SEND_SOLANA_USDC` isn't registered (interpret log: `TOOL SCHEMA count=13`, no Solana
  skill). The irony: Solana support IS built (`lib/skills/send-solana-usdc.ts`,
  `app/api/agent/activate-solana`), just flag-gated off.
- **The real point:** the agent describes its capabilities from the **skills injected
  that turn**, not from a capability registry — so it "doesn't really know," it narrates
  the catalog. Fine functionally, but capability claims aren't authoritative and can
  drift with router selection / flags.
- **To enable Solana (per STRESS_TEST.md §13):** `SOLANA_ENABLED=true` → restart →
  `npm run seed:skills` → `POST /api/agent/activate-solana` (needs devnet SOL + USDC).
- **No action needed** unless we want the agent to speak about *built-but-disabled*
  capabilities differently. Logged for awareness.

## F-7 · 🟢 CLIENT SET_LIMIT balance gate — FIXED (Phase 2, 2026-07-05)

> **FIXED:** the client no longer re-derives the batch USDC requirement. Deleted
> `sumStepsUsdc`/`extractBatchUsdcAmount` (the leaky denylist) from `wallet-shell.tsx`; the
> pre-flight now reads the server-computed `interpret.upfront_usdc` (from the shared
> `pin-policy` SSOT, which counts only `requiresBalanceCheck` skills). Logic-verified:
> `set daily 100 + monthly 10000` → upfront_usdc = **0**, not 10100. Detail below retained.


- **Repro (user, live):** `set my max per day to 100 and max per month to 10000` →
  *"Insufficient balance. Your agent wallet has 51.55 USDC but this batch needs
  10100.00 USDC. Top up from the Fund section."* (10100 = 100 + 10000.)
- **Root cause:** there are TWO balance gates and they disagree:
  - **Server** (`app/api/agent/confirm-policy/route.ts` → `extractPlanAmount`) uses an
    **allowlist**: only steps whose handler has `requiresBalanceCheck=true`
    (SEND_USDC / WITHDRAW / BRIDGE_USDC) count. SET_LIMIT is `CONFIG`,
    `affectsFunds:false`, no `requiresBalanceCheck` → correctly skipped. **R-2 fix is
    present server-side.**
  - **Client** (`app/wallet/wallet-shell.tsx:1108 sumStepsUsdc`, called from `:1317`)
    uses a leaky **denylist**: it excludes SEND_TOKEN + non-USDC swap, but NOT
    SET_LIMIT (nor other CONFIG/policy skills). So it sums the *limit values* as if
    they were USDC and blocks at `:1318-1324` before the request ever reaches the
    (fixed) server.
- **Tell:** the error says "Top up from the **Fund section**" (client copy at
  wallet-shell:1320), not the server's "Top up from the **Agent tab**"
  (confirm-policy:599) — proving it's the client gate that fired.
- **Fix (later, not without go-ahead):** make `sumStepsUsdc` mirror the server's
  allowlist — only count SEND_USDC / WITHDRAW / BRIDGE_USDC (the `requiresBalanceCheck`
  set), instead of denylisting. One small function in wallet-shell.tsx. Also check the
  twin formatter in `app/agent/page.tsx` for the same leak.
- **Regression-matrix impact:** R-2 should be re-marked "server fixed, client OPEN".
- **Where:** `app/wallet/wallet-shell.tsx:1101-1121, 1315-1324`.

## F-8 · 🟢 WITHDRAW shows a confirm card — FIXED (Phase 2, 2026-07-05)

> **FIXED:** the client's hardcoded read-only auto-confirm allowlist is gone (both
> `wallet-shell.tsx` and `agent/page.tsx`). The card decision now reads the server-computed
> `interpret.auto_confirm` (= `!requires_pin`, from the shared `pin-policy` SSOT), so ALL
> no-PIN batches — reads, config, and same-user money moves (withdraw-to-self, swap-in-place,
> self-bridge) — auto-execute with no card. Outward sends (SEND_USDC/SEND_TOKEN, requiresPin
> defaults true) still show card + PIN. Logic-verified. **Behavior note:** PAY_X402
> (`requiresPin:false` by design, a capped external micro-payment) now also auto-executes —
> flagged in fixplan for product confirmation. Detail below retained.


- **Symptom (user):** a confirm card appears for a plain WITHDRAW (agent → own main
  wallet). Per T-033 / R-3, same-user moves should need neither PIN nor ConfirmCard.
- **PIN suppression is CORRECT:** `withdraw.ts:27 requiresPin:false` → interpret sends
  `requires_pin:false` (`route.ts:473-474`) → client renders the card with **no PIN
  field**, just a Confirm button (`wallet-shell.tsx:1522, 1717`). So this is NOT the
  old R-3 PIN-scope bug — the PIN is gone.
- **Root cause:** the *card itself* still shows because the client only auto-executes a
  hardcoded read-only set (`wallet-shell.tsx:1301`):
  `["CHECK_BALANCE","LIST_POLICIES","IKNOW","GET_PRICE","RETRIEVE_TRANSACTIONS"]`.
  WITHDRAW (and SWAP_USDC, SET_LIMIT, self-BRIDGE) aren't in it, so they fall through to
  "show confirm card." The allowlist is read-only-only; it never got the no-PIN
  same-user TRANSFER/CONFIG skills the stress doc expects to skip the card.
- **Design tension to confirm with product:** auto-executing a *money move* (withdraw)
  on parsed LLM intent with zero confirmation is riskier than a read-only lookup. Two
  options: (a) add WITHDRAW to the auto-confirm set → no card at all (matches T-033);
  (b) keep a lightweight card but the user considers even that a no-no. User called it
  "abominable" → leaning (a).
- **Fix (pending go-ahead):** drive the client's auto-confirm decision off
  `requires_pin === false` + non-fund-risk, OR extend the allowlist to include WITHDRAW
  (and reconcile SWAP_USDC / SET_LIMIT per T-029 / T-036). Check the twin surface in
  `app/agent/page.tsx` too.
- **Where:** `app/wallet/wallet-shell.tsx:1298-1327` (auto-confirm gate), `:1522`.

## F-8 update: user confirms — WITHDRAW shows card with **no PIN field, just a Confirm button**. Matches diagnosis. PIN suppression correct; the card-shows-at-all is the issue.

## F-9 · 🟡 UI "refreshes" and scrolls to top after every skill success (R-19)

- **Symptom (user):** after any skill executes, the whole UI re-renders and jumps to
  the top.
- **NOT a hard reload:** no `location.reload()` / `router.refresh()` anywhere in
  `wallet-shell.tsx` / `agent/page.tsx` (grep clean). The only scroll calls are
  `scrollIntoView` to BOTTOM on new messages (`wallet-shell.tsx:992`, `agent:483`).
- **Hypothesis:** a confirmed transfer writes `agent_spend_log` / balance rows → a
  Supabase **Realtime** subscription fires → `agentStatus` refetch → state update
  remounts a large subtree and resets scroll to top. Ties to KNOWN_ISSUES "L1"
  (`/api/agent/status` hammered by multiple surfaces + Realtime refetch on every DB
  change).
- **Fix (later):** isolate the post-exec state update so it doesn't remount the chat
  scroll container; or lift status into a shared provider with dedupe (the L1 fix).
- **Where:** `app/wallet/wallet-shell.tsx` status/Realtime effects; matches R-19.

## F-10 · 🟠 Swap-then-send buffer too thin — send fails by a hair after the swap under-delivers

- **Repro (user):** `send 3 eurc to cryptolympus … then withdraw 2 … then swap
  remaining eurc to cirbtc`. Wallet had 2.34 EURC. LLM correctly planned
  swap-then-send, swapping ~0.8 USDC to cover the ~0.66 EURC shortfall. Result:
  `✗ Step 2 failed: Not enough EURC. Agent wallet has 2.9303 EURC, transfer needs 3.`
- **Math:** swap of ~0.8 USDC yielded only ~0.587 EURC (2.9303 − 2.34), vs ~0.74
  expected at ~1.08 EURC/USDC → **~20% lost to Arc-testnet swap slippage/fees**. The
  prompt's buffer is only **"5-8% slippage buffer"** (`agent-core-v3.ts:424`) — far
  below the real ~20% cost — so the post-swap balance (2.93) lands just under 3.
- **Not a stablecoin-parity issue:** the shortfall exists because EURC ≈ $1.08 (not $1)
  AND testnet swap execution is lossy — nothing to do with EURC being "stable".
- **LLM reasoning was structurally CORRECT** (detected shortfall, reused existing
  balance, swap+send compound). The single flaw is the buffer *constant* being too
  small, plus the LLM sizing the swap itself (arithmetic is the weak link).
- **Recommendation (buffer):** replace the 5-8% with a **floor**: buffer =
  `max(~15-20%, 0.5 absolute)`. Flat 0.5 (user's suggestion) guarantees a cushion on
  small shortfalls; the % covers large ones. Leftover token is harmless (and here task
  3 sweeps it). Better still long-term: make buffer sizing **deterministic in the
  skill** and/or have the send use `min(target, available)` / `$prev`, instead of
  trusting LLM arithmetic. — Pending go-ahead.
- **Where:** `lib/agent-core-v3.ts:417-431` (SMART BALANCE INFERENCE + buffer).

## F-11 · 🟢 Swap to cirBTC "Unsupported tokenOut: CIRBTC" — case-mismatch bug — FIXED (Phase 0)

> **FIXED 2026-07-04:** `swap-usdc.ts:32` `SUPPORTED_TOKENS` now canonical-uppercase
> (`["USDC","EURC","CIRBTC"]`) with `SUPPORTED_TOKENS_DISPLAY` for user copy, and a
> null-address guard (`:87-93`) so cirBTC now fails honestly ("no contract on Arc testnet
> yet", KI 1.1) instead of the self-contradicting "unsupported". Detail below is retained.


- **Repro:** task 3 `swap remaining EURC to cirBTC` →
  `✗ Unsupported tokenOut: CIRBTC. Arc Testnet supports: USDC, EURC, cirBTC.`
  (Self-contradicting: says CIRBTC unsupported, then lists cirBTC as supported.)
- **Root cause:** `swap-usdc.ts:50` uppercases `tokenOut` → `"CIRBTC"`, but
  `SUPPORTED_TOKENS = ["USDC","EURC","cirBTC"]` (`:28`) stores cirBTC **mixed-case**.
  `includes("CIRBTC")` is false → rejected. USDC/EURC survive because uppercasing is a
  no-op for them; only cirBTC breaks. Classic normalize-both-sides bug.
- **Caveat:** even after a casing fix, `TOKEN_INFO.CIRBTC.address = null`
  (`swap-usdc.ts:78`) → the swap would then fail downstream for the *real* reason
  (no cirBTC contract on Arc testnet, KI 1.1 / R-17). Fixing the casing at least makes
  the error coherent instead of self-contradicting.
- **Fix (later):** compare case-insensitively (normalize SUPPORTED_TOKENS too) and give
  a clear "cirBTC swaps aren't available yet (no contract on Arc testnet)" message.
- **Where:** `lib/skills/swap-usdc.ts:28, 39-40, 49-61, 78`.

## F-12 · 🟢 RETRIEVE_TRANSACTIONS renders "✓ Done." — FIXED (Phase 2, 2026-07-05)

> **FIXED (both gaps):** (1) added a `RETRIEVE_TRANSACTIONS` formatter via a shared,
> client-safe `lib/format-transactions.ts` imported by BOTH surfaces — so the aggregate
> renders (count / sent / received) instead of the default "✓ Done.", and the twin surfaces
> can't drift again. (2) Added `largest_in_usdc`/`largest_out_usdc` (max per direction) to the
> skill's aggregate + advertised it in the catalog, so "largest amount I sent to X" is now
> answerable. Logic-verified. Detail below retained.


- **Repro (user):** `what was the largest amount I sent to cryptolympus last week?` →
  UI shows only **"✓ Done."**
- **Backend was CORRECT:** interpret `tasks=1 triggers=now unknown=no`; confirm
  `step=1/1 skill=RETRIEVE_TRANSACTIONS recipient="cryptolympus.arc" ok=true
  duration=3040ms`. The skill resolved the contact, queried, and returned an aggregate.
- **Root cause (render):** `formatTaskResult` in `app/wallet/wallet-shell.tsx` has a
  per-skill `switch` (SEND_USDC, WITHDRAW, SET_LIMIT, CHECK_BALANCE, SWAP_USDC,
  BRIDGE_USDC, PAY_X402, GET_PRICE, IKNOW…) but **no `case "RETRIEVE_TRANSACTIONS"`** →
  falls through to the default "✓ Done." The computed aggregate
  (`count / total_in_usdc / total_out_usdc / by_token`) is silently discarded. Check
  the twin formatter in `app/agent/page.tsx` for the same missing case.
- **Second gap (skill capability):** the aggregate shape
  (`retrieve-transactions.ts:134-141, 185+`) has **no max/largest field** — only
  totals + count + by_token. So even with a formatter, "largest" can't be answered
  today; it'd report total/count. "Largest single transfer" needs a new aggregate
  field (max per direction) or a rows-scan.
- **Router note (fragility, not failure):** this query only routed via FALLBACK —
  `top=0.376 < 0.4 → full catalog (count=14)`. A plain history question scoring below
  threshold on RETRIEVE_TRANSACTIONS is a router-recall weakness ("remind me…",
  superlative phrasing pulled cosine down). Worked only because fallback injects all
  skills. Consider re-embedding RETRIEVE_TRANSACTIONS with more paraphrases, or lowering
  MIN_COSINE. (Ref T-019/T-020, T-G1.)
- **Fix (later):** add a RETRIEVE_TRANSACTIONS formatter branch (total in/out, count,
  per-token, and — if we add the field — largest); optionally extend the skill's
  aggregate with a max. — Pending go-ahead.
- **Where:** `app/wallet/wallet-shell.tsx` formatTaskResult switch; twin in
  `app/agent/page.tsx`; `lib/skills/retrieve-transactions.ts:130-190`.

## F-13 · 🟢 "Instruction too long" message mangled — 5xx regex ate the "500" — FIXED (Phase 0)

> **FIXED 2026-07-04:** the 5xx/status pattern in all three tables now requires an
> `HTTP`/`status`/`status code` prefix, so bare numbers in prose ("max 500 chars",
> "550 USDC") are no longer misclassified/rewritten:
> `friendly-errors.ts:119`, `errors.ts:243`, `circle.ts:68` (`(?:HTTP|status(?:\s*code)?)\s*5\d{2}\b|server error`).
> Verified in code. Detail below retained.


- **Repro (user):** pasted a 754-char instruction → UI showed
  *"Instruction too long (max **Our servers are having a moment. Please try again.**
  chars)."*
- **Validation is CORRECT (T-005 ✅):** `route.ts:97-98` rejects >500 chars with
  `"Instruction too long (max 500 chars)"`, status 400. Length gate works; message is
  the bug. (Also note: this is the *good* behavior the last session lacked — it used to
  return a balance error. So T-005 passes on the logic.)
- **Root cause:** `friendlyError` runs that server string through PATTERNS and hits
  `{ match: /\b5\d{2}\b|server error/i, replace: "Our servers are having a moment…" }`
  (`lib/friendly-errors.ts:116`). `\b5\d{2}\b` matches the literal **500** inside the
  message text (the limit value), and the matcher does a **partial `.replace()`**, so
  `500` → the whole 5xx sentence. Same failure class as F-3.
- **Two compounding faults:** (1) a user-facing copy string contains a bare `500` that
  looks like an HTTP status; (2) the regex matcher partial-replaces instead of matching
  intent, so any message containing 500-599 gets corrupted (limits, amounts, counts…).
  This is a landmine for MANY messages, e.g. "you have 550 USDC", "max 500 chars".
- **Fix (later):** either (a) give the length rejection a typed AppError code so it
  skips the regex matcher (like AUTH_/PIN_ codes do via APP_ERROR_COPY), or (b) tighten
  the 5xx pattern so it only fires on real status strings (`/\bHTTP 5\d{2}\b|server
  error/i`) and never on bare numbers embedded in prose. (a)+(b) both, ideally. Broader:
  the partial-`.replace()` design in friendlyError is fragile — prefer whole-string
  curated copy over in-place substitution.
- **Where:** `lib/friendly-errors.ts:116` (5xx pattern), `:217-223` (partial replace
  loop); `app/api/agent/interpret/route.ts:97-98` (source message).

## F-14 · 🟢 GET_PRICE missing from `VALID_LEAF_SKILLS` — every price task rejected post-LLM — FIXED (Phase 0)

> **FIXED 2026-07-04:** `"GET_PRICE"` added to `VALID_LEAF_SKILLS` (`agent-core-v3.ts:45`,
> with an F-14 comment at `:39`). Price tasks are no longer rejected by the step
> validator. This is the *second* layer of the price bug: KNOWN_ISSUES 1.4 fixed the LLM
> **emitting** the task; F-14 fixed the validator **rejecting** the emitted task. A guard
> asserting `VALID_LEAF_SKILLS === registry keys` is Phase 1 (D1 SSOT). Detail retained.


- **Repro (user):** `send John 3 usdc when btc falls below 10 dollars … also check the
  price of BTC` → `tasks[1].steps[0]: unknown or non-leaf skill 'GET_PRICE'`. The whole
  batch dies.
- **Root cause:** `VALID_LEAF_SKILLS` (`lib/agent-core-v3.ts:37-51`) — the validator's
  allowlist of dispatchable leaf skills — lists all 13 skills BUT **omits GET_PRICE**.
  The step validator at `:617-618` throws `unknown or non-leaf skill` for anything not
  in the set. So a correctly-emitted GET_PRICE task is killed one layer after the LLM.
- **GET_PRICE is unambiguously legit everywhere else:** registry `index.ts:51`, catalog
  `catalog.ts:59` (seeded/routable), `SkillName` type `agent-types.ts:21`, and the V3
  prompt (`:276-280, 290`) explicitly tells the model to EMIT a GET_PRICE task for price
  questions. The allowlist is the sole place it was forgotten.
- **Severity 🔴:** breaks EVERY price query that reaches this validator (standalone
  "what's the price of BTC" AND any multi-intent batch containing a price check).
  Directly contradicts R-1 / T-014 — the task IS emitted (R-1 fix working), then
  rejected here. This likely masqueraded as "price works sometimes" only when a query
  routed to a path that didn't hit this validator.
- **Note:** the price-TRIGGER half of the user's request (SEND_USDC when BTC < $10) is a
  separate concern — price triggers are accepted at creation but the cron evaluator
  doesn't fire them (KI 1.2 / R-18). So even the policy half wouldn't execute; but that's
  pre-known. F-14 is the new, undocumented breakage.
- **Fix (trivial, pending go-ahead):** add `"GET_PRICE"` to `VALID_LEAF_SKILLS`. One
  line. Then re-run T-014/T-015/T-016. Consider a guard/test that asserts
  `VALID_LEAF_SKILLS` == registry keys so registry/validator/catalog can't drift again
  (the index.ts comment at :29-35 explicitly warns about this three-way sync — the warning
  exists BECAUSE this class of drift is easy).
- **Where:** `lib/agent-core-v3.ts:37-51` (missing entry), `:617-618` (throw).

## F-15 · 🟡 Solana wallet is not auto-provisioned — new users must hit the console (no UI path)

- **Question (user):** do Solana wallets spin up automatically for new entries so they
  don't need the console?
- **Answer: No.** `app/api/agent/activate/route.ts:64,96` provisions ONLY the
  `ARC-TESTNET` wallet (blockchain hardcoded). The Solana wallet is a separate endpoint
  `activate-solana` calling `createAgentWalletInCircle("SOL-DEVNET")`, and it has **no
  frontend caller** (grep confirmed earlier) → console-only today.
- **Options:** (a) main `activate` also spins SOL-DEVNET when `SOLANA_ENABLED=true`
  (auto at onboarding); (b) a UI "Enable Solana" button / lazy-provision on first Solana
  intent. **Recommend (b)** — a SOL wallet is dead weight until funded with devnet SOL
  for fees (`assertSolForFees`); auto-spinning empty ones for every user is wasteful.
  Endpoint already exists + is idempotent, so either is small.
- **Where:** `app/api/agent/activate/route.ts:60-103`, `app/api/agent/activate-solana/route.ts`.

## F-16 · 🟡 Verify cron-job.org targets a deployment running THIS (V3) cron code, not V1

- **Context (user):** a cron IS running in prod, hosted by cron-job.org — but it's for
  **V1 (deployed)**.
- **Why it matters:** this repo's evaluator is the **V3** route
  `/api/cron/agent-policies` (composite `and` triggers, compound `executePlan`, and a
  **now-implemented price evaluator** at `route.ts:401-429`). If cron-job.org still hits
  a **V1** endpoint/deployment, the V3 price/compound logic never runs in prod — so a
  `BTC < $10` price policy created against V3 code would sit un-evaluated in prod too.
- **Correction to prior notes / R-18 / KI 1.2:** "price triggers never fire (cron
  evaluator is a stub)" is **STALE** — `case "price"` is fully implemented (live oracle
  fetch + threshold compare). The open risk is deployment/URL drift, not the evaluator.
- **Also ties to R-12:** prod must run current code or HMAC/eval drift bites. Confirm the
  cron-job.org target URL points at a deployment of this V3 branch.
- **Local note:** no scheduler hits `localhost`, so policies created in this dev session
  are never evaluated here — expected, not a bug. To test a tick locally:
  `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/agent-policies`.
- **Where:** `app/api/cron/agent-policies/route.ts`; external: cron-job.org job config.

## ✅ T-025 PASSED — first clean end-to-end sends this session

- `send 3 usdc to cryptolympus` → (F-1 "sick" once, retried) → **✓ Sent 3 USDC to
  0x848f36…48F0, tx 0x0945d17a…**. Then `send 2 more` → (F-5 "Not authenticated" once,
  retried) → **✓ Sent 2 USDC, tx 0x3f233302…**. Interpret→PIN→spend_log→Circle→COMPLETE
  path works. Also confirms **Layer A follow-up continuity**: "send 2 more" / "send him
  1 more" correctly resolved the pronoun + amount from prior turns.

## F-17 · 🟠 Transient name-resolution failure is reported as "not registered" (false-negative on a valid name)

- **Repro:** after two successful sends to cryptolympus.arc, `lets send him 1 more` →
  *"cryptolympus.arc is not registered."* — but the name IS registered (just resolved
  to 0x848f36 twice seconds earlier). Log: `recipient_fail="cryptolympus.arc"
  msg="cryptolympus.arc is not registered"`, and the retry shows
  `fallback=yes(embedding_error)` — i.e. the network was flaking (F-1 ETIMEDOUT).
- **Root cause:** `resolveRecipient` (ANS lookup via RPC) hit a transient network/RPC
  failure and the error is surfaced as the definitive "not registered" instead of a
  "couldn't verify right now, try again." Conflates *lookup failed* with *name doesn't
  exist* — dangerous: tells the user a valid recipient is bad, and could push them to
  re-type / use a raw address unnecessarily.
- **Fix (later):** distinguish "resolved: no owner" (truly unregistered) from "lookup
  errored" (RPC/timeout) and give a retry-friendly message for the latter. Likely same
  transient-vs-terminal error-mapping gap as F-1/F-5. — Pending go-ahead.
- **Where:** `lib/ans.ts` resolveRecipient; surfaced at `interpret/route.ts` recipient
  pre-resolve + skill-level resolve (`send-usdc.ts:70-75`).

## F-18 · 🟡 Contact memory (T-C1) cannot seed in local dev — depends on inbound Circle webhook that can't reach localhost

- **Observation:** two confirmed sends, but grep for `[contact-mem] recorded` = **empty**,
  and line 9 stays `injected=no`. By design, contact memory is written from the Circle
  **webhook** on settlement (`app/api/webhooks/circle` → `lib/memory/contact-mem.ts`),
  NOT at confirm time. Circle can't POST to `localhost:3000`, so the webhook never
  arrives locally → contact memory never populates → contact-injection tests (T-082,
  T-E1) are **untestable locally**.
- **Not a bug — a test-environment limitation.** To exercise it: use a tunnel
  (ngrok/cloudflared) as the Circle webhook target, or manually POST a signed webhook
  payload to `/api/webhooks/circle`. Otherwise this layer can only be validated on a
  deployed env with the real webhook wired.
- **Where:** `app/api/webhooks/circle/route.ts`, `lib/memory/contact-mem.ts`.

## F-19 · 🟢 PIN UX — incorrect PINs handled gracefully (good); suggestion: segmented PIN input boxes

- **Positive (user):** incorrect-PIN handling is graceful (clear retry, no crash) —
  matches the intended L3 behavior (T-044).
- **Enhancement (user suggestion):** use a fixed set of individual boxes for PIN entry
  (OTP-style segmented input) instead of a single field — better affordance + signals
  PIN length. Pure frontend polish, no security change.
- **Where:** PIN input in `app/wallet/wallet-shell.tsx` (ConfirmCard PIN field ~:1739)
  + onboarding PIN step.

## Instrumentation added this session (so we stop patching per-bug)

- **Confirm/money path** (`app/api/agent/confirm-policy/route.ts`): added a single
  per-step logger in `executePlan` that prints EVERY skill outcome — including the
  gate rejections (balance / spend-limit / resolve / self-send) that skills used to
  return silently. Plus: idempotency-claim outcome, plan decision summary
  (`needsPin / affectsFunds / upfrontUsdc / solana / lock`), and the live-balance
  gateway result. One file, DRY — no need to instrument the 15 skill files.
- **Interpret path**: `err.cause` / `cause_code` now surfaced (F-1).
- Typecheck clean (`tsc --noEmit`, exit 0) after all edits.
