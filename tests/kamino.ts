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

export async function waitForMarketSync() {
    await new Promise((r) => setTimeout(r, 5000));
}