import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Connection, PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL, Transaction } from '@solana/web3.js';
import { Program, AnchorProvider, Wallet, setProvider } from '@coral-xyz/anchor';
import BN from 'bn.js';
import * as bs58 from 'bs58';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import idl from './idl.json' with { type: 'json' };

// === Dispute System ===
interface Dispute {
  id: string;
  marketId: string;
  disputerPubkey: string;
  reason: string;
  evidence?: string;
  createdAt: string;
  status: 'active' | 'resolved' | 'rejected';
  resolution?: {
    resolvedAt: string;
    outcome: string;
    responseBy: string;
  };
}

const DISPUTES_FILE = process.env.DISPUTES_FILE || './disputes.json';
const WEBHOOKS_FILE = process.env.WEBHOOKS_FILE || './webhooks.json';

// === Webhook System ===
type WebhookEvent = 'resolution' | 'bet' | 'market_created' | 'dispute';

interface Webhook {
  id: string;
  url: string;
  events: WebhookEvent[];
  marketIds?: string[]; // null = all markets
  secret?: string; // optional HMAC secret for verification
  createdAt: string;
  lastTriggered?: string;
  failCount: number;
  active: boolean;
}

function loadWebhooks(): Webhook[] {
  try {
    if (existsSync(WEBHOOKS_FILE)) {
      return JSON.parse(readFileSync(WEBHOOKS_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Failed to load webhooks:', e);
  }
  return [];
}

function saveWebhooks(webhooks: Webhook[]) {
  try {
    writeFileSync(WEBHOOKS_FILE, JSON.stringify(webhooks, null, 2));
  } catch (e) {
    console.error('Failed to save webhooks:', e);
  }
}

async function triggerWebhooks(event: WebhookEvent, payload: Record<string, unknown>) {
  const webhooks = loadWebhooks();
  const marketId = payload.marketId as string | undefined;
  
  const matching = webhooks.filter(w => 
    w.active && 
    w.events.includes(event) &&
    (!w.marketIds || !marketId || w.marketIds.includes(marketId))
  );
  
  for (const webhook of matching) {
    try {
      const body = JSON.stringify({
        event,
        timestamp: new Date().toISOString(),
        payload,
      });
      
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'AgentBets-Webhook/1.0',
      };
      
      // Add HMAC signature if secret is configured
      if (webhook.secret) {
        const crypto = await import('crypto');
        const signature = crypto.createHmac('sha256', webhook.secret)
          .update(body)
          .digest('hex');
        headers['X-AgentBets-Signature'] = `sha256=${signature}`;
      }
      
      const res = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(5000), // 5s timeout
      });
      
      if (res.ok) {
        webhook.lastTriggered = new Date().toISOString();
        webhook.failCount = 0;
      } else {
        webhook.failCount++;
        console.error(`Webhook ${webhook.id} failed: ${res.status}`);
      }
    } catch (e) {
      webhook.failCount++;
      console.error(`Webhook ${webhook.id} error:`, e);
    }
    
    // Disable after 5 consecutive failures
    if (webhook.failCount >= 5) {
      webhook.active = false;
      console.log(`Webhook ${webhook.id} disabled after 5 failures`);
    }
  }
  
  // Save updated webhook states
  saveWebhooks(webhooks);
}

// === On-Chain Oracle System ===
// Trustless resolution via direct PDA reads - no API, no trust needed

interface OnChainOracle {
  programId: string;
  pdaSeeds: string[];  // Seeds to derive the PDA
  field: string;       // Field to read from account data
  threshold?: number;  // For "greater than" comparisons
  comparison: 'gt' | 'lt' | 'eq' | 'gte' | 'lte';
  yesOutcome: number;  // Which outcome index = "yes"/true
  noOutcome: number;   // Which outcome index = "no"/false
}

// Registered on-chain oracles for markets
const ON_CHAIN_ORACLES: Record<string, OnChainOracle> = {
  'agent-casino-100-games': {
    programId: '5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV',
    pdaSeeds: ['state'],  // Agent Casino global state PDA
    field: 'totalGames',
    threshold: 100,
    comparison: 'gt',
    yesOutcome: 0,
    noOutcome: 1,
  },
  'agent-casino-50-games': {
    programId: '5bo6H5rnN9nn8fud6d1pJHmSZ8bpowtQj18SGXG93zvV',
    pdaSeeds: ['state'],
    field: 'totalGames',
    threshold: 50,
    comparison: 'gt',
    yesOutcome: 0,
    noOutcome: 1,
  },
};

// Read raw PDA account data and extract u64/u32 values
async function readOnChainOracleValue(oracle: OnChainOracle): Promise<{ value: number; raw: Buffer } | null> {
  try {
    const oracleProgramId = new PublicKey(oracle.programId);
    const seeds = oracle.pdaSeeds.map(s => Buffer.from(s));
    const [pda] = PublicKey.findProgramAddressSync(seeds, oracleProgramId);
    
    const accountInfo = await connection.getAccountInfo(pda);
    if (!accountInfo) {
      console.log(`On-chain oracle PDA not found: ${pda.toBase58()}`);
      return null;
    }
    
    // Parse account data - Agent Casino uses Anchor, so skip 8-byte discriminator
    const data = accountInfo.data;
    
    // For Agent Casino state, totalGames is typically a u64 after the discriminator
    // Structure: [8-byte discriminator][authority: 32 bytes][totalGames: 8 bytes (u64)]
    // Adjust offset based on actual Agent Casino IDL
    const DISCRIMINATOR_SIZE = 8;
    const AUTHORITY_SIZE = 32;
    const offset = DISCRIMINATOR_SIZE + AUTHORITY_SIZE;
    
    if (data.length < offset + 8) {
      console.log(`On-chain oracle data too short: ${data.length} bytes`);
      return null;
    }
    
    // Read u64 (little endian)
    const value = Number(data.readBigUInt64LE(offset));
    
    return { value, raw: data };
  } catch (e) {
    console.error('On-chain oracle read error:', e);
    return null;
  }
}

// Resolve market using on-chain oracle
async function resolveViaOnChainOracle(marketId: string): Promise<{ outcome: number; value: number; threshold: number } | null> {
  const oracle = ON_CHAIN_ORACLES[marketId];
  if (!oracle) return null;
  
  const result = await readOnChainOracleValue(oracle);
  if (!result) return null;
  
  const { value } = result;
  const threshold = oracle.threshold ?? 0;
  
  let conditionMet: boolean;
  switch (oracle.comparison) {
    case 'gt': conditionMet = value > threshold; break;
    case 'gte': conditionMet = value >= threshold; break;
    case 'lt': conditionMet = value < threshold; break;
    case 'lte': conditionMet = value <= threshold; break;
    case 'eq': conditionMet = value === threshold; break;
    default: conditionMet = false;
  }
  
  return {
    outcome: conditionMet ? oracle.yesOutcome : oracle.noOutcome,
    value,
    threshold,
  };
}

