# DotArc Circle Integration — Implementation Guide for Builder

This section is the hands-on companion to the research document above. It tells the builder exactly what to do, in what order, and why. Do not skip steps. Do not put secrets in the frontend.

---

## The Two Wallet Types in This System

There are exactly two wallet types. Understanding the difference is mandatory before writing a single line of code.

| Wallet | Type | Who controls it | What it does |
|---|---|---|---|
| **Treasury** | Developer-controlled | DotArc (you) | Holds USDC, auto-signs `.arc` registration fees |
| **User wallets** | User-controlled | The user | Receives payments, sends USDC, owns their `.arc` name |

The treasury is the only developer-controlled wallet in the entire system. You never hold, create, or manage a user's private key. Circle handles user key custody through social login — the user authenticates with Google or email, Circle creates a wallet only they can sign from, and your backend only ever receives the resulting wallet address.

The treasury pays the registration fee on the user's behalf. The user's wallet is just the destination the name resolves to. The user never pays a cent to register their name.

---

## Environment Variables

Create a `.env` file in the root of the project. Add it to `.gitignore` immediately. Never commit it.

```
CIRCLE_API_KEY=
CIRCLE_ENTITY_SECRET=
CIRCLE_TREASURY_WALLET_SET_ID=
CIRCLE_TREASURY_WALLET_ID=
JWT_SECRET=
NEXT_PUBLIC_CIRCLE_APP_ID=
USDC_TOKEN_ADDRESS=0x3600000000000000000000000000000000000000
ARC_REGISTRY_ADDRESS=0xf5e0E328119D16c75Fb4a001282a3a7b733EF6db
ARC_RPC_URL=https://rpc.testnet.arc.network
```

Notice there is no `CIRCLE_USER_WALLET_SET_ID`. User wallets are created through the Circle User-Controlled Wallet SDK on the frontend. Your backend never creates them.

**Notice there is no `TREASURY_PRIVATE_KEY`.** Circle developer-controlled wallets are MPC — a private key never exists in any single place and cannot be exported. The backend signs treasury transactions by calling Circle's `createContractExecutionTransaction` API with `walletId = CIRCLE_TREASURY_WALLET_ID`; Circle's MPC infrastructure performs the signing internally. See the rewritten Step 6 for the implementation. (An earlier version of this guide incorrectly told the builder to export a raw private key — that path does not exist for dev-controlled wallets and has been removed.)

`NEXT_PUBLIC_CIRCLE_APP_ID` is the only value in this list that is safe to expose to the browser. It is a public app identifier, not a key. Get it from `console.circle.com` under App settings.

`JWT_SECRET` is a random string you generate yourself (any 32+ char base64 string). Used to sign session cookies after a user completes Circle PIN setup.

---

## Step 1 — Get a Circle API Key

This is a one-time setup done by the project owner, not automated.

1. Go to `https://console.circle.com` and create a developer account.
2. In the left sidebar, go to **API and client keys**.
3. Click **Generate Key**.
4. Copy the full key and paste it into `.env` as `CIRCLE_API_KEY`.

This key is used only for treasury operations on your backend. It must never appear in any frontend file or be prefixed with `NEXT_PUBLIC_`.

---

## Step 2 — Generate and Register the Entity Secret

The entity secret is a 32-byte cryptographic key that secures the treasury wallet. Circle never stores it. If you lose it, the treasury wallet is unrecoverable. Treat it like a master password.

This is a one-time setup. Run it once, save the outputs, never run it again.

**Install the developer-controlled wallets SDK (backend only):**

```bash
npm install @circle-fin/developer-controlled-wallets
```

**Generate the secret (run once):**

```js
// scripts/generate-secret.mjs
import { generateEntitySecret } from '@circle-fin/developer-controlled-wallets'
generateEntitySecret()
// Prints a hex string to the console. Copy it.
```

```bash
node scripts/generate-secret.mjs
```

Copy the printed value and paste it into `.env` as `CIRCLE_ENTITY_SECRET`.

**Register the secret with Circle (run once):**

```js
// scripts/register-secret.mjs
import { registerEntitySecretCiphertext } from '@circle-fin/developer-controlled-wallets'

const result = await registerEntitySecretCiphertext({
  apiKey: process.env.CIRCLE_API_KEY,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET
})

console.log(result.data?.recoveryFile)
// Save the recovery file content somewhere safe and offline.
```

```bash
node --env-file=.env scripts/register-secret.mjs
```

Save the printed `recoveryFile` content in a secure location offline. This is the only recovery option if the entity secret is ever lost.

---

## Step 3 — Create the Treasury Wallet

The treasury wallet holds USDC and auto-signs `.arc` name registrations. It is created once and lives forever. You top it up with USDC whenever the balance runs low.

