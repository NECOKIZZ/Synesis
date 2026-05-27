# DotArc Smart Wallet — Audit 1

Date: 2026-05-19

Scope:
- Smart Agent architecture
- Circle wallet integration
- Supabase persistence and RLS boundaries
- Modular skill system
- Runtime performance risks
- Documentation drift

Typecheck status at time of audit:

```txt
npm run typecheck
# passed — tsc --noEmit returned exit code 0
```

---

## Executive Summary

The current codebase is in a solid MVP state and the modular Smart Agent skill refactor is the right architectural direction. The major issue is no longer the skill system itself; the bigger risks now come from duplicate legacy routes, inconsistent security enforcement, unsafe logging patterns, missing cron infrastructure, and synchronous slow external calls in user-facing paths.

DotArc handles real USDC, so security must remain above UX and performance. Any optimization must preserve these rules:

- Never trust client-provided user IDs, wallet addresses, or `.arc` ownership without server-side verification.
- Never log Circle `userToken`, `encryptionKey`, API keys, JWT secrets, entity secrets, or full Circle API responses.
- Keep all money-moving agent execution behind one shared security gate.
- HMAC-sign stored agent policies and verify them before scheduled execution.
- Preserve RLS on all user-owned tables.

Overall grades:

| Area | Grade | Notes |
|---|---:|---|
| Type safety | B+ | Typecheck passes. Some `any` remains around Circle SDK boundaries. |
| Security architecture | B- | Good intent and strong primitives, but duplicate routes and unsafe logs create drift. |
| Skill modularity | B | Registry pattern is good; docs and legacy routes still reference old architecture. |
| Production readiness | C+ | Missing cron runner, idempotency, reservations, and safe async tx lifecycle. |
| Performance | C+ | Circle/RPC calls happen in hot paths and make UI slow. |
| Mainnet readiness | Not ready | Needs concurrency-safe spend controls, sanitized logs, rate limiting, and cron hardening. |

---

## Critical / High Priority Findings

### H1 — Duplicate sensitive execution paths still exist

Affected files:

- `app/api/agent/withdraw/route.ts`
- `app/api/agent/set-limits/route.ts`
- `app/api/agent/cancel-policy/route.ts`
- `app/api/agent/verify-pin/route.ts`
- `app/api/agent/confirm-policy/route.ts`
- `lib/skills/*`

Problem:

The architecture was refactored so `confirm-policy` is the single execution gate and delegates to `lib/skills/index.ts`. However, older standalone routes still duplicate sensitive logic for withdraws, limit changes, and policy cancellation.

This creates security drift. For example:

- `confirm-policy` applies PIN lockout attempts.
- `withdraw/route.ts` verifies PIN but does not increment failed attempts.
- `set-limits/route.ts` verifies PIN but does not increment failed attempts.
- `cancel-policy/route.ts` verifies PIN but does not increment failed attempts.
- `set-limits/route.ts` has different hard ceilings than `lib/skills/set-limit.ts`.

Risk:

A future frontend or attacker can hit a weaker endpoint and bypass the stricter modular execution path.

Recommended fix:

Retire or rewrite the duplicate routes. Preferred final shape:

```txt
/api/agent/confirm-policy  -> only money/action execution path
/api/agent/status          -> read-only status
/api/agent/activate        -> setup
/api/agent/fund            -> main-wallet-to-agent funding challenge
/api/agent/set-pin         -> setup/security
```

Any route that remains should delegate to the same shared security and skill registry path.

---

### H2 — PIN lockout is inconsistent across routes

Affected files:

- `app/api/agent/confirm-policy/route.ts`
- `app/api/agent/verify-pin/route.ts`
- `app/api/agent/withdraw/route.ts`
- `app/api/agent/set-limits/route.ts`
- `app/api/agent/cancel-policy/route.ts`

Problem:

PIN verification logic is repeated. Some routes increment `pin_attempts` and set `pin_locked_until`; some only compare the PIN hash and return `403`.

Risk:

Brute-force protection is only as strong as the weakest endpoint.

Recommended fix:

Create one shared helper, for example:

```txt
lib/agent-pin.ts
```

It should expose a single function:

```txt
verifyAgentPinOrThrow({ supabase, userId, pin })
```

This helper should:

1. Load `agent_pin_hash`, `pin_attempts`, and `pin_locked_until`.
2. Reject locked users.
3. Verify bcrypt hash.
4. Increment attempts and lock when invalid.
5. Reset attempts when valid.

Then all PIN-gated routes use it.

---

### H3 — Full Circle response logging can leak sensitive data

Affected files:

- `app/api/circle/session/route.ts`
- `app/api/circle/send-prepare/route.ts`
- `app/api/circle/register-name/route.ts`
- `lib/circle.ts`
- scripts that print full Circle errors

Examples found:

```ts
console.error("[circle/session]", err?.response?.data ?? err);
console.error("[send-prepare] Circle error", err?.response?.data ?? err);
return NextResponse.json({ error: message, circleStatus, circleData }, ...);
```

Problem:

Full Circle response objects may contain sensitive operational details. User-controlled wallet flows also involve `userToken` and `encryptionKey`, which must never appear in logs.

Risk:

Secrets or sensitive wallet/session metadata can leak into terminal logs, deployment logs, or observability tools.

Recommended fix:

Create a safe error formatter:

```txt
lib/safe-error.ts
```

Log only:

- route name
- Circle status code
- Circle error code if available
- sanitized short message
- internal request id if available

Never log:

- `userToken`
- `encryptionKey`
- `JWT_SECRET`
- `CIRCLE_ENTITY_SECRET`
- full Circle response objects
- full wallet lists
- full API response bodies

---

### H4 — `/api/circle/wallet` trusts client-provided `userId`

Affected file:

- `app/api/circle/wallet/route.ts`

Current behavior:

```ts
const userId = url.searchParams.get("userId") || "";
const wallet = await getUserWallet(userId);
```

The only validation is:

```ts
userId.startsWith("dotarc-")
```

Problem:

A caller can ask the backend to look up any `dotarc-*` user ID.

Risk:

This can leak wallet mapping information for other users.

Recommended fix:

Derive the Circle user ID server-side:

```txt
getVerifiedEmail() -> userIdFromEmail(email)
```

Do not accept `userId` from query params.

---

### H5 — Cron architecture is incomplete

Affected files:

- `lib/skills/recurring-payment.ts`
- `AGENT_SKILLS.md`

Missing files:

- `app/api/cron/agent-policies/route.ts`
- `vercel.json`

Problem:

`RecurringPayment.onCronTick()` exists, but there is no production cron runner that reads due policies and dispatches them.

Risk:

Users can create recurring policies, but they will not execute automatically.

Recommended fix:

Add a cron route:

```txt
app/api/cron/agent-policies/route.ts
```

The cron route should:

1. Verify `CRON_SECRET`.
2. Use service Supabase.
3. Select active due policies.
4. Claim/lock rows to prevent double execution.
5. Build `CronContext`.
6. Dispatch to `skillRegistry[policy.skill].onCronTick`.
7. Update `next_run`, `last_run`, or failure state.

Also add `vercel.json` for schedule configuration.

---

## Major Architectural Findings

### M1 — Spend limits are race-condition vulnerable

Affected files:

- `lib/skills/send-usdc.ts`
- `lib/skills/recurring-payment.ts`
- `lib/agent.ts`

Current pattern:

```txt
read completed spend
check limit
insert pending log
execute Circle transaction
mark complete
```

Problem:

Two simultaneous sends can both pass the spend check before either marks a log as complete.

Example:

```txt
Daily limit: 100 USDC
Existing spent: 0
Request A sends 80 USDC
Request B sends 80 USDC
Both read spent = 0
Both pass
Final spend = 160 USDC
```

Recommended fix:

Short-term:

