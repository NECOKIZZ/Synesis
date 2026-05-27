# DotArc Smart Wallet — Authentication, Security and Session Management

This document covers everything related to how users log in, how sessions are managed, how the two wallet types are connected, how the agent is secured, and how friction is minimised without compromising safety. It picks up where the Master Architecture Document ends.

---

## 1. The Core Problem This Document Solves

DotArc Smart Wallet has two wallet types that live in separate Circle infrastructures:

```
User-Controlled Wallet (main wallet)
  → Circle manages the session and PIN
  → User logs in via Circle's OTP flow
  → Your backend only stores the address

Developer-Controlled Wallet (agent wallet)
  → Your backend manages entirely
  → Signed by your entity secret
  → Has no concept of "who the user is" on its own
```

Without a connecting layer, these two things do not know about each other. A user could log into their Circle wallet and have no idea their agent wallet exists. And your agent wallet has no idea which human it belongs to beyond a database row.

The solution is your own app session layer that sits on top of both and ties them together.

---

## 2. The Three-Layer Auth Stack

There are three authentication layers in the product. Each has a distinct job. They must not be confused with each other.

```
Layer 1 — Your App Session (Google OAuth)
  Job: get the user into YOUR product
  Technology: Google OAuth + NextAuth.js
  What it proves: this is maya@gmail.com
  What it loads: both wallets, policies, balances
  Persists: yes, until explicit logout

Layer 2 — Circle User-Controlled Wallet Session
  Job: prove ownership of the main wallet
  Technology: Circle's internal session + OTP on first use
  What it proves: this person owns this Circle wallet
  What it loads: nothing in your app — Circle handles internally
  Persists: yes, in device secure storage

Layer 3 — Circle PIN (for main wallet transactions only)
  Job: authorise individual transactions from the main wallet
  Technology: Circle's SDK PIN modal
  What it proves: the user is present and consenting to this tx
  When it appears: only when sending from the main wallet manually
  Persists: no — required each time
```

Layer 1 is yours to build. Layers 2 and 3 are Circle's infrastructure. You do not build them.

---

## 3. First Time Signup — The Only Time OTP Appears

The OTP appears exactly once in a user's lifetime with the product — during the very first wallet setup. After that it should never appear again under normal use.

```
Step 1 — Google OAuth (your app layer)
  User taps "Get Started"
  Signs in with Google
  Your app creates a user record:
    user_id:   "abc-123"
    email:     "maya@gmail.com"
  Your app session established and persisted to device

Step 2 — Circle Wallet Creation (Circle layer)
  Your backend calls Circle to create a user session
  Circle sends OTP to maya@gmail.com
  Maya enters OTP in Circle's SDK modal
  Circle creates her user-controlled wallet:
    circle_wallet_id: "circle-ucw-xyz"
    wallet_address:   "0xMAYA..."
  Circle's session token persisted to device secure storage

Step 3 — Your Backend Saves the Connection
  users table updated:
    user_id:          "abc-123"
    email:            "maya@gmail.com"
    circle_wallet_id: "circle-ucw-xyz"
    wallet_address:   "0xMAYA..."
    arc_name:         "maya.arc"

Step 4 — Name Registration (silent, backend)
  Treasury pays 5 USDC
  maya.arc registered on-chain
  User sees: "Welcome, maya.arc"
  User never saw a 0x address
  User never sees this again requiring OTP
```

Total OTP appearances in this flow: one. That is the target. Never more than once per device setup.

---

## 4. Every Login After the First — No OTP

After the first setup, logging back in should feel like opening any consumer app. No OTP. No friction.

```
App opens
         ↓
Check: valid Google session token on device?
  Yes → skip Google login, go straight in
  No  → show Google sign-in (one tap on mobile if
         Google account is saved on device)
         ↓
Check: valid Circle SDK session in device secure storage?
  Yes → skip OTP entirely
  No  → Circle may require OTP again (see Section 6)
         ↓
Load user data from your database using user_id:
  → main wallet balance and address
  → agent wallet balance and address (if activated)
  → active policies
  → recent activity
         ↓
User is in. Everything displayed. No friction.
```

The Circle session persisting in device secure storage is what eliminates the repeated OTP. Your job as the builder is to never clear that storage unless the user explicitly logs out of everything.

---

## 5. The "Logout" Problem — And How to Solve It

This was the core friction concern. If logging out clears the Circle session, every re-login requires OTP again. That is unacceptable for a daily use product.

The solution is to distinguish between three different things users might mean when they think "logout":

---

### State 1 — Closing the App (Most Common)