```js
// scripts/create-treasury.mjs
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets'

const client = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET
})

// Create a wallet set to hold the treasury
const walletSetResponse = await client.createWalletSet({
  name: 'DotArc Treasury'
})

const walletSetId = walletSetResponse.data.walletSet.id
console.log('Treasury Wallet Set ID:', walletSetId)

// Create the treasury wallet inside the set on Arc Testnet
const walletsResponse = await client.createWallets({
  walletSetId,
  blockchains: ['ARC-TESTNET'],
  accountType: 'EOA',
  count: 1,
  metadata: [{ name: 'Treasury', refId: 'treasury-001' }]
})

const treasury = walletsResponse.data.wallets[0]
console.log('Treasury Wallet ID:', treasury.id)
console.log('Treasury Wallet Address:', treasury.address)
```

```bash
node --env-file=.env scripts/create-treasury.mjs
```

Copy the printed values into `.env`:

```
CIRCLE_TREASURY_WALLET_SET_ID=   ← wallet set ID from above
CIRCLE_TREASURY_WALLET_ID=       ← wallet ID from above
```

Top up the treasury address with testnet USDC from `https://faucet.circle.com`. It needs enough to cover registrations — 5 USDC per standard name, 50 USDC per short name (4 characters or fewer).

**One-time USDC approval.** The ANS registry pulls 5 USDC from the treasury via `transferFrom` during each registration. To avoid an extra approve transaction every time, run the bonus script once after funding:

```bash
node --env-file=.env packages/api/scripts/treasury-approve-usdc.mjs
```

This submits a single `approve(REGISTRY, MaxUint256)` via Circle's `createContractExecutionTransaction`. After it confirms, every future registration is one Circle transaction instead of two.

**No private key required — ever.** Earlier drafts of this guide referenced a `TREASURY_PRIVATE_KEY`. That was incorrect. Circle dev-controlled wallets are MPC; there is no exportable key, and the backend never needs one. All treasury signing happens through Circle's API using `CIRCLE_ENTITY_SECRET` + `CIRCLE_TREASURY_WALLET_ID`. See Step 6.

---

## Step 4 — User Wallet Creation (Frontend, User-Controlled)

This is where the architecture differs from a normal backend flow. You do not create user wallets on your backend. The user creates their own wallet through the Circle User-Controlled Wallet SDK. You only receive the address at the end.

**Install the user-controlled wallets SDK (frontend):**

```bash
npm install @circle-fin/w3s-pw-web-sdk
```

**The frontend flow when a user signs up:**

```js
// frontend/lib/circle-user.js
import { W3SSdk } from '@circle-fin/w3s-pw-web-sdk'

const sdk = new W3SSdk({
  appSettings: { appId: process.env.NEXT_PUBLIC_CIRCLE_APP_ID }
  // NEXT_PUBLIC_CIRCLE_APP_ID is safe to expose — it is a public app identifier, not an API key.
})

export async function createUserWallet() {
  // Step 1: Your backend creates a session for this user
  const { userToken, encryptionKey, challengeId } = await fetch('/api/create-user-session', {
    method: 'POST'
  }).then(r => r.json())

  // Step 2: SDK initialises with the session
  sdk.setAuthentication({ userToken, encryptionKey })

  // Step 3: Circle prompts the user to set a PIN — you never see the key
  await new Promise((resolve, reject) => {
    sdk.execute(challengeId, (error, result) => {
      if (error) return reject(error)
      resolve(result)
    })
  })

  // Step 4: Fetch the wallet address your backend saved
  const { walletAddress } = await fetch('/api/get-user-wallet').then(r => r.json())

  return walletAddress
}
```

The user goes through Circle's UI to set a PIN or authenticate. Their private key is created and secured by Circle on their behalf. You never see it. You only get back a wallet address.

---

## Step 5 — Backend: User Session Routes

Your backend creates a Circle user session when a new user signs up. This is what the frontend SDK uses to kick off wallet creation.

**Install the user-controlled wallets backend SDK:**

```bash
npm install @circle-fin/user-controlled-wallets
```

**Route 1 — create the session:**

```js
// pages/api/create-user-session.js  (Next.js API route — backend only)
import { initiateUserControlledWalletsClient } from '@circle-fin/user-controlled-wallets'

const client = initiateUserControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY
})

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  // Require the user to be logged in with Google/email first
  const session = await getServerSession(req, res)
  if (!session) return res.status(401).end()

  // Create a Circle user identity for this person
  await client.createUser({ userId: session.user.id })

  // Create a session token so the frontend SDK can initialise
  const tokenResponse = await client.createUserToken({
    userId: session.user.id
  })

  // Create the wallet challenge — tells Circle to create a wallet on Arc Testnet
  const challengeResponse = await client.createUserPinWithWallets({
    userId: session.user.id,
    blockchains: ['ARC-TESTNET']
  })

  return res.status(200).json({
    userToken: tokenResponse.data.userToken,
    encryptionKey: tokenResponse.data.encryptionKey,
    challengeId: challengeResponse.data.challengeId
  })
}
```