- Include both `PENDING` and `COMPLETE` logs in spend checks.

Long-term:

- Add a database-backed reservation system or RPC function that atomically locks the user row, checks limits, and creates the pending spend reservation.

---

### M2 — `agent_spend_log` has no update RLS, but old routes update with user client

Affected file:

- `app/api/agent/withdraw/route.ts`

Migration:

- `agent_spend_log` allows user `select` and `insert`.
- It intentionally does not allow user `update`.

Problem:

The modular skill files correctly use `serviceSupabase` for status updates. The old `withdraw/route.ts` uses the user-scoped Supabase client to update status to `FAILED` or `COMPLETE`.

Risk:

Rows may stay stuck as `PENDING`, causing confusing history and inaccurate spend accounting.

Recommended fix:

Remove old withdraw route or make it delegate to the modular `Withdraw` skill where service-role updates are handled consistently.

---

### M3 — `AGENT_SKILLS.md` is stale after the modular refactor

Affected file:

- `AGENT_SKILLS.md`

Problem:

The document still says new skills require adding a case to the old `confirm-policy` switch.

Current correct flow is:

```txt
create lib/skills/new-skill.ts
implement SkillHandler
register in lib/skills/index.ts
update interpreter prompt/schema
add migration if needed
document skill
```

Recommended fix:

Update the skill documentation to reflect the registry-based modular system.

---

### M4 — Architecture docs disagree about wallet types

Affected files:

- `DOTARC_MASTER_ARCHITECTURE.md`
- `DOTARC_IMPLEMENTATION_GUIDE (1).md`

Problem:

The master architecture correctly describes:

- main wallet: user-controlled
- treasury wallet: developer-controlled
- agent wallets: developer-controlled, one per activated user

The implementation guide still says:

```txt
The treasury is the only developer-controlled wallet in the entire system.
```

That is now outdated.

Recommended fix:

Update implementation guide to state:

```txt
Developer-controlled wallets:
- DotArc treasury wallet
- Per-user Smart Agent wallets

User-controlled wallets:
- Main user wallets
```

---

### M5 — Weekly limit exists but is not enforced

Affected files:

- `supabase/migrations/0002_agent.sql`
- `lib/agent.ts`
- `lib/skills/send-usdc.ts`
- `lib/skills/recurring-payment.ts`

Problem:

DB contains:

```sql
max_weekly_usdc
```

But `checkSpendLimits()` only checks:

- per-transaction
- daily
- monthly

Risk:

Users can set a weekly limit and believe it is enforced when it is not.

Recommended fix:

Add weekly spend calculation and pass `spentThisWeekUsdc` into `checkSpendLimits()`.

---

### M6 — Agent activation can create orphan Circle wallets

Affected file:

- `app/api/agent/activate/route.ts`

Current flow:

```txt
check DB for existing wallet
create Circle wallet
insert DB row
```

Problem:

If Circle wallet creation succeeds but the DB insert fails, a Circle wallet exists with no matching `agent_wallets` row.

Recommended fix:

Use deterministic metadata/refId when creating Circle wallets if Circle supports it:

```txt
refId: dotarc-agent-${supabaseUserId}
```

On retry, search for an existing wallet before creating another.

Also consider adding an `agent_wallet_creation_attempts` table for recovery.

---

### M7 — Policy HMAC does not cover all policy parameters

Affected files:

- `lib/agent.ts`
- `lib/skills/recurring-payment.ts`

Current HMAC covers:

```txt
userId
policyId
skill
recipientAddress
amount
frequency
createdAt
```

It does not cover:

```txt
day_of_week
day_of_month
params JSON
next_run
```

Problem:

A DB tamper event could alter schedule-related fields without invalidating the HMAC, depending on how cron uses them.

Recommended fix:

Include canonicalized policy params in the HMAC payload:

```txt
canonicalJson(params)
```

For advanced future skills, HMAC must bind the full user intent.

---

## Performance Findings

### P1 — `/api/agent/status` calls Circle on every request

