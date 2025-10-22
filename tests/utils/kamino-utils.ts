import * as anchor from "@coral-xyz/anchor";
import { Transaction, SystemProgram, Connection } from "@solana/web3.js";
import { KaminoMarket, DEFAULT_RECENT_SLOT_DURATION_MS } from "@kamino-finance/klend-sdk";
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
} from '@solana/kit';
import {
  getOrCreateAssociatedTokenAccount,
  createSyncNativeInstruction,
  NATIVE_MINT,
} from "@solana/spl-token";
import { BlockhashWithHeight, MarketArgs, ReserveArgs } from "../types/kamino-types";
import BN from "bn.js";

const API_KAMINO_SLOTS_DURATION = 'https://api.kamino.finance/slots/duration';

export async function getMedianSlotDurationInMsFromLastEpochs() {
  try {
    console.log(`Fetching slot duration from Kamino API...`);
    const response = await axios.get<{ recentSlotDurationInMs: number }>(API_KAMINO_SLOTS_DURATION);
    const duration = response.data.recentSlotDurationInMs;
    console.log(`Retrieved slot duration: ${duration}ms`);
    return duration;
  } catch (error) {
    console.error(`Error fetching slot duration:`, error);
    console.log(`Using fallback slot duration: ${DEFAULT_RECENT_SLOT_DURATION_MS}ms`);
    return DEFAULT_RECENT_SLOT_DURATION_MS;
  }
}

export async function getMarket({ rpc, marketPubkey }: MarketArgs) {
  try {
    console.log(`Getting slot duration from Kamino API`);
    const slotDuration = await getMedianSlotDurationInMsFromLastEpochs();
    console.log(`Slot duration: ${slotDuration}ms`);

    console.log(`Loading Kamino market...`);
    const market = await KaminoMarket.load(rpc, marketPubkey, slotDuration);

    if (!market) {
      throw new Error(`Could not load market ${marketPubkey.toString()}`);
    }

    // Add validation to ensure market is properly initialized
    if (!market.address) {
      throw new Error(`Market loaded but address is undefined`);
    }

    console.log(`Market loaded successfully`);
    return market;
  } catch (error) {
    console.error(`Error in getMarket:`, error);
    throw error;
  }
}

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

    console.log(`Getting current slot`);
    const currentSlot = await rpc.getSlot().send();

    console.log(`Successfully loaded market and reserve data`);
    return { market, reserve, currentSlot };
  } catch (error) {
    console.error(`Error in loadReserveData:`, error);
    throw error;
  }
}

export function initRpc(rpcUrl: string): Rpc<SolanaRpcApi> {
  const api = createSolanaRpcApi<SolanaRpcApi>({
    ...DEFAULT_RPC_CONFIG,
    defaultCommitment: 'processed',
  });
  return createRpc({ api, transport: createDefaultRpcTransport({ url: rpcUrl }) });
}

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
  console.log("blockhash: ", blockhash);
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
    await sendAndConfirm(tx, {
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

export async function fetchBlockhash(rpc: Rpc<GetLatestBlockhashApi>): Promise<BlockhashWithHeight> {
  const res = await rpc.getLatestBlockhash({ commitment: 'processed' }).send();
  return {
    blockhash: res.value.blockhash,
    lastValidBlockHeight: res.value.lastValidBlockHeight,
    slot: res.context.slot,
  };
}

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

export async function wrapSol(connection: Connection, provider: anchor.AnchorProvider, wallet: any, solAmount: number) {
  const wsolAta = await getOrCreateAssociatedTokenAccount(
    connection,
    wallet.payer,
    NATIVE_MINT, // this is wSOL mint
    wallet.publicKey
  );

  const wrapTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: wsolAta.address,
      lamports: solAmount,
    }),
    // Sync account to mark lamports as token balance
    createSyncNativeInstruction(wsolAta.address)
  );

  await provider.sendAndConfirm(wrapTx);
  console.log(`Wrapped ${solAmount / 1e9} SOL into wSOL ATA: ${wsolAta.address}`);
}

export function bn(x: number | string) { return new BN(String(x)); }

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