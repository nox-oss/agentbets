#!/usr/bin/env node
/**
 * Create meta-markets on devnet for AgentBets
 * Run: node scripts/create-meta-markets.js
 */

const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram, Keypair, Connection } = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");

// Config
const PROGRAM_ID = "FtNvaXJs5ZUbxPPq91XayvM4MauZyPgxJRrV16fGfn6H";
const RPC_URL = "https://api.devnet.solana.com";
const KEYPAIR_PATH = process.env.HOME + "/.config/solana/agentbets.json";

// Markets to create
const MARKETS = [
  {
    id: "submissions-over-400",
    question: "Total hackathon submissions > 400 at deadline (Feb 12)?",
    outcomes: ["Yes (>400)", "No (≤400)"],
    resolutionDays: 8, // Feb 13
  },
  {
    id: "winner-active-30-days",
    question: "1st place project's GitHub repo created > 30 days before deadline?",
    outcomes: ["Yes (>30 days old)", "No (newer repo)"],
    resolutionDays: 10, // After results announced
  },
  {
    id: "top5-mainnet-deploy",
    question: "Any top-5 project deploys to Solana mainnet before Feb 12?",
    outcomes: ["Yes (mainnet deploy)", "No (devnet only)"],
    resolutionDays: 10,
  },
];

async function main() {
  console.log("Creating meta-markets on devnet...\n");

  // Load keypair
  const keypairData = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf-8"));
  const authority = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  console.log("Authority:", authority.publicKey.toBase58());

  // Connect
  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(authority);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  // Load IDL
  const idlPath = path.join(__dirname, "../api/src/idl.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  idl.address = PROGRAM_ID;
  const program = new anchor.Program(idl, provider);

  console.log("Program ID:", PROGRAM_ID);
  console.log("Network: devnet\n");

  // Check balance
  const balance = await connection.getBalance(authority.publicKey);
  console.log("Balance:", (balance / 1e9).toFixed(4), "SOL\n");

  // Create each market
  for (const market of MARKETS) {
    const resolutionTime = Math.floor(Date.now() / 1000) + 86400 * market.resolutionDays;
    
    const [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), Buffer.from(market.id)],
      program.programId
    );

    console.log(`Creating: "${market.question}"`);
    console.log(`  ID: ${market.id}`);
    console.log(`  PDA: ${marketPda.toBase58()}`);
    console.log(`  Outcomes: ${market.outcomes.join(" | ")}`);
    console.log(`  Resolves: ${new Date(resolutionTime * 1000).toISOString()}`);

    try {
      const tx = await program.methods
        .createMarket(market.id, market.question, market.outcomes, new anchor.BN(resolutionTime))
        .accounts({
          market: marketPda,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log(`  ✅ Created! Tx: ${tx.slice(0, 20)}...\n`);
    } catch (e) {
      if (e.message.includes("already in use")) {
        console.log(`  ⚠️  Already exists, skipping\n`);
      } else {
        console.log(`  ❌ Error: ${e.message}\n`);
      }
    }
  }

  console.log("Done! Check markets at: https://agentbets-api-production.up.railway.app/markets");
}

main().catch(console.error);