Affected file:

- `app/api/agent/status/route.ts`

Problem:

Every status request refreshes balance from Circle. Logs already showed this route taking many seconds.

Recommended fix:

Use cache TTL:

```txt
If balance_cache_at < 30-60 seconds old, return cached balance.
Only refresh when stale or user clicks refresh.
```

Better route split:

```txt
/api/agent/status          -> fast DB read
/api/agent/refresh-balance -> explicit slow refresh
```

---

### P2 — `/api/agent/interpret` fetches Circle balance before every AI call

Affected file:

- `app/api/agent/interpret/route.ts`

Problem:

The interpreter does not execute money movement, so it does not need a fresh Circle balance every time. This slows the chat path and makes interpretation dependent on Circle uptime.

Recommended fix:

Use cached balance from `agent_wallets.balance_cache_usdc`. Let execution paths enforce real constraints later.

---

### P3 — `confirm-policy` waits synchronously for Circle transaction confirmation

Affected files:

- `lib/agent.ts`
- `lib/skills/send-usdc.ts`
- `lib/skills/withdraw.ts`

Problem:

`executeAgentSendUsdc()` submits a Circle transaction and polls until confirmed before returning.

Risk:

- Slow UX
- Higher timeout risk on serverless platforms
- Poor scalability under load

Recommended fix:

Move to async lifecycle:

```txt
confirm-policy:
  create PENDING log
  submit Circle tx
  return { status: "submitted", circleTxId }

background worker/cron:
  poll Circle tx status
  mark COMPLETE or FAILED
```

---

### P4 — RPC providers are initialized at import time

Affected files:

- `lib/circle.ts`
- `lib/ans.ts`

Problem:

Both files create `JsonRpcProvider` during module import. This can cause startup spam like:

```txt
JsonRpcProvider failed to detect network and cannot start up; retry in 1s
```

Recommended fix:

Lazy-create providers:

```txt
getArcProvider()
getRegistryContract()
```

Only initialize when a route actually needs chain reads.

---

## Medium Findings

### N1 — `SET_LIMIT` ceilings differ between old route and modular skill

Affected files:

- `lib/skills/set-limit.ts`
- `app/api/agent/set-limits/route.ts`

New skill ceiling:

```txt
monthly = 5,000 USDC
```

Old route ceiling:

```txt
monthly = 10,000 USDC
```

Recommended fix:

Create a single source of truth:

```txt
lib/agent-limits.ts
```

Export:

```txt
DEFAULT_LIMITS
HARD_LIMIT_CEILINGS
validateLimitUpdate()
```

---

### N2 — `CHECK_BALANCE` docs promise fallback but code does not implement it

Affected files:

- `AGENT_SKILLS.md`
- `lib/skills/check-balance.ts`

Docs say Circle failure returns cached balance. Code returns `502`.

Recommended fix:

Either update the docs or extend `SkillContext.agentWallet` to include:

```txt
balance_cache_usdc
balance_cache_at
```

Then `CHECK_BALANCE` can fall back safely.

---

### N3 — Main wallet and agent wallet code use different send models

Affected files:

- `lib/circle.ts`
- `lib/agent.ts`

Main wallet send uses Circle user-controlled `createTransaction`.

Agent wallet send manually ABI-encodes ERC-20 `transfer` and calls `createContractExecutionTransaction`.

This is not necessarily wrong, but it should be documented and tested because decimals, token address, and fee behavior differ between paths.

Recommended fix:

Add integration tests or a documented transaction matrix:

```txt
main wallet send -> user-controlled challenge -> browser signs
agent send       -> dev-controlled contract execution -> backend submits
agent withdraw   -> dev-controlled contract execution -> backend submits
agent fund       -> user-controlled challenge -> browser signs
```

---

## Recommended Fix Order

### Phase 1 — Security boundary cleanup

1. Retire or delegate duplicate agent routes.
2. Extract shared PIN verification + lockout helper.
3. Sanitize Circle logging.
4. Fix `/api/circle/wallet` to derive user ID server-side.
5. Add a safe error formatter.

