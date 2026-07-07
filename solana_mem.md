> ## Documentation Index
> Fetch the complete documentation index at: https://developers.circle.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Circle Wallets on Solana

> Overview for developers

## Solana-specific features

* **Account type upon wallet creation**: In Solana, you can only specify the
  Externally Owned Account (EOA) type when creating a wallet. The Smart Contract
  Account (SCA) account type is specifically for ERC-4337 (account abstraction)
  implementation and is not supported in Solana.

* **Transaction acceleration/cancellation**: Solana allows you to specify a
  higher priority fee to attempt to accelerate a transaction. However, you
  cannot replace an existing transaction with a higher transaction fee, which
  means the existing API for accelerating or cancelling transactions is not
  supported in Solana.

* **Signing message and typed data**: Solana only supports signing messages and
  does not support signing typed data.

* **Associated Token Account (ATA)**: When transferring SPLs in Solana, an ATA
  is automatically created for the recipient, which ensures that they can
  receive tokens. Since extra network fees are associated with the first
  transaction of a token, you must have enough fees available in your
  originating wallet.

  <Warning>
    **Arbitrary token accounts are not supported**. Circle Wallets on Solana only
    support Associated Token Accounts (ATAs). Transactions involving non-ATA
    accounts are not parsed, and tokens sent to such accounts may be permanently
    lost and cannot be recovered.
  </Warning>

* **Gas Station**: Gas Station is a feature of Wallets that lets developers
  sponsor network fees on behalf of their end users. Solana natively supports
  the Gas Station feature with `feePayer`, while EVM chains require using SCAs
  to utilize the gas station feature. We've integrated this Solana support into
  our Gas Station so that you can sponsor transaction fees for EOA wallets on
  Solana.

* **Gas specification**: The gas fee mechanism on Solana is similar to EIP-1559:
  you can specify a priority fee to incentivize validators to include your
  transaction in a block. Note that on Solana there is no concept of a “max fee”
  and `gasLimit` is optional. Solana defaults to a gas limit of 200,000
  micro-lamport (10^-15 SOL).

## Migrate from EVM chains to Solana

To transition from EVM chains to Solana, set the `blockchains` parameter value
to `SOL` on mainnet, or `SOL-DEVNET` on testnet.

When creating wallets for end-users, follow these steps to allow them to
transfer assets:

## Step 1. Create Solana wallets

For
[developer-controlled wallets](/api-reference/wallets/developer-controlled-wallets/create-wallet),
use existing wallet sets to generate Solana wallets and change the following
body params:

* **accountType**: Set to `EOA`
* **blockchains**: Set to `SOL` or `SOL-DEVNET`
* **walletSetId**: Set to the existing wallet set ID

For
[user-controlled wallets](/api-reference/wallets/user-controlled-wallets/create-user-wallet),
use the same `X-User-Token` header parameter for the same end-user. If it
expires,
[create a new user token](/api-reference/wallets/user-controlled-wallets/get-user-token).
Change the following body parameters:

* **accountType**: Set to `EOA`
* **blockchains**: Set to `SOL` or `SOL-DEVNET`

Next, for both wallets, specify the wallet metadata associated with an end-user
during or after wallet creation:

* **name**: Set to the wallet name, for example: `User Wallet1`
* **refId**: Set to the unique identifier of the reference, for example: `UUID1`

## Step 2. Request test token

To fund Solana
[testnet](/api-reference/wallets/programmable-wallets/request-testnet-tokens)
wallets, update the following body params:

* **blockchain**: `SOL-DEVNET`
* **address**: Set to the newly created Solana wallet address

## Step 3. Set up the Gas Station policy for Solana

Set up the [Gas Station policy](/wallets/gas-station/policy-management) for
Solana in mainnet. Testnet environments come with pre-set default policies.

## Step 4. Execute transactions

Specify the transaction detail in the following API endpoints:

* [`POST` `/transactions/transfer`](/api-reference/wallets/developer-controlled-wallets/create-developer-transaction-transfer)
* [`POST` `/transactions/transfer/estimateFee`](/api-reference/wallets/developer-controlled-wallets/create-transfer-estimate-fee)