**Route 2 — fetch the wallet address after the user completes their PIN:**

```js
// pages/api/get-user-wallet.js  (Next.js API route — backend only)
import { initiateUserControlledWalletsClient } from '@circle-fin/user-controlled-wallets'

const client = initiateUserControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY
})

export default async function handler(req, res) {
  const session = await getServerSession(req, res)
  if (!session) return res.status(401).end()

  const walletsResponse = await client.listWallets({
    userId: session.user.id
  })

  const wallet = walletsResponse.data.wallets[0]

  // Save the address to your DB — this is all you store, no keys
  await db.user.update({
    where: { id: session.user.id },
    data: {
      walletAddress: wallet.address,
      circleWalletId: wallet.id
    }
  })

  return res.status(200).json({ walletAddress: wallet.address })
}
```

---

## Step 6 — Backend: Treasury Registers the Name (via Circle MPC)

Once the frontend has a wallet address for the user, it sends it to this route. The treasury signs and pays. The name resolves to the user's address. The user pays nothing.

**Important:** this route does not use an `ethers.Wallet` or any raw private key. Treasury signing happens through Circle's `createContractExecutionTransaction` API. The `@arcnames/sdk` is used only for read operations (availability check). Writes are encoded manually as calldata and submitted via Circle.

```js
// pages/api/register-name.js  (Next.js API route — backend only)
import { ARCNames } from '@arcnames/sdk'
import { Interface } from 'ethers'
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets'

const circle = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET
})

const registryInterface = new Interface([
  'function register(string label, address resolvedAddress)'
])

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  // Must be authenticated — protects the treasury from being drained by strangers
  const session = await getServerSession(req, res)
  if (!session) return res.status(401).end()

  const { name, userWalletAddress } = req.body
  if (!name || !userWalletAddress) {
    return res.status(400).json({ error: 'name and userWalletAddress are required' })
  }

  // Read-only SDK to check availability before spending treasury USDC
  const ans = new ARCNames({
    rpcUrl: process.env.ARC_RPC_URL,
    registryAddress: process.env.ARC_REGISTRY_ADDRESS
  })

  const available = await ans.isAvailable(name)
  if (!available) {
    return res.status(409).json({ error: 'Name is not available' })
  }

  // Encode the registry.register(name, userAddress) calldata
  // Treasury pays the 5 USDC. Name resolves to the USER's address, not the treasury's.
  const callData = registryInterface.encodeFunctionData('register', [name, userWalletAddress])

  // Submit the transaction via Circle — MPC signs internally
  const txResponse = await circle.createContractExecutionTransaction({
    walletId: process.env.CIRCLE_TREASURY_WALLET_ID,
    contractAddress: process.env.ARC_REGISTRY_ADDRESS,
    callData,
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } }
  })

  const circleTxId = txResponse.data.id

  // Poll Circle until the transaction is on-chain
  const onChainTxHash = await waitForCircleTx(circleTxId)

  return res.status(200).json({
    txHash: onChainTxHash,
    arcName: `${name}.arc`,
    resolvedTo: userWalletAddress
  })
}

// Poll helper — Circle returns immediately, the chain takes a few seconds
async function waitForCircleTx(id, maxAttempts = 20, intervalMs = 3000) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs))
    const { data } = await circle.getTransaction({ id })
    const tx = data?.transaction
    if (tx?.state === 'COMPLETE' || tx?.state === 'CONFIRMED') return tx.txHash
    if (['FAILED', 'CANCELLED', 'DENIED'].includes(tx?.state)) {
      throw new Error(`Circle tx ${tx.state.toLowerCase()}: ${tx.errorReason ?? 'unknown reason'}`)
    }
  }
  throw new Error('Timed out waiting for Circle transaction')
}
```

The critical part is the second argument to `encodeFunctionData('register', [name, userWalletAddress])`. That is what the name resolves to — the user's address. The treasury only pays. It does not own the name and cannot touch the user's wallet.

**Why no `ethers.Wallet`:** Circle dev-controlled wallets are MPC. The private key does not exist as a single retrievable value — it is split between Circle and your entity secret. The only way to make the treasury sign anything is through Circle's API. This is more secure than holding a raw key in `.env` and is also the only option.

---

## Step 7 — Full Signup Flow End to End

This is the complete sequence from a user clicking "Continue with Google" to having a working `.arc` wallet. Read this before building anything.

