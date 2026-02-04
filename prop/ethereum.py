import requests
import json
from web3 import Web3

# Your MetaMask private key (KEEP THIS SECRET)
private_key = "XXXXXX"  # Replace with your actual private key

# Public RPC node (Ensure it's appropriate for the 'holesky' network if needed)
rpc_url = "https://holesky.infura.io/v3/XXXXX"
web3 = Web3(Web3.HTTPProvider(rpc_url))

# API request details for the Figment API
url = "https://api.figment.io/ethereum/validators"
headers = {
    "accept": "application/json",
    "content-type": "application/json",
    "x-api-key": "XXXXXX"  # Replace with your actual API key
}
data = {
    "network": "holesky",
    "validators_count": 1,
    "withdrawal_address": "XXXXXX",
    "funding_address": "XXXXXX",
    "fee_recipient_address": "XXXXXX",
    "region": "ca-central-1"
}

# Send a POST request to the Figment API to create a new validator
response = requests.post(url, headers=headers, data=json.dumps(data))

# Parse the response JSON
response_json = response.json()

# Extract the unsigned transaction serialized part from the response
unsigned_transaction_serialized = response_json.get('meta', {}).get('staking_transaction', {}).get('unsigned_transaction_serialized')
if not unsigned_transaction_serialized:
    # If the serialized transaction is not found, raise an exception
    raise Exception("unsigned_transaction_serialized not found in the response")

# Print the unsigned transaction serialized
print(f"Unsigned transaction serialized: {unsigned_transaction_serialized}")

# Extract the unsigned transaction hashed part from the response
unsigned_transaction_hashed = response_json.get('meta', {}).get('staking_transaction', {}).get('unsigned_transaction_hashed')
if not unsigned_transaction_hashed:
    # If the hashed transaction is not found, raise an exception
    raise Exception("unsigned_transaction_hashed not found in the response")

# Print the unsigned transaction hash
print(f"Unsigned transaction hash: {unsigned_transaction_hashed}")

# Sign the transaction hash using the private key
signed_transaction = web3.eth.account.signHash(unsigned_transaction_hashed, private_key=private_key)

# Print the signed transaction
print(f"Signature: {signed_transaction.signature.hex()}")