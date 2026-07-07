/**
 * Send an unsigned transaction on Hoodi Testnet
 * 
 * This example demonstrates how to:
 * 1. Parse an unsigned transaction from a hex string
 * 2. Prebuild, sign, and broadcast it separately using a BitGo wallet on Hoodi network
 */
import { BitGoAPI } from '@bitgo/sdk-api';
import { Hteth } from '@bitgo/sdk-coin-eth';
import { ethers } from 'ethers';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { config } from 'dotenv';
config();

// Configuration
const figment_apiKey = process.env.FIGMENT_API_KEY!;
const BITGO_ACCESS_TOKEN = process.env.BITGO_ACCESS_TOKEN!;
const WALLET_PASSPHRASE = process.env.WALLET_PASSPHRASE!;
const PREBUILD_FILE = path.join(__dirname, 'prebuild_transaction_multisig.json');
const SIGNED_FILE = path.join(__dirname, 'signed_transaction_multisig.json');

// User Inputs
const environment = process.env.BITGO_ENV || "test";
const WALLET_ID = process.env.WALLET_ID!;
const STAKE_AMOUNT = process.env.STAKE_AMOUNT! || "32.5";
const NETWORK = process.env.NETWORK! || "hoodi";

// API request headers for the Figment API
const headers = {
  accept: "application/json",
  "content-type": "application/json",
  "x-api-key": figment_apiKey,
};

// Initialize BitGo API
const bitgo = new BitGoAPI({
  accessToken: BITGO_ACCESS_TOKEN!,
  env: (environment) as 'test' | 'prod',
});

// Register Hoodi testnet coin
bitgo.register('hteth', Hteth.createInstance);

interface UnsignedTransaction {
  to: string;
  value: string; // in wei
  data: string; // call data (hex string)
  gasLimit: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  nonce?: number;
  chainId?: number;
}

interface SignedTransaction {
  txHex?: string;
  halfSigned?: {
    eip1559?: {
      maxPriorityFeePerGas: string;
      maxFeePerGas: string;
    };
    isBatch?: boolean;
    recipients?: Array<{
      address: string;
      amount: string;
      data?: string;
      [key: string]: any;
    }>;
    expireTime?: number;
    contractSequenceId?: number;
    operationHash?: string;
    signature?: string;
    // Legacy/alternative fields
    txHex?: string;
    payload?: string;
    txBase64?: string;
    expiration?: number;
    [key: string]: any;
  };
  txRequestId?: string;
  [key: string]: any;
}

/**
 * Generate staking transaction from Figment API
 * @param data The staking request data
 * @returns Object containing unsigned_transaction_serialized and unsigned_transaction_hashed
 */
const generateStakeTx = async (data: any): Promise<{
  unsigned_transaction_serialized: string;
  unsigned_transaction_hashed: string;
}> => {
  try {
    console.log("=== Generating Staking Transaction ===");
    console.log("Request data:", JSON.stringify(data, null, 2));

    const resp = await axios.post(`https://api.figment.io/ethereum/validators`, data, { headers });

    const responseJson = resp.data;

    // Extract unsigned transaction serialized
    const unsigned_transaction_serialized =
      responseJson?.meta?.staking_transaction?.unsigned_transaction_serialized;
    if (!unsigned_transaction_serialized) {
      throw new Error("unsigned_transaction_serialized not found in the response");
    }

    // Extract unsigned transaction hashed
    const unsigned_transaction_hashed =
      responseJson?.meta?.staking_transaction?.unsigned_transaction_hashed;
    if (!unsigned_transaction_hashed) {
      throw new Error("unsigned_transaction_hashed not found in the response");
    }

    console.log("✅ Successfully generated staking transaction");
    console.log("Unsigned transaction serialized:", unsigned_transaction_serialized);
    console.log("Unsigned transaction hashed:", unsigned_transaction_hashed);

    return {
      unsigned_transaction_serialized,
      unsigned_transaction_hashed
    };

  } catch (error) {
    console.error("❌ Error generating staking transaction:");
    if (error.response?.data) {
      console.error(JSON.stringify(error.response.data, null, 2));
    } else {
      console.error(error.message);
    }
    throw error;
  }
};

/**
 * Step 1: Prebuild an unsigned transaction
 */
