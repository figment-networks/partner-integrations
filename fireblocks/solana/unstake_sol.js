require('dotenv').config({ path: __dirname + '/../.env' });
const {
  Connection,
  PublicKey,
  Transaction,
  StakeProgram,
} = require('@solana/web3.js');
const { FireblocksSDK, TransactionStatus, TransactionOperation, PeerType } = require('fireblocks-sdk');

// Fireblocks Configuration
const secretKey = process.env.FIREBLOCKS_SECRET_KEY;
const apiKey = process.env.FIREBLOCKS_API_KEY;
const fireblocks = new FireblocksSDK(secretKey, apiKey);

// Solana Configuration
const NETWORK = 'devnet'; // Change to 'mainnet-beta' for production
const RPC_URL = NETWORK === 'mainnet-beta' 
  ? 'https://api.mainnet-beta.solana.com' 
  : 'https://api.devnet.solana.com';
const EXPLORER_BASE_URL = 'https://explorer.solana.com';
const FIREBLOCKS_ASSET_ID = NETWORK === 'mainnet-beta' ? 'SOL' : 'SOL_TEST';

// Deactivate Stake Configuration
const STAKE_ACCOUNT = 'A86TfdAm9DAyaYhPdvJtJWSV7jakZBcgztgFhMRYZiVj';
const VAULT_ACCOUNT_ID = '8';

/**
 * Wait for the Fireblocks transaction to complete
 * @param {object} fbTx - The Fireblocks transaction
 * @returns {Promise<object>} - The completed transaction
 */
async function waitForTxCompletion(fbTx) {
  const errorStatuses = [
    TransactionStatus.BLOCKED,
    TransactionStatus.FAILED,
    TransactionStatus.REJECTED,
    TransactionStatus.CANCELLED
  ];

  let tx = fbTx;
  while (tx.status !== TransactionStatus.COMPLETED) {
    if (errorStatuses.includes(tx.status)) {
      console.log("Transaction status:", tx.status);
      throw new Error(`Transaction failed with status: ${tx.status}`);
    }
    console.log("Transaction status:", tx.status);
    await new Promise(resolve => setTimeout(resolve, 4000));
    tx = await fireblocks.getTransactionById(fbTx.id);
  }
  return await fireblocks.getTransactionById(fbTx.id);
}

/**
 * Get the wallet address from Fireblocks vault
 * @returns {Promise<string>} - The wallet address
 */
async function getVaultAddress() {
  const walletInfo = await fireblocks.getDepositAddresses(VAULT_ACCOUNT_ID, FIREBLOCKS_ASSET_ID);
  return walletInfo[0].address;
}

/**
 * Create the deactivate stake transaction
 * @param {Connection} connection - Solana connection
 * @param {string} authorityAddress - The stake authority address
 * @returns {Promise<Transaction>} - The unsigned transaction
 */
async function createDeactivateTransaction(connection, authorityAddress) {
  const stakeAccountPubkey = new PublicKey(STAKE_ACCOUNT);
  const authorityPubkey = new PublicKey(authorityAddress);

  // Get recent blockhash
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');

  // Create instruction to deactivate stake
  const deactivateIx = StakeProgram.deactivate({
    stakePubkey: stakeAccountPubkey,
    authorizedPubkey: authorityPubkey,
  });

  // Build transaction
  const transaction = new Transaction();
  transaction.add(deactivateIx);
  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;
  transaction.feePayer = authorityPubkey;

  return transaction;
}

/**
 * Sign the transaction using Fireblocks RAW signing
 * @param {Transaction} transaction - The transaction to sign
 * @returns {Promise<Buffer>} - The signature
 */
