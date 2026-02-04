const fs = require('fs');
const axios = require('axios');
const { FireblocksSDK, TransactionStatus, PeerType, TransactionOperation } = require("fireblocks-sdk");

// Configuration
const FIGMENT_API_KEY = process.env.FIGMENT_API_KEY;
const FIREBLOCKS_SECRET_KEY = process.env.FIREBLOCKS_SECRET_KEY;
const FIREBLOCKS_API_KEY = process.env.FIREBLOCKS_API_KEY;

const fireblocks = new FireblocksSDK(FIREBLOCKS_SECRET_KEY, FIREBLOCKS_API_KEY);

const TESTNET = false;
const VAULT_ACCOUNT_ID = 1;
const NETWORK = TESTNET ? "testnet" : "preprod";
const DELEGATOR_ADDRESS = "addr_test1qrswqv7wx5lq9d7p00qmm80ntnja38wm2rq7xd8s0cs767yy4n25eghca4kf20q9tkfun39j3fz03vf9d8nkrvskpchsdw7hqq";
const VALIDATOR_ADDRESS = "pool13m26ky08vz205232k20u8ft5nrg8u68klhn0xfsk9m4gsqsc44v";

const HEADERS = {
  'accept': 'application/json',
  'content-type': 'application/json',
  'x-api-key': FIGMENT_API_KEY
};

async function waitForTxCompletion(fbTx) {
  const errorStatuses = [TransactionStatus.BLOCKED, TransactionStatus.FAILED, TransactionStatus.REJECTED, TransactionStatus.CANCELLED];
  while (fbTx.status !== TransactionStatus.COMPLETED) {
    if (errorStatuses.includes(fbTx.status)) throw new Error(`Transaction ${fbTx.status}`);
    console.log(`Transaction status: ${fbTx.status}`);
    await new Promise(resolve => setTimeout(resolve, 4000));
    fbTx = await fireblocks.getTransactionById(fbTx.id);
  }
  return await fireblocks.getTransactionById(fbTx.id);
}

async function createDelegationTransaction() {
  const response = await axios.post('https://api.figment.io/cardano/delegate',
    { network: NETWORK, delegator_address: DELEGATOR_ADDRESS, validator_address: VALIDATOR_ADDRESS },
    { headers: HEADERS });
  const { signing_payload: signingPayload, unsigned_transaction_serialized: unsignedTx } = response.data.data || {};
  if (!signingPayload || !unsignedTx) throw new Error('Invalid response from delegate endpoint');
  return { signingPayload, unsignedTx };
}

async function signTransaction(signingPayload) {
  const fbTx = await fireblocks.createTransaction({
    assetId: "ADA_TEST",
    operation: TransactionOperation.RAW,
    source: { type: PeerType.VAULT_ACCOUNT, id: String(VAULT_ACCOUNT_ID) },
    note: "Cardano Delegation - Figment API",
    extraParameters: {
      rawMessageData: {
        messages: [{ content: signingPayload }, { content: signingPayload, bip44change: 2 }]
      }
    }
  });
  const tx = await waitForTxCompletion(fbTx);
  if (!tx.signedMessages?.length) throw new Error('No signed messages received from Fireblocks');
  return tx.signedMessages;
}

async function broadcastTransaction(unsignedTx, signedMessages) {
  const response = await axios.post('https://api.figment.io/cardano/broadcast/fireblocks',
    { network: NETWORK, unsigned_transaction_serialized: unsignedTx, signed_messages: signedMessages },
    { headers: HEADERS });
  return response.data?.data?.transaction_hash || response.data?.transaction_hash || response.data;
}

(async () => {
  try {
    console.log(`Starting Cardano Delegation Flow\nNetwork: ${NETWORK}\nDelegator: ${DELEGATOR_ADDRESS}\nValidator: ${VALIDATOR_ADDRESS}\n${'='.repeat(60)}`);
    
    const startTime = Date.now();
    console.log('Creating transaction...');
    const { signingPayload, unsignedTx } = await createDelegationTransaction();
    const creationTime = Date.now();
    console.log(`Transaction created (${((creationTime - startTime) / 1000).toFixed(2)}s)`);

    console.log('Signing with Fireblocks...');
    const signedMessages = await signTransaction(signingPayload);
    const signingTime = Date.now();
    console.log(`Signed (${((signingTime - creationTime) / 1000).toFixed(2)}s, ${signedMessages.length} signature${signedMessages.length !== 1 ? 's' : ''})`);

    console.log('Broadcasting...');
    const txHash = await broadcastTransaction(unsignedTx, signedMessages);
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    
    console.log(`\nDelegation completed! (${totalTime}s)\nTransaction Hash: ${typeof txHash === 'string' ? txHash : JSON.stringify(txHash)}\nAll done!`);

  } catch (error) {
    console.error('\nDelegation failed');
    console.error('Error:', error.response?.data?.error?.message || error.message || error);
    if (error.response && error.response.data && !error.response.data.error) {
      console.error('Response:', JSON.stringify(error.response.data, null, 2));
    }
    process.exit(1);
  }
})();