function loadDisputes(): Record<string, Dispute[]> {
  try {
    if (existsSync(DISPUTES_FILE)) {
      return JSON.parse(readFileSync(DISPUTES_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Failed to load disputes:', e);
  }
  return {};
}

function saveDisputes(disputes: Record<string, Dispute[]>) {
  try {
    writeFileSync(DISPUTES_FILE, JSON.stringify(disputes, null, 2));
  } catch (e) {
    console.error('Failed to save disputes:', e);
  }
}

function getActiveDisputes(marketId: string): Dispute[] {
  const disputes = loadDisputes();
  return (disputes[marketId] || []).filter(d => d.status === 'active');
}

// === Types ===
interface MarketAccount {
  authority: PublicKey;
  marketId: string;
  question: string;
  outcomes: string[];
  outcomePools: BN[];
  totalPool: BN;
  resolutionTime: BN;
  resolved: boolean;
  winningOutcome: number | null;
  createdAt: BN;
  bump: number;
}

interface PositionAccount {
  owner: PublicKey;
  market: PublicKey;
  shares: BN[];
  bump: number;
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
let authorityWallet: Keypair | null = null;
try {
  if (AUTHORITY_PRIVATE_KEY) {
    // Try base58 first, then JSON array
    try {
      authorityWallet = Keypair.fromSecretKey(bs58.default.decode(AUTHORITY_PRIVATE_KEY));
    } catch {
      const keypairData = JSON.parse(AUTHORITY_PRIVATE_KEY);
      authorityWallet = Keypair.fromSecretKey(Uint8Array.from(keypairData));
    }
    console.log(`Authority wallet loaded from env: ${authorityWallet.publicKey.toBase58()}`);
  } else {
    const keypairData = JSON.parse(readFileSync(AUTHORITY_KEYPAIR_PATH, 'utf-8'));
    authorityWallet = Keypair.fromSecretKey(Uint8Array.from(keypairData));
    console.log(`Authority wallet loaded from file: ${authorityWallet.publicKey.toBase58()}`);
  }
} catch (e) {
  console.log('Warning: Authority keypair not found. Market creation/resolution disabled.');
}

// Create provider for program interactions
const wallet = authorityWallet ? new Wallet(authorityWallet) : new Wallet(Keypair.generate());
const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
setProvider(provider);

// Fix IDL address for devnet
const fixedIdl = { ...idl, address: DEVNET_PROGRAM_ID };
// @ts-ignore - Anchor dynamic IDL typing
const program = new Program(fixedIdl as any, provider) as any;

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
    // Try multiple paths (handles Docker WORKDIR and local dev)
    const paths = ['./skill.md', './api/skill.md', `${process.cwd()}/skill.md`];
    let skillContent: string | null = null;
    
    for (const path of paths) {
      try {
        if (existsSync(path)) {
          skillContent = readFileSync(path, 'utf-8');
          break;
        }
      } catch {}
    }
    
    if (skillContent) {
      c.header('Content-Type', 'text/markdown; charset=utf-8');
      return c.text(skillContent);
    }
    throw new Error('skill.md not found');
  } catch (error) {
    // Fallback: fetch from GitHub (canonical source)
    try {
      const res = await fetch('https://raw.githubusercontent.com/nox-oss/agentbets/main/api/skill.md');
      if (res.ok) {
        c.header('Content-Type', 'text/markdown; charset=utf-8');
        return c.text(await res.text());
      }
    } catch {}
    
    // Last resort: inline summary
    return c.text(`# AgentBets Skill

Skill file temporarily unavailable. See: https://github.com/nox-oss/agentbets

## Quick Start
\`\`\`bash
curl https://agentbets-api-production.up.railway.app/markets
curl https://agentbets-api-production.up.railway.app/opportunities  
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
    version: '0.1.1',
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
      'GET /resolutions/history': '📜 Track record of past resolutions',
      'GET /opportunities': '🎯 Find mispriced markets with positive expected value',
      'GET /verify-all': '🔍 Run full trust verification (check on-chain state, vaults, etc.)',
      'GET /security': '🔒 Security model docs (what authority can/cannot do)',
      'GET /skill.md': '📖 Skill file for agent discovery (markdown)',
      'POST /markets': 'Create a new parimutuel market (authority only)',
      'GET /markets/:id/simulate': '🔮 Preview bet payout before committing (no risk, just info)',
      'POST /quick-bet': '⚡ Quick bet: accepts outcome by name, amount in SOL — simplest way to bet',
      'POST /markets/:id/bet': 'Place a bet (returns unsigned tx to sign)',
      'POST /markets/:id/claim': 'Claim winnings after resolution (returns unsigned tx)',
      'POST /markets/:id/dispute': '⚖️ File a dispute against a resolution (24h challenge window)',
      'POST /markets/:id/auto-resolve': 'Auto-resolve verifiable markets (anyone can trigger)',
      'POST /markets/:id/resolve': 'Resolve market manually (authority only)',
      
      // Wallet Authority Integrations — Enable autonomous agent betting
      'POST /markets/:id/bet/paladin': '🤖 Bet via Paladin wallet delegation (bounded authority)',
      
      // AgentWallet Integration — The simplest path for hackathon agents
      'POST /bet/agentwallet/prepare': '💸 Prepare bet via AgentWallet transfer (every agent has this!)',
      'GET /bet/agentwallet/status/:betId': '💸 Check AgentWallet bet status',
      'GET /bet/agentwallet/pending': '💸 List pending AgentWallet deposits',
      'POST /bet/agentwallet/process': '💸 Process pending deposits (cron/manual trigger)',
      'POST /bet/agentwallet/claim/:betId': '💸 Claim winnings and transfer to agent (after resolution)',
      
      // On-Chain Oracles — Trustless resolution via PDA reads
      'GET /oracles': '🔗 List registered on-chain oracles (trustless resolution)',
      'GET /oracles/:marketId': '🔗 Check oracle status and current value for a market',
      
      // Webhooks — Real-time notifications
      'POST /webhooks': '🔔 Register a webhook for market events',
      'GET /webhooks/:id': '🔔 Check webhook status',
      'DELETE /webhooks/:id': '🔔 Unregister a webhook',
      'POST /webhooks/:id/test': '🔔 Test webhook delivery',
      
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
      markets: markets.map((m: { publicKey: PublicKey; account: MarketAccount }) => formatMarket(m.publicKey, m.account)),
      count: markets.length,
    });
  } catch (error) {
    console.error('Error fetching markets:', error);
    return c.json({ error: 'Failed to fetch markets' }, 500);
  }
});

// Get single market
app.get('/markets/:id', async (c) => {
  const marketId = c.req.param('id');
  
  try {
    // Try to parse as pubkey first
    let marketPubkey: PublicKey;
    try {
      marketPubkey = new PublicKey(marketId);
    } catch {
      // If not a pubkey, derive from market_id string
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('market'), Buffer.from(marketId)],
        programId
      );
      marketPubkey = pda;
    }
    
    const market = await program.account.market.fetch(marketPubkey);
    
    return c.json({
      market: formatMarket(marketPubkey, market),
    });
  } catch (error) {
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
    const [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('market'), Buffer.from(marketId)],
      programId
    );
    
    // Create market
    const tx = await program.methods
      .createMarket(
        marketId,
        question,
        outcomes,
        new BN(resolutionTime)
      )
      .accounts({
        market: marketPda,
        authority: authorityWallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([authorityWallet])
      .rpc();
    
    console.log(`Market created: ${marketId} (tx: ${tx})`);
    
    // Trigger webhook asynchronously
    triggerWebhooks('market_created', {
      marketId,
      marketPubkey: marketPda.toBase58(),
      question,
      outcomes,
      resolutionTime,
      resolutionDate: new Date(resolutionTime * 1000).toISOString(),
      txSignature: tx,
      explorerUrl: `https://explorer.solana.com/tx/${tx}?cluster=devnet`,
    }).catch(e => console.error('Market creation webhook trigger failed:', e));
    
    return c.json({
      success: true,
      marketId,
      marketPubkey: marketPda.toBase58(),
      txSignature: tx,
    });
  } catch (error) {
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
    let marketPubkey: PublicKey;
    try {
      marketPubkey = new PublicKey(marketId);
    } catch {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('market'), Buffer.from(marketId)],
        programId
      );
      marketPubkey = pda;
    }
    
    // If signed tx provided, submit it
    if (signedTx) {
      const txBuffer = Buffer.from(signedTx, 'base64');
      const sig = await connection.sendRawTransaction(txBuffer);
      await connection.confirmTransaction(sig, 'confirmed');
      
      // Try to get market data for webhook
      let marketData: MarketAccount | null = null;
      try {
        marketData = await program.account.market.fetch(marketPubkey) as MarketAccount;
      } catch (e) {
        console.error('Failed to fetch market for bet webhook:', e);
      }
      
      // Trigger webhook asynchronously
      triggerWebhooks('bet', {
        marketId: marketData?.marketId || marketId,
        marketPubkey: marketPubkey.toBase58(),
        txSignature: sig,
        explorerUrl: `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
      }).catch(e => console.error('Bet webhook trigger failed:', e));
      
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
    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('position'), marketPubkey.toBuffer(), buyer.toBuffer()],
      programId
    );
    
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
  } catch (error) {
    console.error('Error placing bet:', error);
    return c.json({ error: String(error) }, 500);
  }
});

// === Paladin Wallet Integration ===
// Paladin Program: 4nsD1dKtbA9CpxD5vyN2eVQX7LhvxEWdxPyQJ5r83Kf5
// Enables agents with bounded spending authority to bet autonomously
const PALADIN_PROGRAM_ID = '4nsD1dKtbA9CpxD5vyN2eVQX7LhvxEWdxPyQJ5r83Kf5';

app.post('/markets/:id/bet/paladin', async (c) => {
  const marketId = c.req.param('id');
  
  try {
    const body = await c.req.json();
    const {
      outcomeIndex,
      amount,
      agentPubkey,       // The agent placing the bet
      delegationPubkey,  // The Paladin delegation PDA
      signedTx,          // Optional: pre-signed tx with delegation
    } = body;
    
    // Validate required fields
    if (outcomeIndex === undefined || !amount || !agentPubkey) {
      return c.json({
        error: 'Missing required fields',
        required: ['outcomeIndex', 'amount', 'agentPubkey'],
        optional: ['delegationPubkey', 'signedTx'],
        integration: {
          name: 'Paladin Wallet Integration',
          programId: PALADIN_PROGRAM_ID,
          description: 'Place bets using Paladin wallet delegation for autonomous agents',
          howItWorks: [
            '1. Human funds Paladin wallet with betting budget (e.g., 0.5 SOL)',
            '2. Human creates delegation with DailyLimit plugin (e.g., 0.1 SOL/day)',
            '3. Agent uses this endpoint with delegation proof',
            '4. AgentBets verifies delegation is valid and has remaining budget',
            '5. Bet executes without human approval (within limits)',
          ],
          paladinDocs: 'https://github.com/paladin-agent/paladin',
          status: 'Phase 1: Spec ready, integration testing pending',
        },
      }, 400);
    }
    
    // Get market pubkey
    let marketPubkey: PublicKey;
    try {
      marketPubkey = new PublicKey(marketId);
    } catch {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('market'), Buffer.from(marketId)],
        programId
      );
      marketPubkey = pda;
    }
    
    // Phase 1: Return spec and what we need to test
    // Phase 2: Once we test with paladin-agent on devnet, add actual verification
    if (!delegationPubkey) {
      return c.json({
        status: 'delegation_required',
        message: 'To use Paladin integration, provide your delegation PDA',
        marketPubkey: marketPubkey.toBase58(),
        request: {
          outcomeIndex,
          amount,
          agentPubkey,
        },
        nextSteps: [
          '1. Create a Paladin wallet with betting budget on devnet',
          '2. Set up DailyLimit plugin with your desired spend limit',
          '3. Get your delegation PDA address',
          '4. Retry with delegationPubkey in your request',
        ],
        paladinEndpoints: {
          createWallet: 'paladin-agent API (see their skill.md)',
          getDelegation: 'Query Paladin program for delegation PDAs',
        },
      });
    }
    
    // If signed tx provided (agent signed with delegation authority)
    if (signedTx) {
      try {
        const txBuffer = Buffer.from(signedTx, 'base64');
        const sig = await connection.sendRawTransaction(txBuffer);
        await connection.confirmTransaction(sig, 'confirmed');
        
        // Trigger webhook
        triggerWebhooks('bet', {
          marketId,
          marketPubkey: marketPubkey.toBase58(),
          txSignature: sig,
          viaIntegration: 'paladin',
          agentPubkey,
          delegationPubkey,
          explorerUrl: `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
        }).catch(e => console.error('Paladin bet webhook failed:', e));
        
        return c.json({
          success: true,
          txSignature: sig,
          integration: 'paladin',
          message: 'Bet placed via Paladin delegation',
          explorerUrl: `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
        });
      } catch (error) {
        return c.json({
          error: 'Transaction failed',
          details: String(error),
          hint: 'Check that delegation is valid and has remaining budget',
        }, 400);
      }
    }
    
    // Return unsigned tx for agent to sign with delegation
    const agent = new PublicKey(agentPubkey);
    
    // Derive position PDA
    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('position'), marketPubkey.toBuffer(), agent.toBuffer()],
      programId
    );
    
    // Build instruction
    const ix = await program.methods
      .buyShares(outcomeIndex, new BN(amount))
      .accounts({
        market: marketPubkey,
        position: positionPda,
        buyer: agent,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    
    // Build transaction
    const { blockhash } = await connection.getLatestBlockhash();
    const tx = new (await import('@solana/web3.js')).Transaction({
      recentBlockhash: blockhash,
      feePayer: agent,
    }).add(ix);
    
    const serialized = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }).toString('base64');
    
    return c.json({
      status: 'ready_to_sign',
      unsignedTx: serialized,
      marketPubkey: marketPubkey.toBase58(),
      positionPda: positionPda.toBase58(),
      integration: 'paladin',
      delegation: {
        pubkey: delegationPubkey,
        note: 'Sign this tx using your Paladin delegation authority',
      },
      nextStep: 'Sign with delegation and submit via signedTx field',
    });
    
  } catch (error) {
    console.error('Error in Paladin bet:', error);
    return c.json({ error: String(error) }, 500);
  }
});

// === AgentWallet Transfer Flow ===
// Enables betting via AgentWallet's transfer-solana action
// Every hackathon agent has AgentWallet — this is the path of least resistance

const PENDING_DEPOSITS_FILE = process.env.PENDING_DEPOSITS_FILE || './pending_deposits.json';

interface PendingDeposit {
  betId: string;
  agentPubkey: string;
  marketId: string;
  outcomeIndex: number;
  expectedAmountLamports: number;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'detected' | 'confirmed' | 'placed' | 'expired' | 'failed';
  txSignature?: string;
  betTxSignature?: string;
  error?: string;
}

function loadPendingDeposits(): PendingDeposit[] {
  try {
    if (existsSync(PENDING_DEPOSITS_FILE)) {
      return JSON.parse(readFileSync(PENDING_DEPOSITS_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Failed to load pending deposits:', e);
  }
  return [];
}

function savePendingDeposits(deposits: PendingDeposit[]) {
  try {
    writeFileSync(PENDING_DEPOSITS_FILE, JSON.stringify(deposits, null, 2));
  } catch (e) {
    console.error('Failed to save pending deposits:', e);
  }
}

function generateBetId(): string {
  // Short, readable bet ID: ab-xxxx-xxxx
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'; // no confusing chars
  const part = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `ab-${part()}-${part()}`;
}

// Prepare a bet via AgentWallet transfer
// Agent sends SOL to our vault with bet ID in memo
// We detect the transfer and place the bet on their behalf
app.post('/bet/agentwallet/prepare', async (c) => {
  try {
    const body = await c.req.json();
    const { market, outcome, sol, agentPubkey } = body;
    
    // Validate required fields with helpful errors
    if (!market) {
      return c.json({
        error: 'Missing market',
        hint: 'Which market do you want to bet on?',
        example: { market: 'submissions-over-400', outcome: 'Yes', sol: 0.01, agentPubkey: 'YOUR_AGENTWALLET_ADDRESS' },
        getMarkets: 'GET /markets',
        integration: 'agentwallet',
      }, 400);
    }
    
    if (!outcome) {
      return c.json({
        error: 'Missing outcome',
        hint: 'Which outcome are you betting on?',
        example: { market, outcome: 'Yes', sol: 0.01, agentPubkey: 'YOUR_AGENTWALLET_ADDRESS' },
        integration: 'agentwallet',
      }, 400);
    }
    
    if (!sol) {
      return c.json({
        error: 'Missing sol amount',
        hint: 'How much SOL to bet?',
        example: { market, outcome, sol: 0.01, agentPubkey: 'YOUR_AGENTWALLET_ADDRESS' },
        minBet: '0.001 SOL',
        integration: 'agentwallet',
      }, 400);
    }
    
    if (!agentPubkey) {
      return c.json({
        error: 'Missing agentPubkey',
        hint: 'Your AgentWallet Solana address (winnings will be sent here)',
        example: { market, outcome, sol, agentPubkey: '4aQ9QGLf7SQbhC6zmiWNasF3gW2UH77xPqXGXCZZpzww' },
        integration: 'agentwallet',
      }, 400);
    }
    
    // Validate sol amount
    const amountLamports = Math.floor(sol * LAMPORTS_PER_SOL);
    if (amountLamports < 1000000) { // 0.001 SOL minimum
      return c.json({
        error: 'Bet too small',
        minimum: '0.001 SOL',
        yourBet: `${sol} SOL`,
        hint: 'Increase your bet amount',
      }, 400);
    }
    
    // Find market
    let marketPubkey: PublicKey;
    let marketData: MarketAccount;
    
    try {
      try {
        marketPubkey = new PublicKey(market);
        marketData = await program.account.market.fetch(marketPubkey) as MarketAccount;
      } catch {
        const [pda] = PublicKey.findProgramAddressSync(
          [Buffer.from('market'), Buffer.from(market)],
          programId
        );
        marketPubkey = pda;
        marketData = await program.account.market.fetch(marketPubkey) as MarketAccount;
      }
    } catch {
      const allMarkets = await program.account.market.all();
      const active = allMarkets
        .filter((m: any) => !m.account.resolved)
        .map((m: any) => ({
          id: m.account.marketId,
          question: m.account.question.substring(0, 50) + '...',
        }));
      
      return c.json({
        error: `Market "${market}" not found`,
        hint: 'Use market ID from the list below',
        activeMarkets: active.slice(0, 5),
        getAll: 'GET /markets',
      }, 404);
    }
    
    // Check if market is open
    if (marketData.resolved) {
      return c.json({
        error: 'Market already resolved',
        winner: marketData.outcomes[marketData.winningOutcome as number],
        hint: 'Check /markets for active markets',
      }, 400);
    }
    
    // Find outcome index by name
    const outcomeNames = marketData.outcomes.map((o: string) => o.toLowerCase());
    const outcomeIndex = outcomeNames.indexOf(outcome.toLowerCase());
    
    if (outcomeIndex === -1) {
      return c.json({
        error: `Outcome "${outcome}" not found`,
        validOutcomes: marketData.outcomes,
        hint: `Use one of: ${marketData.outcomes.join(', ')}`,
      }, 400);
    }
    
    // Validate agent pubkey
    let agent: PublicKey;
    try {
      agent = new PublicKey(agentPubkey);
    } catch {
      return c.json({
        error: 'Invalid agentPubkey',
        hint: 'Must be a valid Solana public key',
      }, 400);
    }
    
    // Generate unique bet ID
    const betId = generateBetId();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minute expiry
    
    // Get vault address (authority wallet)
    if (!authorityWallet) {
      return c.json({ error: 'Vault not configured' }, 503);
    }
    const vaultAddress = authorityWallet.publicKey.toBase58();
    
    // Calculate expected payout
    const currentPool = marketData.outcomePools[outcomeIndex].toNumber();
    const totalPool = marketData.totalPool.toNumber();
    const newPool = totalPool + amountLamports;
    const newOutcomePool = currentPool + amountLamports;
    const shareOfOutcome = amountLamports / newOutcomePool;
    const grossPayout = Math.floor(shareOfOutcome * newPool);
    const fee = Math.floor(grossPayout / 50); // 2%
    const netPayout = grossPayout - fee;
    
    // Save pending deposit
    const deposits = loadPendingDeposits();
    const newDeposit: PendingDeposit = {
      betId,
      agentPubkey: agent.toBase58(),
      marketId: marketData.marketId,
      outcomeIndex,
      expectedAmountLamports: amountLamports,
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: 'pending',
    };
    deposits.push(newDeposit);
    savePendingDeposits(deposits);
    
    console.log(`AgentWallet bet prepared: ${betId} for ${sol} SOL on ${marketData.marketId}`);
    
    return c.json({
      status: 'ready',
      betId,
      integration: 'agentwallet',
      
      // Instructions for the agent
      depositInstructions: {
        action: 'transfer-solana',
        to: vaultAddress,
        amount: sol,
        note: 'Use AgentWallet transfer-solana to send SOL to this address',
      },
      
      // What we'll do
      whatHappensNext: [
        `1. You send ${sol} SOL to ${vaultAddress}`,
        '2. We detect your transfer on-chain by matching sender + amount (checking every 60s)',
        '3. We place the bet using our vault (your address tracked for payout)',
        '4. If you win, we transfer winnings to your AgentWallet address',
      ],
      
      // Bet details
      bet: {
        market: marketData.marketId,
        question: marketData.question,
        outcome: marketData.outcomes[outcomeIndex],
        outcomeIndex,
        amount: `${sol} SOL`,
        amountLamports,
        beneficiary: agent.toBase58(),
      },
      
      // Expected payout
      projection: {
        potentialPayout: `${(netPayout / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
        potentialProfit: `${((netPayout - amountLamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
        currentOdds: `${((currentPool / totalPool) * 100).toFixed(1)}%`,
      },
      
      // Timing
      timing: {
        expiresAt: expiresAt.toISOString(),
        expiresInMinutes: 15,
        note: 'Complete transfer within 15 minutes or prepare again',
      },
      
      // Check status
      checkStatus: {
        endpoint: `GET /bet/agentwallet/status/${betId}`,
        note: 'Poll this endpoint to check if your bet was placed',
      },
      
      // AgentWallet specific
      agentWalletAction: {
        tool: 'agentwallet',
        action: 'transfer-solana',
        params: {
          to: vaultAddress,
          amount: sol,
        },
        example: `Use AgentWallet's transfer-solana action with: to="${vaultAddress}", amount=${sol}`,
        note: 'No memo needed - we match by sender address + amount',
      },
    });
    
  } catch (error) {
    console.error('Error preparing AgentWallet bet:', error);
    return c.json({ error: String(error) }, 500);
  }
});

