import { Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { messageWithIntent } from '@mysten/sui/cryptography';
import { fromHex, toBase64 } from '@mysten/sui/utils';
import axios from 'axios';
import fs from "fs";
import { FireblocksSDK, PeerType, TransactionOperation } from "fireblocks-sdk";
import { config } from "dotenv";
config();

// Configuration
const API_KEY = process.env.FIGMENT_API_KEY || ''; // Replace with your actual Figment API key
const fireblocks_secretKey = process.env.FIREBLOCKS_SECRET_KEY || '';
const fireblocks_apiKey = process.env.FIREBLOCKS_API_KEY || '';
const fireblocks = new FireblocksSDK(fireblocks_secretKey, fireblocks_apiKey);

// User Inputs
const stakeAmount = process.env.SUI_STAKE_AMOUNT ? Number(process.env.SUI_STAKE_AMOUNT) : 1;
const validatorAccount = process.env.SUI_VALIDATOR_ACCOUNT || '0x22b35a7481fb136e5585c43421cf8ab49d0e219e902dedc40c2778acdcc7bc9c'; //Figment validator address on testnet "0x22b35a7481fb136e5585c43421cf8ab49d0e219e902dedc40c2778acdcc7bc9c";
const vaultAccountId = process.env.FIREBLOCKS_VAULT_ACCOUNT_ID || ''; // Your Fireblocks vault ID
const network = process.env.NETWORK || "testnet";


async function generateStakePayload(amount, validatorAccount, delegatorAccount) {
    const API_URL = 'https://api.figment.io/sui/stake';
    // Define request body parameters
    const requestBody = {
        network: network,
        amount: amount,   
        validator_address: validatorAccount,
        delegator_address: delegatorAccount
    };

    try {
        const response = await axios.post(API_URL, requestBody, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'x-api-key': API_KEY
            }
        });

        console.log('Response:', response.data);
        return response.data;
    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
        console.error('Error:', JSON.stringify(error, null, 2));
    }
};


async function broadcast(unsigned_transaction_serialized, signature) {
    const API_URL = 'https://api.figment.io/sui/broadcast';
    // Define request body parameters
    const requestBody = {
        network: network,
        unsigned_transaction_serialized: unsigned_transaction_serialized,
        signature: signature
    };

    try {
        const response = await axios.post(API_URL, requestBody, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'x-api-key': API_KEY
            }
        });

        return response;
    } catch (error) {
        console.log('Error:', JSON.stringify(error, null, 2));
        console.error('Error:', error.response ? error.response.data : error.message);
        
    }
};


/**
 * Creates the intent message digest that Sui requires for transaction signing
 * Uses dynamic import to avoid direct dependency on blake2b
 */
async function createIntentMessageDigest(transactionBytes) {
  // Dynamically import blake2b (same library the SDK uses internally)
  const { blake2b } = await import('@noble/hashes/blake2b');
  
  // Create intent message
  const intentMessage = messageWithIntent('TransactionData', transactionBytes);
  
  // Hash the intent message with blake2b (32 bytes output)
  const digest = blake2b(intentMessage, { dkLen: 32 });
  
  return digest;
}

/**
 * Verifies that the Fireblocks signature is valid for the transaction
 */
async function verifyFireblocksSignature(
  transactionBytes,
  fullSig,
  publicKey
) {
  try {
    // Create intent message digest (what Sui expects to be signed)
    const digest = await createIntentMessageDigest(transactionBytes);
    
    // Get signature and public key
    const signatureBytes = fromHex(fullSig);
    const publicKeyBytes = fromHex(publicKey);
    const publicKeyObj = new Ed25519PublicKey(publicKeyBytes);
    
    // Verify signature over the digest
    return await publicKeyObj.verify(digest, signatureBytes);
  } catch (error) {
    console.error('Verification error:', error);
    return false;
  }
}