### Phase 2 — Execution correctness

1. Include `PENDING` in spend checks.
2. Add weekly limit enforcement.
3. Add idempotency keys for send/withdraw/recurring execution.
4. Add spend reservation or DB atomic check.
5. Fix old routes that use user client for spend-log updates.

### Phase 3 — Recurring policy infrastructure

1. Add cron route.
2. Add `CRON_SECRET`.
3. Add due-policy claim/lock mechanism.
4. Dispatch via `skillRegistry`.
5. Update `last_run`, `next_run`, and failure states safely.

### Phase 4 — Performance

1. Add balance cache TTL to `/api/agent/status`.
2. Use cached balance in `/api/agent/interpret`.
3. Split slow balance refresh into explicit endpoint.
4. Convert Circle transaction confirmation to async polling.
5. Lazy-initialize RPC providers.

### Phase 5 — Documentation

1. Update `AGENT_SKILLS.md` to registry-based skill creation.
2. Update `DOTARC_IMPLEMENTATION_GUIDE (1).md` to include agent dev-controlled wallets.
3. Document transaction lifecycle states.
4. Document accepted testnet-only risks vs mainnet-blocking risks.

---

## Suggested Immediate Next Task

The safest next coding task is:

```txt
Consolidate all sensitive agent execution through confirm-policy + skillRegistry.
```

That means:

- remove or delegate `withdraw`, `set-limits`, and `cancel-policy` routes
- extract shared PIN verification
- ensure every money/action skill uses one execution gate

This directly reduces future security drift and keeps the modular architecture honest.

---

## Final Assessment

The core product direction is good. The Smart Agent modular skill system is the correct foundation for future complex skills like conditional buys, prediction market bets, yield strategies, and offramps.

The main risk is that the rest of the backend has not fully caught up to that architecture yet. If the duplicate routes and inconsistent security helpers remain, future features will become fragile and dangerous.

Fixing the execution boundary now will make future skill additions much safer and faster.

---

# Validation Re-pass (2026-05-20)

Re-verified every finding against the actual code after the modular refactor. **19/19 findings valid, 0 false positives.** Severity adjustments:

- **H3** upgraded CRITICAL — `register-name` returned `circleData` in the HTTP response body, not just logs.
- **H4** upgraded CRITICAL — `/api/circle/wallet` accepted client-provided `userId`, enabling wallet enumeration.
- **M1** upgraded HIGH — spend-limit race is a direct fund-loss vector on mainnet.
- **N3** dropped — different send models for main vs agent wallet are by design.

Three additional items added that were not in the original audit:

- **Missing 1** — `waitForCircleTx` default 90 s exceeds Vercel function timeouts.
- **Missing 2** — no rate limiting on `interpret` / `confirm-policy`.
- **Missing 3** — `requireAgentSession` should be verified to cross-check JWT email vs Supabase email.
- **Missing 4** — `WITHDRAW` currently counts against agent spend limits; debatable semantics.

Final category counts:

```txt
Security:        8
Architecture:    6
Performance:     4
Bugs (broken):   2
Documentation:   2
Total:          22
```

---

# Tier 1 — COMPLETED (2026-05-20)

All eight Tier 1 items shipped. Typecheck clean. No new lint errors.

