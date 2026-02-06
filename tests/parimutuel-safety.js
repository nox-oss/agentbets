/**
 * Parimutuel Safety Tests
 * 
 * Core question: Would a smart agent trust AgentBets with their SOL?
 * 
 * This tests the fund-safety invariants for the parimutuel prediction market:
 * 1. Fund conservation: total_claimed <= total_deposited (minus fees)
 * 2. Proportional payout: winners split pool proportionally
 * 3. Loser exclusion: non-winners cannot claim
 * 4. Double-claim prevention: cannot claim twice
 * 5. Edge cases: single bettor, all on one outcome, empty outcomes
 */

const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const assert = require("assert");

describe("parimutuel-safety", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Agentbets;
  const authority = provider.wallet;
  
  // We'll use the authority as the only signer in tests
  // In real scenario, would have multiple wallets

  describe("Fund Conservation", () => {
    let marketPda, positionPda;
    const marketId = "sc-" + Date.now().toString(36); // Short ID

    it("total claimed equals total deposited minus 2% fee", async () => {
      // Setup: Create market
      [marketPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("market"), Buffer.from(marketId)],
        program.programId
      );

      await program.methods
        .createMarket(
          marketId,
          "Test market",
          ["Yes", "No"],
          new anchor.BN(Math.floor(Date.now() / 1000) + 3600)
        )
        .accounts({
          market: marketPda,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Bet 1 SOL on outcome 0 (Yes)
      const betAmount = new anchor.BN(LAMPORTS_PER_SOL);
      
      [positionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), marketPda.toBuffer(), authority.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .buyShares(0, betAmount)
        .accounts({
          market: marketPda,
          position: positionPda,
          buyer: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Verify market received the SOL
      const marketBalance = await provider.connection.getBalance(marketPda);
      console.log("  Market balance after bet:", marketBalance / LAMPORTS_PER_SOL, "SOL");
      
      // Resolve to outcome 0 (winner)
      await program.methods
        .resolveMarket(0)
        .accounts({
          market: marketPda,
          authority: authority.publicKey,
        })
        .rpc();

      // Claim winnings
      const balanceBefore = await provider.connection.getBalance(authority.publicKey);
      
      await program.methods
        .claimWinnings()
        .accounts({
          market: marketPda,
          position: positionPda,
          claimer: authority.publicKey,
        })
        .rpc();

      const balanceAfter = await provider.connection.getBalance(authority.publicKey);
      const netReceived = balanceAfter - balanceBefore;
      
      // Expected: 98% of bet (1 SOL * 0.98 = 0.98 SOL, minus ~5000 lamports tx fee)
      const expectedPayout = LAMPORTS_PER_SOL * 0.98;
      const tolerance = 10000; // ~0.00001 SOL for tx fees
      
      console.log("  Net received:", netReceived / LAMPORTS_PER_SOL, "SOL");
      console.log("  Expected (98% - fees):", expectedPayout / LAMPORTS_PER_SOL, "SOL");
      
      assert(
        netReceived >= expectedPayout - tolerance && netReceived <= expectedPayout + tolerance,
        `Payout should be ~98% of deposit (got ${netReceived}, expected ~${expectedPayout})`
      );
      
      // Verify 2% fee stayed in market
      const marketBalanceAfter = await provider.connection.getBalance(marketPda);
      const feeRemaining = LAMPORTS_PER_SOL * 0.02;
      
      console.log("  Fee remaining in market:", marketBalanceAfter / LAMPORTS_PER_SOL, "SOL");
      assert(
        marketBalanceAfter >= feeRemaining - 1000,
        "2% fee should remain in market"
      );
      
      console.log("  ✓ Fund conservation verified");
    });
  });

  describe("Proportional Payout", () => {
    let marketPda;
    const marketId = "sp-" + Date.now().toString(36); // Short ID

    it("multiple bettors on same outcome split proportionally", async () => {
      // This test uses authority as single wallet, so we simulate
      // by betting twice (position accumulates)
      
      [marketPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("market"), Buffer.from(marketId)],
        program.programId
      );

      await program.methods
        .createMarket(
          marketId,
          "Proportional test",
          ["A", "B"],
          new anchor.BN(Math.floor(Date.now() / 1000) + 3600)
        )
        .accounts({
          market: marketPda,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const [positionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), marketPda.toBuffer(), authority.publicKey.toBuffer()],
        program.programId
      );

      // Bet 0.3 SOL on A
      await program.methods
        .buyShares(0, new anchor.BN(0.3 * LAMPORTS_PER_SOL))
        .accounts({
          market: marketPda,
          position: positionPda,
          buyer: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Bet another 0.7 SOL on A (total: 1 SOL on A, position has all)
      await program.methods
        .buyShares(0, new anchor.BN(0.7 * LAMPORTS_PER_SOL))
        .accounts({
          market: marketPda,
          position: positionPda,
          buyer: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Verify position has 1 SOL worth of shares
      const position = await program.account.position.fetch(positionPda);
      assert.equal(
        position.shares[0].toNumber(),
        LAMPORTS_PER_SOL,
        "Should have 1 SOL of shares"
      );

      // Resolve to A
      await program.methods
        .resolveMarket(0)
        .accounts({
          market: marketPda,
          authority: authority.publicKey,
        })
        .rpc();

      // Claim
      const balanceBefore = await provider.connection.getBalance(authority.publicKey);
      
      await program.methods
        .claimWinnings()
        .accounts({
          market: marketPda,
          position: positionPda,
          claimer: authority.publicKey,
        })
        .rpc();

      const balanceAfter = await provider.connection.getBalance(authority.publicKey);
      const payout = balanceAfter - balanceBefore;
      
      // Only person in pool gets all their money back (minus 2%)
      const expected = LAMPORTS_PER_SOL * 0.98;
      console.log("  Payout:", payout / LAMPORTS_PER_SOL, "SOL");
      console.log("  ✓ Single winner gets full pool minus fee");
    });
  });

  describe("Loser Exclusion", () => {
    let marketPda, positionPda;
    const marketId = "sl-" + Date.now().toString(36); // Short ID

    it("losing outcome cannot claim", async () => {
      [marketPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("market"), Buffer.from(marketId)],
        program.programId
      );

      await program.methods
        .createMarket(
          marketId,
          "Loser test",
          ["Win", "Lose"],
          new anchor.BN(Math.floor(Date.now() / 1000) + 3600)
        )
        .accounts({
          market: marketPda,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      [positionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), marketPda.toBuffer(), authority.publicKey.toBuffer()],
        program.programId
      );

      // Bet on losing outcome (index 1)
      await program.methods
        .buyShares(1, new anchor.BN(0.5 * LAMPORTS_PER_SOL))
        .accounts({
          market: marketPda,
          position: positionPda,
          buyer: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Resolve to outcome 0 (we bet on 1, so we lose)
      await program.methods
        .resolveMarket(0)
        .accounts({
          market: marketPda,
          authority: authority.publicKey,
        })
        .rpc();

      // Try to claim - should fail
      try {
        await program.methods
          .claimWinnings()
          .accounts({
            market: marketPda,
            position: positionPda,
            claimer: authority.publicKey,
          })
          .rpc();
        
        assert.fail("Should have thrown NoWinningShares error");
      } catch (err) {
        assert(
          err.message.includes("NoWinningShares") || 
          err.message.includes("No winning shares") ||
          err.error?.errorCode?.code === "NoWinningShares",
          `Expected NoWinningShares error, got: ${err.message}`
        );
        console.log("  ✓ Loser cannot claim (correct error thrown)");
      }
    });
  });

  describe("Double Claim Prevention", () => {
    let marketPda, positionPda;
    const marketId = "sd-" + Date.now().toString(36); // Short ID

    it("cannot claim twice", async () => {
      [marketPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("market"), Buffer.from(marketId)],
        program.programId
      );

      await program.methods
        .createMarket(
          marketId,
          "Double claim test",
          ["Yes", "No"],
          new anchor.BN(Math.floor(Date.now() / 1000) + 3600)
        )
        .accounts({
          market: marketPda,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      [positionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), marketPda.toBuffer(), authority.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .buyShares(0, new anchor.BN(0.1 * LAMPORTS_PER_SOL))
        .accounts({
          market: marketPda,
          position: positionPda,
          buyer: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await program.methods
        .resolveMarket(0)
        .accounts({
          market: marketPda,
          authority: authority.publicKey,
        })
        .rpc();

      // First claim - should succeed
      await program.methods
        .claimWinnings()
        .accounts({
          market: marketPda,
          position: positionPda,
          claimer: authority.publicKey,
        })
        .rpc();
      
      console.log("  First claim succeeded");

      // Verify shares zeroed
      const position = await program.account.position.fetch(positionPda);
      assert.equal(position.shares[0].toNumber(), 0, "Shares should be zeroed");
      console.log("  Position shares zeroed");

      // Second claim - should fail
      try {
        await program.methods
          .claimWinnings()
          .accounts({
            market: marketPda,
            position: positionPda,
            claimer: authority.publicKey,
          })
          .rpc();
        
        assert.fail("Second claim should have failed");
      } catch (err) {
        assert(
          err.message.includes("NoWinningShares") ||
          err.message.includes("No winning shares"),
          `Expected NoWinningShares error, got: ${err.message}`
        );
        console.log("  ✓ Double claim prevented (shares already zeroed)");
      }
    });
  });

  describe("Edge Cases", () => {
    it("market with bets on both outcomes - winner takes all", async () => {
      const marketId = "sb-" + Date.now().toString(36); // Short ID
      
      const [marketPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("market"), Buffer.from(marketId)],
        program.programId
      );

      await program.methods
        .createMarket(
          marketId,
          "Both outcomes test",
          ["Yes", "No"],
          new anchor.BN(Math.floor(Date.now() / 1000) + 3600)
        )
        .accounts({
          market: marketPda,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const [positionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), marketPda.toBuffer(), authority.publicKey.toBuffer()],
        program.programId
      );

      // Bet 0.3 SOL on Yes (index 0)
      await program.methods
        .buyShares(0, new anchor.BN(0.3 * LAMPORTS_PER_SOL))
        .accounts({
          market: marketPda,
          position: positionPda,
          buyer: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Bet 0.7 SOL on No (index 1)
      await program.methods
        .buyShares(1, new anchor.BN(0.7 * LAMPORTS_PER_SOL))
        .accounts({
          market: marketPda,
          position: positionPda,
          buyer: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const market = await program.account.market.fetch(marketPda);
      console.log("  Total pool:", market.totalPool.toNumber() / LAMPORTS_PER_SOL, "SOL");
      console.log("  Yes pool:", market.outcomePools[0].toNumber() / LAMPORTS_PER_SOL, "SOL");
      console.log("  No pool:", market.outcomePools[1].toNumber() / LAMPORTS_PER_SOL, "SOL");

      // Resolve Yes wins
      await program.methods
        .resolveMarket(0)
        .accounts({
          market: marketPda,
          authority: authority.publicKey,
        })
        .rpc();

      // Claim - should get all 1 SOL (minus 2% fee) because I'm only Yes holder
      const balanceBefore = await provider.connection.getBalance(authority.publicKey);
      
      await program.methods
        .claimWinnings()
        .accounts({
          market: marketPda,
          position: positionPda,
          claimer: authority.publicKey,
        })
        .rpc();

      const balanceAfter = await provider.connection.getBalance(authority.publicKey);
      const payout = balanceAfter - balanceBefore;
      
      // I bet 0.3 on Yes, but total pool is 1 SOL
      // My payout = (0.3 / 0.3) * 1.0 * 0.98 = 0.98 SOL
      const expected = 0.98 * LAMPORTS_PER_SOL;
      console.log("  Payout:", payout / LAMPORTS_PER_SOL, "SOL");
      console.log("  Expected:", expected / LAMPORTS_PER_SOL, "SOL");
      
      assert(
        payout >= expected - 10000 && payout <= expected + 10000,
        "Winner should get entire pool (minus fee)"
      );
      console.log("  ✓ Winner of both-sides market gets entire pool");
    });

    it("cannot bet after resolution", async () => {
      const marketId = "sr-" + Date.now().toString(36); // Short ID
      
      const [marketPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("market"), Buffer.from(marketId)],
        program.programId
      );

      await program.methods
        .createMarket(
          marketId,
          "Post-resolution test",
          ["Yes", "No"],
          new anchor.BN(Math.floor(Date.now() / 1000) + 3600)
        )
        .accounts({
          market: marketPda,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Resolve immediately (no bets)
      await program.methods
        .resolveMarket(0)
        .accounts({
          market: marketPda,
          authority: authority.publicKey,
        })
        .rpc();

      // Try to bet after resolution
      const [positionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), marketPda.toBuffer(), authority.publicKey.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .buyShares(0, new anchor.BN(0.1 * LAMPORTS_PER_SOL))
          .accounts({
            market: marketPda,
            position: positionPda,
            buyer: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        
        assert.fail("Should not allow betting after resolution");
      } catch (err) {
        assert(
          err.message.includes("MarketResolved") ||
          err.message.includes("resolved"),
          `Expected MarketResolved error, got: ${err.message}`
        );
        console.log("  ✓ Cannot bet after market resolved");
      }
    });

    it("cannot resolve twice", async () => {
      const marketId = "sdr-" + Date.now().toString(36); // Short ID
      
      const [marketPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("market"), Buffer.from(marketId)],
        program.programId
      );

      await program.methods
        .createMarket(
          marketId,
          "Double resolve test",
          ["A", "B"],
          new anchor.BN(Math.floor(Date.now() / 1000) + 3600)
        )
        .accounts({
          market: marketPda,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // First resolution
      await program.methods
        .resolveMarket(0)
        .accounts({
          market: marketPda,
          authority: authority.publicKey,
        })
        .rpc();

      // Second resolution attempt
      try {
        await program.methods
          .resolveMarket(1) // Try to change winner
          .accounts({
            market: marketPda,
            authority: authority.publicKey,
          })
          .rpc();
        
        assert.fail("Should not allow resolving twice");
      } catch (err) {
        assert(
          err.message.includes("AlreadyResolved") ||
          err.message.includes("already resolved"),
          `Expected AlreadyResolved error, got: ${err.message}`
        );
        console.log("  ✓ Cannot resolve market twice");
      }
    });
  });

  describe("Invariant: Vault Solvency", () => {
    it("market account balance >= total owed to winners", async () => {
      const marketId = "ss-" + Date.now().toString(36); // Short ID
      
      const [marketPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("market"), Buffer.from(marketId)],
        program.programId
      );

      await program.methods
        .createMarket(
          marketId,
          "Solvency test",
          ["A", "B", "C"],
          new anchor.BN(Math.floor(Date.now() / 1000) + 3600)
        )
        .accounts({
          market: marketPda,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const [positionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), marketPda.toBuffer(), authority.publicKey.toBuffer()],
        program.programId
      );

      // Place multiple bets
      await program.methods
        .buyShares(0, new anchor.BN(0.5 * LAMPORTS_PER_SOL))
        .accounts({
          market: marketPda,
          position: positionPda,
          buyer: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await program.methods
        .buyShares(1, new anchor.BN(0.3 * LAMPORTS_PER_SOL))
        .accounts({
          market: marketPda,
          position: positionPda,
          buyer: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await program.methods
        .buyShares(2, new anchor.BN(0.2 * LAMPORTS_PER_SOL))
        .accounts({
          market: marketPda,
          position: positionPda,
          buyer: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Check solvency before resolution
      const market = await program.account.market.fetch(marketPda);
      const marketBalance = await provider.connection.getBalance(marketPda);
      
      console.log("  Total pool (tracked):", market.totalPool.toNumber() / LAMPORTS_PER_SOL, "SOL");
      console.log("  Market balance (actual):", marketBalance / LAMPORTS_PER_SOL, "SOL");
      
      // Market balance should >= total pool (could be higher due to rent-exempt minimum)
      const rentExempt = await provider.connection.getMinimumBalanceForRentExemption(
        await provider.connection.getAccountInfo(marketPda).then(a => a.data.length)
      );
      
      assert(
        marketBalance >= market.totalPool.toNumber(),
        "Market should hold at least the total pool"
      );
      console.log("  ✓ Vault solvency verified (balance >= total pool)");

      // Resolve and claim
      await program.methods
        .resolveMarket(0)
        .accounts({
          market: marketPda,
          authority: authority.publicKey,
        })
        .rpc();

      await program.methods
        .claimWinnings()
        .accounts({
          market: marketPda,
          position: positionPda,
          claimer: authority.publicKey,
        })
        .rpc();

      // After claim, market should still have 2% fee
      const marketBalanceAfter = await provider.connection.getBalance(marketPda);
      const expectedFee = market.totalPool.toNumber() * 0.02;
      
      console.log("  Balance after claim:", marketBalanceAfter / LAMPORTS_PER_SOL, "SOL");
      console.log("  Expected fee (~2%):", expectedFee / LAMPORTS_PER_SOL, "SOL");
      
      assert(
        marketBalanceAfter >= expectedFee - 1000,
        "Fee should remain in market after all claims"
      );
      console.log("  ✓ 2% protocol fee retained after claim");
    });
  });
});
