# @hashpaylink/sdk Integration Guide

## TL;DR — Can I keep users on my own UI?

**Partially.** The SDK is intentionally thin: it builds checkout URLs and renders a button. Wallet execution always happens on HashKey's hosted checkout (`hashpaylink.com/pay`). There is no fully in-app, zero-redirect mode.

| Mode | What happens |
|---|---|
| `hosted` (default) | Button opens hosted checkout in a new tab |
| `hosted={false}` | Embedded card renders in your page, but still redirects for wallet step |
| URL API | You build the URL manually and open it yourself |

You can control the **trigger** (your own button, card, anything), the **wrapper UI**, and you get **callbacks** when payment completes — but the transaction itself always runs on their page.

---

## Installation

```bash
npm install @hashpaylink/sdk
```

---

## Usage — Arc Network

All examples below lock to Arc via `network="arc"`.

### 1. Drop-in button (opens new tab)

```tsx
import { PayLinkButton } from '@hashpaylink/sdk'

<PayLinkButton
  recipientEVM="0xYourAddress"
  network="arc"
  amount="25"
  memo="Invoice #042"
  onPaymentSuccess={({ txHash, chain }) => console.log('Paid', txHash, chain)}
  onPaymentError={(err) => console.error(err)}
/>
```

### 2. Embedded card (stays in your page longer)

```tsx
<PayLinkButton
  recipientEVM="0xYourAddress"
  network="arc"
  amount="25"
  memo="Invoice #042"
  hosted={false}
/>
```

> Still redirects for wallet execution, but the card lives inside your layout.

### 3. Flexible amount (payer enters their own amount)

```tsx
<PayLinkButton
  recipientEVM="0xYourAddress"
  network="arc"
  flexibleAmount
  memo="Tip Jar"
/>
```

### 4. Your own button → open checkout manually

Use `buildPayLinkUrl` if your Request button already exists and you just want to trigger the checkout:

```tsx
import { buildPayLinkUrl } from '@hashpaylink/sdk'

function RequestButton({ address }: { address: string }) {
  const handleClick = () => {
    const url = buildPayLinkUrl({
      recipientEVM: address,
      amount: '25',
      memo: 'Payment request',
    })
    window.open(`${url}&n=arc`, '_blank')
  }

  return <button onClick={handleClick}>Request Payment</button>
}
```

---

## Props Reference

| Prop | Type | Required | Description |
|---|---|---|---|
| `recipientEVM` | string | one of | EVM address (Base / HashKey / Arc / Arbitrum) |
| `recipientStark` | string | one of | Starknet address (66 chars) |
| `recipientSolana` | string | one of | Solana address (base58) |
| `network` | string | no | `base` \| `arbitrum` \| `solana` \| `starknet` \| `arc` \| `hashkey`. Defaults to `base` |
| `amount` | string | no | Fixed USDC amount. Required unless `flexibleAmount` is true |
| `memo` | string | no | Payment memo shown to payer |
| `flexibleAmount` | boolean | no | Allow payer to enter any amount |
| `multiChain` | boolean | no | Show all chain options simultaneously |
| `eventId` | string | no | Multi-payer dashboard/event ID |
| `mode` | string | no | `wallet` \| `direct`. Defaults to `wallet` |
| `hosted` | boolean | no | `true` = compact link button, `false` = embedded card |
| `label` | string | no | Custom button label text |
| `onPaymentSuccess` | function | no | `({ txHash, chain }) => void` |
| `onPaymentError` | function | no | `(error: Error) => void` |

---

## URL API (no npm required)

Every feature is also accessible via direct URL — useful if you're not in a React app or want full control over the trigger.

```
# Fixed amount, Arc-locked
https://hashpaylink.com/pay?e=0xABC...&a=25&n=arc&m=Invoice+042

# Flexible amount
https://hashpaylink.com/pay?e=0xABC...&f=1&n=arc&m=Tip+Jar

# Multi-payer event
https://hashpaylink.com/pay?e=0xABC...&a=10&v=1&id=my-event-2025&n=arc

# Show NGN local currency equivalent
https://hashpaylink.com/pay?e=0xABC...&a=25&n=arc&fx=ngn
```

### URL Parameters

| Param | Description |
|---|---|
| `e` | EVM recipient address |
| `s` | Solana recipient address (base58) |
| `k` | Starknet recipient address |
| `a` | Fixed USDC amount |
| `m` | URL-encoded payment memo |
| `f` | `1` = flexible amount mode |
| `v` | `1` = multi-payer collection mode |
| `id` | Event ID for multi-payer dashboard |
| `n` | Lock to chain: `arc` \| `base` \| `arbitrum` \| etc. |
| `fx` | Show local currency FX: `ngn` \| `ghs` \| `kes` \| `sgd` |
| `xr` | Custom exchange rate (used with `fx`) |

---

## Validation Helpers

```ts
import {
  buildPayLinkUrl,
  isValidEvmAddress,
  isLikelySolanaAddress,
  isValidStarknetAddress,
  SUPPORTED_NETWORKS,
} from '@hashpaylink/sdk'

// Validate before building a link
if (isValidEvmAddress(address)) {
  const url = buildPayLinkUrl({ recipientEVM: address, amount: '10' })
}
```

---

## What You Can and Can't Control

| ✅ You own this | ❌ Always on HashKey's side |
|---|---|
| The button/trigger UI | Wallet connection |
| Wrapper layout & styling | Transaction signing |
| Amount input & memo fields | Payment confirmation screen |
| `onPaymentSuccess` callback | Relayer / gas logic |
| URL construction logic | |
