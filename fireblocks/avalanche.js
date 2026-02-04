require('dotenv').config({ path: __dirname + '/.env' });
const path = require('path');
const { FireblocksSDK, TransactionStatus, PeerType, TransactionOperation, } = require('fireblocks-sdk');
const axios = require('axios');
const avalanche = require('@avalabs/avalanchejs');
const crypto = require('crypto');

const protocol = path.basename(__filename, '.js').toUpperCase();
const EXPLORER_BASE_URL = process.env[`${protocol}_EXPLORER_URL`];

const AMOUNT_TO_BRIDGE = 30;
const AMOUNT_TO_DELEGATE = 1;
const VALIDATOR_ADDRESS = 'NodeID-PmN1QWcH3MY4DuVUMsbx9QysvgyGrpCPZ'; // if testnet, pick from https://subnets-test.avax.network/validators/dashboard/
const DELEGATION_START_TIME = Math.floor(Date.now() / 1000) + 5 * 60 * 60; // 5 hours from now
const DELEGATION_END_TIME = Math.floor(Date.now() / 1000) + 29 * 60 * 60; // 29 hours from now, for a 24 hour staking period
const TESTNET = true;
const ASSET_ID = TESTNET ? 'AVAXTEST' : 'AVAX';
const VAULT_ACCOUNT_ID = 1;
const NETWORK = TESTNET ? 'fuji' : 'mainnet';
const HEADERS = {
  'Content-Type': 'application/json',
  'x-api-key': process.env.FIGMENT_API_KEY,
};

const fireblocks = new FireblocksSDK(
  process.env.FIREBLOCKS_SECRET_KEY,
  process.env.FIREBLOCKS_API_KEY
);

// /********** Transaction Generation Functions **********/

/**
 * Create an unsigned transaction to export AVAX from C-chain to P-chain using Figment API
 * @param {string} fromAddress - The source C-chain address
 * @param {string} toAddress - The destination P-chain address
 * @param {number} amount - The amount of AVAX to bridge
 * @param {string} network - The network to use (fuji or mainnet)
 * @returns {Promise<{signingPayload: string, unsignedTransactionSerialized: string}>} - The signing payload and unsigned transaction
 */
async function exportFromC(fromAddress, toAddress, amount, network) {
  try {
    const response = await axios.post(
      'https://api.figment.io/avalanche/export',
      {
        from_address: fromAddress,
        to_address: toAddress,
        amount: amount,
        network: network,
      },
      {
        headers: HEADERS,
      }
    );

    if (!response.data || !response.data.data) {
      throw new Error('Invalid response format from Figment API');
    }

    return {
      signingPayload: response.data.data.signing_payload,
      unsignedTransactionSerialized: response.data.data.unsigned_transaction_serialized,
    };
  } catch (error) {
    console.error('Error exporting from C-chain:');
    if (error.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      console.error('Response data:', error.response.data);
      console.error('Response status:', error.response.status);
      console.error('Response headers:', error.response.headers);
    } else if (error.request) {
      // The request was made but no response was received
      console.error('No response received:', error.request);
    } else {
      // Something happened in setting up the request that triggered an Error
      console.error('Error message:', error.message);
    }
    console.error('Error config:', {
      url: error.config?.url,
      method: error.config?.method,
      headers: error.config?.headers,
    });
    throw error;
  }
}

/**
 * Create an unsigned transaction to import AVAX from P-chain to C-chain using Figment API
 * @param {string} fromAddress - The source P-chain address
 * @param {string} toAddress - The destination C-chain address
 * @param {string} network - The network to use (fuji or mainnet)
 * @returns {Promise<{signingPayload: string, unsignedTransactionSerialized: string}>} - The signing payload and unsigned transaction
 */
async function importToP(fromAddress, toAddress, network) {
  try {
    const response = await axios.post(
      'https://api.figment.io/avalanche/import',
      {
        from_address: fromAddress,
        to_address: toAddress,
        network: network,
      },
      {
        headers: HEADERS,
      }
    );

    return {
      signingPayload: response.data.data.signing_payload,
      unsignedTransactionSerialized: response.data.data.unsigned_transaction_serialized,
    };
  } catch (error) {
    console.error('Error importing to C-chain:', error.err || error.message);
    throw error;
  }
}

/**
 * Create an unsigned transaction to delegate AVAX to a validator using Figment API
 * @param {string} fromAddress - The source P-chain address
 * @param {string} network - The network to use (fuji or mainnet)
 * @returns {Promise<{signingPayload: string, unsignedTransactionSerialized: string}>} - The signing payload and unsigned transaction
 */
async function delegate(fromAddress, network, nodeId, amount, startTime, endTime) {
  try {
    const response = await axios.post(
      'https://api.figment.io/avalanche/delegate',
      {
        from_address: fromAddress,
        node_id: nodeId,
        amount: amount,
        start: startTime,
        end: endTime,
        network: network,
      },
      {
        headers: HEADERS,
      }
    );

    return {
      signingPayload: response.data.data.signing_payload,
      unsignedTransactionSerialized: response.data.data.unsigned_transaction_serialized,
    };
  } catch (error) {
    console.error('Error creating delegation transaction:', error);
    throw error;
  }
}