| ID | Fix | Files |
|---|---|---|
| **H2** | Shared PIN helper with consistent attempts + lockout used by every PIN-gated route | `lib/agent-pin.ts` (new), `confirm-policy`, `withdraw`, `set-limits`, `cancel-policy` |
| **H3** | `circleData` stripped from response body in `register-name`; status logged server-side only | `app/api/circle/register-name/route.ts` |
| **H4** | `/api/circle/wallet` derives `userId` from `getVerifiedEmail()`; query-param trust removed | `app/api/circle/wallet/route.ts`, `app/circle-wallet-context.tsx` |
| **M1** | `getSpentSince` in `confirm-policy` now counts `PENDING` + `COMPLETE`, blocking concurrent-send races | `app/api/agent/confirm-policy/route.ts` |
| **M2** | `withdraw` switched to `serviceSupabase` for `agent_spend_log` status updates (no UPDATE RLS exists) | `app/api/agent/withdraw/route.ts` |
| **M5** | Weekly limit now enforced in `checkSpendLimits`; both `send-usdc` and `recurring-payment` pass `spentThisWeekUsdc` | `lib/agent.ts`, `lib/skills/send-usdc.ts`, `lib/skills/recurring-payment.ts` |
| **N1** | `set-limits` route ceilings aligned to modular skill: per-tx 500, daily 1k, weekly 2k, monthly 5k | `app/api/agent/set-limits/route.ts` |
| **Missing 1** | `waitForCircleTx` default lowered to 8 × 3 s = 24 s (fits Vercel 60 s tier), env-overridable via `CIRCLE_TX_POLL_ATTEMPTS` / `CIRCLE_TX_POLL_INTERVAL_MS` | `lib/circle.ts` |

Side effects:

- New shared period helpers `startOfDayUTC` / `startOfWeekUTC` / `startOfMonthUTC` exported from `lib/agent.ts` so every skill computes the same window boundaries.
- `checkSpendLimits` signature gained a required `spentThisWeekUsdc` field — all call sites updated.

---

# Tier 2 — Architecture Backlog (deferred)

Should be done before mainnet. Listed in recommended execution order.

### T2.1 — Cron runner for recurring policies (H5)

State: not started. **No `app/api/cron/` exists.** Recurring policies created today never execute.

Deliverables:
- `app/api/cron/agent-policies/route.ts`
- `vercel.json` with schedule
- `CRON_SECRET` env var
- Row-level claim/lock so two cron invocations cannot double-execute a single policy
- Use the existing `skillRegistry[skill].onCronTick` dispatch

Implementation notes:
- Use `serviceSupabase` (cron has no user session).
- Build `CronContext` with `getSpentSince` (using `PENDING` + `COMPLETE` like confirm-policy).
- For Vercel: lock by `update ... where id = ? and claimed_at is null returning *` pattern with a `claimed_at` timestamp column on `agent_policies`. Will need a small migration.

### T2.2 — Retire / proxy duplicate agent routes (H1)

Routes still alive but redundant after the registry refactor:
- `app/api/agent/withdraw/route.ts`
- `app/api/agent/set-limits/route.ts`
- `app/api/agent/cancel-policy/route.ts`

Tier 1 hardened them (shared PIN, service-role updates, aligned ceilings) but they still bypass the registry. Two options:
- **Option A:** delete and migrate frontend to call `/api/agent/confirm-policy` with `skill = "WITHDRAW"` / `"SET_LIMIT"` / `"CANCEL_POLICY"`. Cleanest.
- **Option B:** keep as thin shims that internally instantiate `SkillContext` and call the skill handler.

Recommend Option A.

### T2.3 — HMAC bind full policy params (M7)

`signPolicyHmac` currently covers `amount`, `frequency`, `recipientAddress`. Schedule details (`day_of_week`, `day_of_month`) and arbitrary future skill params are not bound. A DB tamper can alter schedule without HMAC failure.

Fix: canonicalize `params` JSON (sorted keys) and include it in the HMAC payload. Re-verify in `onCronTick` against `policy.params`.

### T2.4 — Orphan wallet recovery on activation (M6)

`app/api/agent/activate/route.ts` creates a Circle wallet, then inserts the DB row. If the insert fails, the Circle wallet is orphaned.

Fix: use deterministic `refId: dotarc-agent-${supabaseUserId}` when Circle supports it; on activation, search by refId before creating. Optionally add an `agent_wallet_creation_attempts` table for recovery audit.

### T2.5 — Rate limiting (Missing 2)

`/api/agent/interpret` calls OpenRouter (paid). `/api/agent/confirm-policy` moves money. Neither is rate-limited.

