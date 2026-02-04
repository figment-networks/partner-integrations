# DFNS Ethereum Validator Setup

This directory contains scripts for creating Ethereum validators using DFNS wallets and the Figment API.

## Environment Variables

Create a `.env` file in this directory with the following variables:

```
# DFNS API Credentials
DFNS_CRED_ID=your-credential-id
DFNS_PRIVATE_KEY=your-private-key
DFNS_APP_ID=your-application-id
DFNS_AUTH_TOKEN=your-auth-token
DFNS_API_URL=https://api.dfns.io  # or your specific DFNS API URL

# DFNS Wallet
FUNDING_WALLET_ID=your-wallet-id  # ID of the wallet to fund validators from

# Figment API
FIGMENT_API_KEY=your-figment-api-key
```

## Dependencies

Install the required dependencies:

```bash
npm install ethers@6 @dfns/sdk @dfns/lib-ethersjs6 @dfns/sdk-keysigner dotenv axios
```

## Usage

Run the script to create validators:

```bash
node ethereum.js
```

This will:
1. Initialize your DFNS wallet
2. Create validator transactions using the Figment API
3. Sign the transaction with your DFNS wallet
4. Broadcast the transaction
5. Display the transaction link to view on Etherscan 