# Cuerate / PromptLens Problem Log

## 1. Critical Syntax Error in `activate/route.ts`
**File:** `app/api/agent/activate/route.ts`
**Issue:** There is a broken, duplicate `upsert` call at line 105. It appears a line was partially deleted or copy-pasted incorrectly, leaving a dangling `await` statement that will prevent the API from compiling or running correctly.

## 2. Withdrawal Gas Buffer Issue
**Source:** `TESTING.md` (T-031)
**Issue:** During tests, "withdraw all" commands are failing (500 error).
**Root Cause:** The agent is attempting to drain the wallet to exactly zero. Because gas fees are paid in USDC/USDT on these networks, the transaction fails because there is no leftover balance to cover the network fee. The logic needs to be updated to always retain a small "gas buffer" (e.g., 0.1 USDC).

## 3. HMAC Verification / JSON Key Sorting
**Source:** `AGENT_ROADMAP.md` (Critical Finding)
**Issue:** Policies are being deactivated automatically with "HMAC verification failed".
**Root Cause:** Postgres `jsonb` columns re-sort keys by length, but the HMAC was signed using a standard `JSON.stringify`. This causes the signature to mismatch when the data is read back from the database. A `stableStringify` approach is required for signatures.

## 4. Circle API Timeout
**Source:** `TESTING.md`
**Issue:** High latency (up to 204s) on money-moving skills.
**Root Cause:** The `getWalletTokenBalance` call to Circle's devnet has no timeout set. If the Circle API is slow or hangs, the entire agent process hangs.

## 5. UI Confirmation Redundancy
**Issue:** Skills that require a PIN (Withdraw, Swap, Bridge) are showing both a PIN modal AND a confirm card. This creates a friction-heavy UX.