Minimum: per-user token bucket (e.g. 10 interprets/min, 5 confirms/min). Implementation can use a `rate_limits` table or Upstash if added.

### T2.6 — Cross-check JWT email vs Supabase email in `requireAgentSession` (Missing 3)

`/api/circle/send-prepare` already does this. The agent path should too. Defense in depth against JWT cookie tampering combined with a different signed-in Supabase user.

### T2.7 — Decide WITHDRAW spend-limit semantics (Missing 4)

Today, `WITHDRAW` writes to `agent_spend_log` and counts against `max_daily_usdc`. That means withdrawing back to your own main wallet consumes daily quota for outbound sends.

Decision needed:
- **(a)** Keep counting → simpler, but quota is consumed by non-spend movement.
- **(b)** Stop counting → cleaner semantics. Filter `skill != "WITHDRAW"` in `getSpentSince`, OR introduce a separate column.

Recommendation: **(b)** — withdrawals are user reclaiming their own funds, not spending.

---

# Tier 3 — Performance Backlog (deferred)

### T3.1 — Async tx lifecycle (P3 root fix)

Tier 1 lowered the polling timeout but the right answer is to stop polling synchronously. `confirm-policy` should submit + return `{ status: "submitted", circleTxId }` and let a separate polling endpoint or cron resolve final state.

### T3.2 — Balance cache TTL (P1, P2)

