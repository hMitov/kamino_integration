import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { KaminoMarket, DEFAULT_RECENT_SLOT_DURATION_MS, KaminoMarketRpcApi } from "@kamino-finance/klend-sdk";
import axios from "axios";
import {
  createDefaultRpcTransport,
  createRpc,
  createSolanaRpcApi,
  DEFAULT_RPC_CONFIG,
  Rpc,
  SolanaRpcApi,
  AddressesByLookupTableAddress,
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  GetLatestBlockhashApi,
  getSignatureFromTransaction,
  Instruction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  TransactionSigner,
  RpcSubscriptions,
  SignatureNotificationsApi,
  SlotNotificationsApi,
  createSolanaRpcSubscriptions,
  Address,
} from '@solana/kit';
import {
  getOrCreateAssociatedTokenAccount,
  transfer,
} from "@solana/spl-token";
import { BlockhashWithHeight, MarketArgs, ReserveArgs } from "../types/kamino-types";
import BN from "bn.js";

const API_KAMINO_SLOTS_DURATION = 'https://api.kamino.finance/slots/duration';


/* -------------------------------------------------------------------------- */
/*                         SLOT DURATION UTILITIES                            */
/* -------------------------------------------------------------------------- */

/**
 * Fetches the median Solana slot duration (in milliseconds) from Kamino’s API.
 * Falls back to {@link DEFAULT_RECENT_SLOT_DURATION_MS} if the API is unavailable.
 *
 * @returns Median slot duration in milliseconds.
 */
export async function getMedianSlotDurationInMsFromLastEpochs() {
  try {
    console.log(`Fetching slot duration from Kamino API...`);
    const response = await axios.get<{ recentSlotDurationInMs: number }>(API_KAMINO_SLOTS_DURATION);
    if (!response.data?.recentSlotDurationInMs) {
      throw new Error("Invalid response format from Kamino API.");
    }

    console.log(`Retrieved slot duration: ${response.data.recentSlotDurationInMs}ms`);
    return response.data.recentSlotDurationInMs;
  } catch (error) {
    console.error(`Error fetching slot duration:`, error);
    return DEFAULT_RECENT_SLOT_DURATION_MS;
  }
}


/* -------------------------------------------------------------------------- */
/*                             MARKET LOADING                                 */
/* -------------------------------------------------------------------------- */

/**
 * Loads a Kamino lending market using on-chain data.
 *
 * @param rpc - The Solana RPC connection.
 * @param marketPubkey - Public key of the Kamino market.
 * @returns Loaded {@link KaminoMarket} instance.
 * @throws If the market cannot be loaded or validated.
 */
export async function getMarket({ rpc, marketPubkey }: MarketArgs) {
  try {
    const slotDuration = await getMedianSlotDurationInMsFromLastEpochs();

    const market = await KaminoMarket.load(
      rpc as unknown as Rpc<KaminoMarketRpcApi>,
      marketPubkey,
      slotDuration
    );

    if (!market) {
      throw new Error(`Could not load market ${marketPubkey.toString()}`);
    }
    if (!market.address) {
      throw new Error(`Market loaded but address is undefined`);
    }

    console.log(`Market loaded successfully`);
    return market;
  } catch (err) {
    console.error(`Failed to load market ${marketPubkey}:`, err);
    throw err;
  }
}

/**
 * Loads both the Kamino market and a specific reserve (for a given mint).
 *
 * @param rpc - Solana RPC client.
 * @param marketPubkey - Kamino market address.
 * @param mintPubkey - Reserve mint address.
 * @returns Object containing the loaded market, reserve, and current slot.
 * @throws If the market or reserve cannot be loaded.
 */
