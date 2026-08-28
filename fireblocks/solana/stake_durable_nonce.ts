/**
 * Figment Solana durable-nonce stake — Fireblocks SIGNS ONLY, Figment broadcasts.
 * Docs: https://docs.figment.io/reference/solana-stake
 *       https://docs.figment.io/reference/solana-broadcast
 *       https://docs.figment.io/reference/get-solana-activity
 *
 * Sibling script stake_durable_nonce_figment.ts lets Fireblocks sign AND
 * broadcast (PROGRAM_CALL without signOnly). This one splits the two steps.
 *
 * Flow:
 * 1. Resolve funding from Fireblocks vault deposit address
 * 2. Verify nonce account on-chain
 * 3. Create stake tx via Figment (with nonce_account)
 * 4. Fireblocks PROGRAM_CALL with signOnly=true — vault signs, no FB broadcast
 * 5. Extract signedProgramCallData (base64), verify every signature slot filled
 * 6. base64 -> hex, POST /solana/broadcast
 * 7. Poll GET /solana/activities/{txHash} until confirmed
 *
 * Required env:
 *   FIREBLOCKS_API_KEY             Fireblocks API key
 *   FIREBLOCKS_SECRET_KEY_PATH     path to Fireblocks API user private key PEM
 *   FIREBLOCKS_VAULT_ACCOUNT_ID   vault id (e.g. "4")
 *   FIREBLOCKS_SOL_NONCE_ACCOUNT   on-chain nonce account pubkey
 *   API_KEY                        Figment API key (x-api-key)
 *
 * Optional env:
 *   FIREBLOCKS_BASE_URL        default https://api.fireblocks.io
 *   SOL_NONCE_AUTHORITY        defaults to vault funding address
 *   NETWORK                    mainnet | testnet | devnet  (default: devnet)
 *   AMOUNT_SOL                 min 1.1 (default: 1.1)
 *   VOTE_ACCOUNT               default: Figment devnet vote account
 */
import {
  Connection,
  Transaction,
  PublicKey,
  clusterApiUrl,
  NonceAccount,
} from "@solana/web3.js";
import axios from "axios";
import fs from "fs";
import {
  FireblocksSDK,
  TransactionStatus,
  PeerType,
  TransactionOperation,
} from "fireblocks-sdk";
import { config } from "dotenv";

config();

const FIGMENT_STAKE_URL = "https://api.figment.io/solana/stake";
const FIGMENT_BROADCAST_URL = "https://api.figment.io/solana/broadcast";
const FIGMENT_ACTIVITIES_URL = "https://api.figment.io/solana/activities";

// signOnly PROGRAM_CALL settles on SIGNED, not COMPLETED
const FB_SIGNED = "SIGNED";

const FIREBLOCKS_API_KEY = process.env.FIREBLOCKS_API_KEY || "";
const FIGMENT_API_KEY = process.env.FIGMENT_API_KEY || "";
const NETWORK = (process.env.NETWORK || "devnet") as
  | "mainnet"
  | "testnet"
  | "devnet";
const AMOUNT_SOL = Number(process.env.AMOUNT_SOL || "1.1");
const VOTE_ACCOUNT =
  process.env.VOTE_ACCOUNT ||
  "DaRwg7fkGs6Dnbh2cwPwmcsottXCuLBafCAJuQKySZq7";
const NONCE_ACCOUNT = process.env.FIREBLOCKS_SOL_NONCE_ACCOUNT || "";
const NONCE_AUTHORITY = process.env.SOL_NONCE_AUTHORITY || "";
const VAULT_ACCOUNT_ID = process.env.FIREBLOCKS_VAULT_ACCOUNT_ID || "";
const FIREBLOCKS_ASSET_ID =
  NETWORK === "mainnet" ? "SOL" : "SOL_TEST";
const FIREBLOCKS_BASE_URL =
  process.env.FIREBLOCKS_BASE_URL || "https://api.fireblocks.io";
const secretKeyPath = process.env.FIREBLOCKS_SECRET_KEY_PATH || "";

function requireEnv(name: string, value: string) {
  if (!value) throw new Error(`${name} is required`);
}

function createFireblocksClient(): FireblocksSDK {
  requireEnv("FIREBLOCKS_API_KEY", FIREBLOCKS_API_KEY);
  if (!fs.existsSync(secretKeyPath)) {
    throw new Error(`Fireblocks secret key not found: ${secretKeyPath}`);
  }
  const secretKey = fs.readFileSync(secretKeyPath, "utf8");
  return new FireblocksSDK(secretKey, FIREBLOCKS_API_KEY, FIREBLOCKS_BASE_URL);
}

