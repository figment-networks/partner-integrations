require('dotenv').config({ path: __dirname + '/.env' });
const axios = require('axios');
const path = require('path');

const protocol = path.basename(__filename, '.js').toUpperCase();
const secretKey = process.env.FIREBLOCKS_SECRET_KEY;
const apiKey = process.env.FIREBLOCKS_API_KEY;

const { FireblocksSDK, TransactionStatus, PeerType } = require("fireblocks-sdk");
const fireblocks = new FireblocksSDK(secretKey, apiKey);

/* Configuration */
const EXPLORER_BASE_URL = process.env[`${protocol}_EXPLORER_URL`];
const NETWORK = 'devnet';
const FIGMENT_API_URL = 'https://api.figment.io/solana';
const VAULT_ACCOUNT_ID = 1;
const STAKE_AMOUNT = 0.01;
const VALIDATOR_VOTE_ACCOUNT = '21Jxcw74j5SvajRKE3PvNifu26CVorF7DF8HyanKNzZ3';
const FIREBLOCKS_ASSET_ID = "SOL_TEST";
const API_HEADERS = {
  'x-api-key': process.env.FIGMENT_API_KEY
};

/**
 * Create the stake transaction using Figment API
 * @param {string} walletAddress - The funding wallet address
 * @param {string} validatorVoteAccount - Figment's validator address
 * @returns {Promise<string>} - The unsigned transaction serialized in hex
 */
async function createStakeTransaction(walletAddress, validatorVoteAccount) {
    const response = await axios.post(`${FIGMENT_API_URL}/stake`, {
        funding_account: walletAddress,
        vote_account: validatorVoteAccount,
        amount_sol: STAKE_AMOUNT,
        network: NETWORK
    }, { headers: API_HEADERS });

    // return response.data.data.unsigned_transaction_serialized;
    return response.data.data.unsigned_tx_serialized_base64;
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
 * Sign and broadcast the transaction with Fireblocks SDK
 * @param {string} base64EncodedTransaction - The base64 encoded transaction
 * @returns {Promise<Transaction>} - The signed transaction
 */
async function signWithFireblocks(base64EncodedTransaction) {
    const note = `Stake ${STAKE_AMOUNT} SOL to ${VALIDATOR_VOTE_ACCOUNT} on ${NETWORK}`;
    
    const fbTx = await fireblocks.createTransaction({
        assetId: FIREBLOCKS_ASSET_ID,
        operation: 'PROGRAM_CALL',
        source: {
            type: PeerType.VAULT_ACCOUNT,
            id: String(VAULT_ACCOUNT_ID)
        },
        note,
        extraParameters: {
            programCallData: base64EncodedTransaction
        }
    });

    return (await waitForTxCompletion(fbTx));
}

/**
 * Main function to execute the e2e staking flow
 */
async function main() {
    try {
        // Get the Fireblocks wallet address
        const walletInfo = await fireblocks.getDepositAddresses(VAULT_ACCOUNT_ID, FIREBLOCKS_ASSET_ID);
        const walletAddress = walletInfo[0].address;

        // Create the unsigned transaction
        const unsignedTranasctionSerializedBase64 = await createStakeTransaction(walletAddress, VALIDATOR_VOTE_ACCOUNT);

        // Sign the transaction with Fireblocks
        const signedTx = await signWithFireblocks(unsignedTranasctionSerializedBase64);
        let txHash = signedTx.txHash;

        const explorerUrl = `${EXPLORER_BASE_URL}/tx/${txHash}${NETWORK === 'devnet' ? '?cluster=devnet' : ''}`;
        console.log(`Staked ${STAKE_AMOUNT} SOL to ${VALIDATOR_VOTE_ACCOUNT} successfully!`);
        console.log('View transaction on explorer:', explorerUrl);
    } catch (error) {
        console.log(error);
        console.error('Error:', error.message);
    }
}

main();

