require('dotenv').config({ path: __dirname + '/.env' });
const axios = require('axios');
const bs58 = require('bs58');
const path = require('path');
const { 
  Keypair, 
  PublicKey,
  Transaction
} = require('@solana/web3.js');

const protocol = path.basename(__filename, '.js').toUpperCase();
const privateKey = process.env.SOL_PRIVATE_KEY;

/* Configuration */
const NETWORK = 'devnet';
const EXPLORER_BASE_URL = process.env[`${protocol}_EXPLORER_URL`];
const FIGMENT_API_URL = 'https://api.figment.io/solana';
const STAKE_AMOUNT = 0.01;
const VALIDATOR_VOTE_ACCOUNT = '21Jxcw74j5SvajRKE3PvNifu26CVorF7DF8HyanKNzZ3';
const API_HEADERS = {
  'x-api-key': process.env.API_KEY
};

/**
 * Create the stake transaction using Figment API
 * @param {object} wallet - The funding wallet
 * @param {PublicKey} validatorVoteAccount - Figment's validator address
 * @returns {Promise<string>} - The unsigned transaction serialized in hex
 */
async function createStakeTransaction(wallet, validatorVoteAccount) {
  try {
    const response = await axios.post(`${FIGMENT_API_URL}/stake`, {
      funding_account: wallet.publicKey.toString(),
      vote_account: validatorVoteAccount.toString(),
      amount_sol: STAKE_AMOUNT,
      network: NETWORK
    }, { headers: API_HEADERS });

    return response.data.data.unsigned_transaction_serialized;
  } catch (error) {
    console.error('Error creating stake transaction:', error.message);
    throw error;
  }
}

/**
 * Sign the transaction with the wallet
 * @param {string} unsignedTx - The unsigned transaction hex
 * @param {object} wallet - The wallet keypair
 * @returns {Transaction} - The signed transaction
 */
function sign(unsignedTx, wallet) {
  try {
    const transaction = Transaction.from(Buffer.from(unsignedTx, 'hex'));
    transaction.partialSign(wallet);
    return transaction;
  } catch (error) {
    console.error('Error signing transaction:', error.message);
    throw error;
  }
}

/**
 * Broadcast the signed transaction to the network
 * @param {Transaction} signedTx - The signed transaction
 * @returns {Promise<string>} - The transaction hash
 */
async function broadcastStakeTransaction(signedTx) {
  try {
    const response = await axios.post(`${FIGMENT_API_URL}/broadcast`, {
      transaction_payload: signedTx.serialize().toString('hex'),
      network: NETWORK
    }, { headers: API_HEADERS });

    return response.data.transaction_hash;
  } catch (error) {
    console.error('Error broadcasting transaction:', error.message);
    throw error;
  }
}

/**
 * Main function to execute the e2e staking flow
 */
async function main() {
  try {
    // Initialize wallet and validator
    const privateKeyBytes = bs58.decode(privateKey);
    const wallet = Keypair.fromSecretKey(privateKeyBytes);
    const validatorVoteAccount = new PublicKey(VALIDATOR_VOTE_ACCOUNT);

    // Create the unsigned transaction
    const unsignedTx = await createStakeTransaction(wallet, validatorVoteAccount);
    
    // Sign the transaction with the wallet
    const signedTx = sign(unsignedTx, wallet);
    
    // Broadcast the transaction
    const txHash = await broadcastStakeTransaction(signedTx);

    const explorerUrl = `${EXPLORER_BASE_URL}${txHash}${NETWORK === 'devnet' ? '?cluster=devnet' : ''}`;
    console.log(`Staked ${STAKE_AMOUNT} SOL to ${VALIDATOR_VOTE_ACCOUNT} successfully!`);
    console.log('View transaction on explorer:', explorerUrl);
  } catch (error) {
    console.error('Error:', error);
  }
}

main();
