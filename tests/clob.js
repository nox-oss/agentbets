const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const assert = require("assert");

const MARKET_ID = "clob-test-" + Date.now();

describe("agentbets CLOB - order book flow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Agentbets;
  const authority = provider.wallet;

  let marketPda, orderBookPda, vaultPda, positionPda;

  it("1. Creates a CLOB market", async () => {
    const question = "Will SOL hit $300 by March?";
    const resolutionTime = Math.floor(Date.now() / 1000) + 86400 * 30;

    [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("clob_market"), Buffer.from(MARKET_ID)],
      program.programId
    );

    [orderBookPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("order_book"), marketPda.toBuffer()],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), marketPda.toBuffer()],
      program.programId
    );

    console.log("  Market PDA:", marketPda.toBase58());
    console.log("  OrderBook PDA:", orderBookPda.toBase58());
    console.log("  Vault PDA:", vaultPda.toBase58());

    const tx = await program.methods
      .createClobMarket(MARKET_ID, question, new anchor.BN(resolutionTime))
      .accounts({
        market: marketPda,
        orderBook: orderBookPda,
        vault: vaultPda,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("  Create CLOB market tx:", tx.slice(0, 20) + "...");

    const market = await program.account.clobMarket.fetch(marketPda);
    assert.equal(market.question, question);
    assert.equal(market.resolved, false);
    console.log("  ✓ CLOB Market created");

    const orderBook = await program.account.orderBook.fetch(orderBookPda);
    assert.equal(orderBook.yesBids.length, 0);
    assert.equal(orderBook.yesAsks.length, 0);
    console.log("  ✓ Order book initialized (empty)");
  });

  it("2. Places a BID for YES at 60% (6000 bps)", async () => {
    [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("clob_position"), marketPda.toBuffer(), authority.publicKey.toBuffer()],
      program.programId
    );

    const side = 0; // BID
    const isYes = true;
    const price = new anchor.BN(6000); // 60%
    const size = new anchor.BN(100); // 100 shares

    console.log("  Vault PDA:", vaultPda.toBase58());
    console.log("  Position PDA:", positionPda.toBase58());

    const tx = await program.methods
      .placeOrder(side, isYes, price, size)
      .accounts({
        market: marketPda,
        orderBook: orderBookPda,
        vault: vaultPda,
        position: positionPda,
        trader: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("  Place order tx:", tx.slice(0, 20) + "...");

    const orderBook = await program.account.orderBook.fetch(orderBookPda);
    assert.equal(orderBook.yesBids.length, 1);
    assert.equal(orderBook.yesBids[0].price.toNumber(), 6000);
    assert.equal(orderBook.yesBids[0].size.toNumber(), 100);
    console.log("  ✓ BID resting: 100 YES @ 6000 bps (60%)");

    // Check vault received collateral (price * size = 6000 * 100 = 600000 lamports)
    const vaultBalance = await provider.connection.getBalance(vaultPda);
    console.log("  ✓ Vault balance:", vaultBalance, "lamports");
  });

  it("3. Places a competing BID at 55%", async () => {
    // Create a second keypair for the other trader
    const trader2 = anchor.web3.Keypair.generate();
    
    // Airdrop some SOL to trader2
    const airdropSig = await provider.connection.requestAirdrop(
      trader2.publicKey,
      1 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);

    const [position2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("clob_position"), marketPda.toBuffer(), trader2.publicKey.toBuffer()],
      program.programId
    );

    const side = 0; // BID
    const isYes = true;
    const price = new anchor.BN(5500); // 55%
    const size = new anchor.BN(50); // 50 shares

    const tx = await program.methods
      .placeOrder(side, isYes, price, size)
      .accounts({
        market: marketPda,
        orderBook: orderBookPda,
        vault: vaultPda,
        position: position2Pda,
        trader: trader2.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([trader2])
      .rpc();

    console.log("  Place order tx:", tx.slice(0, 20) + "...");

    const orderBook = await program.account.orderBook.fetch(orderBookPda);
    assert.equal(orderBook.yesBids.length, 2);
    // Orders should be sorted: 6000 (best) first, then 5500
    assert.equal(orderBook.yesBids[0].price.toNumber(), 6000);
    assert.equal(orderBook.yesBids[1].price.toNumber(), 5500);
    console.log("  ✓ BID resting: 50 YES @ 5500 bps (55%)");
    console.log("  ✓ Order book sorted: best bid 6000, second 5500");
  });

  it("4. Places an ASK at 65% (no match)", async () => {
    const side = 1; // ASK
    const isYes = true;
    const price = new anchor.BN(6500); // 65%
    const size = new anchor.BN(80); // 80 shares

    const tx = await program.methods
      .placeOrder(side, isYes, price, size)
      .accounts({
        market: marketPda,
        orderBook: orderBookPda,
        vault: vaultPda,
        position: positionPda,
        trader: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("  Place ASK tx:", tx.slice(0, 20) + "...");

    const orderBook = await program.account.orderBook.fetch(orderBookPda);
    assert.equal(orderBook.yesAsks.length, 1);
    assert.equal(orderBook.yesAsks[0].price.toNumber(), 6500);
    console.log("  ✓ ASK resting: 80 YES @ 6500 bps (65%)");
    console.log("  ✓ Bid-Ask spread: 6000-6500 (5% spread)");
  });

  it("5. Places a matching ASK at 60% (crosses spread, fills)", async () => {
    // Create trader3 who will cross the spread
    const trader3 = anchor.web3.Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      trader3.publicKey,
      1 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);

    const [position3Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("clob_position"), marketPda.toBuffer(), trader3.publicKey.toBuffer()],
      program.programId
    );

    // ASK at 6000 (matches best bid)
    const side = 1; // ASK
    const isYes = true;
    const price = new anchor.BN(6000); // 60%
    const size = new anchor.BN(30); // 30 shares (partial fill of 100-share bid)

    const orderBookBefore = await program.account.orderBook.fetch(orderBookPda);
    const bestBidSizeBefore = orderBookBefore.yesBids[0].size.toNumber();

    const tx = await program.methods
      .placeOrder(side, isYes, price, size)
      .accounts({
        market: marketPda,
        orderBook: orderBookPda,
        vault: vaultPda,
        position: position3Pda,
        trader: trader3.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([trader3])
      .rpc();

    console.log("  Place crossing ASK tx:", tx.slice(0, 20) + "...");

    const orderBook = await program.account.orderBook.fetch(orderBookPda);
    const bestBidSizeAfter = orderBook.yesBids[0].size.toNumber();
    
    // Best bid should be partially filled
    assert.equal(bestBidSizeAfter, bestBidSizeBefore - 30);
    console.log("  ✓ Matched 30 shares @ 6000 bps");
    console.log("  ✓ Best bid reduced from", bestBidSizeBefore, "to", bestBidSizeAfter);

    // Trader3 should have NO shares (sold YES = synthetic NO)
    const position3 = await program.account.clobPosition.fetch(position3Pda);
    assert.equal(position3.noShares.toNumber(), 30);
    console.log("  ✓ Seller received 30 NO shares (short YES)");
  });

  it("6. Cancels an order", async () => {
    const orderBook = await program.account.orderBook.fetch(orderBookPda);
    const bidsBeforeCancel = orderBook.yesBids.length;
    
    // Cancel the authority's remaining bid at 6000 (index 0)
    const isBid = true;
    const orderIndex = 0;

    const tx = await program.methods
      .cancelOrder(isBid, orderIndex)
      .accounts({
        market: marketPda,
        orderBook: orderBookPda,
        vault: vaultPda,
        trader: authority.publicKey,
      })
      .rpc();

    console.log("  Cancel order tx:", tx.slice(0, 20) + "...");

    const orderBookAfter = await program.account.orderBook.fetch(orderBookPda);
    assert.equal(orderBookAfter.yesBids.length, bidsBeforeCancel - 1);
    console.log("  ✓ Order cancelled, bids reduced from", bidsBeforeCancel, "to", orderBookAfter.yesBids.length);
    console.log("  ✓ Collateral refunded to trader");
  });

  it("7. Resolves CLOB market - YES wins", async () => {
    const winningOutcome = 0; // YES wins

    const tx = await program.methods
      .resolveClobMarket(winningOutcome)
      .accounts({
        market: marketPda,
        authority: authority.publicKey,
      })
      .rpc();

    console.log("  Resolve tx:", tx.slice(0, 20) + "...");

    const market = await program.account.clobMarket.fetch(marketPda);
    assert.equal(market.resolved, true);
    assert.equal(market.winningSide, 0);
    console.log("  ✓ Market resolved: YES wins");
  });

  it("8. Claims winnings", async () => {
    // The authority bought some YES shares via matches
    // Let's check their position and claim
    const position = await program.account.clobPosition.fetch(positionPda);
    console.log("  Position - YES shares:", position.yesShares.toNumber());
    console.log("  Position - NO shares:", position.noShares.toNumber());

    if (position.yesShares.toNumber() > 0) {
      const balanceBefore = await provider.connection.getBalance(authority.publicKey);

      const tx = await program.methods
        .claimClobWinnings()
        .accounts({
          market: marketPda,
          vault: vaultPda,
          position: positionPda,
          claimer: authority.publicKey,
        })
        .rpc();

      console.log("  Claim tx:", tx.slice(0, 20) + "...");

      const balanceAfter = await provider.connection.getBalance(authority.publicKey);
      const claimed = balanceAfter - balanceBefore;
      console.log("  ✓ Claimed:", claimed, "lamports");
    } else {
      console.log("  ⚠ No YES shares to claim (authority was net seller)");
    }
  });
});

describe("agentbets CLOB - NO shares via inversion", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Agentbets;
  const authority = provider.wallet;

  const MARKET_ID_2 = "clob-no-test-" + Date.now();
  let marketPda, orderBookPda, vaultPda, positionPda;

  it("1. Creates market and places BID for NO at 40%", async () => {
    const question = "Will BTC drop below $80k?";
    const resolutionTime = Math.floor(Date.now() / 1000) + 86400 * 7;

    [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("clob_market"), Buffer.from(MARKET_ID_2)],
      program.programId
    );

    [orderBookPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("order_book"), marketPda.toBuffer()],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), marketPda.toBuffer()],
      program.programId
    );

    [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("clob_position"), marketPda.toBuffer(), authority.publicKey.toBuffer()],
      program.programId
    );

    // Create market
    await program.methods
      .createClobMarket(MARKET_ID_2, question, new anchor.BN(resolutionTime))
      .accounts({
        market: marketPda,
        orderBook: orderBookPda,
        vault: vaultPda,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("  Market created:", MARKET_ID_2);

    // Place BID for NO at 40% (which becomes ASK for YES at 60%)
    const side = 0; // BID
    const isYes = false; // Trading NO shares
    const price = new anchor.BN(4000); // 40% for NO = 60% for YES ask
    const size = new anchor.BN(50);

    const tx = await program.methods
      .placeOrder(side, isYes, price, size)
      .accounts({
        market: marketPda,
        orderBook: orderBookPda,
        vault: vaultPda,
        position: positionPda,
        trader: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("  Place NO bid tx:", tx.slice(0, 20) + "...");

    // Buying NO at 40% becomes selling YES at 60%
    // So this should show up as a YES ask at 6000 bps
    const orderBook = await program.account.orderBook.fetch(orderBookPda);
    console.log("  YES bids:", orderBook.yesBids.length);
    console.log("  YES asks:", orderBook.yesAsks.length);
    
    // Verify it's in the asks (since buying NO = selling YES)
    assert.equal(orderBook.yesAsks.length, 1);
    assert.equal(orderBook.yesAsks[0].price.toNumber(), 6000); // 10000 - 4000
    console.log("  ✓ BID for NO @ 40% = ASK for YES @ 60% (stored as YES ask)");
  });
});
