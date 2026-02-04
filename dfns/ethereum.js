require('dotenv').config()
const axios = require('axios')
const { DfnsApiClient } = require('@dfns/sdk')
const { DfnsWallet } = require('@dfns/lib-ethersjs6')
const { AsymmetricKeySigner } = require('@dfns/sdk-keysigner')

const dfnsCredId = process.env.DFNS_CRED_ID
const dfnsPrivateKey = process.env.DFNS_PRIVATE_KEY
const dfnsAppId = process.env.DFNS_APP_ID
const dfnsAuthToken = process.env.DFNS_AUTH_TOKEN
const dfnsApiUrl = process.env.DFNS_API_URL
const fundingWalletId = process.env.FUNDING_WALLET_ID

/* Configuration */
const NETWORK = 'holesky'
const EXPLORER_BASE_URL = `https://${NETWORK === 'holesky' ? 'holesky.' : ''}etherscan.io/tx/`
const FIGMENT_API_URL = 'https://api.figment.io'
const VALIDATORS_COUNT = 1
const API_HEADERS = { 
  headers: {
    'x-api-key': process.env.FIGMENT_API_KEY
  }
}

const signer = new AsymmetricKeySigner({
  credId: dfnsCredId,
  privateKey: dfnsPrivateKey,
})

const dfnsClient = new DfnsApiClient({
  appId: dfnsAppId,
  authToken: dfnsAuthToken,
  baseUrl: dfnsApiUrl,
  signer,
})

/**
 * Initialize the DFNS wallet
 * @param {string} walletId - The wallet ID
 * @returns {Promise<object>} - The initialized wallet
 */
async function initDfnsWallet(walletId) { 
  return DfnsWallet.init({ walletId, dfnsClient }) 
}

/**
 * Create validator transactions using Figment API
 * @param {string} withdrawalAddress - The withdrawal address
 * @param {number} validatorsCount - Number of validators to create
 * @param {string} network - The network to use
 * @returns {Promise<object>} - The unsigned transaction
 */
async function createValidators(withdrawalAddress, validatorsCount, network) {
  try {
    const response = await axios.post(`${FIGMENT_API_URL}/ethereum/validators`, {
      withdrawal_address: withdrawalAddress,
      validators_count: validatorsCount,
      network: network
    }, API_HEADERS)
    
    return response.data.meta.staking_transaction
  } catch (error) {
    console.error('Error:', error.response?.data?.error || error.message)
    throw error
  }
}

/**
 * Sign transaction with DFNS
 * @param {object} dfnsWallet - The DFNS wallet instance
 * @param {object} unsignedTransaction - The unsigned transaction object
 * @returns {Promise<string>} - The signature
 */
async function signWithDfns(dfnsWallet, unsignedTransaction) {
  try {
    console.log('Unsigned tx: ' + unsignedTransaction.unsigned_transaction_serialized)

    const signedTransaction = await dfnsClient.wallets.generateSignature({
      walletId: fundingWalletId, 
      body: { 
        kind: 'Transaction', 
        transaction: unsignedTransaction.unsigned_transaction_serialized
      }
    })

    return signedTransaction.signature.encoded
  } catch(error) {
    console.error('Error signing transaction:', error.context || error.message)
    throw error
  }
}

/**
 * Broadcast the signed transaction
 * @param {string} signature - The transaction signature
 * @param {string} unsignedTransactionSerialized - The unsigned transaction serialized
 * @returns {Promise<string>} - The transaction hash
 */
async function broadcastTransaction(signature, unsignedTransactionSerialized) {
  try {
    const response = await axios.post(`${FIGMENT_API_URL}/ethereum/broadcast`, {
      network: NETWORK,
      signature: signature,
      unsigned_transaction_serialized: unsignedTransactionSerialized
    }, API_HEADERS)
    
    return response.data.data.transaction_hash
  } catch (error) {
    console.error('Error broadcasting transaction:', error.response?.data?.error || error.message)
    throw error
  }
}

/**
 * Main function to execute the e2e validator creation flow
 */
async function main() {
  try {
    // Initialize DFNS wallet
    const dfnsWallet = await initDfnsWallet(fundingWalletId)
    const withdrawalAddress = await dfnsWallet.getAddress()

    // Create validator transactions
    const unsignedTransaction = await createValidators(withdrawalAddress, VALIDATORS_COUNT, NETWORK)
    console.log('Created validators')
    
    // Sign the transaction with DFNS
    const signature = await signWithDfns(dfnsWallet, unsignedTransaction)
    console.log('Signed transaction')
    
    // Broadcast the transaction
    const txHash = await broadcastTransaction(signature, unsignedTransaction.unsigned_transaction_serialized)
    
    const explorerUrl = `${EXPLORER_BASE_URL}${txHash}`
    console.log(`Created ${VALIDATORS_COUNT} validator(s) successfully!`)
    console.log('View transaction on explorer:', explorerUrl)
  } catch (error) {
    console.error('Error:', error.message)
  }
}

main()