async function resolveFundingFromFireblocksVault(
  fireblocks: FireblocksSDK
): Promise<{
  address: string;
  vaultId: string;
  assetId: string;
}> {
  requireEnv("FIREBLOCKS_VAULT_ACCOUNT_ID", VAULT_ACCOUNT_ID);
  const deposits = await fireblocks.getDepositAddresses(
    VAULT_ACCOUNT_ID,
    FIREBLOCKS_ASSET_ID
  );
  if (!deposits?.length || !deposits[0].address) {
    throw new Error(
      `No deposit address for vault ${VAULT_ACCOUNT_ID} / ${FIREBLOCKS_ASSET_ID}`
    );
  }
  return {
    address: deposits[0].address,
    vaultId: VAULT_ACCOUNT_ID,
    assetId: FIREBLOCKS_ASSET_ID,
  };
}

async function createStakeTx(body: Record<string, unknown>) {
  const { data } = await axios.post(FIGMENT_STAKE_URL, body, {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-api-key": FIGMENT_API_KEY,
    },
  });
  return data?.data ?? data;
}

/**
 * Wait until Fireblocks finishes vault signing (signOnly → SIGNED).
 * COMPLETED/CONFIRMED accepted too (workspace/policy variants).
 */
async function waitForFireblocksSigned(
  fireblocks: FireblocksSDK,
  fbTx: { id: string }
) {
  const terminalFail = new Set<string>([
    TransactionStatus.BLOCKED,
    TransactionStatus.FAILED,
    TransactionStatus.REJECTED,
    TransactionStatus.CANCELLED,
    "DROPPED",
  ]);
  const terminalOk = new Set<string>([
    FB_SIGNED,
    TransactionStatus.COMPLETED
  ]);

  let current: any = await fireblocks.getTransactionById(fbTx.id);
  while (!terminalOk.has(current.status)) {
    if (terminalFail.has(current.status)) {
      console.error("Fireblocks tx failed:", JSON.stringify(current, null, 2));
      throw new Error(
        `Fireblocks status: ${current.status} ${current.subStatus || ""}`.trim()
      );
    }

    console.log(
      "Waiting for Fireblocks sign:",
      current.status,
      current.subStatus || ""
    );
    await new Promise((r) => setTimeout(r, 4000));
    current = await fireblocks.getTransactionById(fbTx.id);
  }

  return fireblocks.getTransactionById(fbTx.id);
}

/**
 * Extract base64 signed wire after PROGRAM_CALL + signOnly.
 * Primary field (docs / multi-vault): signedProgramCallData
 */
function extractSignedProgramCallData(fbTx: any): string {
  const candidates = [
    fbTx?.signedProgramCallData,
    fbTx?.signed_program_call_data,
    fbTx?.extraParameters?.signedProgramCallData,
    fbTx?.extraParameters?.signed_program_call_data,
    // Some workspaces return the updated payload in the same field
    fbTx?.extraParameters?.programCallData,
  ].filter((v) => typeof v === "string" && v.length > 0);

  if (!candidates.length) {
    console.error(
      "Could not find signedProgramCallData. Full Fireblocks tx response:"
    );
    console.error(JSON.stringify(fbTx, null, 2));
    throw new Error(
      "Expected signedProgramCallData after SIGNED status (see Fireblocks response dump above)"
    );
  }

  return String(candidates[0]).replace(/\s/g, "");
}

/**
 * Fireblocks PROGRAM_CALL with signOnly — vault signs only, Figment broadcasts.
 * Accepts Figment unsigned_transaction_serialized (hex); converts to base64 for programCallData.
 * useDurableNonce:false — Figment payload already embeds AdvanceNonce.
 * Docs: https://developers.fireblocks.com/reference/interact-with-solana-programs
 */
async function signWithFireblocks(
  fireblocks: FireblocksSDK,
  unsignedHex: string,
  note: string
): Promise<string> {
  const programCallData = unsignedHexToProgramCallBase64(unsignedHex);
  console.log("\nprogramCallData (base64) length:", programCallData.length);
  console.log(
    "\nSubmitting Fireblocks PROGRAM_CALL (signOnly=true, useDurableNonce=false)..."
  );

  const created = await fireblocks.createTransaction({
    assetId: FIREBLOCKS_ASSET_ID,
    operation: "PROGRAM_CALL" as TransactionOperation,
    source: {
      type: PeerType.VAULT_ACCOUNT,
      id: String(VAULT_ACCOUNT_ID),
    },
    note,
    extraParameters: {
      programCallData,
      useDurableNonce: false,
      signOnly: true,
    },
  });

  console.log("Fireblocks signOnly PROGRAM_CALL created:", created.id);
  const signedTx = await waitForFireblocksSigned(fireblocks, created);
  console.log(
    "Fireblocks sign status:",
    signedTx.status,
    signedTx.subStatus || ""
  );

  return extractSignedProgramCallData(signedTx);
}

