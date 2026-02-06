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
const DEVNET_PROGRAM_ID = 'FtNvaXJs5ZUbxPPq91XayvM4MauZyPgxJRrV16fGfn6H';
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
            'GET /markets/:id/position/:owner': 'Get position for a user',
            'GET /markets/:id/verify': 'Verify resolution data (agents can check independently)',
            'GET /resolutions/pending': 'List upcoming resolutions + challenge windows',
            'POST /markets': 'Create a new market (authority only)',
            'POST /markets/:id/bet': 'Place a bet (returns unsigned tx to sign)',
            'POST /markets/:id/resolve': 'Resolve market (authority only)',
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
// Get pending resolutions (upcoming + their challenge windows)
app.get('/resolutions/pending', async (c) => {
    try {
        const markets = await program.account.market.all();
        const now = Math.floor(Date.now() / 1000);
        const CHALLENGE_WINDOW_HOURS = 24;
        const pending = markets
            .filter((m) => !m.account.resolved)
            .map((m) => {
            const resolutionTime = m.account.resolutionTime.toNumber();
            const challengeDeadline = resolutionTime + (CHALLENGE_WINDOW_HOURS * 3600);
            const hoursUntilResolution = (resolutionTime - now) / 3600;
            const hoursUntilChallengeClosed = (challengeDeadline - now) / 3600;
            return {
                marketId: m.account.marketId,
                question: m.account.question,
                outcomes: m.account.outcomes,
                pubkey: m.publicKey.toBase58(),
                resolutionTime: resolutionTime,
                resolutionDate: new Date(resolutionTime * 1000).toISOString(),
                challengeDeadline: challengeDeadline,
                challengeDeadlineDate: new Date(challengeDeadline * 1000).toISOString(),
                status: now < resolutionTime
                    ? 'awaiting_resolution'
                    : now < challengeDeadline
                        ? 'in_challenge_window'
                        : 'ready_to_finalize',
                hoursUntilResolution: Math.max(0, hoursUntilResolution).toFixed(1),
                hoursUntilChallengeClosed: Math.max(0, hoursUntilChallengeClosed).toFixed(1),
                totalPoolSol: (m.account.totalPool.toNumber() / LAMPORTS_PER_SOL).toFixed(4),
            };
        })
            .sort((a, b) => a.resolutionTime - b.resolutionTime);
        return c.json({
            challengeWindowHours: CHALLENGE_WINDOW_HOURS,
            pendingResolutions: pending,
            count: pending.length,
            note: 'Resolution will be posted to forum before on-chain execution. Challenge during the window to dispute.',
        });
    }
    catch (error) {
        console.error('Error fetching pending resolutions:', error);
        return c.json({ error: 'Failed to fetch pending resolutions' }, 500);
    }
});
// Verify market resolution data (for verifiable markets)
// Lets agents independently check what the resolution SHOULD be
app.get('/markets/:id/verify', async (c) => {
    const marketId = c.req.param('id');
    try {
        // Get market
        let marketPubkey;
        try {
            marketPubkey = new PublicKey(marketId);
        }
        catch {
            const [pda] = PublicKey.findProgramAddressSync([Buffer.from('market'), Buffer.from(marketId)], programId);
            marketPubkey = pda;
        }
        const market = await program.account.market.fetch(marketPubkey);
        const marketIdStr = market.marketId;
        // Verification logic per market type
        if (marketIdStr === 'submissions-over-400' || marketIdStr === 'submissions-over-350') {
            // Fetch live project count from Colosseum API
            const threshold = marketIdStr === 'submissions-over-400' ? 400 : 350;
            try {
                const response = await fetch('https://agents.colosseum.com/api/projects');
                const data = await response.json();
                const projectCount = data.projects?.length || 0;
                const meetsThreshold = projectCount > threshold;
                const expectedOutcome = meetsThreshold ? 0 : 1; // 0 = Yes, 1 = No
                return c.json({
                    marketId: marketIdStr,
                    question: market.question,
                    outcomes: market.outcomes,
                    verificationSource: 'https://agents.colosseum.com/api/projects',
                    verificationMethod: `Count projects and compare to threshold (>${threshold})`,
                    currentData: {
                        projectCount,
                        threshold,
                        meetsThreshold,
                    },
                    expectedResolution: {
                        outcomeIndex: expectedOutcome,
                        outcomeName: market.outcomes[expectedOutcome],
                        confidence: 'high',
                        note: 'Based on live data. Final resolution at deadline (Feb 12).',
                    },
                    resolutionTime: market.resolutionTime.toNumber(),
                    resolved: market.resolved,
                    timestamp: new Date().toISOString(),
                });
            }
            catch (fetchError) {
                return c.json({
                    marketId: marketIdStr,
                    error: 'Failed to fetch verification data',
                    verificationSource: 'https://agents.colosseum.com/api/projects',
                    manualVerification: `curl -s "https://agents.colosseum.com/api/projects" | jq '.projects | length'`,
                }, 503);
            }
        }
        // Markets that depend on hackathon results (not yet verifiable)
        if (marketIdStr === 'winner-uses-anchor' ||
            marketIdStr === 'winner-active-30-days' ||
            marketIdStr === 'top5-mainnet-deploy') {
            return c.json({
                marketId: marketIdStr,
                question: market.question,
                outcomes: market.outcomes,
                verificationStatus: 'awaiting_external_data',
                reason: 'This market depends on hackathon results, which are not yet announced.',
                expectedDataAvailable: 'After Feb 12 (hackathon deadline)',
                verificationMethod: marketIdStr === 'winner-uses-anchor'
                    ? 'Check winning repo for Anchor.toml or @coral-xyz/anchor dependency'
                    : marketIdStr === 'winner-active-30-days'
                        ? 'Check winning repo created_at date via GitHub API'
                        : 'Check top-5 project program IDs on mainnet-beta',
                resolutionTime: market.resolutionTime.toNumber(),
                resolved: market.resolved,
            });
        }
        if (marketIdStr === 'results-within-48h') {
            return c.json({
                marketId: marketIdStr,
                question: market.question,
                outcomes: market.outcomes,
                verificationStatus: 'awaiting_external_data',
                reason: 'Depends on official announcement timing.',
                monitorSources: [
                    'https://twitter.com/ColosseumOrg',
                    'https://arena.colosseum.org',
                ],
                threshold: 'Announcement must be before Feb 14, 11:59 PM UTC',
                resolutionTime: market.resolutionTime.toNumber(),
                resolved: market.resolved,
            });
        }
        // Test market
        if (marketIdStr.startsWith('fresh-test-') || marketIdStr.startsWith('hackathon-test-')) {
            return c.json({
                marketId: marketIdStr,
                question: market.question,
                outcomes: market.outcomes,
                verificationStatus: 'test_market',
                reason: 'This is a test market for system verification.',
                note: 'Resolution decision documented in RESOLUTION_CRITERIA.md',
                resolutionTime: market.resolutionTime.toNumber(),
                resolved: market.resolved,
            });
        }
        // Unknown market type
        return c.json({
            marketId: marketIdStr,
            question: market.question,
            outcomes: market.outcomes,
            verificationStatus: 'unknown',
            note: 'No automated verification available. See RESOLUTION_CRITERIA.md for manual verification.',
            resolutionTime: market.resolutionTime.toNumber(),
            resolved: market.resolved,
        });
    }
    catch (error) {
        console.error('Error verifying market:', error);
        return c.json({ error: 'Market not found' }, 404);
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
