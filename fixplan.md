# Synesis — Fix Plan (Architectural Remediation)

> **Created:** 2026-07-03 · branch `v3.5-memory`
> **Source leads:** `STRESS_FINDINGS.md` (F-1 … F-19) — the symptoms that surfaced these.
> **Companion architecture:** `ARCHITECTURE.md`, `AGENT_ROADMAP.md` (esp. Part II — locked V4).
> **Principle:** fix *diseases*, not symptoms. Patch in place only where there is no
> structural root; otherwise add the missing seam that kills a whole class of drift.
> Every restructure is additive + independently shippable; nothing bundled into one PR.

---

## Context — why this exists

A debugging/stress-test session against the shipped V3.5 build produced 19 findings.
Read together they are not 19 unrelated bugs — they cluster into **6 root causes**. The
aim is to remove the roots so the same bug-classes can't recur, while respecting the
already-locked V4 direction (per-skill `precheck()`, serial execution, tool-router seam)
so this work *paves* V4 rather than fighting it.

---

## The 6 root causes (→ findings)

**D1 — No single source of truth for skills.** The registry (`lib/skills/index.ts`) is the
truth, but skill identity is re-listed in ≥6 drifting places: `VALID_LEAF_SKILLS`
(`agent-core-v3.ts:37`), the prompt catalog (`catalog.ts`), the seed script, the
`SkillName` type, the client `formatTaskResult` switch, the client `readOnlySkills` set.
→ **F-14** (GET_PRICE missing from validator → 🔴 all price tasks rejected), **F-12**
(no RETRIEVE_TRANSACTIONS formatter → "✓ Done."), **F-8** (auto-confirm list narrower
than server's no-PIN set). Token metadata is a mini-instance: **F-11** (cirBTC casing).

**D2 — Server computes gating authority but ships almost none of it; the client re-derives.**
Interpret returns only a batch-level `requires_pin`. The client independently recomputes
balance requirement (denylist), auto-confirm eligibility, and result display.
→ **F-7** (client balance denylist over-counts SET_LIMIT → blocks config as "insufficient
balance"), **F-8**, **F-12**.

**D3 — Almost nothing throws a typed error; a fragile regex mapper guesses; the numeric
hazard is triplicated.** `lib/errors.ts` already has `AppError` + `code` + `retryable` +
a taxonomy, and `APP_ERROR_COPY` bypasses the regex — but outbound sites throw raw
`Error`, so everything falls into `friendlyError`'s partial-`.replace()`. The
`\b5\d{2}\b`-style pattern lives in **three** tables (`friendly-errors.ts:116`,
`errors.ts:238-242`, `circle.ts:68`).
→ **F-13** ("max 500 chars" rewritten to a server-error line), **F-17** (ANS collapses
RPC-failure and unregistered into one "not registered" throw — `ans.ts:48,80`),
**F-1/F-5** (transient network shown as terminal), **F-3** (already-patched symptom).

**D4 — Critical write paths swallow their own failures.** Every memory write is
`.catch(console.warn)`, so a hard crash looks like "no memory," never an error.
→ **F-4**'s invisibility (🔴 two memory layers dead system-wide, silently).

**D5 — Each outbound call reinvents or omits resilience.** No shared timeout+retry+typed
wrapper. Circle has a good one but it's Circle-coupled (global breaker singleton).
OpenRouter has a 30s abort but no retry; embeddings + ANS have nothing.
→ **F-1/F-2** (30–50s hangs, no fast friendly fail).

**D6 — Money math lives in the prompt / LLM arithmetic.** The swap buffer ("5-8%") is
prompt prose the LLM applies by hand.
→ **F-10** (buffer too thin vs ~20% testnet slippage → send fails by a hair). **This is
exactly what the locked V4 `precheck()` model moves into code** — durable fix already
blessed; interim patch now, real fix aligns with V4.

---

## Alignment with locked V4 (`AGENT_ROADMAP.md` Part II)

This plan contradicts nothing V4 locked. V4 commits to per-skill `precheck()` (D6's real
home), a `ToolRouter` seam (already present as `lib/skill-router.ts`), and reusing
`executePlan`/idempotency/`withUserLock` (untouched here). D1's registry-derivation and
D2's gating contract are prerequisites V4 will want anyway.

---

## Phases

### ✅ Phase 0 — Critical unblock (PATCH only) — DONE 2026-07-03, tsc clean
- **F-14** — added `"GET_PRICE"` to `VALID_LEAF_SKILLS` (`agent-core-v3.ts`).
- **F-4** — stripped em dash from both `X-Title` header literals in
  `session-end/route.ts` (`— Memory`/`— Profile` → `-`). Only these two carried it.
- **F-11** — `swap-usdc.ts`: uppercase canonical `SUPPORTED_TOKENS` + `SUPPORTED_TOKENS_DISPLAY`
  + null-address guard so cirBTC fails honestly.
- **F-13** — tightened 4xx/5xx/429 patterns in `friendly-errors.ts`, `errors.ts`, `circle.ts`
  to require an `HTTP`/`status` prefix. Regex unit-verified.

### ✅ Phase 1 — Skill SSOT (RESTRUCTURE → kills D1) — DONE 2026-07-05, tsc + guard clean
- ✅ `VALID_LEAF_SKILLS` now DERIVED from the LLM catalog (`getActiveCatalog()`), not a
  hand-list (`agent-core-v3.ts:45`). Chose the **catalog** over `Object.keys(skillRegistry)`
  as the derivation source because the catalog is exactly "what the model is told it can
  emit" — it correctly EXCLUDES `CREATE_POLICY` (engine-synthesized, never emitted) and is
  flag-gated identically to the registry. Deriving from the registry would wrongly admit
  `CREATE_POLICY` as a valid leaf.
- ✅ **Guard** `scripts/check-skill-sync.ts` enforces the remaining pair —
  `Object.keys(skillRegistry) == catalog leaf skills ∪ {CREATE_POLICY}` — so a skill can't
  be registered without being offered (dead skill) or offered without a handler
  (undispatchable). Wired as `npm run check:skills` **and a `prebuild` hook** so
  `next build` / Vercel fails fast on drift. Negative-tested (goes red + exit 1 on induced
  drift), then green. Permanently closes the F-14 class. (Note: the runtime guard also
  catches a typo'd/misnamed registry key — it lands as "registered but not catalog and not
  engine-only" — so we did NOT retype `skillRegistry` from `Record<string,…>` to a keyed
  Record; that would ripple casts into the ~4 sites that index it with a dynamic DB string,
  for no additional coverage.)
- Deferred to Phase 2: deriving the client auto-confirm set + formatter coverage from shared
  metadata (overlaps the D2 gating/display contract).
- **Touched:** `package.json` (`check:skills` + `prebuild`), `scripts/check-skill-sync.ts`
  (fixed a pre-existing TS2345 — widened the sets to `Set<string>`). `VALID_LEAF_SKILLS`
  derivation + the guard script were already present from the evolved Phase 0 F-14 fix.

### ✅ Phase 2 — Gating/display contract (RESTRUCTURE → kills D2) — DONE 2026-07-05, tsc + logic-verified
- ✅ Moved `totalUpfrontUsdc` (+ helpers) into the shared gating SSOT `lib/skills/pin-policy.ts`
  and added `batchAutoConfirm`. confirm-policy now IMPORTS `totalUpfrontUsdc` (deleted its
  local copy) so interpret and confirm compute the pre-flight number identically — no drift.
- ✅ interpret ships `upfront_usdc` + `auto_confirm` (alongside `requires_pin`), typed on
  `InterpretResult`. Client deleted its `sumStepsUsdc` denylist (F-7) and `readOnlySkills`
  allowlist (F-8) on BOTH surfaces (`wallet-shell.tsx`, `agent/page.tsx`); the balance
  pre-flight now reads `interpret.upfront_usdc`, the card decision reads `interpret.auto_confirm`.
- ✅ `RETRIEVE_TRANSACTIONS` formatter added via a SHARED, client-safe
  `lib/format-transactions.ts` imported by both surfaces (kills the twin-formatter drift that
  caused F-12), + `largest_in_usdc`/`largest_out_usdc` added to the skill's aggregate so
  superlative ("largest") questions are answerable. Catalog description updated to advertise it.
- **Verified:** `tsc --noEmit` clean; a throwaway logic harness proved F-7 (SET_LIMIT
  upfront=0, not 10100), F-8 (SET_LIMIT/WITHDRAW auto-confirm; external SEND_USDC does NOT),
  F-12 (renders count+largest). Guard still green.
- **Behavior note (confirm before shipping):** auto-confirm now = `!requires_pin`, so
  WITHDRAW/SWAP/SET_LIMIT/self-BRIDGE **and PAY_X402** (a capped external micro-payment,
  `requiresPin:false` by design) auto-execute with NO card. Endorsed for the same-user moves
  (F-8); PAY_X402's inclusion is the one to confirm with product.
- **Follow-up (ops, not code):** re-run `npm run seed:skills` to re-embed the edited
  RETRIEVE_TRANSACTIONS catalog description (router-recall only; skill works via fallback now).
- **Files:** `lib/skills/pin-policy.ts`, `app/api/agent/interpret/route.ts`,
  `app/api/agent/confirm-policy/route.ts`, `lib/agent-types.ts`, `lib/format-transactions.ts` (new),
  `app/wallet/wallet-shell.tsx`, `app/agent/page.tsx`, `lib/skills/retrieve-transactions.ts`, `lib/skills/catalog.ts`.

### ✅ Phase 3 — Error-taxonomy adoption (RESTRUCTURE → kills D3) — DONE 2026-07-05, tsc + logic-verified
- ✅ **ANS (F-17 — the concrete fix):** `resolveRecipient` now resolves DIRECTLY (not via
  `resolveName`'s catch-all→null) and throws a typed `AppError` — `RECIPIENT_NOT_FOUND`
  (terminal) for bad address / malformed name / registry says no-owner, vs `NETWORK`
  (retryable) when the RPC lookup itself fails. New exported classifier
  `isTransientRpcError` inspects ethers v6 codes (`NETWORK_ERROR`/`TIMEOUT`/`SERVER_ERROR`
  → transient; `CALL_EXCEPTION` → terminal), nested Node codes (ETIMEDOUT/ECONNRESET/…),
  and message fallbacks. The interpret + confirm-policy pre-resolve handlers now branch on
  `appErr.retryable`: a transient blip surfaces "couldn't verify … try again" and does NOT
  tell the user to "check the .arc name" (confirm returns 503, not 400).
- **OpenRouter / embeddings — assessed as already adequate, no change:** the interpret
  route already returns "AI interpretation failed" → `friendlyError` maps it to the curated
  "feeling sick" copy (F-3), and the `AGENT_INTERPRET_FAILED` classifier is retryable.
  Embeddings failures fall back silently to the full catalog (never user-facing). Neither
  closes an open finding, so typed-throw adoption there is deferred as low-value polish.
- **Verified:** tsc clean; a throwaway harness proved the transient/terminal split (15
  cases: ethers codes, nested Node codes, message heuristics, the AppError→friendlyError
  contract, and resolveRecipient's no-RPC validation branches). Guard green.
- **Files:** `lib/ans.ts`, `app/api/agent/interpret/route.ts`, `app/api/agent/confirm-policy/route.ts`.

### Phase 4 — Shared resilience + observability (RESTRUCTURE → kills D4/D5)
- Extract a provider-agnostic `withResilience(fn, {timeout, retries, breakerKey})` from
  the Circle pattern (per-key breaker, not a global singleton); apply to OpenRouter
  (retry + shorter interactive timeout → F-1/F-2), ANS, embeddings.
- Surface memory-write failures beyond `console.warn` (a counter the diagnostics block
  can show) so a future F-4-class crash can't hide.
- **Files:** new `lib/resilience.ts` (or lift from `lib/circle.ts`), memory paths.

### Phase 5 — Money-math into code (align with V4; mostly defer)
- **Now (PATCH):** swap buffer floor `max(~18%, 0.5)` in the prompt for F-10.
- **Later (V4 `precheck()`):** deterministic buffer sizing + `$prev`-based sends per V4 §5.

### Deferred (not this plan)
Conditional/recurring policy firing (waiting on V3 cron deploy); Solana execution (needs
funded devnet wallet); F-9 scroll-reset + F-19 PIN-box UX (frontend polish); F-15 Solana
auto-provision (product decision); F-18 contact-mem local testing (needs webhook tunnel).

---

## Verification

- `npx tsc --noEmit` after each phase (must stay exit 0).
- Regex/logic unit checks for pure-function changes (Phase 0 done this way).
- Live smoke via the dev server + the 9-line INTERPRET DIAGNOSTICS block:
  - Phase 0/1: `what's the price of BTC?` → real price (not "non-leaf skill").
  - Phase 1: guard test fails if `VALID_LEAF_SKILLS` ≠ registry keys.
  - Phase 2: `set my daily cap to 250 and monthly to 5000` → no false "insufficient
    balance"; `withdraw 1 usdc` → no confirm card; history query renders totals not "✓ Done."
  - Phase 3: transient ANS/RPC failure shows "couldn't verify, try again", not "not registered".
- Network caveat: F-1 (ETIMEDOUT) is environmental — live LLM calls may still stall on a
  bad connection; that does not indicate a code regression.
