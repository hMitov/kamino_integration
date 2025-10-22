import type { Blockhash, Rpc, SolanaRpcApi } from '@solana/kit';
import type { Address } from '@solana/addresses';

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

  export type BlockhashWithHeight = { blockhash: Blockhash; lastValidBlockHeight: bigint; slot: bigint };
