import type { Blockhash, Rpc, SolanaRpcApi } from '@solana/kit';
import type { Address } from '@solana/addresses';

/**
 * Arguments required to fetch or initialize a specific Kamino Reserve.
 *
 * A **Reserve** represents a single lending pool inside a Kamino market,
 * associated with one specific token mint (e.g. USDC, SOL, wBTC, etc.).
 */
export interface ReserveArgs {
  /**
   * web3 connection to your RPC
   */
  rpc: Rpc<SolanaRpcApi>;
  /**
   * Public Key of the Kamino Market (e.g. main market pubkey: 7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF)
   */
  marketPubkey: Address;
  /**
   * Public Key of the reserve's token mint (e.g. For SOL reserve, SOL mint pubkey: So11111111111111111111111111111111111111112)
   */
  mintPubkey: Address;
}

/**
 * Arguments for interacting with a Kamino Lending Market.
 *
 * A **Market** represents the global configuration
 * and set of all reserves (pools) under a single authority.
 */
export interface MarketArgs {
  /**
   * web3 connection to your RPC
   */
  rpc: Rpc<SolanaRpcApi>;
  /**
   * Public Key of the Kamino Market (e.g. main market pubkey: 7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF)
   */
  marketPubkey: Address;
}

/**
 * Utility type representing a Solana blockhash response together with
 * its expiry metadata and slot.
 *
 * Useful for constructing recent transaction messages
 * and for handling blockhash expiration logic.
 */
export type BlockhashWithHeight = {
  /** Recent blockhash used for signing transactions */
  blockhash: Blockhash;
  /** Last valid block height before blockhash expiration */
  lastValidBlockHeight: bigint;
  /** Slot number at which this blockhash was observed */
  slot: bigint
};