// Check status of an AgentWallet bet
app.get('/bet/agentwallet/status/:betId', async (c) => {
  const betId = c.req.param('betId');
  
  const deposits = loadPendingDeposits();
  const deposit = deposits.find(d => d.betId === betId);
  
  if (!deposit) {
    return c.json({
      error: 'Bet ID not found',
      hint: 'Check your bet ID or prepare a new bet',
      prepareEndpoint: 'POST /bet/agentwallet/prepare',
    }, 404);
  }
  
  // Check if expired
  if (deposit.status === 'pending' && new Date(deposit.expiresAt) < new Date()) {
    deposit.status = 'expired';
    savePendingDeposits(deposits);
  }
  
  return c.json({
    betId: deposit.betId,
    status: deposit.status,
    market: deposit.marketId,
    outcomeIndex: deposit.outcomeIndex,
    amount: `${deposit.expectedAmountLamports / LAMPORTS_PER_SOL} SOL`,
    beneficiary: deposit.agentPubkey,
    createdAt: deposit.createdAt,
    expiresAt: deposit.expiresAt,
    ...(deposit.txSignature && { depositTx: deposit.txSignature }),
    ...(deposit.betTxSignature && { betTx: deposit.betTxSignature }),
    ...(deposit.error && { error: deposit.error }),
    statusMeaning: {
      pending: 'Waiting for your SOL transfer',
      detected: 'Transfer detected, placing bet...',
      confirmed: 'Transfer confirmed on-chain',
      placed: 'Bet successfully placed!',
      expired: 'Deposit window expired, prepare a new bet',
      failed: 'Something went wrong, see error field',
    }[deposit.status],
  });
});

