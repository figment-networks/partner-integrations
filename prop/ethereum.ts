import axios from "axios";
import { ethers, SigningKey } from "ethers";
import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
config();

const protocol = path.basename(__filename, '.js').toUpperCase();
const EXPLORER_BASE_URL = process.env[`${protocol}_EXPLORER_URL`];

// Your MetaMask private key (KEEP THIS SECRET)
const privateKey = process.env.PRIVATE_KEY; // Replace with your actual private key
const apiKey = process.env.API_KEY; // Replace with your actual API key

// API request headers for the Figment API
const headers = {
  accept: "application/json",
  "content-type": "application/json",
  "x-api-key": apiKey,
};
const withdrawalAddress = process.env.WITHDRAWAL_ADDRESS; // Replace with your actual withdrawal address

//Supposed to be user input
const data = {
  network: "hoodi",
  validators_count: 1,
  amount: "32.5",
  withdrawal_address: withdrawalAddress,
  region: "ca-central-1",
  credentials_prefix: '0x02',
};

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
 * Generate signature for unsigned transaction hash using ethers.js v6
 * @param unsignedTransactionHash The unsigned transaction hash string
 * @param privateKey The private key to sign with (with or without 0x prefix)
 * @returns The signature hex string
 */
const generateSignatureFromUnsignedTxHash = async (
  unsignedTransactionHash: string,
  privateKey: string
): Promise<string> => {
  try {
    console.log("=== Generating Signature ===");

    // 1. Format private key (ensure 0x prefix)
    const formattedPrivateKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;

    // 2. Create signing key and sign the hash
    const signingKey = new ethers.SigningKey(formattedPrivateKey);
    const signature = signingKey.sign(unsignedTransactionHash);

    console.log("Generated signature components:");
    console.log("  r:", signature.r);
    console.log("  s:", signature.s);
    console.log("  v:", signature.v);
    console.log("  yParity:", signature.yParity);
    console.log("  serialized:", signature.serialized);
    console.log("  compactSerialized:", signature.compactSerialized);

    // 3. Verify the signature we just generated
    const recoveredPublicKey = ethers.SigningKey.recoverPublicKey(unsignedTransactionHash, signature);
    const recoveredAddress = ethers.computeAddress(recoveredPublicKey);
    const walletAddress = ethers.computeAddress(signingKey.publicKey);

    console.log("Wallet address:", walletAddress);
    console.log("Recovered address:", recoveredAddress);
    console.log("Signature verification:", recoveredAddress.toLowerCase() === walletAddress.toLowerCase());

    console.log("=============================");

    // Return the serialized signature (standard format)
    return signature.serialized;

  } catch (error) {
    console.error("Error generating signature:", error);
    throw error;
  }
};


const broadcastTransaction = async (signature, unsignedTransactionSerialized) => {
  try {
    const resp = await axios.post(`https://api.figment.io/ethereum/broadcast`, {
      network: "hoodi",
      signature: signature,
      unsigned_transaction_serialized: unsignedTransactionSerialized
    },
      { headers });

    return resp.data.data.transaction_hash
  } catch (e) {
    console.error("Broadcast Transaction Error:")
    console.error(JSON.stringify(e.response?.data || e.message, null, 2));
  }
}


async function main() {
  // Generate staking transaction
  const { unsigned_transaction_serialized, unsigned_transaction_hashed } = await generateStakeTx(data);

  // Generate signature from the hash
  let signature = await generateSignatureFromUnsignedTxHash(unsigned_transaction_hashed, privateKey);

  // Broadcast transaction
  let txHash = await broadcastTransaction(signature, unsigned_transaction_serialized)
  
  console.log(`broadcasted transaction. explorer link: ${EXPLORER_BASE_URL}${txHash}`)

}

main().catch(console.error);