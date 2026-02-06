import { PublicKey } from '@solana/web3.js';
import type { Market, Position, CreateMarketParams, TradeParams } from './types.js';
/**
 * AgentBets client - handles all interactions with the Solana program
 *
 * TODO: Integrate with actual Anchor program once deployed
 */
export declare class AgentBetsClient {
    private connection;
    private wallet;
    private programId;
    constructor(rpcUrl?: string, programId?: string);
    /**
     * Load wallet from keypair file
     */
    loadWallet(keypairPath: string): Promise<void>;
    /**
     * Get all active markets
     */
    getMarkets(): Promise<Market[]>;
    /**
     * Get a specific market by ID
     */
    getMarket(marketId: string): Promise<Market | null>;
    /**
     * Get user's positions across all markets
     */
    getPositions(owner?: PublicKey): Promise<Position[]>;
    /**
     * Buy shares in a market outcome
     */
    buyShares(params: TradeParams): Promise<string>;
    /**
     * Sell shares in a market outcome
     */
    sellShares(params: TradeParams): Promise<string>;
    /**
     * Create a new prediction market (oracle only)
     */
    createMarket(params: CreateMarketParams): Promise<{
        marketId: string;
        txSignature: string;
    }>;
    /**
     * Resolve a market (oracle only)
     */
    resolveMarket(marketId: string, winningOutcome: number): Promise<string>;
}
export declare function getClient(): AgentBetsClient;