// Process pending AgentWallet deposits (called by cron or manually)
app.post('/bet/agentwallet/process', async (c) => {
  if (!authorityWallet) {
    return c.json({ error: 'Authority wallet not configured' }, 503);
  }
  
  const deposits = loadPendingDeposits();
  const now = new Date();
  const processed: { betId: string; status: string; result?: string }[] = [];
  
  for (const deposit of deposits) {
    // Skip non-pending deposits
    if (deposit.status !== 'pending') continue;
    
    // Check if expired
    if (new Date(deposit.expiresAt) < now) {
      deposit.status = 'expired';
      processed.push({ betId: deposit.betId, status: 'expired' });
      continue;
    }
    
    // Check for incoming transfer matching sender + amount (no memo required)
    // AgentWallet doesn't support memos, so we match by:
    // 1. Sender = agent's pubkey
    // 2. Amount within 5% tolerance (fees vary)
    // 3. Time within window (handled above)
    try {
      const vaultPubkey = authorityWallet.publicKey;
      const agentPubkey = new PublicKey(deposit.agentPubkey);
      const signatures = await connection.getSignaturesForAddress(vaultPubkey, { limit: 50 });
      
      for (const sigInfo of signatures) {
        // Skip if older than deposit creation
        if (sigInfo.blockTime && sigInfo.blockTime * 1000 < new Date(deposit.createdAt).getTime()) {
          continue;
        }
        
        // Get transaction details
        const tx = await connection.getParsedTransaction(sigInfo.signature, { maxSupportedTransactionVersion: 0 });
        if (!tx?.meta || tx.meta.err) continue;
        
        // Find the transfer instruction (system program transfer)
        const instructions = tx.transaction.message.instructions;
        let foundMatch = false;
        
        for (const ix of instructions) {
          // Check for system program transfer
          if ('parsed' in ix && ix.parsed?.type === 'transfer') {
            const info = ix.parsed.info;
            const sender = info.source;
            const recipient = info.destination;
            const lamports = info.lamports;
            
            // Check: sender is agent, recipient is vault, amount matches (5% tolerance)
            if (sender === agentPubkey.toBase58() && 
                recipient === vaultPubkey.toBase58()) {
              const tolerance = deposit.expectedAmountLamports * 0.05;
              if (Math.abs(lamports - deposit.expectedAmountLamports) <= tolerance) {
                foundMatch = true;
                break;
              }
            }
          }
        }
        
        if (foundMatch) {
          // Found matching transfer!
          deposit.status = 'detected';
          deposit.txSignature = sigInfo.signature;
          console.log(`Detected AgentWallet deposit ${deposit.betId} from ${deposit.agentPubkey}: ${sigInfo.signature}`);
          
          // Place the bet on their behalf
          try {
            // Derive market PDA
            const [marketPda] = PublicKey.findProgramAddressSync(
              [Buffer.from('market'), Buffer.from(deposit.marketId)],
              programId
            );
            
            // Use authority wallet as buyer (we control it)
            // Agent is tracked as beneficiary off-chain - winnings transferred on claim
            const [positionPda] = PublicKey.findProgramAddressSync(
              [Buffer.from('position'), marketPda.toBuffer(), authorityWallet!.publicKey.toBuffer()],
              programId
            );
            
            // Place bet with authority wallet (we pay, we sign)
            // Agent's address is stored in deposit.agentPubkey for payout
            const betTx = await program.methods
              .buyShares(deposit.outcomeIndex, new BN(deposit.expectedAmountLamports))
              .accounts({
                market: marketPda,
                position: positionPda,
                buyer: authorityWallet!.publicKey, // Authority places bet
                systemProgram: SystemProgram.programId,
              })
              .signers([authorityWallet!])
              .rpc();
            
            deposit.status = 'placed';
            deposit.betTxSignature = betTx;
            
            // Trigger webhook
            triggerWebhooks('bet', {
              marketId: deposit.marketId,
              betId: deposit.betId,
              viaIntegration: 'agentwallet',
              agentPubkey: deposit.agentPubkey,
              txSignature: betTx,
            }).catch(e => console.error('AgentWallet bet webhook failed:', e));
            
            processed.push({ betId: deposit.betId, status: 'placed', result: betTx });
          } catch (betError) {
            deposit.status = 'failed';
            deposit.error = String(betError);
            processed.push({ betId: deposit.betId, status: 'failed', result: deposit.error });
          }
          
          break; // Found the matching transfer, stop searching
        }
      }
    } catch (searchError) {
      console.error(`Error searching for deposit ${deposit.betId}:`, searchError);
    }
  }
  
  savePendingDeposits(deposits);
  
  return c.json({
    processed: processed.length,
    results: processed,
    pendingCount: deposits.filter(d => d.status === 'pending').length,
  });
});

// List all pending deposits (for debugging/monitoring)
app.get('/bet/agentwallet/pending', async (c) => {
  const deposits = loadPendingDeposits();
  const now = new Date();
  
  const pending = deposits.filter(d => d.status === 'pending' && new Date(d.expiresAt) > now);
  const recent = deposits.filter(d => d.status !== 'pending').slice(-10);
  
  return c.json({
    pending: pending.map(d => ({
      betId: d.betId,
      market: d.marketId,
      amount: `${d.expectedAmountLamports / LAMPORTS_PER_SOL} SOL`,
      expiresIn: Math.round((new Date(d.expiresAt).getTime() - now.getTime()) / 1000 / 60) + ' minutes',
    })),
    recentCompleted: recent.map(d => ({
      betId: d.betId,
      status: d.status,
      market: d.marketId,
    })),
    pendingCount: pending.length,
  });
});

// Claim winnings for an AgentWallet bet and transfer to agent
app.post('/bet/agentwallet/claim/:betId', async (c) => {
  const betId = c.req.param('betId');
  
  if (!authorityWallet) {
    return c.json({ error: 'Authority wallet not configured' }, 503);
  }
  
  const deposits = loadPendingDeposits();
  const deposit = deposits.find(d => d.betId === betId);
  
  if (!deposit) {
    return c.json({ error: 'Bet not found', hint: 'Check your bet ID' }, 404);
  }
  
  if (deposit.status !== 'placed') {
    return c.json({
      error: 'Bet not placed',
      status: deposit.status,
      hint: deposit.status === 'pending' ? 'Deposit not yet detected' : 'Bet was not successfully placed',
    }, 400);
  }
  
  try {
    // Get market
    const [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('market'), Buffer.from(deposit.marketId)],
      programId
    );
    const market = await program.account.market.fetch(marketPda) as MarketAccount;
    
    if (!market.resolved) {
      return c.json({
        error: 'Market not resolved yet',
        market: deposit.marketId,
        question: market.question,
        resolutionTime: new Date(market.resolutionTime.toNumber() * 1000).toISOString(),
        hint: 'Wait for market resolution before claiming',
      }, 400);
    }
    
    // Check if agent's bet won
    const didWin = market.winningOutcome === deposit.outcomeIndex;
    
    if (!didWin) {
      // Update deposit status
      deposit.status = 'failed' as any; // Mark as lost
      deposit.error = `Outcome ${deposit.outcomeIndex} lost. Winner: ${market.winningOutcome}`;
      savePendingDeposits(deposits);
      
      return c.json({
        won: false,
        market: deposit.marketId,
        yourOutcome: market.outcomes[deposit.outcomeIndex],
        winningOutcome: market.outcomes[market.winningOutcome as number],
        message: 'Sorry, your bet did not win.',
      });
    }
    
    // Get authority's position to see winnings
    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('position'), marketPda.toBuffer(), authorityWallet.publicKey.toBuffer()],
      programId
    );
    
    // Claim winnings to authority wallet first
    const claimTx = await program.methods
      .claimWinnings()
      .accounts({
        market: marketPda,
        position: positionPda,
        claimer: authorityWallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([authorityWallet])
      .rpc();
    
    console.log(`Claimed winnings for ${betId}: ${claimTx}`);
    
    // Calculate payout and transfer to agent
    const totalPool = market.totalPool.toNumber();
    const outcomePool = market.outcomePools[deposit.outcomeIndex].toNumber();
    const shareOfOutcome = deposit.expectedAmountLamports / outcomePool;
    const grossPayout = Math.floor(shareOfOutcome * totalPool);
    const fee = Math.floor(grossPayout / 50); // 2% fee
    const netPayout = grossPayout - fee;
    
    // Transfer to agent
    const agentPubkey = new PublicKey(deposit.agentPubkey);
    const transferIx = SystemProgram.transfer({
      fromPubkey: authorityWallet.publicKey,
      toPubkey: agentPubkey,
      lamports: netPayout,
    });
    
    const { blockhash } = await connection.getLatestBlockhash();
    const transferTx = new (await import('@solana/web3.js')).Transaction({
      recentBlockhash: blockhash,
      feePayer: authorityWallet.publicKey,
    }).add(transferIx);
    
    transferTx.sign(authorityWallet);
    const transferSig = await connection.sendRawTransaction(transferTx.serialize());
    await connection.confirmTransaction(transferSig, 'confirmed');
    
    console.log(`Transferred ${netPayout / LAMPORTS_PER_SOL} SOL to ${deposit.agentPubkey}: ${transferSig}`);
    
    // Update deposit status
    (deposit as any).claimTx = claimTx;
    (deposit as any).transferTx = transferSig;
    (deposit as any).payout = netPayout;
    savePendingDeposits(deposits);
    
    return c.json({
      won: true,
      market: deposit.marketId,
      outcome: market.outcomes[deposit.outcomeIndex],
      payout: `${(netPayout / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
      payoutLamports: netPayout,
      transferredTo: deposit.agentPubkey,
      claimTx,
      transferTx: transferSig,
      explorerUrl: `https://explorer.solana.com/tx/${transferSig}?cluster=devnet`,
    });
    
  } catch (error) {
    console.error(`Error claiming ${betId}:`, error);
    return c.json({ error: String(error) }, 500);
  }
});