/**
 * Every signature slot must be filled before Figment sees the payload —
 * an under-signed tx comes back as an opaque 400.
 */
function verifySignedTx(signedBase64: string): Transaction {
  const tx = Transaction.from(Buffer.from(signedBase64, "base64"));

  console.log("\nSigners after Fireblocks:");
  const missing: string[] = [];
  tx.signatures.forEach((s, i) => {
    console.log(
      `  ${i + 1}. ${s.publicKey.toBase58()} → ${
        s.signature ? "Signed" : "MISSING"
      }`
    );
    if (!s.signature) missing.push(s.publicKey.toBase58());
  });

  if (missing.length) {
    throw new Error(`Missing signature(s): ${missing.join(", ")}`);
  }
  return tx;
}

/**
 * Figment Broadcast. transaction_payload is hex-encoded wire format.
 * Docs: https://docs.figment.io/reference/solana-broadcast
 */
async function broadcast(transaction_payload: string) {
  const { data } = await axios.post(
    FIGMENT_BROADCAST_URL,
    { network: NETWORK, transaction_payload },
    {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": FIGMENT_API_KEY,
      },
    }
  );
  return data?.data ?? data;
}

/**
 * Figment Get Solana Activity (UUID or tx hash).
 * Docs: https://docs.figment.io/reference/get-solana-activity
 */
async function getActivityByTxHash(txHash: string) {
  const { data } = await axios.get(`${FIGMENT_ACTIVITIES_URL}/${txHash}`, {
    params: { network: NETWORK },
    headers: {
      Accept: "application/json",
      "x-api-key": FIGMENT_API_KEY,
    },
  });
  return data?.data ?? data;
}

function explorerUrl(txHash: string): string {
  const clusterQs = NETWORK === "mainnet" ? "" : `?cluster=${NETWORK}`;
  return `https://explorer.solana.com/tx/${txHash}${clusterQs}`;
}

async function broadcastAndWaitForCompletion(
  transactionPayload: string,
  maxRetries = 30,
  retryDelay = 2000
) {
  console.log("\nBroadcasting via Figment...");
  const broadcastResult = await broadcast(transactionPayload);
  const txHash = broadcastResult.transaction_hash || broadcastResult.tx_hash;
  if (!txHash) {
    console.error(JSON.stringify(broadcastResult, null, 2));
    throw new Error("No transaction_hash from broadcast");
  }

  console.log("Tx hash: ", txHash);
  console.log("Explorer:", explorerUrl(txHash));

  for (let attempts = 1; attempts <= maxRetries; attempts++) {
    try {
      const activity = await getActivityByTxHash(txHash);
      // activity-life: pending | complete | failed
      // on-chain tx:   in_progress | confirmed | failed | expired
      const activityStatus = activity?.status;
      const txStatus = activity?.tx?.status;

      console.log(
        `Status (${attempts}/${maxRetries}): activity=${activityStatus} tx=${txStatus}`
      );

      if (txStatus === "confirmed") {
        console.log("On-chain tx confirmed.");
        return { txHash, status: activity, success: true };
      }
      if (txStatus === "failed" || txStatus === "expired") {
        console.log("On-chain tx failed/expired.");
        return { txHash, status: activity, success: false };
      }
      if (activityStatus === "failed") {
        return { txHash, status: activity, success: false };
      }
    } catch (e: any) {
      // Activity may not be indexed immediately after broadcast
      console.log(
        `Status check failed (${attempts}/${maxRetries}):`,
        e?.response?.data || e.message
      );
    }
    await new Promise((r) => setTimeout(r, retryDelay));
  }

  return { txHash, status: { status: "timeout" }, success: false };
}

/**
 * Figment Stake returns unsigned_transaction_serialized (hex wire).
 * Fireblocks programCallData expects base64.
 */
function unsignedHexToProgramCallBase64(hex: string): string {
  const cleaned = String(hex).replace(/\s/g, "");
  const tx = Transaction.from(Buffer.from(cleaned, "hex"));
  return tx
    .serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    })
    .toString("base64");
}

async function verifyNonceOnChain(
  connection: Connection,
  noncePubkey: PublicKey,
  expectedAuthority?: PublicKey
) {
  const info = await connection.getAccountInfo(noncePubkey);
  if (!info) {
    throw new Error(
      `Nonce account ${noncePubkey.toBase58()} does not exist on ${NETWORK}`
    );
  }
  const na = NonceAccount.fromAccountData(info.data);
  console.log("On-chain nonce:");
  console.log("  authority:", na.authorizedPubkey.toBase58());
  console.log("  durable nonce value:", na.nonce);
  if (
    expectedAuthority &&
    !na.authorizedPubkey.equals(expectedAuthority)
  ) {
    throw new Error(
      `Nonce authority mismatch: on-chain=${na.authorizedPubkey.toBase58()} expected=${expectedAuthority.toBase58()}`
    );
  }
  return na;
}

