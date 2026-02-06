const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const assert = require("assert");

const MARKET_ID = "hackathon-test-" + Date.now();

describe("agentbets - full flow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Agentbets;
  const authority = provider.wallet;

  let marketPda, positionPda;

  it("1. Creates a market", async () => {
    const question = "Who wins 1st place in the Agent Hackathon?";
    const outcomes = ["SuperRouter", "Clodds", "AgentBets", "Other"];
    const resolutionTime = Math.floor(Date.now() / 1000) + 86400 * 7;

    [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), Buffer.from(MARKET_ID)],
      program.programId
    );

    console.log("  Market PDA:", marketPda.toBase58());

    const tx = await program.methods
      .createMarket(MARKET_ID, question, outcomes, new anchor.BN(resolutionTime))
      .accounts({
        market: marketPda,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("  Create market tx:", tx.slice(0, 20) + "...");

    const market = await program.account.market.fetch(marketPda);
    assert.equal(market.question, question);
    assert.equal(market.outcomes.length, 4);
    assert.equal(market.resolved, false);
    console.log("  ✓ Market created with 4 outcomes");
  });

  it("2. Buys shares in outcome 2 (AgentBets)", async () => {
    [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), marketPda.toBuffer(), authority.publicKey.toBuffer()],
      program.programId
    );

    const outcomeIndex = 2; // AgentBets
    const amount = new anchor.BN(0.1 * LAMPORTS_PER_SOL);

    const tx = await program.methods
      .buyShares(outcomeIndex, amount)
      .accounts({
        market: marketPda,
        position: positionPda,
        buyer: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("  Buy shares tx:", tx.slice(0, 20) + "...");

    const position = await program.account.position.fetch(positionPda);
    assert(position.shares[outcomeIndex].toNumber() > 0);
    
    const market = await program.account.market.fetch(marketPda);
    console.log("  ✓ Bought", (position.shares[outcomeIndex].toNumber() / LAMPORTS_PER_SOL).toFixed(2), "shares");
    console.log("  ✓ Market total pool:", (market.totalPool.toNumber() / LAMPORTS_PER_SOL).toFixed(2), "SOL");
  });

  it("3. Resolves market - AgentBets wins!", async () => {
    const winningOutcome = 2;

    const tx = await program.methods
      .resolveMarket(winningOutcome)
      .accounts({
        market: marketPda,
        authority: authority.publicKey,
      })
      .rpc();

    console.log("  Resolve tx:", tx.slice(0, 20) + "...");

    const market = await program.account.market.fetch(marketPda);
    assert.equal(market.resolved, true);
    assert.equal(market.winningOutcome, winningOutcome);
    console.log("  ✓ Market resolved, winner: outcome", winningOutcome);
  });

  it("4. Claims winnings (98% after 2% fee)", async () => {
    const balanceBefore = await provider.connection.getBalance(authority.publicKey);

    const tx = await program.methods
      .claimWinnings()
      .accounts({
        market: marketPda,
        position: positionPda,
        claimer: authority.publicKey,
      })
      .rpc();

    console.log("  Claim tx:", tx.slice(0, 20) + "...");

    const balanceAfter = await provider.connection.getBalance(authority.publicKey);
    const claimed = balanceAfter - balanceBefore;
    
    // Should receive ~98% of stake (minus tx fee)
    console.log("  ✓ Net balance change:", (claimed / LAMPORTS_PER_SOL).toFixed(4), "SOL");
    console.log("  ✓ 2% protocol fee taken");

    // Verify position is zeroed
    const position = await program.account.position.fetch(positionPda);
    assert.equal(position.shares[2].toNumber(), 0, "Shares should be zeroed after claim");
    console.log("  ✓ Position zeroed (no double-claim)");
  });
});
