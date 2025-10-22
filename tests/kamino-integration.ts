import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { KaminoIntegration } from "../target/types/kamino_integration";
import { BN } from "bn.js";
import { expect } from "chai";
import {
  KaminoAction,
  VanillaObligation,
  PROGRAM_ID,
  getAllOracleAccounts,
  refreshReserve,
  refreshObligation,
  isNotNullPubkey,
  KaminoObligation,
  KaminoMarket,
  Obligation,
  ObligationType,
  KaminoReserve,
  getTokenIdsForScopeRefresh
} from "@kamino-finance/klend-sdk";
import { Scope } from "@kamino-finance/scope-sdk";

import { PublicKey, SystemProgram, TransactionInstruction, AccountMeta } from "@solana/web3.js";
import { address } from '@solana/addresses';
import type { Address } from '@solana/addresses';
import { AccountRole, createKeyPairSignerFromBytes, none, Option, some, TransactionSigner } from "@solana/kit";
import { loadReserveData, sendAndConfirmTx, setUpConnections, wrapSol, extractAssetFromObligation, bn } from './utils/helpers';

const MAIN_MARKET_ADDRESS: Address = address("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");
const SOL_MINT_ADDRESS: Address = address("So11111111111111111111111111111111111111112");
const USDC_MINT_ADDRESS: Address = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

