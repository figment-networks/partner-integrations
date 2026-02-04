/************************ WIP ************************/
require('dotenv').config({ path: __dirname + '/.env' });
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');

const protocol = path.basename(__filename, '.js').toUpperCase();
const secretKey = process.env.FIREBLOCKS_SECRET_KEY;
const apiKey = process.env.FIREBLOCKS_API_KEY;

const { FireblocksSDK, TransactionStatus, PeerType } = require("fireblocks-sdk");
const fireblocks = new FireblocksSDK(secretKey, apiKey);

/* Configuration */
const NETWORK = 'testnet';
const EXPLORER_BASE_URL = process.env[`${protocol}_EXPLORER_URL`];
const FIGMENT_API_URL = 'https://api.figment.io/sui';
const VAULT_ACCOUNT_ID = 1;
const STAKE_AMOUNT = 1; // Amount in SUI (will be converted to mist)
const VALIDATOR_ADDRESS = '0xd32da9c87c1164f7c686067067e37cc3bdd8ad3fc7ef62d5f24c5dc908bb5fcb'; // Replace with actual validator address
const FIREBLOCKS_ASSET_ID = "SUI_TEST";
const API_HEADERS = {
  'x-api-key': process.env.FIGMENT_API_KEY
};

/**
 * Create the stake transaction using Figment API
 * @param {string} walletAddress - The funding wallet address
 * @param {string} validatorAddress - The validator address to stake to
 * @returns {Promise<Object>} - The response containing unsigned transaction and signing payload
 */
async function createStakeTransaction(walletAddress, validatorAddress) {
    const response = await axios.post(`${FIGMENT_API_URL}/stake`, {
        delegator_address: walletAddress,
        validator_address: validatorAddress,
        amount: STAKE_AMOUNT,
        network: NETWORK
    }, { headers: API_HEADERS });

    return response.data.data;
}

/**
 * Broadcast a signed transaction using Figment API
 * @param {string} signedTransaction - The signed transaction
 * @returns {Promise<string>} - The transaction hash
 */
async function broadcastTransaction(signedTransaction, unsignedTransactionSerialized) {
  const prefixedSignedTransaction = signedTransaction.startsWith('0x') ? signedTransaction : `0x${signedTransaction}`;
  const prefixedUnsignedTransactionSerialized = unsignedTransactionSerialized.startsWith('0x') ? unsignedTransactionSerialized : `0x${unsignedTransactionSerialized}`;
  console.log('prefixedSignedTransaction', prefixedSignedTransaction);
  console.log('prefixedUnsignedTransactionSerialized', prefixedUnsignedTransactionSerialized);
    const response = await axios.post(`${FIGMENT_API_URL}/broadcast`, {
        signed_transaction: prefixedSignedTransaction,
        unsigned_transaction_serialized: prefixedUnsignedTransactionSerialized,
        network: NETWORK
    }, { headers: API_HEADERS });

    return response.data.transaction_hash;
}

/**
 * Get all stakes for the wallet
 * @param {string} walletAddress - The wallet address
 * @returns {Promise<Array>} - Array of stake objects
 */
async function getStakes(walletAddress) {
    const response = await axios.post(`${FIGMENT_API_URL}/stakes`, {
        delegator_address: walletAddress
    }, { headers: API_HEADERS });

    return response.data.stakes;
}

/**
 * Create withdraw transaction using Figment API
 * @param {string} walletAddress - The delegator address
 * @param {string} stakedSuiId - The staked SUI ID to withdraw
 * @returns {Promise<Object>} - The response containing unsigned transaction and signing payload
 */
async function createWithdrawTransaction(walletAddress, stakedSuiId) {
    const response = await axios.post(`${FIGMENT_API_URL}/withdraw`, {
        delegator_address: walletAddress,
        staked_sui_id: stakedSuiId,
        // gas_budget: "1000000" // Optional: Gas budget in mist
    }, { headers: API_HEADERS });

    return response.data.data;
}

/**
 * Wait for the transaction to complete by polling Fireblocks
 * @param {Transaction} fbTx - The Fireblocks transaction
 * @returns {Promise<Transaction>} - The completed transaction
 */
async function waitForTxCompletion(fbTx) {
  let tx = fbTx;

  while (tx.status != TransactionStatus.COMPLETED) {
      if(tx.status == TransactionStatus.BLOCKED ||
         tx.status == TransactionStatus.FAILED || 
         tx.status == TransactionStatus.REJECTED || 
         tx.status == TransactionStatus.CANCELLED) {
          console.log("Transaction's status: " + tx.status);
          
          throw Error("Exiting the operation due to error");
      }
      console.log("Transaction's status:",(await fireblocks.getTransactionById(fbTx.id)).status);
      setTimeout(() => { }, 4000);
      
      tx = await fireblocks.getTransactionById(fbTx.id);
                  
  }
  
  return (await fireblocks.getTransactionById(fbTx.id));
}