export async function loadReserveData({ rpc, marketPubkey, mintPubkey }: ReserveArgs) {
  try {
    console.log(`Loading market for ${marketPubkey.toString()}`);
    const market = await getMarket({ rpc: rpc, marketPubkey });

    if (!market) {
      throw new Error(`Failed to load market ${marketPubkey.toString()}`);
    }

    console.log(`Getting reserve for mint ${mintPubkey.toString()}`);
    const reserve = market.getReserveByMint(mintPubkey);

    if (!reserve) {
      throw new Error(`Could not load reserve for ${mintPubkey.toString()}`);
    }

    const currentSlot = await rpc.getSlot().send();

    console.log(`Successfully loaded market and reserve data`);
    return { market, reserve, currentSlot };
  } catch (err) {
    console.error(`Failed to load reserve ${mintPubkey}:`, err);
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/*                           RPC / CONNECTION UTILS                           */
/* -------------------------------------------------------------------------- */

/**
 * Initializes a Solana RPC client using {@link @solana/kit}.
 *
 * @param rpcUrl - RPC endpoint URL.
 * @returns Initialized RPC client.
 */
export function initRpc(rpcUrl: string): Rpc<SolanaRpcApi> {
  const api = createSolanaRpcApi<SolanaRpcApi>({
    ...DEFAULT_RPC_CONFIG,
    defaultCommitment: 'processed',
  });
  return createRpc({ api, transport: createDefaultRpcTransport({ url: rpcUrl }) });
}

/**
 * Sets up both HTTP RPC and WebSocket connections to Solana.
 *
 * @param url - Base URL of the RPC endpoint.
 * @returns Object containing both RPC and WebSocket connections.
 */
export function setUpConnections(url: URL) {
  let wsUrl: string;
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    wsUrl = `ws://${url.hostname}:8900`;
  } else {
    wsUrl = url.href.replace(/^http/i, "ws");
  }

  const rpc = initRpc(url.href);
  const ws = createSolanaRpcSubscriptions(wsUrl);
  return { rpc, ws };
}

/* -------------------------------------------------------------------------- */
/*                          TRANSACTION UTILITIES                             */
/* -------------------------------------------------------------------------- */

/**
 * Fetches the latest blockhash and validity information.
 *
 * @param rpc - Solana RPC client.
 * @returns Blockhash data with slot and expiration height.
 */
export async function fetchBlockhash(rpc: Rpc<GetLatestBlockhashApi>): Promise<BlockhashWithHeight> {
  const res = await rpc.getLatestBlockhash({ commitment: 'processed' }).send();
  return {
    blockhash: res.value.blockhash,
    lastValidBlockHeight: res.value.lastValidBlockHeight,
    slot: res.context.slot,
  };
}

/**
 * Builds, signs, sends, and confirms a Solana transaction.
 * Uses the modern `TransactionMessage` pipeline for LUT compression.
 *
 * @param rpc - Solana RPC client.
 * @param wsRpc - Optional WebSocket RPC for confirmations.
 * @param payer - Fee payer signer.
 * @param ixs - Array of transaction instructions.
 * @param signers - Additional signers.
 * @param description - Optional description for logging.
 * @returns Transaction signature.
 * @throws If the transaction fails or is rejected.
 */
export async function sendAndConfirmTx(
  {
    rpc,
    wsRpc,
  }: {
    rpc: Rpc<SolanaRpcApi>;
    wsRpc?: RpcSubscriptions<SignatureNotificationsApi & SlotNotificationsApi>;
  },
  payer: TransactionSigner,
  ixs: Instruction[],
  signers: TransactionSigner[] = [],
  description = ""
): Promise<any> {
  console.log("Starting sendAndConfirmTx");
  const blockhash = await fetchBlockhash(rpc);
  const lutsByAddress: AddressesByLookupTableAddress = {};

  const tx = await pipe(
    createTransactionMessage({ version: 0 }),
    (msg) => appendTransactionMessageInstructions(ixs, msg),
    (msg) => setTransactionMessageFeePayerSigner(payer, msg),
    (msg) => setTransactionMessageLifetimeUsingBlockhash(blockhash, msg),
    (msg) => compressTransactionMessageUsingAddressLookupTables(msg, lutsByAddress),
    (msg) => addSignersToTransactionMessage(signers, msg),
    (msg) => signTransactionMessageWithSigners(msg)
  );

  const sig = getSignatureFromTransaction(tx);

  try {
    const sendAndConfirm = sendAndConfirmTransactionFactory({
      rpc,
      rpcSubscriptions: wsRpc,
    });
    await sendAndConfirm(tx as any, {
      commitment: "confirmed",
      preflightCommitment: "processed",
      skipPreflight: false,
    });
    console.log(`${description || "Transaction"} confirmed: ${sig}`);
  } catch (err) {
    console.error(`${description || "Transaction"} ${sig} failed`, err);
    try {
      const logs = await rpc
        .getTransaction(sig, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
          encoding: "json",
        })
        .send();
      if (logs?.meta?.logMessages) {
        console.error("Transaction logs:\n", logs.meta.logMessages.join("\n"));
      }
    } catch (fetchErr) {
      console.warn("Could not fetch transaction logs:", fetchErr);
    }
    throw err;
  }

  return sig;
}

/* -------------------------------------------------------------------------- */
/*                          TOKEN ACCOUNT HELPERS                             */
/* -------------------------------------------------------------------------- */

/**
 * Requests an airdrop of SOL (devnet/testnet only).
 *
 * @param connection - Solana connection.
 * @param recipient - Recipient public key.
 * @param solAmount - Amount of SOL to airdrop.
 */