User closes the app or puts their phone down. This is not a logout. Nothing is cleared. Everything persists.

```
User closes app
         ↓
Nothing cleared
Next open → straight back in
No Google. No OTP. No PIN.
```

---

### State 2 — Locking the App (Security-Conscious Users)

User wants the app to require re-entry before showing wallet info. This is a privacy lock, not a logout. Circle session stays alive underneath.

```
User taps "Lock wallet" in settings
OR
App auto-locks after X minutes of inactivity
         ↓
App shows lock screen
Requires: biometric (Face ID / fingerprint)
          OR Google re-auth (one tap)
          NOT OTP
         ↓
Biometric passes → everything loads
Circle session was never touched
No OTP required
```

This is the right default for most users. Offer auto-lock after 5 minutes of inactivity as a toggleable setting.

---

### State 3 — Full Sign Out (Rare, Intentional)

User deliberately signs out of everything. This is for switching accounts, giving away a device, or a security concern. OTP will be required on next login. That is acceptable because this action is intentional and rare.

```
User goes to Settings → Security → Sign out of all devices
         ↓
App confirms: "This will sign you out completely.
You will need to verify your email again next time."
[Sign Out]  [Cancel]
         ↓
Your app session cleared
Circle session cleared from device storage
         ↓
Next login:
  Google sign-in → Circle OTP once → back in
```

This is the only moment OTP reappears. The user chose it deliberately. The friction is acceptable.

---

### State 4 — New Device

User gets a new phone. No stored sessions anywhere. They need to prove they own the account again.

```
New device, opens app
         ↓
No Google session → Google sign-in
No Circle session → Circle OTP sent to email
Both verified → wallets load
         ↓
New device sessions established
Normal use resumes
```

Again, one OTP appearance, tied to device setup. Acceptable.

---

## 6. When OTP Can Reappear — And Why

Circle controls the lifetime of their session token. There are scenarios outside your control where their session expires and OTP is required again. Be honest with users about this.

```
Scenario                          OTP required?
────────────────────────────────────────────────
Normal daily use                  Never
App closed and reopened           Never
App locked and unlocked           Never (biometric instead)
Extended inactivity (months)      Possibly (Circle token expires)
New device                        Yes (once)
Explicit full logout              Yes (once, user chose it)
Circle security event             Possibly (Circle's decision)
```

For the extended inactivity case — if a user has not opened the app in several months and Circle's session has expired, they will see OTP again. This is unavoidable. Frame it in the UI as "verify it's still you" rather than exposing the technical reason.

---

## 7. Connecting the Two Wallets — The Database as the Thread

Your database is what connects the user-controlled wallet and the agent wallet. They are separate Circle products. Your database is the only thing that knows they belong to the same person.

```
users table
  user_id:          "abc-123"          ← the master identity
  email:            "maya@gmail.com"
  circle_wallet_id: "circle-ucw-xyz"   ← main wallet (user-controlled)
  wallet_address:   "0xMAYA..."
  arc_name:         "maya.arc"

agent_wallets table
  user_id:          "abc-123"          ← same user_id = same person
  circle_wallet_id: "circle-dcw-xyz"   ← agent wallet (dev-controlled)
  wallet_address:   "0xAGENT..."
  arc_name:         "maya-agent.arc"
```

When Maya logs in via Google, your backend looks up `user_id` by email, then queries both tables. Everything loads together. Maya sees one unified product — her name, her main wallet, her agent, her policies — with no idea they are two separate Circle wallet types underneath.

---

## 8. Agent Wallet Security — Optional PIN

The agent wallet is developer-controlled. Your backend signs automatically. There is no Circle PIN for agent transactions. The question is what protects the agent from being abused.

The decision made: **make the security method optional.** The user chooses during agent activation.

```
During agent setup:

"Secure your agent"
─────────────────────────────────────────
How should your agent confirm new instructions?

  ◉ Google sign-in only
    One tap to confirm using your Google account
    Recommended for most users

  ○ Set an agent PIN
    A separate 4-6 digit PIN just for agent actions
    For users who want maximum security

[Continue]
```

Their choice is stored in the database. Every high-risk agent action routes through the appropriate verification method.

---

## 9. What Counts as a High-Risk Agent Action

Not every agent interaction needs verification. Low-risk actions just need a valid session. High-risk actions need explicit re-confirmation.

```
LOW RISK — valid session only:
  → Viewing agent balance
  → Viewing active policies
  → Viewing activity feed
  → Checking what the agent has spent

HIGH RISK — requires re-confirmation (Google or PIN):
  → Creating a new payment policy
  → Increasing spend limits
  → Withdrawing USDC from agent to main wallet
  → Cancelling all policies at once
  → Changing the security method itself
```

