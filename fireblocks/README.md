# Fireblocks Staking Recipes

Staking examples using [Fireblocks](https://www.fireblocks.com/) MPC custody.

## Supported Protocols

| Protocol | File | Network | Action |
|----------|------|---------|--------|
| Avalanche | `protocols/avalanche.js` | Fuji (testnet) | Delegate to validator |
| Cardano | `protocols/cardano.js` | Preprod (testnet) | Delegate to pool |
| Ethereum | `protocols/ethereum.js` | Hoodi (testnet) | Create validator |
| Solana | `protocols/solana.js` | Devnet | Stake to validator |
| Sui | `protocols/sui.js` | Testnet | Stake to validator |

## Setup

1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

2. Fill in your credentials in `.env`:
   - `FIGMENT_API_KEY` - Your Figment API key
   - `FIREBLOCKS_API_KEY` - Your Fireblocks API key
   - `FIREBLOCKS_SECRET_KEY` - Your Fireblocks secret key (the full PEM content)
   - `FIREBLOCKS_VAULT_ID` - Your Fireblocks vault account ID

3. Install dependencies:
   ```bash
   npm install
   ```

4. Run a protocol:
   ```bash
   node protocols/solana.js
   ```

## Configuration

Each protocol file has a configuration section at the top that you should review before running:

```js
/* ============ CONFIGURE THESE ============ */
const NETWORK = 'devnet';
const STAKE_AMOUNT = 0.01;
const VALIDATOR_ADDRESS = '...';
const VAULT_ACCOUNT_ID = 1;
/* ========================================= */
```

Adjust these values based on your testing needs.