/********** Fireblocks Helper Functions **********/

/**
 * Get the C-chain address for AVAX from Fireblocks
 * @returns {Promise<string>} - The C-chain address (deposit address)
 */
async function getFireblocksDepositAddress() {
  const response = await fireblocks.getDepositAddresses(VAULT_ACCOUNT_ID, ASSET_ID);

  if (!response || !response[0]?.address) {
    throw new Error('Invalid response format from Fireblocks API');
  }

  return response[0].address;
}

/**
 * Get the AVAX public key from Fireblocks for a specific vault account
 * @param {boolean} compressed - Whether to return compressed or uncompressed public key
 * @returns {Promise<string>} - The public key in hex format
 */
async function getPubkeyFromFireblocks(compressed) {
  const response = await fireblocks.getPublicKeyInfoForVaultAccount({
    vaultAccountId: VAULT_ACCOUNT_ID,
    assetId: ASSET_ID,
    change: 0,
    addressIndex: 0,
    compressed: compressed, // Always use compressed key for consistency
  });

  return response.publicKey;
}

/**
 * Wait for a Fireblocks transaction to complete
 * @param {Transaction} fbTx - The Fireblocks transaction
 * @returns {Promise<Transaction>} - The completed transaction
 */
async function waitForTxCompletion(fbTx) {
  let tx = fbTx;

  while (tx.status != TransactionStatus.COMPLETED) {
    if (
      tx.status == TransactionStatus.BLOCKED ||
      tx.status == TransactionStatus.FAILED ||
      tx.status == TransactionStatus.REJECTED ||
      tx.status == TransactionStatus.CANCELLED
    ) {
      console.log("Transaction's status: " + tx.status);

      throw Error('Exiting the operation due to error');
    }
    console.log(
      "Transaction's status:",
      (await fireblocks.getTransactionById(fbTx.id)).status
    );
    setTimeout(() => {}, 4000);

      tx = await fireblocks.getTransactionById(fbTx.id);
  }

  return await fireblocks.getTransactionById(fbTx.id);
}

/**
 * Sign a message using Fireblocks
 * @param {string} signingPayload - The payload to sign from Figment API
 * @returns {Promise<string>} - The signature object from Fireblocks
 */
async function signWithFireblocks(signingPayload) {
  const response = await fireblocks.createTransaction({
    assetId: ASSET_ID,
    operation: TransactionOperation.RAW,
    source: {
      type: PeerType.VAULT_ACCOUNT,
      id: String(VAULT_ACCOUNT_ID),
    },
    extraParameters: {
      rawMessageData: {
        messages: [{ content: sha256(signingPayload) }],
      },
    },
  });

  let tx = await waitForTxCompletion(response);

  return tx.signedMessages[0].signature;
}

/********** Misc Helper Functions **********/

/**
 * Calculate SHA-256 hash of a hex message
 * @param {string} message - The hex message to hash
 * @returns {string} - The SHA-256 hash in hex format
 */
function sha256(message) {
  return crypto.createHash('sha256').update(hexToBuffer(message)).digest('hex');
}

/**
 * Translate a Fireblocks Avalanche C-chain address to a P-chain address
 * @param {boolean} compressed - Whether to use compressed or uncompressed public key
 * @returns {Promise<string>} - The C-chain address
 */
async function translateAddress(compressed) {
  const pubkey = await getPubkeyFromFireblocks(compressed);
  console.log('Pubkey: ', pubkey);

  const pubkeyBytes = avalanche.utils.hexToBuffer(pubkey);
  const addressPrefix = NETWORK;

  const address = avalanche.utils.formatBech32(
    addressPrefix,
    avalanche.secp256k1.publicKeyBytesToAddress(pubkeyBytes)
  );

  return `P-${address}`;
}

/**
 * Convert a hex string to a Buffer
 * @param {string} hex - The hex string to convert
 * @returns {Buffer} - The resulting buffer
 */
function hexToBuffer(hex) {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  return Buffer.from(cleanHex, 'hex');
}

/**
 * Convert a Buffer to a hex string
 * @param {Buffer} buffer - The buffer to convert
 * @returns {string} - The resulting hex string
 */
function bufferToHex(buffer) {
  return '0x' + buffer.toString('hex');
}

/**
 * Add the v value to a signature
 * @param {Object} signature - The signature object containing fullSig and v
 * @returns {string} - The complete signature with v value to pass to Figment API
 */
function addVToSignature(signature) {
  const fullSigBytes = hexToBuffer(signature.fullSig);
  const newSig = Buffer.alloc(65);
  fullSigBytes.copy(newSig);
  newSig[64] = signature.v;
  return bufferToHex(newSig);
}