<Warning>
  Ensure the `blockchains` body parameter is set to `SOL` or `SOL-DEVNET`
</Warning>

<Note>
  The response to a `POST` request to the `/transactions/transfer/estimateFee`
  endpoint is the same for each fee level (`high`, `medium`, `low`).
</Note>


how does solana integration work...do I need to create a different wallet for it and how would I sign transactions...does it need gas??

Read 1 file

Found results for Solana wallet integration sign transactions
Here's a summary for Solana integration:

Wallet Creation
Yes, you need a Solana-specific wallet. Create one with blockchains: ["SOL-DEVNET"] (or SOL for mainnet) and accountType: "EOA" — only EOA wallets are supported on Solana (no SCA/account abstraction).

Signing Transactions
You build the transaction using @solana/web3.js, serialize it as base64, then call client.signTransaction({ walletId, rawTransaction }). Circle signs it and returns a signedTransaction you broadcast yourself via your own RPC/node provider.

Gas (Fees)
Solana doesn't use "gas" like EVM — it uses fees in SOL (lamports). You must fund your wallet with devnet SOL before broadcasting. You can optionally set a priority fee. Circle's Gas Station also supports Solana via feePayer, so you can sponsor fees for users. Note: there's no gasLimit requirement (defaults to 200,000 micro-lamports), and no concept of a "max fee."

See Sign transactions and Wallets on Solana for full details.

Sign transactions
Wallets on Solana



can I interact with smart contract on solana...my dev tells me that I need to build the transactions myself so that circle will sign

Searched for 2 patterns
Your dev is correct. Circle's signing API works exactly this way for Solana:

You build the transaction yourself using @solana/web3.js — including any Solana program (smart contract) instructions via TransactionInstruction or program-specific SDKs.
Serialize it to base64 and pass it as rawTransaction to Circle's sign API.
Circle signs it, returns the signed transaction, and you broadcast it via your own RPC connection.
So yes, you can interact with any Solana program/smart contract — just add the relevant instructions to your Transaction object before serializing. Circle is purely the signer; it doesn't restrict what instructions are in the transaction.

so does gateway support solana, if yes, can I interacts with smart contracts using usdc from gateway?? if yes, what is the gas if I do so?? sol or usdc

Searched for 3 patterns

Found results for Solana gateway support smart contracts USDC gas fees
Yes, Gateway supports Solana. Here's a summary:

Solana support: Yes, Solana is a supported blockchain on Gateway.
Smart contract interactions with USDC: Solana does not use EVM-style smart contracts. Gateway on Solana supports USDC transfers (deposits/burns), but Solana-specific limitations apply — for example, only EOA wallet types are supported, not Smart Contract Accounts (SCAs).
Gas fee on Solana: Gas fees are paid in USDC (not SOL). The Gateway gas fee for Solana is $0.15 USDC per burn intent.
See Gateway fees for the full fee breakdown.

Gateway fees
Solana-specific features
Unified Balance Solana Quickstart



so if I have a unified balance and I want to interact with a predmarket on solana, how do I do so, what do I use for the fees, give me the details
Let me look into this for you.


Searched for 9 patterns

Found results for unified balance interact smart contract Solana program
Here's the full picture for interacting with a prediction market on Solana using a unified balance:

How it works (high level):

Deposit USDC from any supported chain into the Gateway Wallet to build your unified balance.
Create a burn intent — sign a transfer spec specifying Solana as the destination, the prediction market program as the recipient (or your wallet), and optionally use hookData for onchain composition with other programs.
Submit to the Gateway API (/v1/transfer) to get an attestation.
Call gatewayMint on the Solana Gateway Minter program to receive USDC on Solana, then interact with the prediction market program from there.
Fees (all in USDC, not SOL):

Gas fee: $0.15 USDC (Solana burn)
Transfer fee: 0.005% of the transfer amount (crosschain only)
Forwarding fee: $0.20 + ~$0.15 gas if you use the Circle Forwarding Service to handle the mint automatically
Note: Solana transaction fees (lamports/SOL) are still needed in your wallet to submit Solana transactions, but Gateway's own fees are all denominated in USDC.

Gateway fees
Unified Balance Solana Quickstart