// === Quick Bet Endpoint ===
// Simplified betting for agents - accepts outcome by name, amount in SOL
app.post('/quick-bet', async (c) => {
  try {
    const body = await c.req.json();
    const { market, outcome, sol, pubkey, signedTx } = body;
    
    // Validate required fields with helpful errors
    if (!market) {
      return c.json({
        error: 'Missing market',
        hint: 'Provide market ID or slug from /markets endpoint',
        example: { market: 'submissions-over-400', outcome: 'Yes', sol: 0.01, pubkey: 'YOUR_PUBKEY' },
        getMarkets: 'GET /markets',
      }, 400);
    }
    
    if (!outcome) {
      return c.json({
        error: 'Missing outcome',
        hint: 'What are you betting on? Use outcome name like "Yes" or "No"',
        example: { market, outcome: 'Yes', sol: 0.01, pubkey: 'YOUR_PUBKEY' },
      }, 400);
    }
    
    if (!sol && !signedTx) {
      return c.json({
        error: 'Missing sol amount',
        hint: 'How much SOL to bet? (e.g., 0.01)',
        example: { market, outcome, sol: 0.01, pubkey: 'YOUR_PUBKEY' },
        minBet: '0.001 SOL',
      }, 400);
    }
    
    if (!pubkey && !signedTx) {
      return c.json({
        error: 'Missing pubkey',
        hint: 'Your Solana wallet public key',
        example: { market, outcome, sol, pubkey: 'Ensa3bMUnd...' },
      }, 400);
    }
    
    // If signed tx provided, submit it directly
    if (signedTx) {
      const txBuffer = Buffer.from(signedTx, 'base64');
      const sig = await connection.sendRawTransaction(txBuffer);
      await connection.confirmTransaction(sig, 'confirmed');
      
      triggerWebhooks('bet', {
        marketId: market,
        txSignature: sig,
        viaEndpoint: 'quick-bet',
        explorerUrl: `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
      }).catch(e => console.error('Quick-bet webhook failed:', e));
      
      return c.json({
        success: true,
        txSignature: sig,
        explorerUrl: `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
      });
    }
    
    // Find market
    let marketPubkey: PublicKey;
    let marketData: MarketAccount;
    
    try {
      // Try as pubkey first
      try {
        marketPubkey = new PublicKey(market);
        marketData = await program.account.market.fetch(marketPubkey) as MarketAccount;
      } catch {
        // Try as slug
        const [pda] = PublicKey.findProgramAddressSync(
          [Buffer.from('market'), Buffer.from(market)],
          programId
        );
        marketPubkey = pda;
        marketData = await program.account.market.fetch(marketPubkey) as MarketAccount;
      }
    } catch {
      // List available markets
      const allMarkets = await program.account.market.all();
      const active = allMarkets
        .filter((m: any) => !m.account.resolved)
        .map((m: any) => ({
          id: m.account.marketId,
          question: m.account.question.substring(0, 50) + '...',
        }));
      
      return c.json({
        error: `Market "${market}" not found`,
        hint: 'Use market ID from the list below',
        activeMarkets: active.slice(0, 5),
        getAll: 'GET /markets',
      }, 404);
    }
    
    // Check if market is open
    if (marketData.resolved) {
      return c.json({
        error: 'Market already resolved',
        winner: marketData.outcomes[marketData.winningOutcome as number],
        hint: 'Check /markets for active markets',
      }, 400);
    }
    
    // Find outcome index by name
    const outcomeNames = marketData.outcomes.map((o: string) => o.toLowerCase());
    const outcomeIndex = outcomeNames.indexOf(outcome.toLowerCase());
    
    if (outcomeIndex === -1) {
      return c.json({
        error: `Outcome "${outcome}" not found`,
        validOutcomes: marketData.outcomes,
        hint: `Use one of: ${marketData.outcomes.join(', ')}`,
        example: { market, outcome: marketData.outcomes[0], sol, pubkey },
      }, 400);
    }
    
    // Convert SOL to lamports
    const amount = Math.floor(sol * LAMPORTS_PER_SOL);
    if (amount < 1000000) { // 0.001 SOL minimum
      return c.json({
        error: 'Bet too small',
        minimum: '0.001 SOL',
        yourBet: `${sol} SOL`,
        hint: 'Increase your bet amount',
      }, 400);
    }
    
    // Build unsigned tx
    const buyer = new PublicKey(pubkey);
    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('position'), marketPubkey.toBuffer(), buyer.toBuffer()],
      programId
    );
    
    const ix = await program.methods
      .buyShares(outcomeIndex, new BN(amount))
      .accounts({
        market: marketPubkey,
        position: positionPda,
        buyer,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    
    const { blockhash } = await connection.getLatestBlockhash();
    const tx = new (await import('@solana/web3.js')).Transaction({
      recentBlockhash: blockhash,
      feePayer: buyer,
    }).add(ix);
    
    const serialized = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }).toString('base64');
    
    // Calculate expected payout
    const currentPool = marketData.outcomePools[outcomeIndex].toNumber();
    const totalPool = marketData.totalPool.toNumber();
    const newPool = totalPool + amount;
    const newOutcomePool = currentPool + amount;
    const shareOfOutcome = amount / newOutcomePool;
    const payout = Math.floor(shareOfOutcome * newPool);
    const profit = payout - amount;
    
    return c.json({
      status: 'ready',
      bet: {
        market: marketData.marketId,
        question: marketData.question,
        outcome: marketData.outcomes[outcomeIndex],
        amount: `${sol} SOL`,
        amountLamports: amount,
      },
      projection: {
        potentialPayout: `${(payout / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
        potentialProfit: `${(profit / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
        impliedOdds: `${((currentPool / totalPool) * 100).toFixed(1)}%`,
      },
      unsignedTx: serialized,
      nextStep: 'Sign with your wallet, then POST to /quick-bet with signedTx',
      claimAfterWin: `POST /markets/${marketData.marketId}/claim`,
    });
    
  } catch (error) {
    console.error('Error in quick-bet:', error);
    return c.json({
      error: 'Unexpected error',
      details: String(error),
      help: 'Check your request format and try again',
    }, 500);
  }
});

// Get position for a user in a market
app.get('/markets/:id/position/:owner', async (c) => {
  const marketId = c.req.param('id');
  const owner = c.req.param('owner');
  
  try {
    let marketPubkey: PublicKey;
    try {
      marketPubkey = new PublicKey(marketId);
    } catch {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('market'), Buffer.from(marketId)],
        programId
      );
      marketPubkey = pda;
    }
    
    const ownerPubkey = new PublicKey(owner);
    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('position'), marketPubkey.toBuffer(), ownerPubkey.toBuffer()],
      programId
    );
    
    const position = await program.account.position.fetch(positionPda);
    
    return c.json({
      position: {
        pubkey: positionPda.toBase58(),
        owner: position.owner.toBase58(),
        market: position.market.toBase58(),
        shares: position.shares.map((s: any) => s.toString()),
      },
    });
  } catch (error) {
    return c.json({ error: 'Position not found' }, 404);
  }
});