For Google re-auth on mobile, this is literally one tap if the user is already signed into Google on their device. The friction is minimal. The protection is real.

---

## 10. The Agent Auth Flow — Both Methods

### If User Chose Google Re-Auth

```
User says: "pay sara 50 USDC every Friday"
         ↓
Claude interprets → returns JSON
         ↓
Frontend shows confirmation card
         ↓
"Confirm with Google to save this policy"
[Continue with Google]
         ↓
Google re-auth (one tap on mobile)
         ↓
Your backend receives confirmation
Records: auth_verified_at = now(), auth_method = "google_reauth"
Policy saved to database
Cron job picks it up on schedule
```

### If User Chose Agent PIN

```
User says: "pay sara 50 USDC every Friday"
         ↓
Claude interprets → returns JSON
         ↓
Frontend shows confirmation card
         ↓
"Enter your agent PIN"
[● ● ● ●]
         ↓
Frontend sends PIN to /api/agent/verify-pin
Backend compares against agent_pin_hash (bcrypt)
Match → proceed
No match → increment attempts, maybe lock
         ↓
Records: auth_verified_at = now(), auth_method = "pin"
Policy saved to database
```

---

## 11. Agent PIN Storage and Safety

If the user chose PIN, this is how it is stored. The raw PIN number never exists in your system after the moment of entry.

```javascript
// When user sets their agent PIN
const hash = await bcrypt.hash(userEnteredPin, 12)
// Store hash in agent_wallets.agent_pin_hash
// The number "2847" is gone. Only the hash exists.

// When user enters PIN to confirm an action
const match = await bcrypt.compare(enteredPin, storedHash)
// true  → proceed with the action
// false → increment agent_wallets.pin_attempts
//         check if lockout threshold reached
```

### Lockout Rules

```
3 wrong attempts  → lock for 15 minutes
                    (set pin_locked_until = now + 15min)

5 wrong attempts  → lock until email verification
                    (send recovery email to maya@gmail.com)

Successful entry  → reset pin_attempts to 0
```

---

## 12. Changing the Security Method

Users can switch between Google re-auth and PIN at any time under Settings → Agent Security.

The rule: you must prove you are the current legitimate user before changing the security method. You cannot lower your own security without first proving you set it up.

```
Switching from Google to PIN:
  → Requires Google re-auth first
  → Then set new PIN
  → New PIN stored as bcrypt hash

Switching from PIN to Google:
  → Requires current PIN entry first
  → PIN hash deleted from database
  → auth_method updated to "google_reauth"

Changing PIN to a new PIN:
  → Requires current PIN entry first
  → New PIN hashed and stored
```

---

## 13. The Cron Job — No User Auth Needed

The cron job runs server-side on your backend. It does not involve the user at all. It does not need Google auth. It does not need Circle PIN. It does not need the agent PIN.

The cron job's authority comes from:

```
1. Your entity secret → signs Circle transactions
2. The agent_policies database record → proves the user
   already authorised this action (auth_verified_at timestamp)
3. The spend limits check → ensures the action is within
   what the user configured
```

The legitimacy of each execution is established at policy creation time (when the user confirmed with Google or PIN). The cron job just reads those pre-authorised instructions and executes them. No human needs to be present.

---

## 14. The Full Session and Wallet Loading Flow

This is what happens from app open to fully loaded UI, every time after the first setup.

```
App opens on device
         ↓
NextAuth checks device for persisted Google session token
  Found and valid → user_id resolved → skip to data load
  Not found → show Google sign-in button
         ↓ (if Google sign-in needed)
User taps "Sign in with Google"
On mobile this is one tap if Google account is on device
Google token returned → your backend verifies it
user_id resolved from email
Your session token issued and persisted
         ↓
Circle SDK checks device secure storage for Circle session
  Found and valid → Circle ready for tx signing
  Not found or expired → Circle will require OTP if user
                         tries to sign from main wallet
                         (does not block app loading)
         ↓
Your backend queries database for user_id:

  SELECT * FROM users WHERE user_id = 'abc-123'
  SELECT * FROM agent_wallets WHERE user_id = 'abc-123'
  SELECT * FROM agent_policies WHERE user_id = 'abc-123' AND active = true
  SELECT balance FROM Circle API for both wallet addresses
         ↓
Frontend receives:
  main_wallet:    { name: "maya.arc", balance: 150 }
  agent_wallet:   { name: "maya-agent.arc", balance: 100 }
  active_policies: [ netflix, sara ]
  recent_activity: [ last 10 transactions ]
         ↓
App displays unified wallet UI
User is in
```