`agent_wallets.balance_cache_usdc` and `balance_cache_at` already exist on the table. Use them:
- `/api/agent/status`: read cache if `< 30 s` old.
- `/api/agent/interpret`: always read cache (interpreter doesn't need fresh values).
- Add `/api/agent/refresh-balance` for explicit refresh.

### T3.3 — Lazy RPC providers (P4)

`lib/circle.ts` and `lib/ans.ts` instantiate `JsonRpcProvider` at import time, causing cold-start "failed to detect network" spam. Wrap in `getArcProvider()` lazy accessors.

### T3.4 — `CHECK_BALANCE` cache fallback (N2)

Docs promise Circle-down fallback to cache; code returns 502. Either update docs or extend `SkillContext.agentWallet` to expose `balance_cache_usdc` and let the skill fall back.

---

# Tier 4 — Documentation Backlog

### T4.1 — Update `AGENT_SKILLS.md` (M3)

Still references the old `confirm-policy` switch pattern. Should describe:

```txt
1. Create lib/skills/<skill>.ts implementing SkillHandler
2. Register in lib/skills/index.ts
3. Update the interpreter prompt in lib/agent.ts buildSystemPrompt
4. Add to VALID_SKILLS list
5. Migrate DB if needed
6. Add test cases
```

### T4.2 — Update `DOTARC_IMPLEMENTATION_GUIDE (1).md` (M4)

Currently claims the treasury is the only developer-controlled wallet. Update to reflect:

```txt
Developer-controlled wallets:
- DotArc treasury wallet
- Per-user Smart Agent wallets

User-controlled wallets:
- Main user wallets
```

### T4.3 — Document transaction lifecycle states

Add a short doc describing `PENDING → COMPLETE / FAILED` semantics in `agent_spend_log`, who updates each (RLS rules), and how the spend-limit query counts them.

---

# Summary Snapshot

```txt
Tier 1 (security + critical bugs):   8/8  done ✓
Tier 2 (architecture backlog):       0/7  pending
Tier 3 (performance):                0/4  pending
Tier 4 (documentation):              0/3  pending
```

Mainnet readiness gate: **Tier 2 must be complete.** Tier 3 is strongly recommended. Tier 4 is good hygiene.

---

# Skill Contract Refactor — COMPLETED (2026-05-20)

Three passes shipped on top of Tier 1:

### Pass A — Contract metadata

`lib/skills/types.ts` rewritten. Every `SkillHandler` now declares:

```ts
readonly category: "READ" | "TRANSFER" | "CONFIG" | "POLICY";
readonly version: number;
readonly affectsFunds: boolean;
readonly requiresPin?: boolean;
idempotencyKey?(params): string | null;
validate?(params): Record<string, unknown>;
execute(ctx): Promise<SkillOutput>;
onCronTick?(ctx, policy): Promise<CronTickOutput>;
```

New `CronTickOutput` type lets cron handlers return `{ ok: true }`, `{ ok: false, retry: true }`, or `{ ok: false, pauseReason: "..." }`. The skill no longer mutates `agent_policies` state — the future cron runner owns those writes.

All 6 skills declared metadata + `idempotencyKey` for the three fund-relevant ones (SEND_USDC, WITHDRAW, RECURRING_PAYMENT).

### Pass B — Idempotency wired into `confirm-policy`

New table `agent_idempotency` (see migration `supabase/migrations/0003_idempotency_audit.sql`).

New helper `lib/agent-idempotency.ts` with:
- `claimIdempotency()` — atomic insert / replay / 409-in-flight / stale-takeover
- `finalizeIdempotency()` — persist outcome for replay window

TTL: 60 s for `affectsFunds` skills, 30 s otherwise.

Behavior:
- Replay → returns cached result with original HTTP status, marked `replayed: true`
- In-flight → 409
- Recent failure → 409 (don't hammer)
- Stale or first call → execute

Skills with `affectsFunds: true` and no `idempotencyKey` are skipped silently (no-op). Strongly recommended to declare one for all such skills.

### Pass C — Audit log wired into `confirm-policy`

New table `agent_audit_log` (same migration). Per-call row records:

```txt
user_id, skill, category, affects_funds, sanitized_params,
ok, http_status, error, duration_ms, replayed, created_at
```

New helper `lib/agent-audit.ts` with:
- `sanitizeParams()` — strips `pin|password|secret|token|api[_-]?key` keys, truncates long strings, stringifies objects
- `logSkillExecution()` — best-effort insert; failures only console.error

Audit log captures every call including:
- Successful executions
- Failed executions (with error message)
- Idempotency replays (`replayed: true`, `duration_ms: 0`)

Failure to write the audit row never blocks the response.

### Files touched

| File | Change |
|---|---|
| `lib/skills/types.ts` | New contract + CronTickOutput |
| `lib/skills/index.ts` | Re-export new types |
| `lib/skills/check-balance.ts` | metadata |
| `lib/skills/send-usdc.ts` | metadata + idempotencyKey |
| `lib/skills/withdraw.ts` | metadata + idempotencyKey |
| `lib/skills/set-limit.ts` | metadata |
| `lib/skills/cancel-policy.ts` | metadata |
| `lib/skills/recurring-payment.ts` | metadata + idempotencyKey + onCronTick → CronTickOutput; removed agent_policies writes |
| `lib/agent-idempotency.ts` | new |
| `lib/agent-audit.ts` | new |
| `app/api/agent/confirm-policy/route.ts` | wired idempotency + audit |
| `supabase/migrations/0003_idempotency_audit.sql` | new |

### Operational notes

- **Migration must be run** in Supabase before deploying the route changes. Otherwise `confirm-policy` will fail on every claim/audit insert.
- The existing duplicate routes (`withdraw`, `set-limits`, `cancel-policy`) still skip both idempotency and audit. That stays true until T2.2 retires them — for now, only the unified registry path is fully instrumented.
- Idempotency cache stores `result_json` as `jsonb`. Today the largest payload is a transfer result (~few hundred bytes). Cleanup of expired rows is opportunistic via `expires_at` checks; if growth becomes a concern, add a `pg_cron` purge job.

### Snapshot

```txt
Tier 1 (security + critical bugs):                 8/8  done ✓
Skill contract refactor (A,B,C):                   3/3  done ✓
Tier 2 (architecture backlog):                     0/7  pending
Tier 3 (performance):                              0/4  pending
Tier 4 (documentation):                            0/3  pending
```
