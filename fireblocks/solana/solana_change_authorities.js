require('dotenv').config({ path: __dirname + '/../.env' });
const {
  Connection,
  PublicKey,
  Transaction,
  StakeProgram,
  StakeAuthorizationLayout,
} = require('@solana/web3.js');
const { FireblocksSDK, TransactionStatus, TransactionOperation, PeerType } = require('fireblocks-sdk');

// Fireblocks Configuration
const secretKey = process.env.FIREBLOCKS_SECRET_KEY;
const apiKey = process.env.FIREBLOCKS_API_KEY;
const fireblocks = new FireblocksSDK(secretKey, apiKey);

// Solana Configuration
const NETWORK = 'mainnet-beta'; // Change to 'devnet' for testing
const RPC_URL = NETWORK === 'mainnet-beta' 
  ? 'https://api.mainnet-beta.solana.com' 
  : 'https://api.devnet.solana.com';
const EXPLORER_BASE_URL = 'https://explorer.solana.com';
const FIREBLOCKS_ASSET_ID = NETWORK === 'mainnet-beta' ? 'SOL' : 'SOL_TEST';

// Authority Change Configuration
const STAKE_ACCOUNT = '5h54WWdXpbqNBSWHJDMjurPcwctY4w52ZTXHUtAALx5j';
const CURRENT_AUTHORITY = 'BKBS1s6k6PttR6iSfptmXuP3C4E5u7vL6PtmmEvbBHED';
const NEW_AUTHORITY = '9TzihSD4qyUAjwBVXvhGvFAnanazMnnu5McQFoMLM9ga';
const CURRENT_AUTHORITY_VAULT_ID = '2';

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
 * Create the authority change transaction
 * @param {Connection} connection - Solana connection
 * @returns {Promise<Transaction>} - The unsigned transaction
 */
async function createAuthorityChangeTransaction(connection) {
  const stakeAccountPubkey = new PublicKey(STAKE_ACCOUNT);
  const currentAuthorityPubkey = new PublicKey(CURRENT_AUTHORITY);
  const newAuthorityPubkey = new PublicKey(NEW_AUTHORITY);

  // Get recent blockhash
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');

  // Create instruction to change stake authority
  const authorizeStakeIx = StakeProgram.authorize({
    stakePubkey: stakeAccountPubkey,
    authorizedPubkey: currentAuthorityPubkey,
    newAuthorizedPubkey: newAuthorityPubkey,
    stakeAuthorizationType: StakeAuthorizationLayout.Staker,
  });

  // Create instruction to change withdraw authority
  const authorizeWithdrawIx = StakeProgram.authorize({
    stakePubkey: stakeAccountPubkey,
    authorizedPubkey: currentAuthorityPubkey,
    newAuthorizedPubkey: newAuthorityPubkey,
    stakeAuthorizationType: StakeAuthorizationLayout.Withdrawer,
  });

  // Build transaction with both instructions
  const transaction = new Transaction();
  transaction.add(authorizeStakeIx);
  transaction.add(authorizeWithdrawIx);
  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;
  transaction.feePayer = currentAuthorityPubkey;

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
      id: CURRENT_AUTHORITY_VAULT_ID
    },
    note: `Change stake and withdraw authorities for stake account ${STAKE_ACCOUNT}`,
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
 * Main function to execute the authority change flow
 */
async function main() {
  try {
    console.log('='.repeat(60));
    console.log('Solana Stake Account Authority Change');
    console.log('='.repeat(60));
    console.log(`Network: ${NETWORK}`);
    console.log(`Stake Account: ${STAKE_ACCOUNT}`);
    console.log(`Current Authority: ${CURRENT_AUTHORITY}`);
    console.log(`New Authority: ${NEW_AUTHORITY}`);
    console.log(`Fireblocks Vault ID: ${CURRENT_AUTHORITY_VAULT_ID}`);
    console.log('='.repeat(60));

    // Initialize Solana connection
    const connection = new Connection(RPC_URL, 'finalized');

    // Step 1: Create the transaction
    console.log('\n[1/3] Creating authority change transaction...');
    const transaction = await createAuthorityChangeTransaction(connection);
    console.log('Transaction created with 2 instructions:');
    console.log('  - Authorize Staker change');
    console.log('  - Authorize Withdrawer change');

    // Step 2: Sign with Fireblocks
    console.log('\n[2/3] Signing with Fireblocks...');
    const signature = await signWithFireblocks(transaction);

    // Add the signature to the transaction
    const currentAuthorityPubkey = new PublicKey(CURRENT_AUTHORITY);
    transaction.addSignature(currentAuthorityPubkey, signature);

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
    console.log('SUCCESS! Authority change completed.');
    console.log('='.repeat(60));
    console.log(`Transaction Signature: ${txSignature}`);
    console.log(`View on Explorer: ${explorerUrl}`);
    console.log('\nNew authorities for stake account:');
    console.log(`  Stake Authority: ${NEW_AUTHORITY}`);
    console.log(`  Withdraw Authority: ${NEW_AUTHORITY}`);

  } catch (error) {
    console.error('\nERROR:', error.message);
    if (error.response?.data) {
      console.error('Response:', JSON.stringify(error.response.data, null, 2));
    }
    process.exit(1);
  }
}

main();