---

## 15. Database Fields Added by This Document

These fields extend the schema defined in the Master Architecture Document.

### users (additions)
```
google_id           → Google OAuth subject ID (ties Google account to user)
google_session_token → persisted session token
session_expires_at  → when to refresh the session
```

### agent_wallets (additions)
```
auth_method         → "google_reauth" or "pin"
agent_pin_hash      → null if google_reauth, bcrypt hash if pin
pin_attempts        → integer, resets on success
pin_locked_until    → timestamp, null if not locked
```

### agent_policies (additions)
```
auth_verified_at    → timestamp when user confirmed this policy
auth_method_used    → "google_reauth" or "pin" — audit trail
```

---

## 16. New API Routes Added by This Document

These routes extend the API routes defined in the Master Architecture Document.

```
POST /api/auth/google
  Receives Google OAuth token
  Verifies with Google
  Creates or retrieves user_id
  Issues app session token
  Returns user session

POST /api/auth/logout
  Clears app session token
  Optionally clears Circle session (full logout only)
  Returns confirmation

POST /api/agent/verify-pin
  Receives PIN entry for PIN-method users
  Compares against bcrypt hash
  Returns verified token or error + remaining attempts
  Handles lockout logic

POST /api/agent/set-pin
  Sets or changes agent PIN
  Requires current auth verification first
  Stores new bcrypt hash
  Returns confirmation

POST /api/agent/set-auth-method
  Switches between google_reauth and pin
  Requires current auth verification first
  Updates auth_method in agent_wallets
  Returns confirmation

GET /api/user/load
  Single endpoint called on every app open
  Returns everything needed to render the UI:
    main wallet info
    agent wallet info (if activated)
    active policies
    recent activity
    spend limits
  One query. One response. Everything at once.
```

---

## 17. Security Summary — The Rules

These rules govern every security decision in the product. The builder must not deviate from them.

**Rule 1 — OTP appears once per device setup, never more under normal use.**
Persist Circle's session token. Only clear it on explicit full logout.

**Rule 2 — Closing the app is not a logout.**
Nothing is cleared when the user backgrounds the app or closes it.

**Rule 3 — Locking the app uses biometrics, not OTP.**
Lock screen requires Face ID or fingerprint. Circle session is untouched.

**Rule 4 — The agent PIN is optional, chosen by the user.**
Store the choice in `auth_method`. Route all high-risk actions through the chosen method.

**Rule 5 — Raw PINs are never stored anywhere.**
bcrypt hash only. The number itself must not exist in logs, database, or memory after hashing.

**Rule 6 — Every agent wallet action checks user_id ownership.**
Session user_id must match agent_wallets.user_id. No exceptions. No bypasses.

**Rule 7 — Cron job authority comes from pre-authorised policies.**
The cron job does not need user auth. The user authorised the policy at creation. auth_verified_at is the proof.

**Rule 8 — Increasing security settings requires current auth.**
You cannot raise or lower security without first proving you are the legitimate user.

**Rule 9 — High-risk actions require re-confirmation.**
Session alone is not enough for creating policies, withdrawing, or changing limits.

**Rule 10 — Full logout is explicit and warned.**
The UI must make clear that full logout will require OTP on next login. It is never triggered accidentally.

---

## 18. What the Builder Implements — In Order

```
1. NextAuth.js Google OAuth setup
   → Google sign-in, session token, user_id resolution
   → /api/auth/google
   → /api/user/load

2. Circle session persistence
   → Store Circle SDK session in device secure storage
   → Never clear it except on explicit full logout

3. App lock screen
   → Biometric re-entry (Face ID / fingerprint)
   → Auto-lock timer setting

4. Full logout flow
   → Warning modal before clearing sessions
   → /api/auth/logout

5. Agent auth method selection
   → Choice UI during agent activation
   → /api/agent/set-auth-method

6. Agent PIN implementation (for users who choose PIN)
   → PIN setup, bcrypt storage
   → /api/agent/set-pin
   → /api/agent/verify-pin
   → Lockout logic

7. Google re-auth gate (for users who choose Google)
   → Re-auth prompt on high-risk actions
   → Verification before policy save

8. Ownership check middleware
   → Reusable function: does session user_id own this agent wallet?
   → Applied to every agent API route
```

Do not build items 5-8 until items 1-4 are working and tested. The session layer must be solid before the agent security layer is added on top.