```
1. User clicks "Continue with Google"
           ↓
2. Google OAuth completes — user is authenticated in your app
           ↓
3. Frontend calls POST /api/create-user-session
   Backend creates Circle user + session token + wallet challenge
           ↓
4. Frontend passes session to Circle User-Controlled SDK
   Circle prompts user to set a PIN
   Circle creates the wallet — user holds the key, you never see it
           ↓
5. Frontend calls GET /api/get-user-wallet
   Backend fetches wallet address from Circle and saves to DB
           ↓
6. Frontend shows name picker — user types "maya"
           ↓
7. Frontend calls POST /api/register-name { name: "maya", userWalletAddress: "0x..." }
   Backend checks name is available
   Treasury signs and pays 5 USDC to the registry
   Registry records: maya.arc → 0xUSER_ADDRESS
   Backend saves arcName to user record
           ↓
8. Frontend shows: "Your wallet is maya.arc"
```

The user record in your database when complete:

```json
{
  "userId": "user-abc-123",
  "email": "maya@gmail.com",
  "authMethod": "google",
  "circleWalletId": "circle-wallet-id",
  "walletAddress": "0x...",
  "arcName": "maya.arc"
}
```

The frontend only ever shows `maya.arc`. The `0x...` address is infrastructure. Store it, but never surface it unless the user explicitly asks.

---

## Step 8 — Resolving Names for Sends

When a user wants to send USDC to another `.arc` name, the frontend resolves it first. This is read-only and safe to run in the browser.

```js
// frontend — safe in the browser
import { ARCNames } from '@arcnames/sdk'

const ans = new ARCNames({
  rpcUrl: 'https://rpc.testnet.arc.network',
  registryAddress: '0xf5e0E328119D16c75Fb4a001282a3a7b733EF6db'
})

async function resolveBeforeSend(input) {
  const name = input.replace(/\.arc$/, '')
  const address = await ans.resolve(name)
  if (!address) throw new Error('Name not found')
  return address
}
```

After resolving the address, the user signs the USDC transfer from their own Circle wallet using their PIN. Your backend is not involved in sends. The transaction goes directly from user wallet to recipient wallet on-chain.

---

## Error Cases the Builder Must Handle

| Error | When it happens | What to do |
|---|---|---|
| Name taken | User picks an already-registered name | Check availability before the name picker loads, and again before registering |
| Treasury low on USDC | Registration fee cannot be paid | Monitor treasury balance, alert project owner, block new signups gracefully |
| Circle session creation fails | Circle API is down | Show "Try again" — do not proceed to wallet creation |
| User abandons PIN setup | User closes the Circle SDK modal | Let them resume from the name picker — their session can be restarted |
| Arc RPC timeout | Chain is slow | Retry once, then show error with link to the block explorer |
| Name taken in race condition | Someone registered between availability check and register call | Prompt user to choose a different name — their wallet already exists and is reusable |

---

## Security Rules — Never Break These

1. `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, and `JWT_SECRET` are backend only. Never in any frontend file. (There is no `TREASURY_PRIVATE_KEY` in this architecture — Circle's MPC handles treasury signing; see Step 6.)
2. Never prefix these with `NEXT_PUBLIC_` — that exposes them to every browser that loads the page.
3. Never log them, even in development.
4. Never commit `.env` to git.
5. `NEXT_PUBLIC_CIRCLE_APP_ID` is the only Circle value safe on the frontend. It is a public app identifier, not a key.
6. The `/api/register-name` endpoint must require a valid authenticated session. Without auth on this route, anyone can POST to it and drain the treasury.
7. The treasury wallet address is public — it is on-chain and anyone can see it. The signing capability (entity secret + wallet ID) is not. Never confuse the two.

---

## Network Reference

| Property | Value |
|---|---|
| Chain | Arc Testnet |
| Chain ID | 5042002 |
| RPC URL | `https://rpc.testnet.arc.network` |
| Registry Contract | `0xf5e0E328119D16c75Fb4a001282a3a7b733EF6db` |
| USDC Token | `0x3600000000000000000000000000000000000000` |
| Block Explorer | `https://testnet.arcscan.app` |
| Gas Token | USDC — no ETH needed for any transaction |
| Registration Fee | 5 USDC/year standard, 50 USDC/year for names 4 chars or shorter |
| Circle Testnet Faucet | `https://faucet.circle.com` |

---

## What the Builder Should Build First (MVP Order)

1. Steps 1–3: Run the setup scripts once. Fill in `.env`. This is configuration, not code — it should take less than an hour.
2. Step 5: The two backend routes — `create-user-session` and `get-user-wallet`.
3. Step 6: The `/api/register-name` route.
4. Step 4: The frontend Circle User-Controlled SDK integration.
5. Step 7: Wire everything together into a signup page — Google login → name picker → wallet created → shows `yourname.arc`.
6. Step 8: The send page with live name resolution.

Do not build the agent wallet, merchant wallet, or passkey wallet until the basic Gmail-to-`.arc` flow works end to end and has been tested.
