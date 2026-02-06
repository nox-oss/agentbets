const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram } = require("@solana/web3.js");

const MARKET_ID = "hackathon-winner-" + Date.now();

describe("agentbets", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Agentbets;
  const authority = provider.wallet;

  it("Creates a market", async () => {
    const marketId = MARKET_ID;
    const question = "Who wins 1st place in the Agent Hackathon?";
    const outcomes = ["SuperRouter", "Clodds", "AgentBets", "Other"];
    const resolutionTime = Math.floor(Date.now() / 1000) + 86400 * 7; // 7 days

    // Derive market PDA
    const [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), Buffer.from(marketId)],
      program.programId
    );

    console.log("Market PDA:", marketPda.toBase58());
    console.log("Authority:", authority.publicKey.toBase58());

    const tx = await program.methods
      .createMarket(marketId, question, outcomes, new anchor.BN(resolutionTime))
      .accounts({
        market: marketPda,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("Create market tx:", tx);

    // Fetch and verify
    const market = await program.account.market.fetch(marketPda);
    console.log("Market created:", market.question);
    console.log("Outcomes:", market.outcomes);
    
    if (market.question !== question) throw new Error("Question mismatch");
    if (market.outcomes.length !== 4) throw new Error("Outcomes count mismatch");
    if (market.resolved) throw new Error("Market should not be resolved");
  });

  it("Buys shares in an outcome", async () => {
    const marketId = MARKET_ID;
    
    const [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), Buffer.from(marketId)],
      program.programId
    );

    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), marketPda.toBuffer(), authority.publicKey.toBuffer()],
      program.programId
    );

    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), marketPda.toBuffer()],
      program.programId
    );

    console.log("Position PDA:", positionPda.toBase58());
    console.log("Vault PDA:", vaultPda.toBase58());

    const outcomeIndex = 2; // AgentBets
    const amount = new anchor.BN(100000000); // 0.1 SOL

    const tx = await program.methods
      .buyShares(outcomeIndex, amount)
      .accounts({
        market: marketPda,
        position: positionPda,
        vault: vaultPda,
        buyer: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("Buy shares tx:", tx);

    // Verify position
    const position = await program.account.position.fetch(positionPda);
    console.log("Position shares:", position.shares.map(s => s.toString()));
    
    if (position.shares[outcomeIndex].toNumber() <= 0) throw new Error("No shares purchased");
  });
});