/**
 * Sign transaction with Fireblocks raw signing
 * @param {string} payload - The payload to sign (either signing_payload or sha256 of unsigned_transaction_serialized)
 * @param {string} operation - The operation type (STAKE or WITHDRAW)
 * @returns {Promise<Transaction>} - The signed transaction
 */
async function signWithFireblocks(payload, operation = 'STAKE') {
    const note = operation === 'STAKE' 
        ? `Stake ${STAKE_AMOUNT} SUI to ${VALIDATOR_ADDRESS} on ${NETWORK}`
        : `Withdraw SUI stake on ${NETWORK}`;
    
    const fbTx = await fireblocks.createTransaction({
        assetId: FIREBLOCKS_ASSET_ID,
        operation: 'RAW',
        source: {
            type: PeerType.VAULT_ACCOUNT,
            id: String(VAULT_ACCOUNT_ID)
        },
        note,
        extraParameters: {
            rawMessageData: {
                messages: [{
                    content: payload.startsWith('0x') ? payload.slice(2) : payload
                }]
            }
        }
    });

    return (await waitForTxCompletion(fbTx));
}

/**
 * Process the signing payload from Figment API response
 * @param {Object} responseData - The response data from Figment API
 * @returns {string} - The processed payload for Fireblocks signing
 */
function processSigningPayload(responseData) {
    // If signing_payload is empty, use unsigned_transaction_serialized and sha256 it
    if (!responseData.signing_payload || responseData.signing_payload === '') {
        const hash = crypto.createHash('sha256');
        hash.update(responseData.unsigned_transaction_serialized);
        return hash.digest('hex');
    }
    
    return responseData.signing_payload;
}

/**
 * Main function to execute the e2e staking flow
 */
async function main() {
    try {
        // Get the Fireblocks wallet address
        const walletInfo = await fireblocks.getDepositAddresses(VAULT_ACCOUNT_ID, FIREBLOCKS_ASSET_ID);
        const walletAddress = walletInfo[0].address;
        console.log(`Using wallet address: ${walletAddress}`);

        // Step 1: Create the stake transaction
        console.log('Creating stake transaction...');
        const stakeResponse = await createStakeTransaction(walletAddress, VALIDATOR_ADDRESS);
        const unsignedTransactionSerialized = stakeResponse.unsigned_transaction_serialized;
        console.log('Stake response: ', stakeResponse);
        
        // Step 2: Process the signing payload
        const signingPayload = processSigningPayload(stakeResponse);
        console.log('Signing payload processed: ', signingPayload);

        // Step 3: Sign the transaction with Fireblocks
        console.log('Signing transaction with Fireblocks...');
        const signedTx = await signWithFireblocks(unsignedTransactionSerialized, 'STAKE');
        const signature = signedTx.signedMessages[0].signature.fullSig;
        console.log('Transaction signed successfully: ', signature);
  

        // Step 4: Broadcast the signed transaction
        console.log('Broadcasting transaction...');
        const txHash = await broadcastTransaction(signature, unsignedTransactionSerialized);

        const explorerUrl = `${EXPLORER_BASE_URL}${txHash}${NETWORK === 'testnet' ? '?network=testnet' : ''}`;
        console.log(`Staked ${STAKE_AMOUNT} SUI to ${VALIDATOR_ADDRESS} successfully!`);
        console.log('View transaction on explorer:', explorerUrl);

        // Step 5: Get stakes to verify
        console.log('Fetching stakes...');
        const stakes = await getStakes(walletAddress);
        console.log(`Found ${stakes.length} stakes`);
        console.log('Stakes: ', stakes);

         // // Step 6: Demonstrate withdraw (if we have stakes)
         // if (stakes.length > 0) {
         //     console.log('Demonstrating withdraw flow...');
         //     const firstStake = stakes[0];
         //     console.log(`Withdrawing stake with ID: ${firstStake.staked_sui_id}`);
             
         //     // Create withdraw transaction
         //     const withdrawResponse = await createWithdrawTransaction(walletAddress, firstStake.staked_sui_id);
             
         //     // Process signing payload for withdraw
         //     const withdrawSigningPayload = processSigningPayload(withdrawResponse);
             
         //     // Sign withdraw transaction
         //     const signedWithdrawTx = await signWithFireblocks(withdrawSigningPayload, 'WITHDRAW');
             
         //     // Broadcast withdraw transaction
         //     const withdrawTxHash = await broadcastTransaction(signedWithdrawTx.signedMessage);
             
         //     const withdrawExplorerUrl = `${EXPLORER_BASE_URL}${withdrawTxHash}${NETWORK === 'testnet' ? '?network=testnet' : ''}`;
         //     console.log('Withdraw transaction successful!');
         //     console.log('View withdraw transaction on explorer:', withdrawExplorerUrl);
         // }

    } catch (error) {
        console.log(error);
        console.error('Error:', error.message);
    }
}

main();
