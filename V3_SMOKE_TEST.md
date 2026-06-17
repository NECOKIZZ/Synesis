# DotArc V3 — Pre-Push Smoke Test

> **Scope:** Verify the 2026-06-16 hardening pass before pushing V3. This is NOT the
> full 100-test suite — it targets only what changed this session plus the V3 fixes
> that were code-verified but never live-tested.
>
> **Prereqs:** migrations `0011_rate_limits` + `0012_cron_runs` applied (✅ done),
> dev server running, a funded agent wallet, and a second `.arc` recipient to send to.
>
> Mark each: ✅ PASS · ❌ FAIL · ⚠️ PARTIAL. For any FAIL, note what you saw.

---

## A. Circle modal isolation (issue 5.8) — the headline change

The rule being tested: **the Circle PIN modal owns its own interaction; the webhook
owns "did it succeed"; a transient modal hiccup must NEVER become a stuck app error.**

| # | Setup | Action | ✅ Expected | ❌ Fail looks like |
|---|---|---|---|---|
| A1 | Fresh signup (new email) | When the Circle PIN dialog opens, **close/cancel it** | Stays on calm "Setting up your wallet…" or a retryable screen. If you actually completed the PIN, webhook/Realtime auto-advances. | Full-screen red **"Something went wrong"** |
| A2 | Start a main-wallet send → reach PIN dialog | **Wait ~70s**, then enter PIN | Send completes normally — **not** auto-failed at 60s | "PIN confirmation timed out" failure around 60s |
| A3 | Do a normal send (Arc often returns no hash from the SDK) | Complete it | "Done" screen, then **"Confirming…"** resolves to a clickable tx hash within a few seconds (webhook poll) | No explorer link ever appears |
| A4 | Start a send → reach PIN dialog | **Cancel** the dialog | Soft amber note **"You cancelled the PIN dialog — nothing was sent. Review and try again."** back on the confirm screen | Scary red **"Transaction failed"** |
| A5 | After A1/A4 (an error was raised) | Navigate away from `/wallet` and back (or sign out → in) | Fresh login screen with **no leftover error banner** | Stale red error persists on the login screen |

> If A1–A5 pass, the 5.8 cluster is good.

---

## B. Rate limiting (issue 2.3)

Needs migration `0011`. The limiter is **fail-open** — if these DON'T block, first
confirm `consume_rate_limit` exists in the DB (else it silently allows everything).

| # | Action | ✅ Expected |
|---|---|---|
| B1 | Send **11 agent chat messages** within one minute | ~11th reply: **"You're sending requests too quickly. Try again in Ns."** (HTTP 429) |
| B2 | Confirm **6 agent actions** within one minute | ~6th: **"Too many confirmations in a short time. Try again in Ns."** (HTTP 429) |

Quick check (psql / Supabase SQL editor): after B1, `select * from rate_limits where bucket_key like 'interpret:%';` should show a row with `count >= 10`.

---

## C. Cron claim-lock — no double-payment (issues 3.1 / 3.2)

Needs migration `0012`. **This is the money-critical one.**

| # | Setup | Action | ✅ Expected | ❌ Fail looks like |
|---|---|---|---|---|
| C1 | Create policy: *"send 0.1 USDC to `<recipient>` every minute"* | Let the cron run for 2–3 minutes | **Exactly one** send per minute. `select status,count(*) from agent_spend_log where ... group by 1` → one COMPLETE per cycle. `cron_runs` has one row per minute slot. | Two sends / two spend-log rows per cycle |
| C2 | A policy is due now | Hit the cron endpoint **twice in parallel** (two terminals): `curl -H "Authorization: Bearer $CRON_SECRET" https://<dev>/api/cron/agent-policies` | One response shows the policy `fired`; the other shows it in `details` as **"Already claimed this cycle (idempotent skip)"**. Only **one** on-chain send. | Both fire → duplicate payment |

After C1, clean up: cancel the every-minute policy so it stops spending.

---

## D. Register-name race — no double treasury charge (issue 2.7)

| # | Setup | Action | ✅ Expected |
|---|---|---|---|
| D1 | Fresh user, no `.arc` name yet | Submit register-name **twice in fast parallel** (double-click, or two `curl` POSTs to `/api/circle/register-name` with the same session cookie) | **One** succeeds; the other returns 409 **"This wallet already owns …"**. Treasury pays the 5 USDC fee **once** (check treasury balance / one tx). |

> Note: this is **same-instance** protection (`withUserLock`). On Vercel two requests
> can land in different cold containers and still race — full cross-instance fix
> (Postgres advisory lock) is a mainnet item, not tested here.

---

## E. Earlier V3 hardening — code-verified, never live-tested

These were fixed in the V3 hardening commit but flagged "needs live retest."

| # | Test | ✅ Expected (what the fix guarantees) |
|---|---|---|
| E1 | `send 5 USDC to <recipient>` | Completes — **no** 44s hang / 204s 500 (Circle timeout+retry+circuit breaker) |
| E2 | `swap 5 USDC to cirBTC` | Completes or clean error — no hang; no spend-log row for the swap |
| E3 | `withdraw 1 USDC to my main wallet` | Completes; **no** PIN/confirm card for self-withdraw |
| E4 | `withdraw all my funds` | Leaves **~0.1 USDC** gas buffer; a follow-up tx still works (not drained to 0) |
| E5 | Multi-turn agent chat, then close tab / 10-min idle | Server logs show **no** `ByteString` / em-dash crash on `session-end` |
| E6 | `swap 3 USDC to cirBTC then send all of it to <recipient>` | One task, two steps, `$prev.amountOut` chains the real swap output |

---

## Go / No-Go

**Push V3 if:** all of **A** and **C** pass (modal isolation + no cron double-pay are
the non-negotiables — they touch UX and money). B/D/E failures are fixable post-push
but log them.

**Hold if:** any of C fails (double-payment), or A1/A4 still throws a full-screen error
(modal regression), or E4 drains the wallet to zero.

---

### Result log

| Test | Result | Notes |
|---|---|---|
| A1 |  |  |
| A2 |  |  |
| A3 |  |  |
| A4 |  |  |
| A5 |  |  |
| B1 |  |  |
| B2 |  |  |
| C1 |  |  |
| C2 |  |  |
| D1 |  |  |
| E1 |  |  |
| E2 |  |  |
| E3 |  |  |
| E4 |  |  |
| E5 |  |  |
| E6 |  |  |