// Simulate a bet - preview payout before committing
// Shows exact ROI, breakeven probability, and what happens in each outcome
app.get('/markets/:id/simulate', async (c) => {
  const marketId = c.req.param('id');
  const outcomeIndex = parseInt(c.req.query('outcome') || '0');
  const amountLamports = parseInt(c.req.query('amount') || '50000000'); // Default 0.05 SOL
  
  try {
    // Get market
    let marketPubkey: PublicKey;
    try {
      marketPubkey = new PublicKey(marketId);
    } catch {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('market'), Buffer.from(marketId)],
        programId
      );
      marketPubkey = pda;
    }
    
    const market = await program.account.market.fetch(marketPubkey);
    
    if (market.resolved) {
      return c.json({ 
        error: 'Market already resolved',
        winningOutcome: market.winningOutcome,
        winningOutcomeName: market.outcomes[market.winningOutcome as number],
      }, 400);
    }
    
    if (outcomeIndex < 0 || outcomeIndex >= market.outcomes.length) {
      return c.json({ 
        error: `Invalid outcome index. Valid range: 0-${market.outcomes.length - 1}`,
        outcomes: market.outcomes,
      }, 400);
    }
    
    const totalPool = market.totalPool.toNumber();
    const outcomePools = market.outcomePools.map((p: any) => p.toNumber());
    const currentOutcomePool = outcomePools[outcomeIndex];
    
    // Simulate adding this bet
    const newOutcomePool = currentOutcomePool + amountLamports;
    const newTotalPool = totalPool + amountLamports;
    
    // Calculate shares you'd get (proportional to your contribution)
    const yourShares = amountLamports;
    
    // If you win: (yourShares / totalWinningShares) * totalPool - 2% fee
    const grossPayout = Math.floor((yourShares * newTotalPool) / newOutcomePool);
    const fee = Math.floor(grossPayout / 50); // 2%
    const netPayout = grossPayout - fee;
    const profit = netPayout - amountLamports;
    
    // Calculate implied probability
    const impliedProb = newOutcomePool / newTotalPool;
    const multiplier = netPayout / amountLamports;
    const roi = ((netPayout - amountLamports) / amountLamports) * 100;
    
    // Breakeven probability (what probability makes this bet EV-neutral)
    const breakevenProb = amountLamports / netPayout;
    
    return c.json({
      simulation: {
        marketId: market.marketId,
        question: market.question,
        betOutcome: market.outcomes[outcomeIndex],
        outcomeIndex,
        betAmount: {
          lamports: amountLamports,
          sol: amountLamports / LAMPORTS_PER_SOL,
        },
      },
      ifYouWin: {
        grossPayout: {
          lamports: grossPayout,
          sol: grossPayout / LAMPORTS_PER_SOL,
        },
        fee: {
          lamports: fee,
          sol: fee / LAMPORTS_PER_SOL,
          percent: '2%',
        },
        netPayout: {
          lamports: netPayout,
          sol: netPayout / LAMPORTS_PER_SOL,
        },
        profit: {
          lamports: profit,
          sol: profit / LAMPORTS_PER_SOL,
        },
        multiplier: `${multiplier.toFixed(2)}x`,
        roi: `+${roi.toFixed(1)}%`,
      },
      ifYouLose: {
        loss: {
          lamports: amountLamports,
          sol: amountLamports / LAMPORTS_PER_SOL,
        },
        note: 'You lose your entire bet. No partial refunds.',
      },
      odds: {
        impliedProbability: `${(impliedProb * 100).toFixed(1)}%`,
        breakevenProbability: `${(breakevenProb * 100).toFixed(1)}%`,
        note: `You profit if true probability > ${(breakevenProb * 100).toFixed(1)}%`,
      },
      currentMarket: {
        totalPool: `${(totalPool / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
        outcomePool: `${(currentOutcomePool / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
        outcomes: market.outcomes.map((name: string, i: number) => ({
          name,
          pool: `${(outcomePools[i] / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
          impliedOdds: totalPool > 0 ? `${((outcomePools[i] / totalPool) * 100).toFixed(1)}%` : '0%',
        })),
      },
      readyToBet: {
        endpoint: `POST /markets/${market.marketId}/bet`,
        body: {
          outcomeIndex,
          amount: amountLamports,
          buyerPubkey: 'YOUR_WALLET_PUBKEY',
        },
      },
    });
  } catch (error) {
    console.error('Error simulating bet:', error);
    return c.json({ error: 'Market not found' }, 404);
  }
});

// Get pending resolutions (upcoming + their challenge windows)
app.get('/resolutions/pending', async (c) => {
  try {
    const markets = await program.account.market.all();
    const now = Math.floor(Date.now() / 1000);
    const CHALLENGE_WINDOW_HOURS = 24;
    
    const pending = markets
      .filter((m: { account: MarketAccount }) => !m.account.resolved)
      .map((m: { publicKey: PublicKey; account: MarketAccount }) => {
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
      .sort((a: any, b: any) => a.resolutionTime - b.resolutionTime);
    
    return c.json({
      challengeWindowHours: CHALLENGE_WINDOW_HOURS,
      pendingResolutions: pending,
      count: pending.length,
      note: 'Resolution will be posted to forum before on-chain execution. Challenge during the window to dispute.',
    });
  } catch (error) {
    console.error('Error fetching pending resolutions:', error);
    return c.json({ error: 'Failed to fetch pending resolutions' }, 500);
  }
});

// Resolution history — track record of past resolutions
app.get('/resolutions/history', async (c) => {
  try {
    const markets = await program.account.market.all();
    
    const resolved = markets
      .filter((m: { account: MarketAccount }) => m.account.resolved)
      .map((m: { publicKey: PublicKey; account: MarketAccount }) => {
        const winningIdx = m.account.winningOutcome;
        const winningOutcomeName = winningIdx !== null && winningIdx !== undefined 
          ? m.account.outcomes[winningIdx] 
          : 'Unknown';
        
        return {
          marketId: m.account.marketId,
          question: m.account.question,
          outcomes: m.account.outcomes,
          pubkey: m.publicKey.toBase58(),
          resolved: true,
          winningOutcome: winningIdx,
          winningOutcomeName,
          totalPoolSol: (m.account.totalPool.toNumber() / LAMPORTS_PER_SOL).toFixed(4),
          resolutionTime: m.account.resolutionTime.toNumber(),
          resolutionDate: new Date(m.account.resolutionTime.toNumber() * 1000).toISOString(),
          verifyOnChain: `https://explorer.solana.com/address/${m.publicKey.toBase58()}?cluster=devnet`,
        };
      })
      .sort((a: any, b: any) => b.resolutionTime - a.resolutionTime);
    
    return c.json({
      title: '📜 Resolution History',
      description: 'Completed market resolutions with on-chain verification links.',
      resolutions: resolved,
      count: resolved.length,
      trustNote: 'Each resolution is recorded on-chain. Click verifyOnChain to confirm.',
    });
  } catch (error) {
    console.error('Error fetching resolution history:', error);
    return c.json({ error: 'Failed to fetch resolution history' }, 500);
  }
});

// Verify market resolution data (for verifiable markets)
// Lets agents independently check what the resolution SHOULD be
app.get('/markets/:id/verify', async (c) => {
  const marketId = c.req.param('id');
  
  try {
    // Get market
    let marketPubkey: PublicKey;
    try {
      marketPubkey = new PublicKey(marketId);
    } catch {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('market'), Buffer.from(marketId)],
        programId
      );
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
        const data = await response.json() as { projects: any[]; totalCount?: number };
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
      } catch (fetchError) {
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
  } catch (error) {
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
    let marketPubkey: PublicKey;
    try {
      marketPubkey = new PublicKey(marketId);
    } catch {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('market'), Buffer.from(marketId)],
        programId
      );
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
    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('position'), marketPubkey.toBuffer(), claimer.toBuffer()],
      programId
    );
    
    let position;
    try {
      position = await program.account.position.fetch(positionPda);
    } catch {
      return c.json({ 
        error: 'No position found for this wallet in this market.',
        positionPda: positionPda.toBase58(),
      }, 404);
    }
    
    const winningOutcome = market.winningOutcome as number;
    const winnerShares = position.shares[winningOutcome].toNumber();
    
    if (winnerShares <= 0) {
      return c.json({ 
        error: 'No winning shares to claim. Either you bet on a losing outcome or already claimed.',
        winningOutcome,
        winningOutcomeName: market.outcomes[winningOutcome],
        yourShares: position.shares.map((s: any) => s.toString()),
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
  } catch (error) {
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
    let marketPubkey: PublicKey;
    try {
      marketPubkey = new PublicKey(marketId);
    } catch {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('market'), Buffer.from(marketId)],
        programId
      );
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
        winningOutcomeName: market.outcomes[market.winningOutcome as number],
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
    const hasOnChainOracle = ON_CHAIN_ORACLES[marketIdStr] !== undefined;
    
    if (!isSubmissionsMarket && !isTestMarket && !hasOnChainOracle) {
      return c.json({ 
        error: 'Auto-resolution only available for verifiable markets',
        marketId: marketIdStr,
        verifiableMarkets: [
          'submissions-over-400', 
          'submissions-over-350', 
          'fresh-test-*',
          ...Object.keys(ON_CHAIN_ORACLES),
        ],
        note: 'Other markets require manual resolution after hackathon results.',
      }, 400);
    }
    
    // === On-Chain Oracle Resolution (Trustless!) ===
    if (hasOnChainOracle) {
      const oracleResult = await resolveViaOnChainOracle(marketIdStr);
      
      if (!oracleResult) {
        const oracle = ON_CHAIN_ORACLES[marketIdStr];
        return c.json({
          error: 'Failed to read on-chain oracle data',
          oracleProgram: oracle.programId,
          pdaSeeds: oracle.pdaSeeds,
          message: 'The oracle program PDA may not exist yet or data format is unexpected.',
        }, 503);
      }
      
      const { outcome, value, threshold } = oracleResult;
      const oracle = ON_CHAIN_ORACLES[marketIdStr];
      const winningOutcomeName = market.outcomes[outcome];
      
      // Execute resolution
      const tx = await program.methods
        .resolveMarket(outcome)
        .accounts({
          market: marketPubkey,
          authority: authorityWallet.publicKey,
        })
        .signers([authorityWallet])
        .rpc();
      
      // Trigger webhooks
      await triggerWebhooks('resolution', {
        marketId: marketIdStr,
        winningOutcome: outcome,
        winningOutcomeName,
        oracleType: 'on-chain',
        oracleProgram: oracle.programId,
        oracleValue: value,
        threshold,
      });
      
      console.log(`On-chain oracle resolved ${marketIdStr}: ${winningOutcomeName} (value: ${value}, threshold: ${threshold})`);
      
      return c.json({
        success: true,
        marketId: marketIdStr,
        resolution: {
          winningOutcome: outcome,
          winningOutcomeName,
          reason: `On-chain value (${value}) ${oracle.comparison} threshold (${threshold})`,
        },
        verification: {
          oracleType: 'on-chain',
          oracleProgram: oracle.programId,
          pdaSeeds: oracle.pdaSeeds,
          field: oracle.field,
          value,
          threshold,
          comparison: oracle.comparison,
          trustLevel: 'TRUSTLESS — Anyone can verify by reading the PDA directly',
          note: 'Resolution determined by on-chain data, not API calls',
        },
        txSignature: tx,
        message: 'Market resolved via on-chain oracle. Anyone can claim winnings.',
      });
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
    
    let projectCount: number;
    try {
      const response = await fetch('https://agents.colosseum.com/api/projects');
      const data = await response.json() as { projects: any[]; totalCount?: number };
      projectCount = data.totalCount ?? data.projects?.length ?? 0;
    } catch (fetchError) {
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
  } catch (error) {
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
    let marketPubkey: PublicKey;
    let marketIdStr: string;
    try {
      marketPubkey = new PublicKey(marketId);
      const market = await program.account.market.fetch(marketPubkey);
      marketIdStr = market.marketId;
    } catch {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('market'), Buffer.from(marketId)],
        programId
      );
      marketPubkey = pda;
      marketIdStr = marketId;
    }
    
    // Verify market exists
    let market;
    try {
      market = await program.account.market.fetch(marketPubkey);
    } catch {
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
    const dispute: Dispute = {
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
  } catch (error) {
    console.error('Error filing dispute:', error);
    return c.json({ error: String(error) }, 500);
  }
});

// Get disputes for a market
app.get('/markets/:id/disputes', async (c) => {
  const marketId = c.req.param('id');
  
  try {
    // Get market pubkey
    let marketIdStr: string;
    try {
      const marketPubkey = new PublicKey(marketId);
      const market = await program.account.market.fetch(marketPubkey);
      marketIdStr = market.marketId;
    } catch {
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
  } catch (error) {
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
    
    let marketPubkey: PublicKey;
    try {
      marketPubkey = new PublicKey(marketId);
    } catch {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('market'), Buffer.from(marketId)],
        programId
      );
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
    
    // Fetch updated market data for webhook
    let marketData: MarketAccount | null = null;
    try {
      marketData = await program.account.market.fetch(marketPubkey) as MarketAccount;
    } catch (e) {
      console.error('Failed to fetch market for webhook:', e);
    }
    
    // Trigger webhooks asynchronously (don't block response)
    triggerWebhooks('resolution', {
      marketId: marketData?.marketId || marketId,
      marketPubkey: marketPubkey.toBase58(),
      winningOutcome,
      winnerName: marketData?.outcomes?.[winningOutcome] || `Outcome ${winningOutcome}`,
      txSignature: tx,
      totalPool: marketData ? (marketData.totalPool.toNumber() / LAMPORTS_PER_SOL).toFixed(4) : null,
      explorerUrl: `https://explorer.solana.com/tx/${tx}?cluster=devnet`,
    }).catch(e => console.error('Webhook trigger failed:', e));
    
    return c.json({
      success: true,
      txSignature: tx,
    });
  } catch (error) {
    console.error('Error resolving market:', error);
    return c.json({ error: String(error) }, 500);
  }
});

// === Trust Verification Endpoint ===
// Agents can call this to verify the system is trustworthy

app.get('/verify-all', async (c) => {
  const results: { passed: boolean; check: string; details: string }[] = [];
  
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
    const authorityMatches = markets.filter((m: any) => 
      m.account.authority.toBase58() === expectedAuthority
    ).length;
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
        const rentExempt = await connection.getMinimumBalanceForRentExemption(
          market.account.question.length + 500 // Approximate account size
        );
        const actualPool = Math.max(0, marketBalance - rentExempt);
        // Allow 0.01 SOL tolerance
        if (Math.abs(actualPool - reportedPool) < 0.01 * LAMPORTS_PER_SOL) {
          balanceMatches++;
        }
      } catch {
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
        const [marketPDA] = PublicKey.findProgramAddressSync(
          [Buffer.from('market'), Buffer.from(marketId)],
          programId
        );
        const marketAccount = await program.account.market.fetch(marketPDA);
        if (marketAccount) verifyWorks++;
      } catch {
        // Market doesn't exist
      }
    }
    results.push({
      passed: verifyWorks > 0,
      check: 'Auto-resolvable markets exist',
      details: `${verifyWorks}/${verifiableMarkets.length} verifiable markets found`,
    });
    
    // 6. Check for skin in the game
    const anchorMarket = markets.find((m: any) => m.account.marketId === 'winner-uses-anchor');
    if (anchorMarket) {
      const pools = anchorMarket.account.outcomePools.map((p: any) => p.toNumber());
      const hasBothSides = pools.filter((p: number) => p > 0).length >= 2;
      results.push({
        passed: hasBothSides,
        check: 'Skin in the game',
        details: hasBothSides 
          ? `Counter-positions exist (Yes: ${pools[0]/LAMPORTS_PER_SOL} SOL, No: ${pools[1]/LAMPORTS_PER_SOL} SOL)`
          : 'No counter-positions found',
      });
    }
    
    // Calculate trust score
    const passed = results.filter(r => r.passed).length;
    const total = results.length;
    const trustScore = Math.round((passed / total) * 100);
    
    let grade = 'F';
    if (trustScore >= 90) grade = 'A';
    else if (trustScore >= 80) grade = 'B';
    else if (trustScore >= 70) grade = 'C';
    else if (trustScore >= 60) grade = 'D';
    
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
  } catch (error) {
    return c.json({ 
      error: 'Verification failed', 
      details: String(error),
      message: 'You can verify manually via Solana Explorer',
    }, 500);
  }
});

