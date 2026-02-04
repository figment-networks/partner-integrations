# Proprietary Custody Staking Recipes

Staking examples using self-custody (hot wallet signing). Use these as a starting point if you have your own custody solution - replace the signing logic with your infrastructure.

## Supported Protocols

| Protocol | File | Network | Action |
|----------|------|---------|--------|
| Ethereum | `protocols/ethereum.ts` | Hoodi (testnet) | Create validator |
| Solana | `protocols/solana.js` | Devnet | Stake to validator |

## Setup

1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

2. Fill in your credentials in `.env`:
   - `FIGMENT_API_KEY` - Your Figment API key
   - `SOLANA_PRIVATE_KEY` - Your Solana private key (base58 encoded)
   - `ETHEREUM_PRIVATE_KEY` - Your Ethereum private key (hex)

3. Install dependencies:
   ```bash
   npm install
   ```

4. Run a protocol:
   ```bash
   node protocols/solana.js
   # or for TypeScript:
   npx ts-node protocols/ethereum.ts
   ```

## Configuration

Each protocol file has a configuration section at the top that you should review before running:

```js
/* ============ CONFIGURE THESE ============ */
const NETWORK = 'devnet';
const STAKE_AMOUNT = 0.01;
const VALIDATOR_ADDRESS = '...';
/* ========================================= */
```

## Integrating Your Own Signing

The `sign()` function in each file handles transaction signing. Replace this with your custody solution:

```js
// Current implementation (hot wallet)
function sign(unsignedTx, wallet) {
  const transaction = Transaction.from(Buffer.from(unsignedTx, 'hex'));
  transaction.partialSign(wallet);
  return transaction;
}

// Your implementation
function sign(unsignedTx, yourSigningClient) {
  // Call your custody API here
}
```
