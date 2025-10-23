// tests/kamino.ts
import {
    KaminoAction,
    VanillaObligation,
    KaminoMarket,
    KaminoReserve,
    refreshReserve,
    PROGRAM_ID
} from "@kamino-finance/klend-sdk";
import { BN } from "bn.js";
import { some, none } from "@solana/kit";
import { isNotNullPubkey } from "@kamino-finance/klend-sdk";
import { sendAndConfirmTx } from './utils/kamino-utils';

export async function executeKaminoDeposit(
    depositAmount: number,
    loadedMarket: KaminoMarket,
    solReserve: KaminoReserve,
    signer: any,
    rpc: any,
    wsRpc: any
) {
    const depositAction = await KaminoAction.buildDepositTxns(
        loadedMarket,
        new BN(depositAmount),
        solReserve.getLiquidityMint(),
        signer,
        new VanillaObligation(PROGRAM_ID),
        false,
        undefined,
        300_000,
        true
    );

    await sendAndConfirmTx(
        { rpc, wsRpc },
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
}

export function createRefreshInstructions(
    loadedMarket: KaminoMarket,
    reserves: KaminoReserve[]
) {
    return reserves.map(reserve =>
        refreshReserve({
            lendingMarket: loadedMarket.getAddress(),
            reserve: reserve.address,
            pythOracle: isNotNullPubkey(reserve.state.config.tokenInfo.pythConfiguration.price) ?
                some(reserve.state.config.tokenInfo.pythConfiguration.price) : none(),
            switchboardPriceOracle: none(),
            switchboardTwapOracle: none(),
            scopePrices: isNotNullPubkey(reserve.state.config.tokenInfo.scopeConfiguration.priceFeed) ?
                some(reserve.state.config.tokenInfo.scopeConfiguration.priceFeed) : none(),
        }, undefined, loadedMarket.programId)
    );
}

export async function executeKaminoBorrow(
    borrowAmount: number,
    loadedMarket: KaminoMarket,
    usdcReserve: KaminoReserve,
    signer: any,
    rpc: any,
    wsRpc: any,
    refreshInstructions: any[]
) {
    const borrowAction = await KaminoAction.buildBorrowTxns(
        loadedMarket,
        new BN(borrowAmount),
        usdcReserve.getLiquidityMint(),
        signer,
        new VanillaObligation(PROGRAM_ID),
        true,
        undefined,
    );

    await sendAndConfirmTx(
        { rpc, wsRpc },
        signer,
        [
            ...refreshInstructions,
            ...KaminoAction.actionToIxs(borrowAction),
        ],
        [],
        [],
        "borrow"
    );
}

export async function executeKaminoLiquidation(
    loadedMarket: KaminoMarket,
    repayAmount: number,
    minCollateralReceiveAmount: number,
    usdcReserve: KaminoReserve,
    solReserve: KaminoReserve,
    liquidator: any,
    obligationOwner: any,
    rpc: any,
    wsRpc: any
) {
    const obligation = await loadedMarket.getUserVanillaObligation(obligationOwner);

    const liquidationAction = await KaminoAction.buildLiquidateTxns(
        loadedMarket,
        new BN(repayAmount),                         // how much USDC you repay
        new BN(minCollateralReceiveAmount),           // min SOL you expect to receive
        usdcReserve.getLiquidityMint(),       // repayTokenMint
        solReserve.getLiquidityMint(),        // withdrawTokenMint (collateral)
        liquidator,                           // liquidator signer
        obligationOwner,                      // borrower's address
        obligation,    // obligation type
        false,                                 // useV2Ixs
        undefined,                            // scopeRefreshConfig
        0,                            // extra compute budget
        true,                                 // include ATA ixs
        false,                                // requestElevationGroup
        { skipInitialization: true, skipLutCreation: true },
        none(),                               // referrer
        0,                                    // maxAllowedLtvOverridePercent
        BigInt(0)                              // current slot
    );

    await sendAndConfirmTx(
        { rpc, wsRpc },
        liquidator,
        [
            ...liquidationAction.computeBudgetIxs,
            ...liquidationAction.setupIxs,
            ...liquidationAction.lendingIxs,
            ...liquidationAction.cleanupIxs,
        ],
        [],
        [],
        "liquidation"
    );
}

export async function waitForMarketSync() {
    await new Promise((r) => setTimeout(r, 5000));
}