export async function airdropSol(
  connection: Connection,
  recipient: anchor.web3.PublicKey,
  solAmount: number
) {
  const airdropSignature = await connection.requestAirdrop(
    recipient,
    solAmount * anchor.web3.LAMPORTS_PER_SOL
  );
  await connection.confirmTransaction(airdropSignature);
  console.log(`Funded ${solAmount} SOL to ${recipient.toBase58()}`);
}

/**
 * Transfers USDC between borrower and liquidator accounts.
 *
 * @param connection - Solana connection.
 * @param provider - Anchor provider.
 * @param funderWallet - Wallet object providing and signing for the USDC transfer.
 * @param recipientKeypair - Keypair of the recipient (e.g. liquidator).
 * @param usdcMint - USDC mint address.
 * @param amount - Amount of USDC to transfer.
 */
export async function fundLiquidatorWithUsdc(
  connection: Connection,
  funderWallet: any,
  recipientKeypair: anchor.web3.Keypair,
  usdcMint: Address,
  amount: number
) {
  const payer = funderWallet.payer;
  const usdcMintPublicKey = new PublicKey(usdcMint);
  const borrowerUsdcAta = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    usdcMintPublicKey,
    funderWallet.publicKey
  );

  const liquidatorUsdcAta = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    usdcMintPublicKey,
    recipientKeypair.publicKey
  );

  await transfer(
    connection,
    payer,
    borrowerUsdcAta.address,
    liquidatorUsdcAta.address,
    funderWallet.publicKey,
    amount * 1e6 // amount in USDC (6 decimals)
  );

  console.log(`Transferred ${amount} USDC to liquidator (${liquidatorUsdcAta.address.toBase58()})`);
}

/* -------------------------------------------------------------------------- */
/*                         DATA & COMPUTATION HELPERS                         */
/* -------------------------------------------------------------------------- */

/**
 * Shorthand helper for BN creation.
 *
 * @param x - Number or string to convert.
 * @returns BN instance.
 */
export function bn(x: number | string) { return new BN(String(x)); }


/**
 * Extracts and normalizes an asset’s metadata and pricing
 * from a Kamino obligation or reserve.
 *
 * Converts Kamino’s internal fixed-point price (2^60) into a 1e8-scaled integer.
 *
 * @param loadedMarket - Loaded Kamino market.
 * @param reserveAddr - Reserve address.
 * @param amount - Amount of the asset.
 * @param isCollateral - Whether the asset is collateral.
 * @returns Normalized asset data or null if invalid.
 */

export async function extractAssetFromObligation(
  loadedMarket: any,
  reserveAddr: string,
  amount: any,
  isCollateral: boolean = false
) {
  const reserve = loadedMarket.getReserveByAddress(reserveAddr);
  if (!reserve) return null;

  const reserveState = reserve.state;
  let amtBN;
  if (amount && typeof amount === 'object' && amount.toString) {
    console.log('Converting object to string:', amount.toString());
    const amountStr = amount.toString();
    if (amountStr.includes('.')) {
      const integerPart = amountStr.split('.')[0];
      amtBN = new BN(integerPart);
    } else {
      amtBN = new BN(amountStr);
    }
  } else {
    console.error('Invalid amount format:', amount);
    return null;
  }

  if (amtBN.lte(new BN(0))) return null;

  // Convert marketPriceSf (2^60-scaled) to priceE8 (1e8-scaled)
  const marketPriceSf = reserveState.liquidity.marketPriceSf;
  const scaleFactor = new BN(2).pow(new BN(60));
  const priceE8 = marketPriceSf.mul(new BN(1e8)).div(scaleFactor);

  // Debug print
  const humanPrice = priceE8.toNumber() / 1e8;
  console.log(`Reserve ${reserveAddr} → price: $${humanPrice.toFixed(4)}`);

  const baseData = {
    amount: amtBN,
    decimals: reserveState.liquidity.mintDecimals.toNumber(),
    priceE8,
  };

  if (isCollateral) {
    const ltv = new BN(reserveState.config.loanToValuePct.toString());
    const liqThresholdBps = ltv.lte(new BN(100)) ? ltv.muln(100) : ltv;
    return {
      ...baseData,
      liqThresholdBps,
      borrowFactorBps: new BN(0),
    };
  }

  return baseData;
}

/**
 * Converts a Q64.64 fixed-point health factor (HF)
 * into a floating-point decimal representation.
 *
 * @param hfState - Object containing a `lastHfQ64` field.
 * @returns Health factor as a floating-point number.
 */
export function convertHfQ64ToDecimal(hfState: any): number {
  // Convert Q64.64 format to decimal
  const hfQ64 = BigInt(hfState.lastHfQ64.toString());
  const integerPart = hfQ64 >> BigInt(64);
  const fractionalPart = hfQ64 & ((BigInt(1) << BigInt(64)) - BigInt(1));

  return Number(integerPart) + Number(fractionalPart) / 2 ** 64;
}