describe("kamino_integration with deposit and withdraw", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.KaminoIntegration as Program<KaminoIntegration>;
  const wallet = provider.wallet;
  const connection = provider.connection;

  const url = new URL(connection.rpcEndpoint);
  const { rpc, ws } = setUpConnections(url);

  let hfStatePda: PublicKey;
  let signer: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>;

  before(async () => {
    const solAmount = 2 * 1_000_000_000 // 2 SOL
    wrapSol(connection, provider, wallet, solAmount);

    console.log("Loading market data...");

    const { market: loadedMarket, reserve: solReserve }: { market: KaminoMarket; reserve: KaminoReserve } = await loadReserveData({
      rpc: rpc,
      marketPubkey: MAIN_MARKET_ADDRESS,
      mintPubkey: SOL_MINT_ADDRESS,
    });

    // Assign to the outer scope variable
    [hfStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("hf"), wallet.publicKey.toBuffer()],
      program.programId
    );
    await new Promise((r) => setTimeout(r, 5000));

    await loadedMarket.loadReserves();
    await loadedMarket.refreshAll();

    signer = await createKeyPairSignerFromBytes(wallet.payer.secretKey);

    const depositAction = await KaminoAction.buildDepositTxns(
      loadedMarket,
      new BN(1_000_000_000),
      solReserve.getLiquidityMint(),
      signer,
      new VanillaObligation(PROGRAM_ID),
      false,
      undefined,
      300_000,
      true
    );

    await sendAndConfirmTx(
      { rpc, wsRpc: ws },
      signer,
      [
        ...depositAction.computeBudgetIxs,
        ...depositAction.setupIxs,
        ...depositAction.lendingIxs,
        ...depositAction.cleanupIxs,
      ],
      [],
      [],
      'deposit'
    );

    console.log("Borrowing USDC against deposited wSOL...");

    const { reserve: usdcReserve } = await loadReserveData({
      rpc: rpc,
      marketPubkey: MAIN_MARKET_ADDRESS,
      mintPubkey: USDC_MINT_ADDRESS,
    });

    // Refresh reserves before borrowing
    const refreshSolIx = refreshReserve(
      {
        lendingMarket: loadedMarket.getAddress(),
        reserve: solReserve.address,
        pythOracle: isNotNullPubkey(solReserve.state.config.tokenInfo.pythConfiguration.price) ?
          some(solReserve.state.config.tokenInfo.pythConfiguration.price) : none(),
        switchboardPriceOracle: none(),
        switchboardTwapOracle: none(),
        scopePrices: isNotNullPubkey(solReserve.state.config.tokenInfo.scopeConfiguration.priceFeed) ?
          some(solReserve.state.config.tokenInfo.scopeConfiguration.priceFeed) : none(),
      },
      undefined,
      loadedMarket.programId
    );

    const refreshUsdcIx = refreshReserve(
      {
        lendingMarket: loadedMarket.getAddress(),
        reserve: usdcReserve.address,
        pythOracle: isNotNullPubkey(usdcReserve.state.config.tokenInfo.pythConfiguration.price) ?
          some(usdcReserve.state.config.tokenInfo.pythConfiguration.price) : none(),
        switchboardPriceOracle: none(),
        switchboardTwapOracle: none(),
        scopePrices: isNotNullPubkey(usdcReserve.state.config.tokenInfo.scopeConfiguration.priceFeed) ?
          some(usdcReserve.state.config.tokenInfo.scopeConfiguration.priceFeed) : none(),
      },
      undefined,
      loadedMarket.programId
    );

    const borrowAmount = new BN(50_000_000);
    const borrowAction = await KaminoAction.buildBorrowTxns(
      loadedMarket,
      borrowAmount,
      usdcReserve.getLiquidityMint(),
      signer,
      new VanillaObligation(PROGRAM_ID),
      true,
      undefined,
    );

    await sendAndConfirmTx(
      { rpc, wsRpc: ws },
      signer,
      [
        refreshSolIx,
        refreshUsdcIx,
        ...KaminoAction.actionToIxs(borrowAction),
      ],
      [],
      [],
      "borrow"
    );
    console.log("Successfully borrowed 50 USDC!");
  });

  it("computes HF using generic compute_hf", async () => {
    const collaterals = [
      {
        amount: bn(10_000_000_000),    // u64 (10 SOL in base units)
        decimals: 9,                   // u8
        priceE8: bn(18_612_000_000),   // i64 ($150 * 1e8)  <<--- BN, not number/BigInt
        liqThresholdBps: 8500,         // u16
        borrowFactorBps: 0,            // u16
      },
    ];

    const debts = [
      {
        amount: bn(5_000_000),     // u64 (5 USDC)
        decimals: 6,                   // u8
        priceE8: bn(500_000_000),      // i64 ($1 * 1e8)   <<--- BN
      },
    ];

    await program.methods
      .computeHf({
        collaterals: collaterals.map(c => ({
          amount: c.amount,
          decimals: c.decimals,
          priceE8: c.priceE8,
          liqThresholdBps: c.liqThresholdBps,
          borrowFactorBps: c.borrowFactorBps,
        })),
        debts: debts.map(d => ({
          amount: d.amount,
          decimals: d.decimals,
          priceE8: d.priceE8,
        })),
      })
      .accounts({
        hfState: hfStatePda,
        user: wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const state = await program.account.hfState.fetch(hfStatePda);

    // Convert u128 (BN) → BigInt safely
    const hfQ64 = BigInt(state.lastHfQ64.toString());
    // Split integer and fractional parts from Q64.64
    const integerPart = hfQ64 >> BigInt(64);
    const fractionalPart = hfQ64 & ((BigInt(1) << BigInt(64)) - BigInt(1));
    // Convert to JavaScript float (approx, but safe for this scale)
    const hf = Number(integerPart) + Number(fractionalPart) / 2 ** 64;
    // Log + assert
    console.log(`On-chain HF: ${hf.toFixed(4)}x`);
    expect(hf).to.be.greaterThan(1.0);
  });

  // it("computes HF using live Kamino accounts", async () => {
  //   const { market: loadedMarket } = await loadReserveData({
  //     rpc,
  //     marketPubkey: MAIN_MARKET_ADDRESS,
  //     mintPubkey: SOL_MINT_ADDRESS,
  //   });

  //   // 1️⃣ Load all reserves and prices
  //   await loadedMarket.loadReserves();
  //   await loadedMarket.refreshAll();

  //   // 2️⃣ Get user's obligation (Vanilla type)
  //   const userObligation = await loadedMarket.getUserVanillaObligation(signer.address);
  //   if (!userObligation) throw new Error("User has no Kamino obligation");

  //   // 3️⃣ Extract collateral and debt data from obligation
  //   const collaterals = [];
  //   const debts = [];

  //   // Process deposits (collaterals)
  //   for (const [reserveAddr, depositInfo] of userObligation.deposits.entries()) {
  //     const assetData = extractAssetFromObligation(loadedMarket, reserveAddr, depositInfo.amount, true);
  //     if (assetData) collaterals.push(assetData);
  //   }

  //   // Process borrows (debts)
  //   for (const [reserveAddr, borrowInfo] of userObligation.borrows.entries()) {
  //     const assetData = extractAssetFromObligation(loadedMarket, reserveAddr, borrowInfo.amount, false);
  //     if (assetData) debts.push(assetData);
  //   }

  //   console.log("Extracted Collaterals:", collaterals);
  //   console.log("Extracted Debts:", debts);

  //   // 4️⃣ Call compute_hf with extracted data
  //   await program.methods
  //     .computeHf({
  //       collaterals: collaterals.map(c => ({
  //         amount: c.amount,
  //         decimals: c.decimals,
  //         priceE8: c.priceE8,
  //         liqThresholdBps: c.liqThresholdBps,
  //         borrowFactorBps: c.borrowFactorBps,
  //       })),
  //       debts: debts.map(d => ({
  //         amount: d.amount,
  //         decimals: d.decimals,
  //         priceE8: d.priceE8,
  //       })),
  //     })
  //     .accounts({
  //       hfState: hfStatePda,
  //       user: wallet.publicKey,
  //       systemProgram: SystemProgram.programId,
  //     })
  //     .rpc();

  //   // 5️⃣ Read back the computed HF
  //   const hfState = await program.account.hfState.fetch(hfStatePda);
  //   const hfQ64 = BigInt(hfState.lastHfQ64.toString());

  //   // Convert to decimal
  //   const integerPart = hfQ64 >> BigInt(64);
  //   const fractionalPart = hfQ64 & ((BigInt(1) << BigInt(64)) - BigInt(1));
  //   const hfDecimal = Number(integerPart) + Number(fractionalPart) / 2 ** 64;

  //   console.log(`On-chain Health Factor (Q64.64): ${hfDecimal.toFixed(4)}x`);
  //   expect(hfDecimal).to.be.greaterThan(1.0);
  // });
});