async function prebuildTransaction(
  walletId: string,
  unsignedTx: UnsignedTransaction
) {
  try {
    // Authenticate with BitGo
    await bitgo.authenticateWithAccessToken({
      accessToken: BITGO_ACCESS_TOKEN!,
    });

    // Get the wallet
    const wallet = await bitgo.coin('hteth').wallets().get({ id: walletId });

    console.log(`Wallet Address: ${wallet.receiveAddress()}`);
    console.log(`Wallet Label: ${wallet.label()}`);

    // Prebuild the transaction
    const prebuildParams = {
      recipients: [
        {
          address: unsignedTx.to,
          amount: unsignedTx.value,
          data: unsignedTx.data,
        },
      ],
      type: 'transfer', // REQUIRED for TSS wallets
      gasLimit: Number(unsignedTx.gasLimit),
      ...(unsignedTx.maxFeePerGas && {
        gasPrice: Number(unsignedTx.maxFeePerGas)
      }),
      ...(unsignedTx.maxPriorityFeePerGas && {
        eip1559: {
          maxFeePerGas: unsignedTx.maxFeePerGas || '0',
          maxPriorityFeePerGas: unsignedTx.maxPriorityFeePerGas,
        }
      }),
      ...(unsignedTx.nonce !== undefined && { nonce: String(unsignedTx.nonce) }),
    };

    console.log('\n📋 Prebuilding transaction...');
    const prebuild = await wallet.prebuildTransaction(prebuildParams);

    console.log('\n✅ Transaction prebuilt successfully!');
    console.log('Prebuild result:', JSON.stringify(prebuild, null, 2));
    
    // Save prebuild to file
    const prebuildData = {
      walletId,
      unsignedTx,
      prebuild,
      timestamp: new Date().toISOString(),
    };
    
    fs.writeFileSync(PREBUILD_FILE, JSON.stringify(prebuildData, null, 2));
    console.log(`\n💾 Prebuild data saved to: ${PREBUILD_FILE}`);
    
  } catch (error) {
    console.error('❌ Error prebuilding transaction:', error);
    throw error;
  }
}

/**
 * Step 2: Read prebuild file, sign it, and save signed data file
 */
async function signPrebuildFile(
  walletId: string,
  walletPassphrase: string
): Promise<void> {
  try {
    console.log('\n=== STEP 2: Sign Transaction from File ===\n');
    
    // Check if prebuild file exists
    if (!fs.existsSync(PREBUILD_FILE)) {
      throw new Error(`Prebuild file not found: ${PREBUILD_FILE}. Please run Step 1 first.`);
    }

    // Read prebuild file
    console.log(`📂 Loading prebuild data from: ${PREBUILD_FILE}`);
    const fileContent = fs.readFileSync(PREBUILD_FILE, 'utf-8');
    const { walletId: fileWalletId, prebuild } = JSON.parse(fileContent);
    
    if (fileWalletId !== walletId) {
      throw new Error(`Wallet ID mismatch: file has ${fileWalletId}, but provided ${walletId}`);
    }

    // Authenticate with BitGo
    await bitgo.authenticateWithAccessToken({
      accessToken: process.env.BITGO_ACCESS_TOKEN!,
    });

    // Get the wallet
    const wallet = await bitgo.coin('hteth').wallets().get({ id: walletId });
    
    console.log(`Wallet Address: ${wallet.receiveAddress()}`);
    console.log(`Wallet Label: ${wallet.label()}`);
    
    console.log('\n✍️  Signing transaction...');
    // Sign the prebuilt transaction
    const signedTx = await wallet.signTransaction({
      txPrebuild: prebuild,
      walletPassphrase: walletPassphrase,
    });

    console.log('\n✅ Transaction signed successfully!');
    console.log('Signed transaction structure:', JSON.stringify(signedTx, null, 2));
    
    // Save signed transaction to file
    const signedData = {
      walletId,
      signedTx,
      timestamp: new Date().toISOString(),
    };
    
    fs.writeFileSync(SIGNED_FILE, JSON.stringify(signedData, null, 2));
    console.log(`\n💾 Signed transaction saved to: ${SIGNED_FILE}`);
    
  } catch (error) {
    console.error('❌ Error in Step 2:', error);
    throw error;
  }
}

/**
 * Step 3: Broadcast a signed transaction (Multisig only)
 */
async function broadcastTransaction(
  walletId: string,
  signedTx: SignedTransaction | any
) {
  try {
    console.log('\n=== STEP 3: Broadcast Transaction ===\n');
    
    // Authenticate with BitGo
    await bitgo.authenticateWithAccessToken({
      accessToken: BITGO_ACCESS_TOKEN!,
    });

    // Get the wallet
    const wallet = await bitgo.coin('hteth').wallets().get({ id: walletId });

    console.log('📡 Broadcasting transaction...');
    console.log('Signed transaction structure:', JSON.stringify(signedTx, null, 2));

    // For multisig wallets, check for halfSigned object
    if (!signedTx.halfSigned) {
      throw new Error('halfSigned object not found. This function only supports multisig wallets.');
    }

    const halfSigned = signedTx.halfSigned;
    console.log('✅ Found halfSigned object (multisig wallet)');
    console.log('HalfSigned structure:', JSON.stringify(halfSigned, null, 2));

    // Send the half-signed transaction
    // BitGo will add its signature and broadcast the transaction
    console.log(`\n📤 Sending half-signed transaction...`);
    const result = await bitgo.post(wallet.baseCoin.url(`/wallet/${walletId}/tx/send`))
      .send({ halfSigned: halfSigned })
      .result();

    console.log('\n✅ Transaction broadcast successfully!');
    console.log('Transaction ID:', result.txid);
    console.log('Transaction Hash:', result.hash || result.tx);
    console.log('\nFull broadcast response:');
    console.log(JSON.stringify(result, null, 2));

    return result;
  } catch (error) {
    console.error('❌ Error broadcasting transaction:', error);
    throw error;
  }
}

