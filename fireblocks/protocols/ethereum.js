require('dotenv').config({ path: __dirname + '/../.env' });
const axios = require('axios');
const path = require('path');
const { FireblocksSDK, TransactionOperation, TransactionStatus, PeerType } = require('fireblocks-sdk');

const protocol = path.basename(__filename, '.js').toUpperCase();
const secretKey = process.env.FIREBLOCKS_SECRET_KEY;
const apiKey = process.env.FIREBLOCKS_API_KEY;

const fireblocksApiClient = new FireblocksSDK(secretKey, apiKey);

/* Configuration */
const EXPLORER_BASE_URL = process.env[`${protocol}_EXPLORER_URL`];
const NETWORK = 'hoodi';
const FIGMENT_API_URL = 'https://api.figment.io/ethereum';
const VAULT_ACCOUNT_ID = "1";
const FIREBLOCKS_ASSET_ID='ETH_TEST_HOODI';
const VALIDATORS_COUNT = 1;
const CONTRACT_ADDRESS = '0xA627f94a8F94E4713d38F52aC3a6377B0a111d47';
const API_HEADERS = {
  'accept': 'application/json',
  'content-type': 'application/json',
  'x-api-key': process.env.FIGMENT_API_KEY
};

/**
 * Create validator transactions using Figment API
 * @returns {Promise<string>} - The contract call data for validators creation
 */
async function createValidators() {
  const withdrawalAddress = (await fireblocksApiClient.getDepositAddresses(VAULT_ACCOUNT_ID, FIREBLOCKS_ASSET_ID))[0].address;
  try {
    const response = await axios.post(`${FIGMENT_API_URL}/validators`, {
      network: NETWORK,
      validators_count: VALIDATORS_COUNT,
      withdrawal_address: withdrawalAddress,
    }, {
      headers: API_HEADERS
    });

    return response.data.meta.staking_transaction.contract_call_data;
  } catch (error) {
    console.error('Error creating validators:', error);
    throw error;
  }
}

/**
 * Sign with Fireblocks SDK
 * @param {string} contractAddress - The contract address
 * @param {string} contractCallData - The contract call data
 * @returns {Promise<Transaction>} - The Fireblocks transaction
 */
async function signWithFireblocks(contractAddress, contractCallData) {
  try {
    console.log("Submitting contract call data to Fireblocks...");
    
    const transaction = await fireblocksApiClient.createTransaction({
      operation: TransactionOperation.CONTRACT_CALL,
      assetId: FIREBLOCKS_ASSET_ID,
      source: {
        type: PeerType.VAULT_ACCOUNT,
        id: VAULT_ACCOUNT_ID
      },
      destination: {
        type: PeerType.ONE_TIME_ADDRESS,
        oneTimeAddress: {
          address: contractAddress
        }
      },
      note: `Create ${VALIDATORS_COUNT} validator(s) on ${NETWORK}`,
      amount: "32",
      extraParameters: {
        contractCallData
      }
    });
    
    console.log(`✔ Submitted to Fireblocks for approval & signature. ID: ${transaction.id}`);
    return transaction;
  } catch (error) {
    console.error(`Fireblocks API Error: ${error.message}`);
    throw error;
  }
}

/**
 * Wait for the transaction to complete by polling Fireblocks
 * @param {Transaction} fbTx - The Fireblocks transaction
 * @returns {Promise<Transaction>} - The completed transaction
 */
async function waitForTxCompletion(fbTx) {
  let tx = fbTx;

  while (tx.status !== TransactionStatus.COMPLETED) {
    if ([TransactionStatus.BLOCKED, TransactionStatus.FAILED, TransactionStatus.REJECTED, TransactionStatus.CANCELLED].includes(tx.status)) {
      console.log("Transaction's status: " + tx.status);
      throw new Error("Exiting the operation due to error");
    }
    
    console.log("Transaction's status:", (await fireblocksApiClient.getTransactionById(fbTx.id)).status);
    await new Promise(resolve => setTimeout(resolve, 4000));
    
    tx = await fireblocksApiClient.getTransactionById(fbTx.id);
  }
  
  return (await fireblocksApiClient.getTransactionById(fbTx.id));
}

/**
 * Main function to execute the e2e validator creation flow
 */
async function main() {
  try {
    // Create the contract call data
    const contractCallData = await createValidators();
    
    // Sign the transaction with Fireblocks
    const fbTx = await signWithFireblocks(CONTRACT_ADDRESS, contractCallData);
    
    // Wait for the transaction to complete
    const completedTx = await waitForTxCompletion(fbTx);
    
    const explorerUrl = `${EXPLORER_BASE_URL}/tx/${completedTx.txHash}`;
    console.log(`Created ${VALIDATORS_COUNT} validator(s) successfully!`);
    console.log('View transaction on explorer:', explorerUrl);
  } catch (error) {
    console.error('Error:', error.message);
  }
}

main();