/**
 * Broadcast a signed transaction to the Avalanche network
 * @param {string} network - The network to broadcast to (fuji or mainnet)
 * @param {string} signedPayload - The signed transaction payload
 * @param {string} unsignedTransactionSerialized - The original unsigned transaction
 * @returns {Promise<Object>} - The broadcast response
 */
async function broadcastTx(network, signedPayload, unsignedTransactionSerialized) {
  try {
    const response = await axios.post(
      'https://api.figment.io/avalanche/broadcast',
      {
        network: network,
        signed_payload: signedPayload,
        unsigned_transaction_serialized: unsignedTransactionSerialized,
      },
      {
        headers: HEADERS,
      }
    );

    return response.data;
  } catch (error) {
    console.log('Error broadcasting transaction: ', error);
    throw error;
  }
}

/**
 * Generate an SnowTrace explorer URL for a transaction
 * @param {string} txHash - The transaction hash
 * @returns {string} - The full SnowTrace explorer URL
 */
function explorerUrl(txHash, pChain = false) {
  if (pChain) {
    return `${EXPLORER_BASE_URL}/p-chain/tx/${txHash}`;
  } else {
    return `${EXPLORER_BASE_URL}/c-chain/tx/${txHash}`;
  }
}

async function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/********** Main Function **********/
(async () => {
  try {
    const cChainAddress = await getFireblocksDepositAddress();
    console.log('C-chain address: ', cChainAddress);
    const pChainAddress = await translateAddress(true);
    console.log('P-chain address: ', pChainAddress);

    // Export from C-chain
    console.log('\n=== Exporting from C-chain ===');
    try {
      const { signingPayload: exportSigningPayload, unsignedTransactionSerialized: exportUnsignedTx } = await exportFromC(cChainAddress, pChainAddress, AMOUNT_TO_BRIDGE, NETWORK);
      console.log('Export transaction created successfully');

      const exportSignedPayload = addVToSignature(await signWithFireblocks(exportSigningPayload));
      console.log('Transaction signed successfully');

      const exportTxHash = (await broadcastTx(NETWORK, exportSignedPayload, exportUnsignedTx)).data.transaction_hash;
      console.log('Export from C-chain transaction successful! View here: ', explorerUrl(exportTxHash));

      // // Wait for 5 seconds to ensure the export is complete
      // await sleep(5);

      // // Import to C-chain
      // console.log('\n=== Importing to P-chain ===');
      // const { signingPayload: importSigningPayload, unsignedTransactionSerialized: importUnsignedTx } = await importToP(cChainAddress, pChainAddress, NETWORK);

      // const importSignedPayload = addVToSignature(await signWithFireblocks(importSigningPayload));

      // const importTxHash = (await broadcastTx(NETWORK, importSignedPayload, importUnsignedTx)).data.transaction_hash;
      // console.log('Import to P-chain transaction successful! View here: ', explorerUrl(importTxHash, true));

      // // Wait for 5 seconds to ensure the import is complete
      // await sleep(5);

      // // Delegate to validator
      // console.log('\n=== Delegating to validator ===');
      // const { signingPayload: delegateSigningPayload, unsignedTransactionSerialized: delegateUnsignedTx } = await delegate(pChainAddress, NETWORK, VALIDATOR_ADDRESS, AMOUNT_TO_DELEGATE, DELEGATION_START_TIME, DELEGATION_END_TIME);

      // const delegateSignedPayload = addVToSignature(await signWithFireblocks(delegateSigningPayload));

      // const delegateTxHash = (await broadcastTx(NETWORK, delegateSignedPayload, delegateUnsignedTx)).data.transaction_hash;
      // console.log('Delegate to validator transaction successful! View here: ', explorerUrl(delegateTxHash, true));

      // Bridge P->C
      // const { signingPayload: exportSigningPayload, unsignedTransactionSerialized: exportUnsignedTx } = await exportFromC(pChainAddress, cChainAddress, AMOUNT_TO_BRIDGE, NETWORK);
      // console.log('Export transaction created successfully');

      // const exportSignedPayload = addVToSignature(await signWithFireblocks(exportSigningPayload));
      // console.log('Transaction signed successfully');

      // const exportTxHash = (await broadcastTx(NETWORK, exportSignedPayload, exportUnsignedTx)).data.transaction_hash;
      // console.log('Export from P-chain transaction successful! View here: ', explorerUrl(exportTxHash));

      // console.log('\n=== Importing to P-chain ===');
      // const { signingPayload: importSigningPayload, unsignedTransactionSerialized: importUnsignedTx } = await importToP(pChainAddress, cChainAddress, NETWORK);

      // const importSignedPayload = addVToSignature(await signWithFireblocks(importSigningPayload));

      // const importTxHash = (await broadcastTx(NETWORK, importSignedPayload, importUnsignedTx)).data.transaction_hash;
      // console.log('Import to C-chain transaction successful! View here: ', explorerUrl(importTxHash, true));

    } catch (error) {
      console.error('Error in transaction flow:', error);
      if (error.response) {
        console.error('API Response:', error.response.data);
        console.error('Status:', error.response.status);
      }
      throw error;
    }
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
})();