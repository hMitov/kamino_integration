import {
    KaminoAction,
    VanillaObligation,
    KaminoMarket,
    KaminoReserve,
    refreshReserve,
    PROGRAM_ID
} from "@kamino-finance/klend-sdk";
import { BN } from "bn.js";
import { some, none, Rpc, SolanaRpcApi, RpcSubscriptions, SlotNotificationsApi, SignatureNotificationsApi, Address, KeyPairSigner } from "@solana/kit";
import { isNotNullPubkey } from "@kamino-finance/klend-sdk";
import { sendAndConfirmTx } from '../utils/kamino-utils';

const EXTRA_COMPUTE_BUDGET = 300000;

/**
 * Executes a deposit transaction on Kamino using the provided reserve.
 *
 * Builds and sends the full sequence of deposit-related instructions,
 * including setup, lending, and cleanup phases.
 *
 * @param depositAmount - Amount of the token (in smallest units, e.g. lamports) to deposit.
 * @param loadedMarket - Loaded {@link KaminoMarket} instance.
 * @param solReserve - Target reserve where tokens will be deposited.
 * @param signer - Transaction signer / wallet performing the deposit.
 * @param rpc - Solana RPC client.
 * @param wsRpc - WebSocket RPC subscription client for confirmations.
 */

export async function executeKaminoDeposit(
    depositAmount: number,
    loadedMarket: KaminoMarket,
    solReserve: KaminoReserve,
    signer: any,
    rpc: Rpc<SolanaRpcApi>,
    wsRpc: RpcSubscriptions<SignatureNotificationsApi & SlotNotificationsApi>,
) {
    const depositAction = await KaminoAction.buildDepositTxns(
        loadedMarket,
        new BN(depositAmount),
        solReserve.getLiquidityMint(),
        signer,
        new VanillaObligation(PROGRAM_ID),
        false,
        undefined,
        EXTRA_COMPUTE_BUDGET,
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
        'deposit'
    );
}

/**
 * Creates a list of refresh instructions for a given set of reserves.
 *
 * This ensures price oracles (Pyth or Scope) are refreshed before performing
 * dependent actions (e.g. borrowing or liquidation).
 *
 * @param loadedMarket - Loaded {@link KaminoMarket} instance.
 * @param reserves - Array of {@link KaminoReserve} objects to refresh.
 * @returns Array of Solana instructions to refresh reserve price data.
 */
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

/**
 * Executes a borrow transaction on Kamino.
 *
 * Builds, signs, and sends the transaction to borrow a specified amount
 * of an asset (e.g. USDC) from the lending market.
 *
 * @param borrowAmount - Amount to borrow (in smallest units, e.g. 1 USDC = 1_000_000).
 * @param loadedMarket - Loaded {@link KaminoMarket} instance.
 * @param usdcReserve - Reserve from which tokens will be borrowed.
 * @param signer - Wallet performing the borrow.
 * @param rpc - Solana RPC client.
 * @param wsRpc - WebSocket RPC for transaction confirmation.
 * @param refreshInstructions - Preceding refresh instructions for up-to-date oracle data.
 */
export async function executeKaminoBorrow(
    borrowAmount: number,
    loadedMarket: KaminoMarket,
    usdcReserve: KaminoReserve,
    signer: any,
    rpc: Rpc<SolanaRpcApi>,
    wsRpc: RpcSubscriptions<SignatureNotificationsApi & SlotNotificationsApi>,
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
        "borrow"
    );
}

/**
 * Executes a liquidation on Kamino, repaying a borrower’s debt
 * in exchange for part of their collateral.
 *
 * The liquidator repays `repayAmount` of the debt asset and receives
 * a proportional amount of the collateral asset (`minCollateralReceiveAmount`).
 *
 * @param loadedMarket - Loaded {@link KaminoMarket} instance.
 * @param repayAmount - Amount of debt token (e.g. USDC) to repay (in smallest units).
 * @param minCollateralReceiveAmount - Minimum acceptable amount of collateral to receive (e.g. in lamports).
 * @param usdcReserve - Debt reserve (the asset being repaid).
 * @param solReserve - Collateral reserve (the asset being seized).
 * @param liquidator - Liquidator signer performing the liquidation.
 * @param obligationOwner - Address of the borrower being liquidated.
 * @param rpc - Solana RPC client.
 * @param wsRpc - WebSocket RPC for confirmations.
 */
export async function executeKaminoLiquidation(
    loadedMarket: KaminoMarket,
    repayAmount: number,
    minCollateralReceiveAmount: number,
    usdcReserve: KaminoReserve,
    solReserve: KaminoReserve,
    liquidator: KeyPairSigner,
    obligationOwner: Address,
    rpc: Rpc<SolanaRpcApi>,
    wsRpc: RpcSubscriptions<SignatureNotificationsApi & SlotNotificationsApi>,
) {
    const obligation = await loadedMarket.getUserVanillaObligation(obligationOwner);

    const liquidationAction = await KaminoAction.buildLiquidateTxns(
        loadedMarket,
        new BN(repayAmount),                         
        new BN(minCollateralReceiveAmount),           
        usdcReserve.getLiquidityMint(),       // Repay token
        solReserve.getLiquidityMint(),        // Collateral token
        liquidator,                           
        obligationOwner,                      
        obligation,    
        false,                           
        undefined,                            
        EXTRA_COMPUTE_BUDGET,                            
        true,                                
        false,                                
        { skipInitialization: true, skipLutCreation: true },
        none(),                               
        0,                                    
        BigInt(0)                              
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
        "liquidation"
    );
}

/**
 * Simple delay to allow Kamino on-chain state to sync between
 * market refreshes and subsequent read/write operations.
 */
export async function waitForMarketSync() {
    await new Promise((r) => setTimeout(r, 5000));
}