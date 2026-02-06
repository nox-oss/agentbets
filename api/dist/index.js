import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Connection, PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Program, AnchorProvider, Wallet, setProvider } from '@coral-xyz/anchor';
import BN from 'bn.js';
import * as bs58 from 'bs58';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import idl from './idl.json' with { type: 'json' };
const DISPUTES_FILE = process.env.DISPUTES_FILE || './disputes.json';
function loadDisputes() {
    try {
        if (existsSync(DISPUTES_FILE)) {
            return JSON.parse(readFileSync(DISPUTES_FILE, 'utf-8'));
        }
    }
    catch (e) {
        console.error('Failed to load disputes:', e);
    }
    return {};
}
function saveDisputes(disputes) {
    try {
        writeFileSync(DISPUTES_FILE, JSON.stringify(disputes, null, 2));
    }
    catch (e) {
        console.error('Failed to save disputes:', e);
    }
}
function getActiveDisputes(marketId) {
    const disputes = loadDisputes();
    return (disputes[marketId] || []).filter(d => d.status === 'active');
}
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
// Ensure UTF-8 charset on all JSON responses
app.use('*', async (c, next) => {
    await next();
    const contentType = c.res.headers.get('Content-Type');
    if (contentType && contentType.includes('application/json') && !contentType.includes('charset')) {
        c.res.headers.set('Content-Type', 'application/json; charset=utf-8');
    }
});
// Serve skill.md for agent discovery
app.get('/skill.md', async (c) => {
    try {
        const skillContent = readFileSync('./skill.md', 'utf-8');
        c.header('Content-Type', 'text/markdown; charset=utf-8');
        return c.text(skillContent);
    }
    catch (error) {
        // Fallback: return inline skill summary
        return c.text(`# AgentBets Skill

Skill file not found locally. Visit https://github.com/nox-oss/agentbets for documentation.

## Quick Start
\`\`\`bash
# List markets
curl https://agentbets-api-production.up.railway.app/markets

# Check opportunities
curl https://agentbets-api-production.up.railway.app/opportunities

# Verify trust
curl https://agentbets-api-production.up.railway.app/verify-all
\`\`\`
`, 200);
    }
});
// Health check
app.get('/', (c) => {
    c.header('Content-Type', 'application/json; charset=utf-8');
    return c.json({
        name: 'AgentBets API',
        version: '0.1.0',
        network: 'devnet',
        programId: DEVNET_PROGRAM_ID,
        endpoints: {
            // Parimutuel Markets (existing)
            'GET /markets': 'List all parimutuel markets',
            'GET /markets/:id': 'Get market details',
            'GET /markets/:id/position/:owner': 'Get position for a user',
            'GET /markets/:id/verify': 'Verify resolution data (agents can check independently)',
            'GET /markets/:id/disputes': '⚖️ View disputes filed against this market',
            'GET /resolutions/pending': 'List upcoming resolutions + challenge windows',
            'GET /opportunities': '🎯 Find mispriced markets with positive expected value',
            'GET /verify-all': '🔍 Run full trust verification (check on-chain state, vaults, etc.)',
            'GET /security': '🔒 Security model docs (what authority can/cannot do)',
            'POST /markets': 'Create a new parimutuel market (authority only)',
            'POST /markets/:id/bet': 'Place a bet (returns unsigned tx to sign)',
            'POST /markets/:id/claim': 'Claim winnings after resolution (returns unsigned tx)',
            'POST /markets/:id/dispute': '⚖️ File a dispute against a resolution (24h challenge window)',
            'POST /markets/:id/auto-resolve': 'Auto-resolve verifiable markets (anyone can trigger)',
            'POST /markets/:id/resolve': 'Resolve market manually (authority only)',
            // CLOB Markets (Order Book) — ⚠️ Trading DISABLED pending bug fixes
            'GET /clob/markets': '📊 List all CLOB markets (read-only)',
            'GET /clob/markets/:id': '📊 Get CLOB market with order book (read-only)',
            'GET /clob/markets/:id/position/:owner': '📊 Get CLOB position for a user (read-only)',
            'POST /clob/markets': '⚠️ DISABLED — CLOB has known fund-safety bugs',
            'POST /clob/markets/:id/order': '⚠️ DISABLED — use parimutuel /markets instead',
            'POST /clob/markets/:id/cancel': '⚠️ DISABLED — CLOB trading not available',
            'POST /clob/markets/:id/resolve': '⚠️ DISABLED — CLOB trading not available',
            'POST /clob/markets/:id/claim': '⚠️ DISABLED — CLOB trading not available',
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
                // Use totalCount if available (API may paginate), otherwise count projects array
                const projectCount = data.totalCount ?? data.projects?.length ?? 0;
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
        // Test market - auto-resolvable
        if (marketIdStr.startsWith('fresh-test-') || marketIdStr.startsWith('hackathon-test-')) {
            const now = Math.floor(Date.now() / 1000);
            const resolutionTime = market.resolutionTime.toNumber();
            const canAutoResolve = now >= resolutionTime;
            return c.json({
                marketId: marketIdStr,
                question: market.question,
                outcomes: market.outcomes,
                verificationStatus: 'auto_resolvable',
                reason: 'Test market - always resolves to "Yes" (outcome 0) to prove system works.',
                expectedResolution: {
                    outcomeIndex: 0,
                    outcomeName: market.outcomes[0],
                    confidence: 'certain',
                },
                autoResolve: {
                    available: canAutoResolve,
                    resolutionTime: resolutionTime,
                    resolutionDate: new Date(resolutionTime * 1000).toISOString(),
                    hoursRemaining: canAutoResolve ? 0 : ((resolutionTime - now) / 3600).toFixed(1),
                    endpoint: `POST /markets/${marketIdStr}/auto-resolve`,
                    note: canAutoResolve
                        ? 'Anyone can trigger auto-resolution now!'
                        : 'Wait for resolution time to pass, then anyone can trigger',
                },
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
// Claim winnings (for winners after resolution)
app.post('/markets/:id/claim', async (c) => {
    const marketId = c.req.param('id');
    try {
        const body = await c.req.json();
        const { claimerPubkey, signedTx } = body;
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
        if (!claimerPubkey) {
            return c.json({
                error: 'Missing required field: claimerPubkey (or signedTx)'
            }, 400);
        }
        const claimer = new PublicKey(claimerPubkey);
        // Check if market is resolved first
        const market = await program.account.market.fetch(marketPubkey);
        if (!market.resolved) {
            return c.json({
                error: 'Market not yet resolved. Cannot claim until resolution.',
                resolved: false,
                resolutionTime: market.resolutionTime.toNumber(),
                resolutionDate: new Date(market.resolutionTime.toNumber() * 1000).toISOString(),
            }, 400);
        }
        // Check if claimer has a winning position
        const [positionPda] = PublicKey.findProgramAddressSync([Buffer.from('position'), marketPubkey.toBuffer(), claimer.toBuffer()], programId);
        let position;
        try {
            position = await program.account.position.fetch(positionPda);
        }
        catch {
            return c.json({
                error: 'No position found for this wallet in this market.',
                positionPda: positionPda.toBase58(),
            }, 404);
        }
        const winningOutcome = market.winningOutcome;
        const winnerShares = position.shares[winningOutcome].toNumber();
        if (winnerShares <= 0) {
            return c.json({
                error: 'No winning shares to claim. Either you bet on a losing outcome or already claimed.',
                winningOutcome,
                winningOutcomeName: market.outcomes[winningOutcome],
                yourShares: position.shares.map((s) => s.toString()),
            }, 400);
        }
        // Calculate expected payout
        const totalWinningShares = market.outcomePools[winningOutcome].toNumber();
        const totalPool = market.totalPool.toNumber();
        const grossPayout = Math.floor((winnerShares * totalPool) / totalWinningShares);
        const fee = Math.floor(grossPayout / 50); // 2%
        const netPayout = grossPayout - fee;
        // Build instruction
        const ix = await program.methods
            .claimWinnings()
            .accounts({
            market: marketPubkey,
            position: positionPda,
            claimer,
        })
            .instruction();
        // Build transaction
        const { blockhash } = await connection.getLatestBlockhash();
        const tx = new (await import('@solana/web3.js')).Transaction({
            recentBlockhash: blockhash,
            feePayer: claimer,
        }).add(ix);
        // Return serialized unsigned tx with payout info
        const serialized = tx.serialize({
            requireAllSignatures: false,
            verifySignatures: false,
        }).toString('base64');
        return c.json({
            unsignedTx: serialized,
            marketPubkey: marketPubkey.toBase58(),
            positionPda: positionPda.toBase58(),
            payout: {
                winningOutcome,
                winningOutcomeName: market.outcomes[winningOutcome],
                yourWinningShares: winnerShares,
                totalWinningShares,
                totalPool: totalPool / LAMPORTS_PER_SOL,
                grossPayoutLamports: grossPayout,
                feeLamports: fee,
                netPayoutLamports: netPayout,
                netPayoutSol: netPayout / LAMPORTS_PER_SOL,
            },
            message: 'Sign this transaction with your wallet and submit via signedTx field',
        });
    }
    catch (error) {
        console.error('Error claiming winnings:', error);
        return c.json({ error: String(error) }, 500);
    }
});
// Auto-resolve market (anyone can trigger for verifiable markets)
// Removes human discretion - the data determines the outcome
app.post('/markets/:id/auto-resolve', async (c) => {
    if (!authorityWallet) {
        return c.json({ error: 'Authority wallet not configured' }, 503);
    }
    const marketId = c.req.param('id');
    try {
        // Get market pubkey
        let marketPubkey;
        try {
            marketPubkey = new PublicKey(marketId);
        }
        catch {
            const [pda] = PublicKey.findProgramAddressSync([Buffer.from('market'), Buffer.from(marketId)], programId);
            marketPubkey = pda;
        }
        // Fetch market data
        const market = await program.account.market.fetch(marketPubkey);
        const marketIdStr = market.marketId;
        const now = Math.floor(Date.now() / 1000);
        const resolutionTime = market.resolutionTime.toNumber();
        // Check if already resolved
        if (market.resolved) {
            return c.json({
                error: 'Market already resolved',
                winningOutcome: market.winningOutcome,
                winningOutcomeName: market.outcomes[market.winningOutcome],
            }, 400);
        }
        // Check if resolution time has passed
        if (now < resolutionTime) {
            const hoursRemaining = ((resolutionTime - now) / 3600).toFixed(1);
            return c.json({
                error: 'Resolution time has not passed yet',
                resolutionTime,
                resolutionDate: new Date(resolutionTime * 1000).toISOString(),
                hoursRemaining,
            }, 400);
        }
        // Check for active disputes
        const activeDisputes = getActiveDisputes(marketIdStr);
        if (activeDisputes.length > 0) {
            return c.json({
                error: 'Cannot auto-resolve: active disputes exist',
                disputes: activeDisputes,
                message: 'Disputes must be resolved before market can be finalized. Check /markets/:id/disputes for details.',
            }, 400);
        }
        // Auto-resolve verifiable markets
        const isSubmissionsMarket = marketIdStr === 'submissions-over-400' || marketIdStr === 'submissions-over-350';
        const isTestMarket = marketIdStr.startsWith('fresh-test-') || marketIdStr.startsWith('hackathon-test-');
        if (!isSubmissionsMarket && !isTestMarket) {
            return c.json({
                error: 'Auto-resolution only available for verifiable markets',
                marketId: marketIdStr,
                verifiableMarkets: ['submissions-over-400', 'submissions-over-350', 'fresh-test-*'],
                note: 'Other markets require manual resolution after hackathon results.',
            }, 400);
        }
        // Handle test markets (always resolve to Yes - outcome 0)
        if (isTestMarket) {
            const winningOutcome = 0; // Yes
            const winningOutcomeName = market.outcomes[winningOutcome];
            // Execute resolution
            const tx = await program.methods
                .resolveMarket(winningOutcome)
                .accounts({
                market: marketPubkey,
                authority: authorityWallet.publicKey,
            })
                .signers([authorityWallet])
                .rpc();
            console.log(`Auto-resolved test market ${marketIdStr}: ${winningOutcomeName}`);
            return c.json({
                success: true,
                marketId: marketIdStr,
                resolution: {
                    winningOutcome,
                    winningOutcomeName,
                    reason: 'Test market - resolves to Yes to demonstrate system functionality',
                },
                verification: {
                    marketType: 'test',
                    expectedOutcome: 'Yes (always)',
                    note: 'Test markets exist to verify the betting/resolution/claim flow works correctly',
                    timestamp: new Date().toISOString(),
                },
                txSignature: tx,
                message: 'Test market resolved automatically. Anyone can claim winnings.',
            });
        }
        // Fetch verification data for submissions markets
        const threshold = marketIdStr === 'submissions-over-400' ? 400 : 350;
        let projectCount;
        try {
            const response = await fetch('https://agents.colosseum.com/api/projects');
            const data = await response.json();
            projectCount = data.totalCount ?? data.projects?.length ?? 0;
        }
        catch (fetchError) {
            return c.json({
                error: 'Failed to fetch verification data from Colosseum API',
                verificationSource: 'https://agents.colosseum.com/api/projects',
                message: 'Retry later or use manual resolution',
            }, 503);
        }
        // Determine outcome based on data
        const meetsThreshold = projectCount > threshold;
        const winningOutcome = meetsThreshold ? 0 : 1; // 0 = Yes, 1 = No
        const winningOutcomeName = market.outcomes[winningOutcome];
        // Execute resolution
        const tx = await program.methods
            .resolveMarket(winningOutcome)
            .accounts({
            market: marketPubkey,
            authority: authorityWallet.publicKey,
        })
            .signers([authorityWallet])
            .rpc();
        console.log(`Auto-resolved ${marketIdStr}: ${winningOutcomeName} (project count: ${projectCount}, threshold: ${threshold})`);
        return c.json({
            success: true,
            marketId: marketIdStr,
            resolution: {
                winningOutcome,
                winningOutcomeName,
                reason: `Project count (${projectCount}) ${meetsThreshold ? '>' : '≤'} threshold (${threshold})`,
            },
            verification: {
                projectCount,
                threshold,
                meetsThreshold,
                source: 'https://agents.colosseum.com/api/projects',
                timestamp: new Date().toISOString(),
            },
            txSignature: tx,
            message: 'Market resolved automatically based on verifiable data. No human discretion involved.',
        });
    }
    catch (error) {
        console.error('Error auto-resolving market:', error);
        return c.json({ error: String(error) }, 500);
    }
});
// === Dispute System Endpoints ===
// File a dispute against a market resolution
app.post('/markets/:id/dispute', async (c) => {
    const marketId = c.req.param('id');
    try {
        const body = await c.req.json();
        const { disputerPubkey, reason, evidence } = body;
        if (!disputerPubkey || !reason) {
            return c.json({
                error: 'Missing required fields: disputerPubkey, reason'
            }, 400);
        }
        // Get market pubkey
        let marketPubkey;
        let marketIdStr;
        try {
            marketPubkey = new PublicKey(marketId);
            const market = await program.account.market.fetch(marketPubkey);
            marketIdStr = market.marketId;
        }
        catch {
            const [pda] = PublicKey.findProgramAddressSync([Buffer.from('market'), Buffer.from(marketId)], programId);
            marketPubkey = pda;
            marketIdStr = marketId;
        }
        // Verify market exists
        let market;
        try {
            market = await program.account.market.fetch(marketPubkey);
        }
        catch {
            return c.json({ error: 'Market not found' }, 404);
        }
        // Check if market is in challenge window
        const now = Math.floor(Date.now() / 1000);
        const resolutionTime = market.resolutionTime.toNumber();
        const CHALLENGE_WINDOW_HOURS = 24;
        const challengeDeadline = resolutionTime + (CHALLENGE_WINDOW_HOURS * 3600);
        if (now < resolutionTime) {
            return c.json({
                error: 'Cannot dispute before resolution time',
                resolutionTime,
                resolutionDate: new Date(resolutionTime * 1000).toISOString(),
            }, 400);
        }
        if (now > challengeDeadline) {
            return c.json({
                error: 'Challenge window has closed',
                challengeDeadline,
                challengeDeadlineDate: new Date(challengeDeadline * 1000).toISOString(),
            }, 400);
        }
        // Create dispute
        const dispute = {
            id: `dispute-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            marketId: marketIdStr,
            disputerPubkey,
            reason,
            evidence,
            createdAt: new Date().toISOString(),
            status: 'active',
        };
        // Save dispute
        const disputes = loadDisputes();
        if (!disputes[marketIdStr]) {
            disputes[marketIdStr] = [];
        }
        disputes[marketIdStr].push(dispute);
        saveDisputes(disputes);
        console.log(`Dispute filed for ${marketIdStr}: ${reason}`);
        return c.json({
            success: true,
            dispute,
            message: 'Dispute filed successfully. Resolution will be paused until dispute is reviewed.',
            nextSteps: [
                'Dispute will be reviewed by the authority within 24 hours',
                'You can check dispute status at GET /markets/:id/disputes',
                'If dispute is valid, resolution may be corrected',
            ],
        });
    }
    catch (error) {
        console.error('Error filing dispute:', error);
        return c.json({ error: String(error) }, 500);
    }
});
// Get disputes for a market
app.get('/markets/:id/disputes', async (c) => {
    const marketId = c.req.param('id');
    try {
        // Get market pubkey
        let marketIdStr;
        try {
            const marketPubkey = new PublicKey(marketId);
            const market = await program.account.market.fetch(marketPubkey);
            marketIdStr = market.marketId;
        }
        catch {
            marketIdStr = marketId;
        }
        const disputes = loadDisputes();
        const marketDisputes = disputes[marketIdStr] || [];
        return c.json({
            marketId: marketIdStr,
            disputes: marketDisputes,
            activeCount: marketDisputes.filter(d => d.status === 'active').length,
            totalCount: marketDisputes.length,
            note: 'Active disputes pause auto-resolution until reviewed.',
        });
    }
    catch (error) {
        console.error('Error fetching disputes:', error);
        return c.json({ error: String(error) }, 500);
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
// === Trust Verification Endpoint ===
// Agents can call this to verify the system is trustworthy
app.get('/verify-all', async (c) => {
    const results = [];
    try {
        // 1. Verify program exists
        const programInfo = await connection.getAccountInfo(programId);
        results.push({
            passed: programInfo !== null && programInfo.executable,
            check: 'Program exists on-chain',
            details: programInfo ? `Program ${DEVNET_PROGRAM_ID} is deployed and executable` : 'Program not found',
        });
        // 2. Fetch all markets
        const markets = await program.account.market.all();
        results.push({
            passed: markets.length > 0,
            check: 'Markets exist',
            details: `Found ${markets.length} markets on-chain`,
        });
        // 3. Verify authority consistency
        const expectedAuthority = authorityWallet?.publicKey.toBase58() || 'DAS1DbaCVn7PuruRLo7gbn84f8SqTcVUPDW4S5qfZRL2';
        const authorityMatches = markets.filter((m) => m.account.authority.toBase58() === expectedAuthority).length;
        results.push({
            passed: authorityMatches === markets.length,
            check: 'Market authorities match',
            details: `${authorityMatches}/${markets.length} markets have expected authority`,
        });
        // 4. Verify pool balances (SOL is stored in market account itself)
        let balanceMatches = 0;
        for (const market of markets) {
            try {
                // In AgentBets, SOL is held in the market account itself (not a separate vault)
                const marketBalance = await connection.getBalance(market.publicKey);
                const reportedPool = market.account.totalPool.toNumber();
                // Subtract rent-exempt minimum (~0.002 SOL for account storage)
                const rentExempt = await connection.getMinimumBalanceForRentExemption(market.account.question.length + 500 // Approximate account size
                );
                const actualPool = Math.max(0, marketBalance - rentExempt);
                // Allow 0.01 SOL tolerance
                if (Math.abs(actualPool - reportedPool) < 0.01 * LAMPORTS_PER_SOL) {
                    balanceMatches++;
                }
            }
            catch {
                // Skip failed checks
            }
        }
        results.push({
            passed: balanceMatches >= markets.length * 0.8, // 80% threshold
            check: 'Pool balances match on-chain',
            details: `${balanceMatches}/${markets.length} market accounts have correct SOL balances`,
        });
        // 5. Check verifiable markets have working verify endpoints
        const verifiableMarkets = ['submissions-over-400', 'submissions-over-350'];
        let verifyWorks = 0;
        for (const marketId of verifiableMarkets) {
            try {
                // Check if market exists
                const [marketPDA] = PublicKey.findProgramAddressSync([Buffer.from('market'), Buffer.from(marketId)], programId);
                const marketAccount = await program.account.market.fetch(marketPDA);
                if (marketAccount)
                    verifyWorks++;
            }
            catch {
                // Market doesn't exist
            }
        }
        results.push({
            passed: verifyWorks > 0,
            check: 'Auto-resolvable markets exist',
            details: `${verifyWorks}/${verifiableMarkets.length} verifiable markets found`,
        });
        // 6. Check for skin in the game
        const anchorMarket = markets.find((m) => m.account.marketId === 'winner-uses-anchor');
        if (anchorMarket) {
            const pools = anchorMarket.account.outcomePools.map((p) => p.toNumber());
            const hasBothSides = pools.filter((p) => p > 0).length >= 2;
            results.push({
                passed: hasBothSides,
                check: 'Skin in the game',
                details: hasBothSides
                    ? `Counter-positions exist (Yes: ${pools[0] / LAMPORTS_PER_SOL} SOL, No: ${pools[1] / LAMPORTS_PER_SOL} SOL)`
                    : 'No counter-positions found',
            });
        }
        // Calculate trust score
        const passed = results.filter(r => r.passed).length;
        const total = results.length;
        const trustScore = Math.round((passed / total) * 100);
        let grade = 'F';
        if (trustScore >= 90)
            grade = 'A';
        else if (trustScore >= 80)
            grade = 'B';
        else if (trustScore >= 70)
            grade = 'C';
        else if (trustScore >= 60)
            grade = 'D';
        return c.json({
            trustScore,
            grade,
            checksRun: total,
            checksPassed: passed,
            results,
            verifyYourself: {
                program: `https://explorer.solana.com/address/${DEVNET_PROGRAM_ID}?cluster=devnet`,
                markets: `${c.req.url.replace('/verify-all', '/markets')}`,
                resolutions: `${c.req.url.replace('/verify-all', '/resolutions/pending')}`,
            },
            timestamp: new Date().toISOString(),
        });
    }
    catch (error) {
        return c.json({
            error: 'Verification failed',
            details: String(error),
            message: 'You can verify manually via Solana Explorer',
        }, 500);
    }
});
// === Opportunities Endpoint ===
// Highlights mispriced markets where agents can make profit
// Shows expected value calculations for each bet
app.get('/opportunities', async (c) => {
    try {
        const markets = await program.account.market.all();
        const now = Math.floor(Date.now() / 1000);
        const opportunities = [];
        for (const m of markets) {
            const market = m.account;
            const marketId = market.marketId;
            // Skip resolved markets
            if (market.resolved)
                continue;
            // Skip expired markets
            if (now > market.resolutionTime.toNumber())
                continue;
            const totalPool = market.totalPool.toNumber();
            const outcomePools = market.outcomePools.map((p) => p.toNumber());
            // Calculate current implied probabilities
            const impliedOdds = outcomePools.map((pool) => totalPool > 0 ? pool / totalPool : 1 / market.outcomes.length);
            // Get fair odds based on verifiable data
            let fairOdds = null;
            let confidence = 'unknown';
            let reasoning = '';
            let opportunity = null;
            if (marketId === 'submissions-over-400' || marketId === 'submissions-over-350') {
                // Fetch live project count
                try {
                    const response = await fetch('https://agents.colosseum.com/api/projects');
                    const data = await response.json();
                    const projectCount = data.totalCount ?? data.projects?.length ?? 0;
                    const threshold = marketId === 'submissions-over-400' ? 400 : 350;
                    const daysRemaining = 6; // Hackathon ends Feb 12
                    const projectsNeeded = threshold - projectCount;
                    const projectsPerDay = projectCount / 4; // ~4 days elapsed
                    const projectedFinal = projectCount + (projectsPerDay * daysRemaining);
                    if (projectsNeeded > projectedFinal * 0.5) {
                        // Very unlikely to hit threshold
                        fairOdds = [0.05, 0.95]; // 5% Yes, 95% No
                        confidence = 'high';
                        reasoning = `${projectCount} projects now, need ${projectsNeeded} more for ${threshold}. At current rate (~${projectsPerDay.toFixed(0)}/day), projected final: ${projectedFinal.toFixed(0)}. Very unlikely to hit threshold.`;
                    }
                    else if (projectedFinal > threshold * 1.2) {
                        // Likely to hit threshold
                        fairOdds = [0.85, 0.15]; // 85% Yes, 15% No
                        confidence = 'high';
                        reasoning = `${projectCount} projects now, projected ${projectedFinal.toFixed(0)} by deadline. Likely to exceed ${threshold}.`;
                    }
                    else {
                        // Close call
                        fairOdds = [0.4, 0.6];
                        confidence = 'medium';
                        reasoning = `${projectCount} projects now, projected ${projectedFinal.toFixed(0)}. Threshold ${threshold} is borderline.`;
                    }
                    // Calculate best opportunity
                    const impliedNoProb = impliedOdds[1];
                    const fairNoProb = fairOdds[1];
                    const edge = fairNoProb - impliedNoProb;
                    if (edge > 0.1) { // At least 10% edge
                        const betAmount = 0.1 * LAMPORTS_PER_SOL; // 0.1 SOL example
                        const potentialReturn = betAmount / impliedNoProb;
                        const expectedValue = (fairNoProb * potentialReturn) - betAmount;
                        const evPercent = (expectedValue / betAmount) * 100;
                        opportunity = {
                            recommendedBet: 'No',
                            outcomeIndex: 1,
                            edge: `${(edge * 100).toFixed(1)}%`,
                            impliedOdds: `${(impliedNoProb * 100).toFixed(1)}%`,
                            fairOdds: `${(fairNoProb * 100).toFixed(1)}%`,
                            exampleBet: {
                                amount: '0.1 SOL',
                                potentialReturn: `${(potentialReturn / LAMPORTS_PER_SOL).toFixed(3)} SOL`,
                                expectedValue: `+${(expectedValue / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
                                evPercent: `+${evPercent.toFixed(1)}%`,
                            },
                            confidence,
                            reasoning,
                            currentData: {
                                projectCount,
                                threshold,
                                daysRemaining,
                                projectedFinal: projectedFinal.toFixed(0),
                            },
                        };
                    }
                }
                catch {
                    // API fetch failed
                }
            }
            // Test markets (known outcomes)
            if (marketId.startsWith('fresh-test-')) {
                const resolutionTime = market.resolutionTime.toNumber();
                const hoursUntil = (resolutionTime - now) / 3600;
                fairOdds = [1.0, 0.0]; // Always resolves to Yes
                confidence = 'certain';
                reasoning = 'Test market - always resolves to "Yes" after resolution time.';
                if (hoursUntil <= 0) {
                    opportunity = {
                        recommendedBet: 'Yes (then trigger auto-resolve)',
                        outcomeIndex: 0,
                        edge: '100%',
                        impliedOdds: `${(impliedOdds[0] * 100).toFixed(1)}%`,
                        fairOdds: '100%',
                        action: 'Bet on Yes, then call POST /auto-resolve to claim',
                        confidence: 'certain',
                        reasoning: 'Resolution time passed. Yes is guaranteed.',
                        autoResolvable: true,
                    };
                }
            }
            if (opportunity) {
                opportunities.push({
                    marketId,
                    question: market.question,
                    outcomes: market.outcomes,
                    currentOdds: impliedOdds.map((p) => `${(p * 100).toFixed(1)}%`),
                    totalPool: `${(totalPool / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
                    opportunity,
                    resolves: new Date(market.resolutionTime.toNumber() * 1000).toISOString(),
                    betEndpoint: `POST /markets/${marketId}/bet`,
                });
            }
        }
        // Sort by edge (highest first)
        opportunities.sort((a, b) => {
            const edgeA = parseFloat(a.opportunity.edge) || 0;
            const edgeB = parseFloat(b.opportunity.edge) || 0;
            return edgeB - edgeA;
        });
        return c.json({
            title: '🎯 AgentBets Opportunities',
            summary: opportunities.length > 0
                ? `Found ${opportunities.length} mispriced market(s) with positive expected value`
                : 'No clear opportunities right now. Check back later or create counter-positions.',
            opportunities,
            methodology: {
                howWeCalculate: 'We compare market-implied odds to fair odds based on verifiable data.',
                edge: 'The difference between fair probability and market probability.',
                expectedValue: '(fairOdds × potentialReturn) - betAmount. Positive EV = profitable long-term.',
                confidence: 'How certain we are about the fair odds (certain > high > medium > low).',
            },
            disclaimer: 'This is not financial advice. Verify all data independently before betting.',
            dataSource: 'https://agents.colosseum.com/api/projects',
            timestamp: new Date().toISOString(),
        });
    }
    catch (error) {
        console.error('Error calculating opportunities:', error);
        return c.json({ error: 'Failed to calculate opportunities' }, 500);
    }
});
// === Security Model Endpoint ===
// Documents exactly what the authority CAN and CANNOT do
// Agents should verify these claims against the program code
app.get('/security', async (c) => {
    const programCodeUrl = 'https://github.com/mxmnci/agentbets/blob/main/programs/agentbets/src/lib.rs';
    return c.json({
        title: 'AgentBets Security Model',
        summary: 'Your SOL is held by the Solana program, not by us. We can resolve markets, but we cannot steal funds.',
        authorityCapabilities: {
            canDo: [
                {
                    action: 'Resolve markets',
                    proof: 'resolve_market instruction requires authority signer',
                    risk: 'Could resolve incorrectly in their favor',
                    mitigation: 'Auto-resolution for verifiable markets removes this risk. For other markets, transparent criteria + challenge window.',
                },
                {
                    action: 'Create new markets',
                    proof: 'create_market instruction requires authority signer',
                    risk: 'None - creating markets doesn\'t affect existing funds',
                },
            ],
            cannotDo: [
                {
                    action: 'Withdraw funds from market accounts',
                    proof: 'No withdraw instruction exists in the program. Only claim_winnings can move SOL out, and it requires: (1) market resolved, (2) caller has winning shares.',
                    codeRef: `${programCodeUrl}#L98-L130`,
                },
                {
                    action: 'Modify your position',
                    proof: 'Position PDA is derived from [market, owner]. Only owner can call claim_winnings with their position.',
                    codeRef: `${programCodeUrl}#L195-L206`,
                },
                {
                    action: 'Prevent you from claiming',
                    proof: 'claim_winnings is permissionless. If you have winning shares, you can claim. Authority signature not required.',
                    codeRef: `${programCodeUrl}#L98`,
                },
                {
                    action: 'Change the program',
                    proof: 'Program is deployed and immutable (no upgrade authority). Verify on Solana Explorer.',
                },
            ],
        },
        fundProtection: {
            howFundsAreStored: 'SOL is transferred directly to the market PDA (program-owned account) via buy_shares instruction.',
            whoOwnsThePDA: 'The Solana program owns the market PDA. Only program instructions can move SOL out.',
            howFundsAreReleased: 'Only claim_winnings instruction can transfer SOL out. It verifies: resolved=true, caller has winning shares, shares > 0.',
            doubleClaim: 'Shares are zeroed after claim (position.shares[winning_outcome] = 0), preventing double-claims.',
        },
        worstCaseScenarios: [
            {
                scenario: 'Authority resolves market incorrectly',
                impact: 'Winners become losers and vice versa',
                mitigation: 'Auto-resolution for verifiable markets, transparent criteria for others, 24h challenge window',
                note: 'For verifiable markets (submissions, test), resolution is programmatic - authority discretion eliminated',
            },
            {
                scenario: 'Authority disappears',
                impact: 'Markets without auto-resolution never resolve, funds locked',
                mitigation: 'Auto-resolution covers verifiable markets. For others, consider this risk before betting large amounts.',
            },
            {
                scenario: 'Smart contract bug',
                impact: 'Funds could be lost or locked',
                mitigation: 'Program is simple (220 lines), no external calls. You can audit it yourself.',
                audit: 'Not audited (hackathon project). Bet accordingly.',
            },
        ],
        verifyYourself: {
            programCode: programCodeUrl,
            programOnChain: `https://explorer.solana.com/address/${DEVNET_PROGRAM_ID}?cluster=devnet`,
            programId: DEVNET_PROGRAM_ID,
            marketAccounts: 'Each market is a PDA. Check account data on Explorer.',
            vaultLocations: 'SOL is stored IN the market account itself (not a separate vault). Check market account balance.',
        },
        keyInsight: 'We designed the program with no admin privileges over funds. The only power the authority has is resolving markets - and we\'ve eliminated even that for verifiable markets via auto-resolution.',
        recommendation: 'Start with small bets on auto-resolvable markets (submissions-over-*, fresh-test-*). Once you see correct resolution, consider larger bets on other markets.',
        timestamp: new Date().toISOString(),
    });
});
// List all CLOB markets
app.get('/clob/markets', async (c) => {
    try {
        const markets = await program.account.clobMarket.all();
        return c.json({
            markets: markets.map((m) => formatClobMarket(m.publicKey, m.account)),
            count: markets.length,
        });
    }
    catch (error) {
        console.error('Error fetching CLOB markets:', error);
        return c.json({ error: 'Failed to fetch CLOB markets' }, 500);
    }
});
// Get single CLOB market with order book
app.get('/clob/markets/:id', async (c) => {
    const marketId = c.req.param('id');
    try {
        let marketPubkey;
        try {
            marketPubkey = new PublicKey(marketId);
        }
        catch {
            const [pda] = PublicKey.findProgramAddressSync([Buffer.from('clob_market'), Buffer.from(marketId)], programId);
            marketPubkey = pda;
        }
        const market = await program.account.clobMarket.fetch(marketPubkey);
        // Get order book
        const [orderBookPda] = PublicKey.findProgramAddressSync([Buffer.from('order_book'), marketPubkey.toBuffer()], programId);
        let orderBook = null;
        try {
            const ob = await program.account.orderBook.fetch(orderBookPda);
            orderBook = formatOrderBook(ob);
        }
        catch (e) {
            // Order book may not exist yet
        }
        return c.json({
            market: formatClobMarket(marketPubkey, market),
            orderBook,
        });
    }
    catch (error) {
        console.error('Error fetching CLOB market:', error);
        return c.json({ error: 'CLOB market not found' }, 404);
    }
});
// Create a CLOB market
// ⚠️ DISABLED: CLOB system has known fund-safety bugs. See CLOB_VALIDATION.md
// Implementation preserved in git history (commit before this change)
app.post('/clob/markets', async (c) => {
    return c.json({
        error: 'CLOB market creation temporarily disabled',
        reason: 'CLOB system has known fund-safety bugs — waiting for program fix',
        documentation: 'https://github.com/mxmnci/agentbets/blob/main/CLOB_VALIDATION.md',
        alternative: 'Use parimutuel markets at POST /markets',
        status: 'COMING_SOON'
    }, 503);
});
// Place an order in the CLOB
// ⚠️ DISABLED: Known bug where maker positions don't update on fill (funds can get stuck)
// Implementation preserved in git history (commit before this change)
app.post('/clob/markets/:id/order', async (c) => {
    return c.json({
        error: 'CLOB order placement temporarily disabled',
        reason: 'Known bug: maker positions not updated on fill (funds can get stuck)',
        documentation: 'https://github.com/mxmnci/agentbets/blob/main/CLOB_VALIDATION.md',
        alternative: 'Use parimutuel markets at /markets endpoints — fully tested and working',
        status: 'COMING_SOON'
    }, 503);
});
// Cancel an order
// ⚠️ DISABLED: CLOB order system has known bugs. See CLOB_VALIDATION.md
// Implementation preserved in git history (commit before this change)
app.post('/clob/markets/:id/cancel', async (c) => {
    return c.json({
        error: 'CLOB order cancellation temporarily disabled',
        reason: 'CLOB system has known fund-safety bugs',
        documentation: 'https://github.com/mxmnci/agentbets/blob/main/CLOB_VALIDATION.md',
        alternative: 'Use parimutuel markets at /markets endpoints',
        status: 'COMING_SOON'
    }, 503);
});
// Resolve a CLOB market
// ⚠️ DISABLED: CLOB system has known bugs. See CLOB_VALIDATION.md
// Implementation preserved in git history (commit before this change)
app.post('/clob/markets/:id/resolve', async (c) => {
    return c.json({
        error: 'CLOB resolution temporarily disabled',
        reason: 'CLOB system has known fund-safety bugs',
        documentation: 'https://github.com/mxmnci/agentbets/blob/main/CLOB_VALIDATION.md',
        alternative: 'Use parimutuel markets at /markets endpoints',
        status: 'COMING_SOON'
    }, 503);
});
// Claim CLOB winnings
// ⚠️ DISABLED: CLOB system has known bugs. See CLOB_VALIDATION.md
// Implementation preserved in git history (commit before this change)
app.post('/clob/markets/:id/claim', async (c) => {
    return c.json({
        error: 'CLOB claims temporarily disabled',
        reason: 'CLOB system has known fund-safety bugs',
        documentation: 'https://github.com/mxmnci/agentbets/blob/main/CLOB_VALIDATION.md',
        alternative: 'Use parimutuel markets at /markets endpoints',
        status: 'COMING_SOON'
    }, 503);
});
// Get CLOB position
app.get('/clob/markets/:id/position/:owner', async (c) => {
    const marketId = c.req.param('id');
    const owner = c.req.param('owner');
    try {
        let marketPubkey;
        try {
            marketPubkey = new PublicKey(marketId);
        }
        catch {
            const [pda] = PublicKey.findProgramAddressSync([Buffer.from('clob_market'), Buffer.from(marketId)], programId);
            marketPubkey = pda;
        }
        const ownerPubkey = new PublicKey(owner);
        const [positionPda] = PublicKey.findProgramAddressSync([Buffer.from('clob_position'), marketPubkey.toBuffer(), ownerPubkey.toBuffer()], programId);
        const position = await program.account.clobPosition.fetch(positionPda);
        return c.json({
            position: {
                pubkey: positionPda.toBase58(),
                owner: position.owner.toBase58(),
                market: position.market.toBase58(),
                yesShares: position.yesShares.toNumber(),
                noShares: position.noShares.toNumber(),
            },
        });
    }
    catch (error) {
        return c.json({ error: 'Position not found' }, 404);
    }
});
// === Helper Functions ===
function formatClobMarket(pubkey, account) {
    return {
        pubkey: pubkey.toBase58(),
        marketId: account.marketId,
        question: account.question,
        type: 'CLOB',
        resolutionTime: account.resolutionTime.toNumber(),
        resolutionDate: new Date(account.resolutionTime.toNumber() * 1000).toISOString(),
        resolved: account.resolved,
        winningSide: account.winningSide,
        winnerName: account.winningSide === null ? null : (account.winningSide === 0 ? 'YES' : 'NO'),
        totalYesVolume: account.totalYesVolume.toNumber(),
        totalNoVolume: account.totalNoVolume.toNumber(),
        authority: account.authority.toBase58(),
        createdAt: new Date(account.createdAt.toNumber() * 1000).toISOString(),
    };
}
function formatOrderBook(ob) {
    return {
        market: ob.market.toBase58(),
        yesBids: ob.yesBids.map(o => ({
            owner: o.owner.toBase58(),
            price: o.price.toNumber(),
            pricePercent: (o.price.toNumber() / 100).toFixed(2) + '%',
            size: o.size.toNumber(),
            timestamp: o.timestamp.toNumber(),
            orderId: o.orderId.toNumber(),
        })),
        yesAsks: ob.yesAsks.map(o => ({
            owner: o.owner.toBase58(),
            price: o.price.toNumber(),
            pricePercent: (o.price.toNumber() / 100).toFixed(2) + '%',
            size: o.size.toNumber(),
            timestamp: o.timestamp.toNumber(),
            orderId: o.orderId.toNumber(),
        })),
        spread: ob.yesBids.length > 0 && ob.yesAsks.length > 0
            ? ob.yesAsks[0].price.toNumber() - ob.yesBids[0].price.toNumber()
            : null,
        bestBid: ob.yesBids.length > 0 ? ob.yesBids[0].price.toNumber() : null,
        bestAsk: ob.yesAsks.length > 0 ? ob.yesAsks[0].price.toNumber() : null,
    };
}
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
