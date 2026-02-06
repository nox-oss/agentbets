#!/usr/bin/env node
/**
 * Seed meta-markets with initial bets
 * Uses same pattern as tests/agentbets.js which works
 */

const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram, Keypair, Connection, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");

const PROGRAM_ID = "FtNvaXJs5ZUbxPPq91XayvM4MauZyPgxJRrV16fGfn6H";
const RPC_URL = "https://api.devnet.solana.com";
const KEYPAIR_PATH = process.env.HOME + "/.config/solana/agentbets.json";

// Bets to place
const BETS = [
  { marketId: "submissions-over-400", outcome: 0, sol: 0.05 }, // Yes
  { marketId: "submissions-over-400", outcome: 1, sol: 0.03 }, // No
  { marketId: "winner-active-30-days", outcome: 0, sol: 0.03 }, // Yes
  { marketId: "top5-mainnet-deploy", outcome: 1, sol: 0.03 }, // No
];

async function main() {
  console.log("Seeding markets with initial bets...\n");

  // Load keypair - same way as anchor test
  const keypairData = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf-8"));
  const buyerKeypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  
  // Create wallet using Anchor's NodeWallet
  const wallet = new anchor.Wallet(buyerKeypair);
  console.log("Buyer:", wallet.publicKey.toBase58());

  // Set up provider - matching test pattern
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  // Load program with IDL
  const idlPath = path.join(__dirname, "../api/src/idl.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  idl.address = PROGRAM_ID;
  const programId = new PublicKey(PROGRAM_ID);
  const program = new anchor.Program(idl, provider);

  // Check balance
  const balance = await connection.getBalance(wallet.publicKey);
  console.log("Balance:", (balance / LAMPORTS_PER_SOL).toFixed(4), "SOL\n");

  for (const bet of BETS) {
    const [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), Buffer.from(bet.marketId)],
      programId
    );

    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), marketPda.toBuffer(), wallet.publicKey.toBuffer()],
      programId
    );

    const amount = new anchor.BN(bet.sol * LAMPORTS_PER_SOL);

    console.log(`Betting ${bet.sol} SOL on outcome ${bet.outcome} in ${bet.marketId}`);

    try {
      // Use .rpc() with explicit signer
      const tx = await program.methods
        .buyShares(bet.outcome, amount)
        .accounts({
          market: marketPda,
          position: positionPda,
          buyer: wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log(`  ✅ Tx: ${tx.slice(0, 20)}...\n`);
    } catch (e) {
      console.log(`  ❌ Error: ${e.message}\n`);
    }
  }

  // Final balance
  const finalBalance = await connection.getBalance(wallet.publicKey);
  console.log("Final balance:", (finalBalance / LAMPORTS_PER_SOL).toFixed(4), "SOL");
  console.log("Total spent:", ((balance - finalBalance) / LAMPORTS_PER_SOL).toFixed(4), "SOL");
}

main().catch(console.error);