async function main() {
  requireEnv("FIREBLOCKS_SOL_NONCE_ACCOUNT", NONCE_ACCOUNT.trim());
  requireEnv("API_KEY", FIGMENT_API_KEY);
  if (AMOUNT_SOL < 1.1) {
    throw new Error("amount_sol must be >= 1.1 (Fireblocks minimum)");
  }

  const fireblocks = createFireblocksClient();

  const {
    address: fundingAddress,
    vaultId,
    assetId,
  } = await resolveFundingFromFireblocksVault(fireblocks);
  const fundingPubkey = new PublicKey(fundingAddress);

  const noncePubkey = new PublicKey(NONCE_ACCOUNT.trim());
  const authorityPubkey = NONCE_AUTHORITY
    ? new PublicKey(NONCE_AUTHORITY.trim())
    : fundingPubkey;

  const cluster =
    NETWORK === "mainnet" ? "mainnet-beta" : (NETWORK as "devnet" | "testnet");
  const connection = new Connection(clusterApiUrl(cluster), "confirmed");

  console.log("Network:         ", NETWORK);
  console.log("Fireblocks vault:", vaultId, `(${assetId})`);
  console.log("Funding (vault): ", fundingPubkey.toBase58());
  console.log("Vote account:    ", VOTE_ACCOUNT);
  console.log("Amount SOL:      ", AMOUNT_SOL);
  console.log("Nonce account:   ", noncePubkey.toBase58());
  console.log("Nonce authority: ", authorityPubkey.toBase58());

  await verifyNonceOnChain(connection, noncePubkey, authorityPubkey);

  const requestBody: Record<string, unknown> = {
    network: NETWORK,
    amount_sol: AMOUNT_SOL,
    vote_account: VOTE_ACCOUNT,
    funding_account: fundingPubkey.toBase58(),
    nonce_account: noncePubkey.toBase58(),
    nonce_authority: authorityPubkey.toBase58(),
  };

  console.log("\nPOST", FIGMENT_STAKE_URL);
  console.log("body:", JSON.stringify(requestBody, null, 2));

  let stake;
  try {
    stake = await createStakeTx(requestBody);
  } catch (err: any) {
    console.error(
      "Figment stake error:",
      err?.response?.data || err.message || err
    );
    process.exit(1);
  }

  console.log("\n--- Figment response ---");
  console.log("stake_account:          ", stake.stake_account);
  console.log("is_durable_nonce:       ", stake.is_durable_nonce);
  console.log("nonce_value:            ", stake.nonce_value);
  console.log("last_valid_block_height:", stake.last_valid_block_height);
  console.log("network:                ", stake.network);

  const hex = stake.unsigned_transaction_serialized;
  if (!hex) {
    throw new Error("No unsigned_transaction_serialized from Figment Stake API");
  }

  console.log("\nunsigned_transaction_serialized length:", String(hex).length);
  const tx = Transaction.from(Buffer.from(String(hex).replace(/\s/g, ""), "hex"));
  console.log("\nRequired signers:");
  tx.signatures.forEach((s, i) => {
    console.log(
      `  ${i + 1}. ${s.publicKey.toBase58()} → ${
        s.signature ? "pre-signed" : "MISSING"
      }`
    );
  });

  const signedBase64 = await signWithFireblocks(
    fireblocks,
    hex,
    `Figment durable-nonce stake stake_account=${stake.stake_account || "?"} amount=${AMOUNT_SOL}`
  );

  verifySignedTx(signedBase64);

  // Fireblocks hands back base64; Figment /solana/broadcast expects hex
  const signedBuffer = Buffer.from(signedBase64, "base64");
  const transactionPayloadHex = signedBuffer.toString("hex");
  console.log("\nsigned tx bytes:        ", signedBuffer.length);
  console.log("transaction_payload hex:", transactionPayloadHex.length, "chars");

  const result = await broadcastAndWaitForCompletion(transactionPayloadHex);

  console.log("\n--- Figment broadcast result ---");
  console.log("txHash:  ", result.txHash);
  console.log("success: ", result.success);
  console.log("activity:", JSON.stringify(result.status, null, 2));
  console.log("Explorer:", explorerUrl(result.txHash));

  if (!result.success) {
    throw new Error("Transaction did not confirm — see activity status above");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e?.response?.data || e);
    process.exit(1);
  });
