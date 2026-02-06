import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Connection, PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Program, AnchorProvider, Wallet, setProvider } from '@coral-xyz/anchor';
import BN from 'bn.js';
import * as bs58 from 'bs58';
import { readFileSync } from 'fs';
import idl from './idl.json' with { type: 'json' };
// === Configuration ===
const DEVNET_PROGRAM_ID = 'G59nkJ7khC1aKMr6eaRX1SssfeUuP7Ln8BpDj7ELkkcu';
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
const PORT = parseInt(process.env.PORT || '3000', 10);
const AUTHORITY_KEYPAIR_PATH = process.env.AUTHORITY_KEYPAIR || `${process.env.HOME}/.config/solana/agentbets.json`;
const AUTHORITY_PRIVATE_KEY = process.env.AUTHORITY_PRIVATE_KEY; // Base58 or JSON array
// === Initialize Solana Connection ===
const connection = new Connection(RPC_URL, 'confirmed');
const programId = new PublicKey(DEVNET_PROGRAM_ID);
// Load authority wallet (for creating markets, resolving)
// Priority: env var AUTHORITY_PRIVATE_KEY > file path
let authorityWallet = null;
try {
    if (AUTHORITY_PRIVATE_KEY) {
        // Try base58 first, then JSON array
        try {
            authorityWallet = Keypair.fromSecretKey(bs58.default.decode(AUTHORITY_PRIVATE_KEY));
        }
        catch {
            const keypairData = JSON.parse(AUTHORITY_PRIVATE_KEY);
            authorityWallet = Keypair.fromSecretKey(Uint8Array.from(keypairData));
        }
        console.log(`Authority wallet loaded from env: ${authorityWallet.publicKey.toBase58()}`);
    }
    else {
        const keypairData = JSON.parse(readFileSync(AUTHORITY_KEYPAIR_PATH, 'utf-8'));
        authorityWallet = Keypair.fromSecretKey(Uint8Array.from(keypairData));
        console.log(`Authority wallet loaded from file: ${authorityWallet.publicKey.toBase58()}`);
    }
}
catch (e) {
    console.log('Warning: Authority keypair not found. Market creation/resolution disabled.');
}
// Create provider for program interactions
const wallet = authorityWallet ? new Wallet(authorityWallet) : new Wallet(Keypair.generate());
const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
setProvider(provider);
// Fix IDL address for devnet
const fixedIdl = { ...idl, address: DEVNET_PROGRAM_ID };
// @ts-ignore - Anchor dynamic IDL typing
const program = new Program(fixedIdl, provider);
// === Hono App ===
const app = new Hono();
// Enable CORS for all origins (agents calling from anywhere)
app.use('*', cors());
// Health check
app.get('/', (c) => {
    return c.json({
        name: 'AgentBets API',
        version: '0.1.0',
        network: 'devnet',
        programId: DEVNET_PROGRAM_ID,
        endpoints: {
            'GET /markets': 'List all markets',
            'GET /markets/:id': 'Get market details',
            'POST /markets': 'Create a new market (authority only)',
            'POST /markets/:id/bet': 'Place a bet (requires signed tx)',
        },
    });
});
// === Market Endpoints ===
// List all markets
app.get('/markets', async (c) => {
    try {
        const markets = await program.account.market.all();
        return c.json({
            markets: markets.map((m) => formatMarket(m.publicKey, m.account)),
            count: markets.length,
        });
    }
    catch (error) {
        console.error('Error fetching markets:', error);
        return c.json({ error: 'Failed to fetch markets' }, 500);
    }
});
// Get single market
app.get('/markets/:id', async (c) => {
    const marketId = c.req.param('id');
    try {
        // Try to parse as pubkey first
        let marketPubkey;
        try {
            marketPubkey = new PublicKey(marketId);
        }
        catch {
            // If not a pubkey, derive from market_id string
            const [pda] = PublicKey.findProgramAddressSync([Buffer.from('market'), Buffer.from(marketId)], programId);
            marketPubkey = pda;
        }
        const market = await program.account.market.fetch(marketPubkey);
        return c.json({
            market: formatMarket(marketPubkey, market),
        });
    }
    catch (error) {
        console.error('Error fetching market:', error);
        return c.json({ error: 'Market not found' }, 404);
    }
});
// Create market (authority only)
app.post('/markets', async (c) => {
    if (!authorityWallet) {
        return c.json({ error: 'Authority wallet not configured' }, 503);
    }
    try {
        const body = await c.req.json();
        const { marketId, question, outcomes, resolutionTime } = body;
        if (!marketId || !question || !outcomes || !resolutionTime) {
            return c.json({
                error: 'Missing required fields: marketId, question, outcomes, resolutionTime'
            }, 400);
        }
        if (outcomes.length < 2 || outcomes.length > 10) {
            return c.json({ error: 'Outcomes must be between 2-10' }, 400);
        }
        // Derive market PDA
        const [marketPda] = PublicKey.findProgramAddressSync([Buffer.from('market'), Buffer.from(marketId)], programId);
        // Create market
        const tx = await program.methods
            .createMarket(marketId, question, outcomes, new BN(resolutionTime))
            .accounts({
            market: marketPda,
            authority: authorityWallet.publicKey,
            systemProgram: SystemProgram.programId,
        })
            .signers([authorityWallet])
            .rpc();
        console.log(`Market created: ${marketId} (tx: ${tx})`);
        return c.json({
            success: true,
            marketId,
            marketPubkey: marketPda.toBase58(),
            txSignature: tx,
        });
    }
    catch (error) {
        console.error('Error creating market:', error);
        return c.json({ error: String(error) }, 500);
    }
});
// Place a bet
// For agents: they sign the tx themselves and submit
// For convenience: we can build an unsigned tx for them to sign
app.post('/markets/:id/bet', async (c) => {
    const marketId = c.req.param('id');
    try {
        const body = await c.req.json();
        const { outcomeIndex, amount, buyerPubkey, signedTx } = body;
        // Get market pubkey
        let marketPubkey;
        try {
            marketPubkey = new PublicKey(marketId);
        }
        catch {
            const [pda] = PublicKey.findProgramAddressSync([Buffer.from('market'), Buffer.from(marketId)], programId);
            marketPubkey = pda;
        }
        // If signed tx provided, submit it
        if (signedTx) {
            const txBuffer = Buffer.from(signedTx, 'base64');
            const sig = await connection.sendRawTransaction(txBuffer);
            await connection.confirmTransaction(sig, 'confirmed');
            return c.json({
                success: true,
                txSignature: sig,
            });
        }
        // Otherwise, build unsigned tx for agent to sign
        if (outcomeIndex === undefined || !amount || !buyerPubkey) {
            return c.json({
                error: 'Missing required fields: outcomeIndex, amount, buyerPubkey (or signedTx)'
            }, 400);
        }
        const buyer = new PublicKey(buyerPubkey);
        // Derive position PDA
        const [positionPda] = PublicKey.findProgramAddressSync([Buffer.from('position'), marketPubkey.toBuffer(), buyer.toBuffer()], programId);
        // Build instruction
        const ix = await program.methods
            .buyShares(outcomeIndex, new BN(amount))
            .accounts({
            market: marketPubkey,
            position: positionPda,
            buyer,
            systemProgram: SystemProgram.programId,
        })
            .instruction();
        // Build transaction
        const { blockhash } = await connection.getLatestBlockhash();
        const tx = new (await import('@solana/web3.js')).Transaction({
            recentBlockhash: blockhash,
            feePayer: buyer,
        }).add(ix);
        // Return serialized unsigned tx
        const serialized = tx.serialize({
            requireAllSignatures: false,
            verifySignatures: false,
        }).toString('base64');
        return c.json({
            unsignedTx: serialized,
            marketPubkey: marketPubkey.toBase58(),
            positionPda: positionPda.toBase58(),
            message: 'Sign this transaction with your wallet and submit via signedTx field',
        });
    }
    catch (error) {
        console.error('Error placing bet:', error);
        return c.json({ error: String(error) }, 500);
    }
});
// Get position for a user in a market
app.get('/markets/:id/position/:owner', async (c) => {
    const marketId = c.req.param('id');
    const owner = c.req.param('owner');
    try {
        let marketPubkey;
        try {
            marketPubkey = new PublicKey(marketId);
        }
        catch {
            const [pda] = PublicKey.findProgramAddressSync([Buffer.from('market'), Buffer.from(marketId)], programId);
            marketPubkey = pda;
        }
        const ownerPubkey = new PublicKey(owner);
        const [positionPda] = PublicKey.findProgramAddressSync([Buffer.from('position'), marketPubkey.toBuffer(), ownerPubkey.toBuffer()], programId);
        const position = await program.account.position.fetch(positionPda);
        return c.json({
            position: {
                pubkey: positionPda.toBase58(),
                owner: position.owner.toBase58(),
                market: position.market.toBase58(),
                shares: position.shares.map((s) => s.toString()),
            },
        });
    }
    catch (error) {
        return c.json({ error: 'Position not found' }, 404);
    }
});
// Resolve market (authority only)
app.post('/markets/:id/resolve', async (c) => {
    if (!authorityWallet) {
        return c.json({ error: 'Authority wallet not configured' }, 503);
    }
    const marketId = c.req.param('id');
    try {
        const body = await c.req.json();
        const { winningOutcome } = body;
        if (winningOutcome === undefined) {
            return c.json({ error: 'Missing winningOutcome' }, 400);
        }
        let marketPubkey;
        try {
            marketPubkey = new PublicKey(marketId);
        }
        catch {
            const [pda] = PublicKey.findProgramAddressSync([Buffer.from('market'), Buffer.from(marketId)], programId);
            marketPubkey = pda;
        }
        const tx = await program.methods
            .resolveMarket(winningOutcome)
            .accounts({
            market: marketPubkey,
            authority: authorityWallet.publicKey,
        })
            .signers([authorityWallet])
            .rpc();
        return c.json({
            success: true,
            txSignature: tx,
        });
    }
    catch (error) {
        console.error('Error resolving market:', error);
        return c.json({ error: String(error) }, 500);
    }
});
// === Helper Functions ===
function formatMarket(pubkey, account) {
    const totalPool = account.totalPool.toNumber();
    const outcomePools = account.outcomePools.map((p) => p.toNumber());
    // Calculate implied probabilities
    const probabilities = outcomePools.map((pool) => totalPool > 0 ? pool / totalPool : 1 / account.outcomes.length);
    return {
        pubkey: pubkey.toBase58(),
        marketId: account.marketId,
        question: account.question,
        outcomes: account.outcomes,
        outcomePools: outcomePools.map((p) => (p / LAMPORTS_PER_SOL).toFixed(4)),
        totalPoolSol: (totalPool / LAMPORTS_PER_SOL).toFixed(4),
        probabilities: probabilities.map((p) => (p * 100).toFixed(1) + '%'),
        resolutionTime: account.resolutionTime.toNumber(),
        resolutionDate: new Date(account.resolutionTime.toNumber() * 1000).toISOString(),
        resolved: account.resolved,
        winningOutcome: account.winningOutcome,
        authority: account.authority.toBase58(),
        createdAt: new Date(account.createdAt.toNumber() * 1000).toISOString(),
    };
}
// === Start Server ===
console.log(`Starting AgentBets API on port ${PORT}...`);
console.log(`Program ID: ${DEVNET_PROGRAM_ID}`);
console.log(`RPC: ${RPC_URL}`);
serve({
    fetch: app.fetch,
    port: PORT,
});
console.log(`AgentBets API running at http://localhost:${PORT}`);