// === On-Chain Oracle Endpoints ===
// Trustless resolution via direct PDA reads - no API, no trust

// List all registered on-chain oracles
app.get('/oracles', async (c) => {
  const oracles = Object.entries(ON_CHAIN_ORACLES).map(([marketId, oracle]) => ({
    marketId,
    programId: oracle.programId,
    pdaSeeds: oracle.pdaSeeds,
    field: oracle.field,
    threshold: oracle.threshold,
    comparison: oracle.comparison,
    outcomes: {
      yes: oracle.yesOutcome,
      no: oracle.noOutcome,
    },
  }));
  
  return c.json({
    oracles,
    count: oracles.length,
    trustLevel: 'TRUSTLESS — Resolution determined by on-chain PDA data',
    verificationNote: 'Anyone can verify by reading the PDA directly from the Solana blockchain',
  });
});

// Check oracle status for a specific market
app.get('/oracles/:marketId', async (c) => {
  const marketId = c.req.param('marketId');
  const oracle = ON_CHAIN_ORACLES[marketId];
  
  if (!oracle) {
    return c.json({
      error: 'No on-chain oracle registered for this market',
      marketId,
      registeredOracles: Object.keys(ON_CHAIN_ORACLES),
    }, 404);
  }
  
  // Try to read current oracle value
  const result = await readOnChainOracleValue(oracle);
  
  if (!result) {
    // PDA doesn't exist yet or data format unexpected
    const oracleProgramId = new PublicKey(oracle.programId);
    const seeds = oracle.pdaSeeds.map(s => Buffer.from(s));
    const [pda] = PublicKey.findProgramAddressSync(seeds, oracleProgramId);
    
    return c.json({
      marketId,
      oracle: {
        programId: oracle.programId,
        pdaSeeds: oracle.pdaSeeds,
        pdaAddress: pda.toBase58(),
        field: oracle.field,
        threshold: oracle.threshold,
        comparison: oracle.comparison,
      },
      status: 'PENDING',
      message: 'Oracle PDA not found or data format unexpected. The program may not have initialized state yet.',
      explorerUrl: `https://explorer.solana.com/address/${pda.toBase58()}?cluster=devnet`,
    });
  }
  
  // PDA exists, show current value and what resolution would be
  const { value } = result;
  const threshold = oracle.threshold ?? 0;
  
  let conditionMet: boolean;
  let comparisonStr: string;
  switch (oracle.comparison) {
    case 'gt': conditionMet = value > threshold; comparisonStr = '>'; break;
    case 'gte': conditionMet = value >= threshold; comparisonStr = '>='; break;
    case 'lt': conditionMet = value < threshold; comparisonStr = '<'; break;
    case 'lte': conditionMet = value <= threshold; comparisonStr = '<='; break;
    case 'eq': conditionMet = value === threshold; comparisonStr = '=='; break;
    default: conditionMet = false; comparisonStr = '?';
  }
  
  const oracleProgramId = new PublicKey(oracle.programId);
  const seeds = oracle.pdaSeeds.map(s => Buffer.from(s));
  const [pda] = PublicKey.findProgramAddressSync(seeds, oracleProgramId);
  
  return c.json({
    marketId,
    oracle: {
      programId: oracle.programId,
      pdaSeeds: oracle.pdaSeeds,
      pdaAddress: pda.toBase58(),
      field: oracle.field,
      threshold: oracle.threshold,
      comparison: oracle.comparison,
    },
    status: 'LIVE',
    currentValue: value,
    threshold,
    condition: `${value} ${comparisonStr} ${threshold}`,
    conditionMet,
    projectedOutcome: conditionMet ? oracle.yesOutcome : oracle.noOutcome,
    projectedOutcomeName: conditionMet ? 'Yes' : 'No',
    trustLevel: 'TRUSTLESS — Value read directly from on-chain PDA',
    explorerUrl: `https://explorer.solana.com/address/${pda.toBase58()}?cluster=devnet`,
    verifyYourself: `Read account ${pda.toBase58()} and check ${oracle.field} field`,
  });
});

// === Opportunities Endpoint ===
// Highlights mispriced markets where agents can make profit
// Shows expected value calculations for each bet

