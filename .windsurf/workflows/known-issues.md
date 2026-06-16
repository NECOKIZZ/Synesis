---
description: Known issues and architectural debt
---

# Known Issues

## 1. Circle W3S SDK callback unreliability

**Severity:** High — affects new-user onboarding UX
**File:** `app/circle-wallet-context.tsx` (`startCircleFlow`)

### Problem

The Circle W3S SDK's `execute(challengeId, callback)` does not reliably fire its callback when the user completes the PIN setup dialog. The callback is supposed to signal `COMPLETE`, `FAILED`, or `ERROR`, but in practice it sometimes silently drops — the iframe closes, the user thinks they're done, but the Promise never resolves.

**Evidence:**
- Terminal shows `init-user` returns `alreadyOnboarded: false, hasChallengeId: true`
- User finishes PIN dialog in the browser
- No `[circle] execute callback fired:` log appears
- SDK callback never fires → app stays on "Setting up your wallet…" spinner indefinitely
- Clicking "Try again" re-runs `init-user`, which now returns `alreadyOnboarded: true` (FAST PATH)
- This proves the server state changed, but the client callback never notified us

### Current mitigation

`startCircleFlow` no longer has a 60s timeout on the SDK callback Promise. The user can take unlimited time in the PIN dialog without being kicked out with a false "timed out" error.

### Webhook integration (partially implemented)

A `challenges.initialize` webhook handler has been added to `app/api/webhooks/circle/route.ts`. When the user completes the PIN setup, Circle POSTs to this endpoint, which:
1. Receives the `challenges.initialize` + `COMPLETE` notification
2. Fetches the user's wallet from Circle's API
3. Updates the `profiles` table with the wallet address

### Remaining work

**Client-side push notification (NOT YET IMPLEMENTED):**

The webhook updates the database, but the client sitting on the "Setting up your wallet…" screen does not know this happened. The client must either:

1. **Supabase Realtime subscription** (recommended): Subscribe to `profiles` row changes in `circle-wallet-context.tsx`. When the webhook updates `wallet_address`, Realtime pushes the event to the client, which transitions from `challenging` → `wallet-ready` → `needs-name` automatically.

2. **Manual refresh**: The user refreshes the page. `refresh()` calls `/api/circle/me`, which sees the updated session and transitions. This works but is not automatic.

**Send flow (`executeChallenge`) still uses SDK callback:**

The send flow (`send-modal.tsx` → `executeChallenge`) still relies on the SDK callback with a 60s timeout. This is a different challenge type (`challenges.createTransaction`). The webhook architecture should eventually be extended to cover send confirmations as well, using `challenges.createTransaction` webhooks + Realtime to push the tx result to the client.

### Status

- ✅ Webhook endpoint receives `challenges.initialize`
- ✅ Webhook updates `profiles.wallet_address` on server
- ✅ Onboarding no longer has false 60s timeout
- ❌ Client does not auto-transition when webhook lands (needs Realtime)
- ❌ Send flow still depends on flaky SDK callback
