# Figment Staking Recipes

Stake in _minutes_!

Use this repo to test programmatic staking flows using Figment's API. Each directory contains examples for a different custody solution.

## Custody Options

| Directory | Description | Protocols |
|-----------|-------------|-----------|
| `fireblocks/` | Fireblocks MPC custody | Avalanche, Cardano, Ethereum, Solana, Sui |
| `prop/` | Proprietary/self-custody (hot wallet) | Ethereum, Solana |

## Setup

1. Create a Figment API key using [these instructions](https://docs.figment.io/reference/authentication)
2. `cd` into the directory of the custody solution you'll use
3. `cp .env.example .env` and add your credentials
4. `npm install`
5. Run the protocol you want to test:
   ```bash
   node protocols/solana.js
   ```

## Structure

```
├── fireblocks/
│   ├── .env.example
│   ├── package.json
│   └── protocols/
│       ├── avalanche.js
│       ├── cardano.js
│       ├── ethereum.js
│       ├── solana.js
│       └── sui.js
└── prop/
    ├── .env.example
    ├── package.json
    └── protocols/
        ├── ethereum.ts
        └── solana.js
```

## Resources

- [Figment API Documentation](https://docs.figment.io)
- [Figment API Authentication](https://docs.figment.io/reference/authentication)
