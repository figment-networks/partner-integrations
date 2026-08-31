/**
 * Stake SOL: local stake-account key + BitGo online TSS sign + merge
 *
 * 1. Build createAccount + delegate tx locally (see direct_delegate.ts)
 * 2. BitGo prebuildTransaction(customTx) + signTransaction (user + BitGo server share)
 * 3. partialSign with the new stake-account keypair
 * 4. Broadcast
 *
 * Unlike the Figment-first flow, BitGo builds and signs its own message bytes, so
 * online TSS co-signing works without local user+backup shares.
 */
import { BitGoAPI } from '@bitgo/sdk-api';
import type { SolInstruction } from '@bitgo/sdk-core';
import { Tsol, Sol } from '@bitgo/sdk-coin-sol';
import {
  Authorized,
  clusterApiUrl,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  Lockup,
  PublicKey,
  StakeProgram,
  Transaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import * as fs from 'fs';
import * as path from 'path';
import { config } from 'dotenv';

config();

const BITGO_ACCESS_TOKEN = process.env.BITGO_ACCESS_TOKEN!;
const WALLET_PASSPHRASE = process.env.WALLET_PASSPHRASE!;
const WALLET_ID = process.env.SOL_WALLET_ID!;
const STAKE_AMOUNT_SOL = Number(process.env.STAKE_AMOUNT_SOL || '1.1');
const VOTE_ACCOUNT =
  process.env.VOTE_ACCOUNT || '21Jxcw74j5SvajRKE3PvNifu26CVorF7DF8HyanKNzZ3';
const ENV = (process.env.BITGO_ENV || 'test') as 'test' | 'prod';
const COIN = ENV === 'test' ? 'tsol' : 'sol';
const NETWORK = ENV === 'test' ? 'devnet' : 'mainnet';
const CLUSTER = ENV === 'test' ? 'devnet' : 'mainnet-beta';

const BUILD_FILE = path.join(__dirname, 'stake_bitgo_build_sol.json');
const SIGNED_FILE = path.join(__dirname, 'stake_bitgo_signed_sol.json');

const bitgo = new BitGoAPI({ accessToken: BITGO_ACCESS_TOKEN, env: ENV });
if (ENV === 'test') {
  bitgo.register('tsol', Tsol.createInstance);
} else {
  bitgo.register('sol', Sol.createInstance);
}

interface StakeBuildFile {
  walletId: string;
  coin: string;
  fundingAccount: string;
  stakeAccountPublicKey: string;
  /** Ephemeral stake-account secret (base58). Needed only to partialSign after BitGo signs. */
  stakeAccountSecretKey: string;
  customTxParams: {
    type: 'customTx';
    comment: string;
    solInstructions: SolInstruction[];
  };
  prebuild: {
    txRequestId: string;
    txHex: string;
    buildParams?: unknown;
    feeInfo?: unknown;
  };
  timestamp: string;
}

interface SignedStakeFile {
  walletId: string;
  coin: string;
  fundingAccount: string;
  stakeAccountPublicKey: string;
  signedTxHex: string;
  bitgoSignResult: {
    txRequestId: string;
  };
  timestamp: string;
}

function solToLamportsNumber(sol: number): number {
  const input = sol.toString().trim();
  if (!/^\d+(\.\d+)?$/.test(input)) {
    throw new Error(`Invalid SOL amount: "${sol}"`);
  }
  const decimals = LAMPORTS_PER_SOL.toString().length - 1;
  const [whole, frac = ''] = input.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const lamportsBig =
    BigInt(whole) * BigInt(LAMPORTS_PER_SOL) + BigInt(fracPadded || '0');
  if (lamportsBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Lamports exceed safe number range: ${lamportsBig.toString()}`);
  }
  return Number(lamportsBig);
}

function txToSolInstructions(tx: Transaction): SolInstruction[] {
  return tx.instructions.map((ix) => ({
    programId: ix.programId.toBase58(),
    keys: ix.keys.map((k) => ({
      pubkey: k.pubkey.toBase58(),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: ix.data.toString('base64'),
  }));
}

async function getFundingAddress(walletId: string): Promise<string> {
  await bitgo.authenticateWithAccessToken({ accessToken: BITGO_ACCESS_TOKEN });
  const wallet = await bitgo.coin(COIN).wallets().get({ id: walletId });
  const address = wallet.receiveAddress();
  if (!address) {
    throw new Error(`No receive address found for wallet ${walletId}`);
  }
  console.log(`Funding address: ${address}`);
  return address;
}

/**
 * Build native stake tx locally (createAccount + delegate), same shape as direct_delegate.ts.
 */
async function buildLocalStakeTransaction(
  fundingAccount: string,
  stakeAccount: Keypair
): Promise<Transaction> {
  const connection = new Connection(clusterApiUrl(CLUSTER), 'confirmed');
  const minimumRent = await connection.getMinimumBalanceForRentExemption(StakeProgram.space);
  const minDelegationResp = await connection.getStakeMinimumDelegation();
  const minDelegationLamports = Number(minDelegationResp.value);
  const amountUserWantsToStake = solToLamportsNumber(STAKE_AMOUNT_SOL);
  const lamports = minimumRent + amountUserWantsToStake;

  if (amountUserWantsToStake < minDelegationLamports) {
    throw new Error(
      `STAKE_AMOUNT_SOL (${STAKE_AMOUNT_SOL}) is below network minimum delegation ` +
        `(${minDelegationLamports / LAMPORTS_PER_SOL} SOL on ${CLUSTER}). ` +
        `Stake error 0xc (InsufficientDelegation) will occur on broadcast.`
    );
  }

  console.log(`Amount to stake: ${amountUserWantsToStake / LAMPORTS_PER_SOL} SOL`);
  console.log(`Minimum delegation: ${minDelegationLamports / LAMPORTS_PER_SOL} SOL`);
  console.log(`Rent-exempt minimum: ${minimumRent / LAMPORTS_PER_SOL} SOL`);
  console.log(`Total lamports in stake account: ${lamports / LAMPORTS_PER_SOL} SOL`);

  const fromPubkey = new PublicKey(fundingAccount);
  const votePubkey = new PublicKey(VOTE_ACCOUNT);

  const tx = new Transaction();
  tx.add(
    StakeProgram.createAccount({
      authorized: new Authorized(fromPubkey, fromPubkey),
      fromPubkey,
      lamports,
      lockup: new Lockup(0, 0, fromPubkey),
      stakePubkey: stakeAccount.publicKey,
    }),
    StakeProgram.delegate({
      stakePubkey: stakeAccount.publicKey,
      authorizedPubkey: fromPubkey,
      votePubkey,
    })
  );

  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = fromPubkey;

  return tx;
}

async function fetchTxRequest(walletId: string, txRequestId: string) {
  const result = await bitgo
    .get(bitgo.url(`/wallet/${walletId}/txrequests`, 2))
    .query({ txRequestIds: txRequestId, latest: 'true' })
    .result();
  const txRequests = (result as { txRequests?: unknown[] }).txRequests;
  if (!txRequests?.length) {
    throw new Error(`TxRequest ${txRequestId} not found`);
  }
  return txRequests[0] as {
    txRequestId: string;
    apiVersion?: string;
    state?: string;
    transactions?: Array<{
      unsignedTx?: { signableHex?: string; serializedTxHex?: string };
      signedTx?: { tx?: string; id?: string };
    }>;
    unsignedTxs?: Array<{ serializedTxHex?: string }>;
  };
}

function extractFundingSignedTxBase64(
  signedResult: unknown,
  txRequest: Awaited<ReturnType<typeof fetchTxRequest>>
): string {
  const fromSignResult = (signedResult as { tx?: string }).tx;
  if (fromSignResult) return fromSignResult;

  const fromTransactions = txRequest.transactions?.[0]?.signedTx?.tx;
  if (fromTransactions) return fromTransactions;

  throw new Error(
    'BitGo signed tx missing. Ensure prebuild uses apiVersion: "full". ' +
      `TxRequest state=${txRequest.state ?? 'unknown'}, apiVersion=${txRequest.apiVersion ?? 'unknown'}`
  );
}

async function buildAndPrebuild(walletId: string): Promise<StakeBuildFile> {
  const fundingAccount = await getFundingAddress(walletId);
  const stakeAccount = Keypair.generate();

  console.log('\n=== Build stake tx locally ===');
  console.log(`New stake account: ${stakeAccount.publicKey.toBase58()}`);

  const localTx = await buildLocalStakeTransaction(fundingAccount, stakeAccount);
  const customTxParams = {
    type: 'customTx' as const,
    comment: `Stake ${STAKE_AMOUNT_SOL} SOL to ${VOTE_ACCOUNT}`,
    solInstructions: txToSolInstructions(localTx),
  };

  const wallet = await bitgo.coin(COIN).wallets().get({ id: walletId });
  if (wallet.multisigType() !== 'tss') {
    throw new Error(`Expected TSS wallet, got "${wallet.multisigType()}"`);
  }

  console.log('\n=== BitGo prebuildTransaction (customTx, apiVersion: full) ===');
  const prebuild = await wallet.prebuildTransaction({
    ...customTxParams,
    apiVersion: 'full',
  });
  if (!prebuild.txRequestId || !prebuild.txHex) {
    throw new Error('Expected txRequestId and txHex from BitGo prebuild');
  }

  console.log('Tx Request ID:', prebuild.txRequestId);
  console.log('Prebuild tx hex prefix:', `${prebuild.txHex.slice(0, 64)}...`);

  const payload: StakeBuildFile = {
    walletId,
    coin: COIN,
    fundingAccount,
    stakeAccountPublicKey: stakeAccount.publicKey.toBase58(),
    stakeAccountSecretKey: bs58.encode(stakeAccount.secretKey),
    customTxParams,
    prebuild: {
      txRequestId: prebuild.txRequestId,
      txHex: prebuild.txHex,
      buildParams: prebuild.buildParams,
      feeInfo: prebuild.feeInfo,
    },
    timestamp: new Date().toISOString(),
  };

  fs.writeFileSync(BUILD_FILE, JSON.stringify(payload, null, 2));
  console.log(`Saved: ${BUILD_FILE}`);
  return payload;
}

function loadBuildFile(walletId: string): StakeBuildFile {
  if (!fs.existsSync(BUILD_FILE)) {
    throw new Error(`Build file not found: ${BUILD_FILE}`);
  }
  const data = JSON.parse(fs.readFileSync(BUILD_FILE, 'utf-8')) as StakeBuildFile;
  if (data.walletId !== walletId) throw new Error('Wallet ID mismatch');
  return data;
}

/**
 * BitGo online TSS sign (user share + BitGo server share), then stake-account partialSign.
 */
async function signWithBitGoAndMergeStake(
  walletId: string,
  walletPassphrase: string,
  build: StakeBuildFile
): Promise<SignedStakeFile> {
  await bitgo.authenticateWithAccessToken({ accessToken: BITGO_ACCESS_TOKEN });
  const wallet = await bitgo.coin(COIN).wallets().get({ id: walletId });

  console.log('\n=== BitGo signTransaction (online TSS: user + BitGo server) ===');

  const signedResult = await wallet.signTransaction({
    txPrebuild: { ...build.prebuild, buildParams: build.customTxParams },
    walletPassphrase,
    verifyTxParams: { txParams: build.customTxParams },
    apiVersion: 'full',
  });

  const txRequestId =
    (signedResult as { txRequestId?: string }).txRequestId ?? build.prebuild.txRequestId;
  const txRequest = await fetchTxRequest(walletId, txRequestId);
  const signedTxBase64 = extractFundingSignedTxBase64(signedResult, txRequest);

  console.log('\n=== Stake account partialSign (local new keypair) ===');
  const stakeAccount = Keypair.fromSecretKey(bs58.decode(build.stakeAccountSecretKey));
  if (stakeAccount.publicKey.toBase58() !== build.stakeAccountPublicKey) {
    throw new Error('Stake account public key mismatch in build file');
  }

  const tx = Transaction.from(Buffer.from(signedTxBase64, 'base64'));

  console.log('Signatures before stake partialSign:');
  for (const sig of tx.signatures) {
    const pubkey = sig.publicKey?.toBase58() ?? 'unknown';
    console.log(`  ${pubkey}: ${sig.signature ? 'signed' : 'MISSING'}`);
  }

  const fundingSig = tx.signatures.find(
    (s) => s.publicKey?.toBase58() === build.fundingAccount
  );
  if (!fundingSig?.signature) {
    throw new Error(`BitGo did not sign funding account ${build.fundingAccount}`);
  }

  tx.partialSign(stakeAccount);

  const stillUnsigned = tx.signatures.find((s) => !s.signature);
  if (stillUnsigned) {
    throw new Error(`Still missing signature for ${stillUnsigned.publicKey?.toBase58()}`);
  }

  const signedTxHex = tx.serialize({ requireAllSignatures: true }).toString('hex');
  console.log('✅ Fully signed tx ready');

  return {
    walletId,
    coin: COIN,
    fundingAccount: build.fundingAccount,
    stakeAccountPublicKey: build.stakeAccountPublicKey,
    signedTxHex,
    bitgoSignResult: { txRequestId },
    timestamp: new Date().toISOString(),
  };
}

async function signFromBuildFile(walletId: string, walletPassphrase: string) {
  const build = loadBuildFile(walletId);
  const signed = await signWithBitGoAndMergeStake(walletId, walletPassphrase, build);
  fs.writeFileSync(SIGNED_FILE, JSON.stringify(signed, null, 2));
  console.log(`Saved: ${SIGNED_FILE}`);
  return signed;
}

function loadSignedFile(walletId: string): SignedStakeFile {
  if (!fs.existsSync(SIGNED_FILE)) throw new Error(`Signed file not found: ${SIGNED_FILE}`);
  const data = JSON.parse(fs.readFileSync(SIGNED_FILE, 'utf-8')) as SignedStakeFile;
  if (data.walletId !== walletId) throw new Error('Wallet ID mismatch');
  return data;
}

async function broadcastSignedTx(signedTxHex: string): Promise<string> {
  console.log('\n=== Solana broadcast ===');
  const connection = new Connection(clusterApiUrl(CLUSTER), 'confirmed');
  const tx = Transaction.from(Buffer.from(signedTxHex, 'hex'));

  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) {
    throw new Error(
      `Transaction simulation failed before broadcast: ${JSON.stringify(sim.value.err)}. ` +
        `Logs: ${sim.value.logs?.slice(-3).join(' | ')}`
    );
  }

  const coin = bitgo.coin(COIN);
  const signedTxBase64 = Buffer.from(signedTxHex, 'hex').toString('base64');
  const result = await coin.broadcastTransaction({ serializedSignedTransaction: signedTxBase64 });
  const txid =
    (result as { txid?: string; txId?: string }).txid ??
    (result as { txId?: string }).txId;
  if (!txid) {
    console.log(JSON.stringify(result, null, 2));
    throw new Error('txid missing from broadcast response');
  }
  console.log('✅ Transaction hash:', txid);
  return txid;
}

async function main() {
  console.log(`🚀 Solana stake via BitGo online TSS (${COIN} / ${NETWORK})\n`);
  const build = await buildAndPrebuild(WALLET_ID);
  const signed = await signWithBitGoAndMergeStake(WALLET_ID, WALLET_PASSPHRASE, build);
  fs.writeFileSync(SIGNED_FILE, JSON.stringify(signed, null, 2));
  await broadcastSignedTx(signed.signedTxHex);
}

const cmd = process.argv[2];
if (cmd === 'build') {
  buildAndPrebuild(WALLET_ID).catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else if (cmd === 'sign') {
  signFromBuildFile(WALLET_ID, WALLET_PASSPHRASE).catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else if (cmd === 'broadcast') {
  broadcastSignedTx(loadSignedFile(WALLET_ID).signedTxHex).catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
