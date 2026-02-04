require('dotenv').config({ path: __dirname + '/.env' });
import { btcstakingtx } from "@babylonlabs-io/babylon-proto-ts";
import {
  DirectSecp256k1Wallet,
  Registry
} from '@cosmjs/proto-signing';
import {
  SigningStargateClient,
  calculateFee
} from '@cosmjs/stargate';
import { TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx.js"
import { fromHex } from "@cosmjs/encoding";
import { MsgCreateBTCDelegation } from '@babylonlabs-io/babylon-proto-ts/dist/generated/babylon/btcstaking/v1/tx.js'
import fs from 'fs';

const privateKey = fs.readFileSync('./.key', "utf8").trim();

const signingPayload = process.argv[2];
const txBuf = Buffer.from(signingPayload, "hex");
const txJson = JSON.parse(txBuf.toString());

// TODO: look these up from the Blockchain
const nonce = process.argv[3];
const accountNumber = process.argv[4];

const msg = btcstakingtx.MsgCreateBTCDelegation.fromJSON(txJson['messages'][0].value);
txJson['messages'][0].value = msg

const sign = async (txJson, privateKeys, options) => {
  const signer = await DirectSecp256k1Wallet.fromKey(
    fromHex(privateKeys[0]),
    "bbn"
  );
  const { address } = (await signer.getAccounts())[0];
  const registry = new Registry();

  registry.register(
    "/babylon.btcstaking.v1.MsgCreateBTCDelegation",
    MsgCreateBTCDelegation
  );
  const signingClient = await SigningStargateClient.offline(signer, { registry });
  const { accountNumber, sequence, chainId } = options;
  const txRaw = await signingClient.sign(
    address,
    txJson.messages,
    txJson.fee,
    txJson.memo,
    {
      accountNumber,
      sequence,
      chainId,
    }
  );
  const txBytes = TxRaw.encode(txRaw).finish();
  return txBytes.toString("hex");
}

const signed = await sign(txJson, [privateKey], {
  accountNumber: accountNumber,
  sequence: nonce,
  chainId: 'bbn-test-5'
})

console.log(signed)