/**
 * Load and broadcast a previously signed transaction from file
 */
async function broadcastFromFile(walletId: string, filePath?: string) {
  const signedTxPath = filePath || SIGNED_FILE;

  if (!fs.existsSync(signedTxPath)) {
    throw new Error(`Signed transaction file not found: ${signedTxPath}`);
  }

  console.log(`\n📂 Loading signed transaction from: ${signedTxPath}`);
  const fileContent = fs.readFileSync(signedTxPath, 'utf-8');
  const { signedTx } = JSON.parse(fileContent);
  console.log(signedTx);

  return await broadcastTransaction(walletId, signedTx);
}



/**
 * Parse a raw unsigned transaction hex string
 */
async function parseRawTransaction(rawUnsignedTx: string): Promise<UnsignedTransaction> {
  try {
    console.log('Parsing unsigned transaction...');

    // Parse the unsigned transaction using ethers.js
    const tx = ethers.Transaction.from(rawUnsignedTx);

    const unsignedTx: UnsignedTransaction = {
      to: tx.to || '',
      value: tx.value.toString(),
      data: tx.data,
      gasLimit: tx.gasLimit.toString(),
      maxFeePerGas: tx.maxFeePerGas?.toString(),
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas?.toString(),
      nonce: tx.nonce,
      chainId: Number(tx.chainId),
    };

    console.log('\n📋 Parsed transaction details:');
    console.log('  To:', unsignedTx.to);
    console.log('  Value:', unsignedTx.value, 'wei');
    console.log('  Data:', unsignedTx.data);
    console.log('  Gas Limit:', unsignedTx.gasLimit);
    console.log('  Max Fee Per Gas:', unsignedTx.maxFeePerGas || 'N/A');
    console.log('  Max Priority Fee Per Gas:', unsignedTx.maxPriorityFeePerGas || 'N/A');
    console.log('  Nonce:', unsignedTx.nonce);
    console.log('  Chain ID:', unsignedTx.chainId);

    // Verify chain ID matches Hoodi (560048)
    if (unsignedTx.chainId !== 560048) {
      console.warn(`⚠️  Warning: Chain ID ${unsignedTx.chainId} does not match Hoodi testnet (560048)`);
    }

    return unsignedTx;
  } catch (error) {
    console.error('❌ Error parsing raw transaction:', error);
    throw error;
  }
}

/**
 * Get withdrawal address from BitGo wallet
 * @param walletId The BitGo wallet ID
 * @returns The wallet's receive address (withdrawal address)
 */
async function getWithdrawalAddress(walletId: string): Promise<string> {
  try {
    // Authenticate with BitGo
    await bitgo.authenticateWithAccessToken({
      accessToken: BITGO_ACCESS_TOKEN!,
    });

    // Get the wallet
    const wallet = await bitgo.coin('hteth').wallets().get({ id: walletId });

    // Get the receive address (this is the withdrawal address)
    const withdrawalAddress = wallet.receiveAddress();

    console.log(`📥 Withdrawal Address: ${withdrawalAddress}`);

    return withdrawalAddress;
  } catch (error) {
    console.error('❌ Error fetching withdrawal address:', error);
    throw error;
  }
}

/**
 * Main function
 */
async function main() {

  console.log('🚀 Starting Hoodi transaction example...\n');
  // Step 1: generate unsigned transaction and save its prebuild data to file
  const withdrawalAddress = await getWithdrawalAddress(WALLET_ID);

  const data = {
    network: NETWORK,
    validators_count: 1,
    amount: STAKE_AMOUNT,
    withdrawal_address: withdrawalAddress,
    region: "ca-central-1",
    credentials_prefix: '0x02',
  };

  console.log('\n📝 Step 1: Generate unsigned transaction and save its prebuild data to file\n');
  const { unsigned_transaction_serialized, unsigned_transaction_hashed } = await generateStakeTx(data);
  const unsignedTx = await parseRawTransaction(unsigned_transaction_serialized);
  //save prebuild data to file
  await prebuildTransaction(WALLET_ID, unsignedTx);

  // Step 2: Sign the transaction and save to file
  await signPrebuildFile(WALLET_ID, WALLET_PASSPHRASE);

  // Step 3: Broadcast separately from the file
  console.log('\n⏳ Waiting 2 seconds before broadcasting...');
  await new Promise(resolve => setTimeout(resolve, 2000));
  await broadcastFromFile(WALLET_ID);

}

// Run the example
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});