async function signWithFireblocks(transaction) {
  // Serialize the transaction message for signing
  const message = transaction.serializeMessage();
  const messageHex = message.toString('hex');

  console.log('Submitting raw message to Fireblocks for signing...');
  console.log('Message to sign (hex):', messageHex);

  const fbTx = await fireblocks.createTransaction({
    assetId: FIREBLOCKS_ASSET_ID,
    operation: TransactionOperation.RAW,
    source: {
      type: PeerType.VAULT_ACCOUNT,
      id: VAULT_ACCOUNT_ID
    },
    note: `Deactivate stake account ${STAKE_ACCOUNT}`,
    extraParameters: {
      rawMessageData: {
        messages: [{
          content: messageHex
        }]
      }
    }
  });

  console.log(`Fireblocks transaction created. ID: ${fbTx.id}`);
  
  const completedTx = await waitForTxCompletion(fbTx);
  
  if (!completedTx.signedMessages || completedTx.signedMessages.length === 0) {
    throw new Error('No signed messages received from Fireblocks');
  }

  // Get the signature from Fireblocks response
  const signedMessage = completedTx.signedMessages[0];
  const fullSig = signedMessage.signature.fullSig;
  
  console.log('Signature received from Fireblocks:', fullSig);
  
  return Buffer.from(fullSig, 'hex');
}

/**
 * Broadcast the signed transaction to the Solana network
 * @param {Connection} connection - Solana connection
 * @param {Transaction} transaction - The signed transaction
 * @returns {Promise<string>} - The transaction signature
 */
async function broadcastTransaction(connection, transaction) {
  const rawTransaction = transaction.serialize();
  
  console.log('Broadcasting transaction...');
  
  const signature = await connection.sendRawTransaction(rawTransaction, {
    skipPreflight: false,
    preflightCommitment: 'finalized'
  });

  console.log('Transaction sent. Waiting for confirmation...');
  
  // Wait for confirmation
  const confirmation = await connection.confirmTransaction({
    signature,
    blockhash: transaction.recentBlockhash,
    lastValidBlockHeight: transaction.lastValidBlockHeight,
  }, 'finalized');

  if (confirmation.value.err) {
    throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }

  return signature;
}

/**
 * Main function to execute the deactivate stake flow
 */
async function main() {
  try {
    console.log('='.repeat(60));
    console.log('Solana Stake Account Deactivation');
    console.log('='.repeat(60));
    console.log(`Network: ${NETWORK}`);
    console.log(`Stake Account: ${STAKE_ACCOUNT}`);
    console.log(`Fireblocks Vault ID: ${VAULT_ACCOUNT_ID}`);
    console.log('='.repeat(60));

    // Initialize Solana connection
    const connection = new Connection(RPC_URL, 'finalized');

    // Get the authority address from Fireblocks vault
    console.log('\nFetching vault address from Fireblocks...');
    const authorityAddress = await getVaultAddress();
    console.log(`Authority Address: ${authorityAddress}`);

    // Step 1: Create the transaction
    console.log('\n[1/3] Creating deactivate stake transaction...');
    const transaction = await createDeactivateTransaction(connection, authorityAddress);
    console.log('Transaction created with deactivate instruction');

    // Step 2: Sign with Fireblocks
    console.log('\n[2/3] Signing with Fireblocks...');
    const signature = await signWithFireblocks(transaction);

    // Add the signature to the transaction
    const authorityPubkey = new PublicKey(authorityAddress);
    transaction.addSignature(authorityPubkey, signature);

    // Verify the transaction is properly signed
    if (!transaction.verifySignatures()) {
      throw new Error('Transaction signature verification failed');
    }
    console.log('Signature verified successfully');

    // Step 3: Broadcast the transaction
    console.log('\n[3/3] Broadcasting transaction...');
    const txSignature = await broadcastTransaction(connection, transaction);

    // Success
    const clusterParam = NETWORK === 'devnet' ? '?cluster=devnet' : '';
    const explorerUrl = `${EXPLORER_BASE_URL}/tx/${txSignature}${clusterParam}`;
    
    console.log('\n' + '='.repeat(60));
    console.log('SUCCESS! Stake account deactivated.');
    console.log('='.repeat(60));
    console.log(`Transaction Signature: ${txSignature}`);
    console.log(`View on Explorer: ${explorerUrl}`);
    console.log('\nNote: After deactivation, you must wait for the stake to cool down');
    console.log('(typically until the end of the current epoch) before withdrawing.');

  } catch (error) {
    console.error('\nERROR:', error.message);
    if (error.response?.data) {
      console.error('Response:', JSON.stringify(error.response.data, null, 2));
    }
    process.exit(1);
  }
}

main();
