import { PublicKey } from '@solana/web3.js';
/**
 * Market state from the Anchor program
 */
export interface Market {
    publicKey: PublicKey;
    authority: PublicKey;
    oracle: PublicKey;
    question: string;
    outcomes: string[];
    endTime: number;
    resolved: boolean;
    winningOutcome: number | null;
    totalShares: number[];
    liquidity: number;
}
/**
 * User position in a market
 */
export interface Position {
    market: PublicKey;
    owner: PublicKey;
    shares: number[];
    costBasis: number;
}
/**
 * Market creation parameters
 */
export interface CreateMarketParams {
    question: string;
    outcomes: string[];
    endTime: Date;
    initialLiquidity: number;
}
/**
 * Trade parameters
 */
export interface TradeParams {
    marketId: string;
    outcome: number;
    amount: number;
}