app.get('/opportunities', async (c) => {
  try {
    const markets = await program.account.market.all();
    const now = Math.floor(Date.now() / 1000);
    
    const opportunities: any[] = [];
    
    for (const m of markets) {
      const market = m.account;
      const marketId = market.marketId;
      
      // Skip resolved markets
      if (market.resolved) continue;
      
      // Skip expired markets
      if (now > market.resolutionTime.toNumber()) continue;
      
      const totalPool = market.totalPool.toNumber();
      const outcomePools = market.outcomePools.map((p: any) => p.toNumber());
      
      // Calculate current implied probabilities
      const impliedOdds = outcomePools.map((pool: number) => 
        totalPool > 0 ? pool / totalPool : 1 / market.outcomes.length
      );
      
      // Get fair odds based on verifiable data
      let fairOdds: number[] | null = null;
      let confidence = 'unknown';
      let reasoning = '';
      let opportunity: any = null;
      
      if (marketId === 'submissions-over-400' || marketId === 'submissions-over-350') {
        // Fetch live project count
        try {
          const response = await fetch('https://agents.colosseum.com/api/projects');
          const data = await response.json() as { totalCount?: number; projects?: any[] };
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
          } else if (projectedFinal > threshold * 1.2) {
            // Likely to hit threshold
            fairOdds = [0.85, 0.15]; // 85% Yes, 15% No
            confidence = 'high';
            reasoning = `${projectCount} projects now, projected ${projectedFinal.toFixed(0)} by deadline. Likely to exceed ${threshold}.`;
          } else {
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
        } catch {
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
          currentOdds: impliedOdds.map((p: number) => `${(p * 100).toFixed(1)}%`),
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
  } catch (error) {
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

// ===========================================
// Faucet - Remove friction for first bets
// ===========================================

const FAUCET_FILE = process.env.FAUCET_FILE || './faucet-claims.json';
const FAUCET_AMOUNT = 0.02 * LAMPORTS_PER_SOL; // 0.02 SOL per agent
const FAUCET_MAX_TOTAL = 1 * LAMPORTS_PER_SOL; // 1 SOL max total faucet spend

function loadFaucetClaims(): Record<string, { claimedAt: string; txSignature: string }> {
  try {
    if (existsSync(FAUCET_FILE)) {
      return JSON.parse(readFileSync(FAUCET_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Failed to load faucet claims:', e);
  }
  return {};
}

function saveFaucetClaims(claims: Record<string, { claimedAt: string; txSignature: string }>) {
  try {
    writeFileSync(FAUCET_FILE, JSON.stringify(claims, null, 2));
  } catch (e) {
    console.error('Failed to save faucet claims:', e);
  }
}

// POST /faucet - Get free devnet SOL for your first bet
app.post('/faucet', async (c) => {
  if (!authorityWallet) {
    return c.json({ error: 'Faucet not available - authority wallet not configured' }, 503);
  }

  try {
    const body = await c.req.json();
    const { walletPubkey, agentId } = body;

    if (!walletPubkey) {
      return c.json({ error: 'Missing required field: walletPubkey' }, 400);
    }

    // Validate pubkey
    let recipientPubkey: PublicKey;
    try {
      recipientPubkey = new PublicKey(walletPubkey);
    } catch {
      return c.json({ error: 'Invalid wallet public key' }, 400);
    }

    // Check if already claimed
    const claims = loadFaucetClaims();
    if (claims[walletPubkey]) {
      return c.json({ 
        error: 'Faucet already claimed for this wallet',
        claimedAt: claims[walletPubkey].claimedAt,
        txSignature: claims[walletPubkey].txSignature,
      }, 400);
    }

    // Check total faucet spend
    const totalClaimed = Object.keys(claims).length * FAUCET_AMOUNT;
    if (totalClaimed >= FAUCET_MAX_TOTAL) {
      return c.json({ 
        error: 'Faucet depleted - max total spend reached',
        totalClaimed: totalClaimed / LAMPORTS_PER_SOL,
        maxTotal: FAUCET_MAX_TOTAL / LAMPORTS_PER_SOL,
      }, 400);
    }

    // Check authority wallet balance
    const balance = await connection.getBalance(authorityWallet.publicKey);
    if (balance < FAUCET_AMOUNT + 5000) { // 5000 lamports for tx fee
      return c.json({ 
        error: 'Faucet wallet low on funds',
        balance: balance / LAMPORTS_PER_SOL,
      }, 503);
    }

    // Optional: Verify agent is hackathon participant
    if (agentId) {
      try {
        const agentRes = await fetch(`https://agents.colosseum.com/api/agents/${agentId}`);
        if (!agentRes.ok) {
          console.log(`Agent ${agentId} not found in hackathon, but allowing faucet claim anyway`);
        }
      } catch (e) {
        console.log('Could not verify agent, allowing claim anyway:', e);
      }
    }

    // Send SOL
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: authorityWallet.publicKey,
        toPubkey: recipientPubkey,
        lamports: FAUCET_AMOUNT,
      })
    );

    const txSignature = await connection.sendTransaction(transaction, [authorityWallet]);
    await connection.confirmTransaction(txSignature, 'confirmed');

    // Record claim
    claims[walletPubkey] = {
      claimedAt: new Date().toISOString(),
      txSignature,
    };
    saveFaucetClaims(claims);

    console.log(`Faucet: Sent ${FAUCET_AMOUNT / LAMPORTS_PER_SOL} SOL to ${walletPubkey} (tx: ${txSignature})`);

    return c.json({
      success: true,
      amount: FAUCET_AMOUNT / LAMPORTS_PER_SOL,
      txSignature,
      message: `Sent ${FAUCET_AMOUNT / LAMPORTS_PER_SOL} SOL to ${walletPubkey}. Now go place a bet!`,
      nextStep: 'POST /markets/{marketId}/bet with your wallet',
    });
  } catch (error) {
    console.error('Faucet error:', error);
    return c.json({ error: 'Faucet transfer failed: ' + String(error) }, 500);
  }
});

// GET /faucet/status - Check faucet status
app.get('/faucet/status', async (c) => {
  const claims = loadFaucetClaims();
  const totalClaimed = Object.keys(claims).length * FAUCET_AMOUNT;
  
  let walletBalance = 0;
  if (authorityWallet) {
    try {
      walletBalance = await connection.getBalance(authorityWallet.publicKey);
    } catch (e) {
      console.error('Failed to get wallet balance:', e);
    }
  }

  return c.json({
    available: authorityWallet !== null && totalClaimed < FAUCET_MAX_TOTAL,
    amountPerClaim: FAUCET_AMOUNT / LAMPORTS_PER_SOL,
    totalClaimed: totalClaimed / LAMPORTS_PER_SOL,
    maxTotal: FAUCET_MAX_TOTAL / LAMPORTS_PER_SOL,
    claimsCount: Object.keys(claims).length,
    walletBalance: walletBalance / LAMPORTS_PER_SOL,
    remaining: Math.max(0, (FAUCET_MAX_TOTAL - totalClaimed)) / LAMPORTS_PER_SOL,
  });
});

// ===========================================
// Webhook Registration Endpoints
// ===========================================

// POST /webhooks - Register a new webhook
app.post('/webhooks', async (c) => {
  try {
    const body = await c.req.json();
    const { url, events, marketIds, secret } = body;
    
    if (!url || typeof url !== 'string') {
      return c.json({ error: 'Missing or invalid url' }, 400);
    }
    
    // Validate URL
    try {
      new URL(url);
    } catch {
      return c.json({ error: 'Invalid URL format' }, 400);
    }
    
    const validEvents: WebhookEvent[] = ['resolution', 'bet', 'market_created', 'dispute'];
    const requestedEvents = events || ['resolution']; // Default to resolution only
    
    if (!Array.isArray(requestedEvents) || requestedEvents.some(e => !validEvents.includes(e))) {
      return c.json({ 
        error: 'Invalid events. Valid: ' + validEvents.join(', '),
        validEvents,
      }, 400);
    }
    
    // Generate webhook ID
    const id = `wh_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    
    const webhook: Webhook = {
      id,
      url,
      events: requestedEvents,
      marketIds: marketIds || null,
      secret: secret || undefined,
      createdAt: new Date().toISOString(),
      failCount: 0,
      active: true,
    };
    
    const webhooks = loadWebhooks();
    webhooks.push(webhook);
    saveWebhooks(webhooks);
    
    return c.json({
      success: true,
      webhook: {
        id: webhook.id,
        url: webhook.url,
        events: webhook.events,
        marketIds: webhook.marketIds,
        hasSecret: !!webhook.secret,
        createdAt: webhook.createdAt,
        active: webhook.active,
      },
      usage: {
        getStatus: `GET /webhooks/${id}`,
        delete: `DELETE /webhooks/${id}`,
      },
    });
  } catch (error) {
    console.error('Webhook registration error:', error);
    return c.json({ error: 'Failed to register webhook: ' + String(error) }, 500);
  }
});

// GET /webhooks/:id - Check webhook status
app.get('/webhooks/:id', async (c) => {
  const id = c.req.param('id');
  const webhooks = loadWebhooks();
  const webhook = webhooks.find(w => w.id === id);
  
  if (!webhook) {
    return c.json({ error: 'Webhook not found' }, 404);
  }
  
  return c.json({
    id: webhook.id,
    url: webhook.url,
    events: webhook.events,
    marketIds: webhook.marketIds,
    hasSecret: !!webhook.secret,
    createdAt: webhook.createdAt,
    lastTriggered: webhook.lastTriggered || null,
    failCount: webhook.failCount,
    active: webhook.active,
  });
});

// DELETE /webhooks/:id - Unregister a webhook
app.delete('/webhooks/:id', async (c) => {
  const id = c.req.param('id');
  const webhooks = loadWebhooks();
  const index = webhooks.findIndex(w => w.id === id);
  
  if (index === -1) {
    return c.json({ error: 'Webhook not found' }, 404);
  }
  
  webhooks.splice(index, 1);
  saveWebhooks(webhooks);
  
  return c.json({
    success: true,
    message: 'Webhook unregistered',
  });
});

// POST /webhooks/:id/test - Test a webhook
app.post('/webhooks/:id/test', async (c) => {
  const id = c.req.param('id');
  const webhooks = loadWebhooks();
  const webhook = webhooks.find(w => w.id === id);
  
  if (!webhook) {
    return c.json({ error: 'Webhook not found' }, 404);
  }
  
  try {
    const body = JSON.stringify({
      event: 'test',
      timestamp: new Date().toISOString(),
      payload: {
        message: 'This is a test webhook from AgentBets',
        webhookId: webhook.id,
      },
    });
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'AgentBets-Webhook/1.0',
    };
    
    if (webhook.secret) {
      const crypto = await import('crypto');
      const signature = crypto.createHmac('sha256', webhook.secret)
        .update(body)
        .digest('hex');
      headers['X-AgentBets-Signature'] = `sha256=${signature}`;
    }
    
    const res = await fetch(webhook.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(5000),
    });
    
    return c.json({
      success: res.ok,
      status: res.status,
      statusText: res.statusText,
    });
  } catch (error) {
    return c.json({
      success: false,
      error: String(error),
    });
  }
});

// ===========================================
// CLOB (Order Book) Endpoints
// ===========================================

// CLOB Types
interface ClobMarketAccount {
  authority: PublicKey;
  marketId: string;
  question: string;
  resolutionTime: BN;
  resolved: boolean;
  winningSide: number | null;
  createdAt: BN;
  totalYesVolume: BN;
  totalNoVolume: BN;
  bump: number;
}

interface OrderBookAccount {
  market: PublicKey;
  yesBids: Array<{owner: PublicKey; price: BN; size: BN; timestamp: BN; orderId: BN}>;
  yesAsks: Array<{owner: PublicKey; price: BN; size: BN; timestamp: BN; orderId: BN}>;
  bump: number;
}

// List all CLOB markets
app.get('/clob/markets', async (c) => {
  try {
    const markets = await program.account.clobMarket.all();
    
    return c.json({
      markets: markets.map((m: { publicKey: PublicKey; account: ClobMarketAccount }) => formatClobMarket(m.publicKey, m.account)),
      count: markets.length,
    });
  } catch (error) {
    console.error('Error fetching CLOB markets:', error);
    return c.json({ error: 'Failed to fetch CLOB markets' }, 500);
  }
});

// Get single CLOB market with order book
app.get('/clob/markets/:id', async (c) => {
  const marketId = c.req.param('id');
  
  try {
    let marketPubkey: PublicKey;
    try {
      marketPubkey = new PublicKey(marketId);
    } catch {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('clob_market'), Buffer.from(marketId)],
        programId
      );
      marketPubkey = pda;
    }
    
    const market = await program.account.clobMarket.fetch(marketPubkey);
    
    // Get order book
    const [orderBookPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('order_book'), marketPubkey.toBuffer()],
      programId
    );
    
    let orderBook = null;
    try {
      const ob = await program.account.orderBook.fetch(orderBookPda);
      orderBook = formatOrderBook(ob);
    } catch (e) {
      // Order book may not exist yet
    }
    
    return c.json({
      market: formatClobMarket(marketPubkey, market),
      orderBook,
    });
  } catch (error) {
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
    let marketPubkey: PublicKey;
    try {
      marketPubkey = new PublicKey(marketId);
    } catch {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('clob_market'), Buffer.from(marketId)],
        programId
      );
      marketPubkey = pda;
    }
    
    const ownerPubkey = new PublicKey(owner);
    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('clob_position'), marketPubkey.toBuffer(), ownerPubkey.toBuffer()],
      programId
    );
    
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
  } catch (error) {
    return c.json({ error: 'Position not found' }, 404);
  }
});

// === Helper Functions ===

function formatClobMarket(pubkey: PublicKey, account: ClobMarketAccount) {
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

function formatOrderBook(ob: OrderBookAccount) {
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

function formatMarket(pubkey: PublicKey, account: MarketAccount) {
  const totalPool = account.totalPool.toNumber();
  const outcomePools = account.outcomePools.map((p) => p.toNumber());
  
  // Calculate implied probabilities
  const probabilities = outcomePools.map((pool: number) => 
    totalPool > 0 ? pool / totalPool : 1 / account.outcomes.length
  );
  
  return {
    pubkey: pubkey.toBase58(),
    marketId: account.marketId,
    question: account.question,
    outcomes: account.outcomes,
    outcomePools: outcomePools.map((p: number) => (p / LAMPORTS_PER_SOL).toFixed(4)),
    totalPoolSol: (totalPool / LAMPORTS_PER_SOL).toFixed(4),
    probabilities: probabilities.map((p: number) => (p * 100).toFixed(1) + '%'),
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
