/* SIGNING ONLY */

const nearAPI = require("near-api-js");
const sha256 = require("js-sha256");
const BaseTransaction = require("../../../baseTransaction");

class Transaction extends BaseTransaction {
  async sign(privateKeys, _options) {
    const keyPair = nearAPI.utils.key_pair.KeyPairEd25519.fromString(
      privateKeys[0]
    );

    // 1) serialize the transaction in Borsh
    const serializedTx = Buffer.from(this.payload, "hex");
    // 2) deserialize to Transaction object
    const transaction = nearAPI.utils.serialize.deserialize(
      nearAPI.transactions.SCHEMA,
      nearAPI.transactions.Transaction,
      serializedTx
    );
    // 3) hash the serialized transaction using sha256
    const serializedTxHash = new Uint8Array(sha256.sha256.array(serializedTx));
    // 4) create a signature using the hashed transaction
    // This is using Ed25519 algorithm to sign the hashed transaction (per NEAR protocol)
    const signature = keyPair.sign(serializedTxHash);

    // now we can sign the transaction :)
    const signedTransaction = new nearAPI.transactions.SignedTransaction({
      transaction,
      signature: new nearAPI.transactions.Signature({
        keyType: transaction.publicKey.keyType,
        data: signature.signature,
      }),
    });

    // encodes signed transaction to serialized Borsh (required for all transactions)
    const signedSerializedTx = signedTransaction.encode();

    return Buffer.from(signedSerializedTx).toString("hex");
  }
}

module.exports = Transaction;