async function signSuiTxWithFireblocks(signing_payload) {
  // Convert hex to bytes
  const transactionBytes = fromHex(signing_payload);
  
  // Create the intent message digest that Sui requires
  // This is what Fireblocks should sign, NOT the raw transaction bytes
  const intentMessageDigest = await createIntentMessageDigest(transactionBytes);
  
  // Convert digest to hex for Fireblocks
  const digestHex = Buffer.from(intentMessageDigest).toString('hex');
  
  console.log('Raw transaction bytes length:', transactionBytes.length);
  console.log('Intent message digest (hex):', digestHex);
  console.log('Intent message digest length:', intentMessageDigest.length, 'bytes');
  
  // 1. Create a RAW transaction for signing
  // IMPORTANT: Send the intent message digest, not the raw transaction!
  const txRes = await fireblocks.createTransaction({
    assetId: network === "mainnet" ? "SUI" : "SUI_TEST",
    source: { type: PeerType.VAULT_ACCOUNT, id: vaultAccountId },
    operation: TransactionOperation.RAW,
    extraParameters: {
      rawMessageData: {
        messages: [
          { content: digestHex }, // Send intent message digest, not raw transaction
        ]
      },
      algorithm: "MPC_EDDSA_ED25519"
    },
    note: "Sign Sui transaction (intent message digest)"
  });

  console.log("Transaction created:", txRes.id);

  // 2. Wait for the transaction to be signed
  let tx;
  do {
    tx = await fireblocks.getTransactionById(txRes.id);
    if (!["CONFIRMED", "CANCELLED", "REJECTED", "FAILED"].includes(tx.status)) {
      console.log(`Waiting for signature... Current status: ${tx.status}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  } while (!["COMPLETED", "CONFIRMED", "CANCELLED", "REJECTED", "FAILED"].includes(tx.status));

  // 3. Extract signatures
  const signedMessages = tx.signedMessages;
  console.log("Signed Messages:", signedMessages);

  console.log('Public Key:', publicKeyToSuiAddress(signedMessages[0].publicKey));
  console.log('Full Sig:', signedMessages[0].signature.fullSig);

  let fullSig = signedMessages[0].signature.fullSig;
  let publicKey = signedMessages[0].publicKey;

  // Verify the signature before returning
  const isValid = await verifyFireblocksSignature(transactionBytes, fullSig, publicKey);
  if (!isValid) {
    throw new Error(
      'Fireblocks signature verification failed. ' +
      'The signature does not match the intent message digest. ' +
      'Make sure Fireblocks signed the intent message digest, not the raw transaction bytes.'
    );
  }
  console.log('✅ Signature verification passed');

  return { fullSig, publicKey };
}

/**
 * Convert Fireblocks public key (hex) to Sui address
 * @param publicKeyHex Hex-encoded public key from Fireblocks
 * @returns Sui address string
 */
function publicKeyToSuiAddress(publicKeyHex) {
  try {
      // Remove '0x' prefix if present
      const cleanHex = publicKeyHex.startsWith('0x') 
          ? publicKeyHex.slice(2) 
          : publicKeyHex;
      
      // Convert hex to bytes
      const publicKeyBytes = fromHex(cleanHex);
      
      // Create Ed25519PublicKey object
      const publicKey = new Ed25519PublicKey(publicKeyBytes);
      
      // Convert to Sui address
      const suiAddress = publicKey.toSuiAddress();
      console.log('Sui Address:', suiAddress);
      
      return suiAddress;
  } catch (error) {
      throw new Error(`Failed to convert public key to Sui address: ${error}`);
  }
}

/**
 * Converts a Fireblocks signed message to Sui's serialized signature format
 * Sui signature format: flag (1 byte) || signature (64 bytes) || publicKey (32 bytes)
 */
function convertFireblocksSignatureToSui(
  fullSig,
  publicKey
) {
  // ED25519 flag is 0x00
  const flag = 0x00;
  
  // Convert hex strings to bytes using the Sui SDK utility
  const signatureBytes = fromHex(fullSig);
  const publicKeyBytes = fromHex(publicKey);
  
  // Validate lengths
  if (signatureBytes.length !== 64) {
    throw new Error(`Invalid signature length: expected 64 bytes, got ${signatureBytes.length}`);
  }
  if (publicKeyBytes.length !== 32) {
    throw new Error(`Invalid public key length: expected 32 bytes, got ${publicKeyBytes.length}`);
  }
  
  // Create serialized signature: flag || signature || publicKey
  const serializedSignature = new Uint8Array(1 + signatureBytes.length + publicKeyBytes.length);
  serializedSignature.set([flag], 0);
  serializedSignature.set(signatureBytes, 1);
  serializedSignature.set(publicKeyBytes, 1 + signatureBytes.length);
  
  // Return as base64 encoded string
  return toBase64(serializedSignature);
}


async function main() {
    try {
        const vaultAddresses = await fireblocks.getDepositAddresses(vaultAccountId, network === "mainnet" ? "SUI" : "SUI_TEST");
        const delegatorAddress = vaultAddresses[0].address;
        console.log('Delegator Address:', delegatorAddress);
        // generate stake payload
        let response = await generateStakePayload(stakeAmount, validatorAccount, delegatorAddress);
        let unsignedTransactionHex = response.data.unsigned_transaction_serialized;
        console.log('Unsigned Transaction:', unsignedTransactionHex);

        // sign transaction - now sends intent message digest to Fireblocks
        let { fullSig, publicKey } = await signSuiTxWithFireblocks(unsignedTransactionHex);
        console.log('Fully Signed Transaction:', fullSig);
        let suiSignature = convertFireblocksSignatureToSui(fullSig, publicKey);
        console.log('Sui Signature:', suiSignature);
        
        // broadcast transaction
        let result = await broadcast(unsignedTransactionHex, suiSignature);
        console.log('Response:', result);

    } catch (error) {
        console.error("❌ Error broadcasting transaction:", error);
    }
};

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });