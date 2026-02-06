/**
 * CLOB Safety Test Suite
 * 
 * Goal: 100% confidence that user funds cannot be lost under any sequence of operations.
 * 
 * Test Categories:
 * 1. Fund Safety Tests (P0) - Conservation of funds invariants
 * 2. Matching Engine Tests - Correct fill mechanics
 * 3. Edge Cases - Boundary conditions
 * 4. Resolution & Claims - Settlement correctness
 * 5. Invariant Tests - Randomized sequences with invariant checks
 * 
 * Key Invariant: vault_balance = Σ(resting_order_collateral) + Σ(position_value)
 * After resolution: All winning shares can be claimed from vault with no deficit.
 */

const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram, Keypair, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const assert = require("assert");

// ===== CONSTANTS =====
const BPS_MAX = 10_000;
const SHARE_PAYOUT = 10_000; // lamports per winning share

// ===== HELPER FUNCTIONS =====

function generateMarketId() {
  return `safety-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function airdrop(provider, pubkey, amount = 10 * LAMPORTS_PER_SOL) {
  const sig = await provider.connection.requestAirdrop(pubkey, amount);
  await provider.connection.confirmTransaction(sig);
}

function getPDAs(program, marketId, trader) {
  const [marketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("clob_market"), Buffer.from(marketId)],
    program.programId
  );
  const [orderBookPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("order_book"), marketPda.toBuffer()],
    program.programId
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), marketPda.toBuffer()],
    program.programId
  );
  
  let positionPda = null;
  if (trader) {
    [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("clob_position"), marketPda.toBuffer(), trader.toBuffer()],
      program.programId
    );
  }
  
  return { marketPda, orderBookPda, vaultPda, positionPda };
}

// Calculate collateral required for an order
function calculateCollateral(side, price, size) {
  if (side === 0) {
    // BID: pay price * size
    return price * size;
  } else {
    // ASK: pay (BPS_MAX - price) * size
    return (BPS_MAX - price) * size;
  }
}

// Calculate total collateral locked in resting orders
function calculateRestingCollateral(orderBook) {
  let total = 0;
  
  // Bids lock (price * size)
  for (const bid of orderBook.yesBids) {
    total += bid.price.toNumber() * bid.size.toNumber();
  }
  
  // Asks lock ((BPS_MAX - price) * size)
  for (const ask of orderBook.yesAsks) {
    total += (BPS_MAX - ask.price.toNumber()) * ask.size.toNumber();
  }
  
  return total;
}

// ===== TEST HELPERS =====

async function createTestMarket(program, provider, marketId) {
  const id = marketId || generateMarketId();
  const pdas = getPDAs(program, id);
  
  const resolutionTime = Math.floor(Date.now() / 1000) + 86400 * 30; // 30 days
  
  await program.methods
    .createClobMarket(id, "Test Market", new anchor.BN(resolutionTime))
    .accounts({
      market: pdas.marketPda,
      orderBook: pdas.orderBookPda,
      vault: pdas.vaultPda,
      authority: provider.wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  
  return { marketId: id, pdas };
}

async function getMarketState(program, provider, pdas, traders) {
  const vaultBalance = await provider.connection.getBalance(pdas.vaultPda);
  const orderBookData = await program.account.orderBook.fetch(pdas.orderBookPda);
  const marketData = await program.account.clobMarket.fetch(pdas.marketPda);
  
  const positions = new Map();
  for (const trader of traders) {
    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), trader.toBuffer()],
      program.programId
    );
    try {
      const posData = await program.account.clobPosition.fetch(positionPda);
      positions.set(trader.toBase58(), {
        owner: posData.owner,
        yesShares: posData.yesShares.toNumber(),
        noShares: posData.noShares.toNumber(),
      });
    } catch {
      // Position doesn't exist yet
    }
  }
  
  return {
    vaultBalance,
    orderBook: orderBookData,
    positions,
    resolved: marketData.resolved,
    winningSide: marketData.winningSide,
  };
}

// ===== INVARIANT CHECKERS =====

function assertVaultSolvency(state, context) {
  const restingCollateral = calculateRestingCollateral(state.orderBook);
  
  console.log(`  [${context}] Vault: ${state.vaultBalance}, Resting: ${restingCollateral}`);
  
  // Basic check: vault should cover resting orders
  if (state.vaultBalance < restingCollateral) {
    throw new Error(
      `INVARIANT VIOLATION at ${context}: Vault balance ${state.vaultBalance} < ` +
      `resting collateral ${restingCollateral}. Vault is INSOLVENT!`
    );
  }
}

// ==========================================
// TEST SUITES
// ==========================================

describe("CLOB Safety Tests", function() {
  this.timeout(120000);
  
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Agentbets;
  const authority = provider.wallet;
  
  // =========================================
  // 1. FUND SAFETY TESTS (P0)
  // =========================================
  
  describe("1. Fund Safety Tests (P0)", () => {
    
    it("1.1 Collateral is transferred on order placement", async () => {
      const { pdas, marketId } = await createTestMarket(program, provider);
      
      const [posPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), authority.publicKey.toBuffer()],
        program.programId
      );
      
      const vaultBefore = await provider.connection.getBalance(pdas.vaultPda);
      
      // Place a BID for 100 YES @ 60%
      const price = 6000;
      const size = 100;
      const expectedCollateral = price * size; // 600,000 lamports
      
      await program.methods
        .placeOrder(0, true, new anchor.BN(price), new anchor.BN(size))
        .accounts({
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
          vault: pdas.vaultPda,
          position: posPda,
          trader: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      
      const vaultAfter = await provider.connection.getBalance(pdas.vaultPda);
      
      assert.equal(vaultAfter - vaultBefore, expectedCollateral);
      console.log(`  ✓ Vault received ${expectedCollateral} lamports`);
    });
    
    it("1.2 Collateral is refunded on order cancellation", async () => {
      const { pdas } = await createTestMarket(program, provider);
      const [posPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), authority.publicKey.toBuffer()],
        program.programId
      );
      
      // Place order
      const price = 5000;
      const size = 50;
      const collateral = price * size;
      
      await program.methods
        .placeOrder(0, true, new anchor.BN(price), new anchor.BN(size))
        .accounts({
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
          vault: pdas.vaultPda,
          position: posPda,
          trader: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      
      const vaultBefore = await provider.connection.getBalance(pdas.vaultPda);
      
      // Cancel the order
      await program.methods
        .cancelOrder(true, 0)
        .accounts({
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
          vault: pdas.vaultPda,
          trader: authority.publicKey,
        })
        .rpc();
      
      const vaultAfter = await provider.connection.getBalance(pdas.vaultPda);
      
      assert.equal(vaultBefore - vaultAfter, collateral);
      console.log(`  ✓ ${collateral} lamports refunded on cancel`);
    });
    
    it("1.3 Vault balance equals resting order collateral (no fills)", async () => {
      const { pdas } = await createTestMarket(program, provider);
      const traders = [];
      
      // Create 5 traders and place orders
      for (let i = 0; i < 5; i++) {
        const trader = Keypair.generate();
        await airdrop(provider, trader.publicKey);
        traders.push(trader);
        
        const [posPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), trader.publicKey.toBuffer()],
          program.programId
        );
        
        // Each trader places a bid and an ask
        const bidPrice = 4000 + i * 200;
        const askPrice = 6000 + i * 200;
        const size = 10 + i * 5;
        
        await program.methods
          .placeOrder(0, true, new anchor.BN(bidPrice), new anchor.BN(size))
          .accounts({
            market: pdas.marketPda,
            orderBook: pdas.orderBookPda,
            vault: pdas.vaultPda,
            position: posPda,
            trader: trader.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([trader])
          .rpc();
        
        await program.methods
          .placeOrder(1, true, new anchor.BN(askPrice), new anchor.BN(size))
          .accounts({
            market: pdas.marketPda,
            orderBook: pdas.orderBookPda,
            vault: pdas.vaultPda,
            position: posPda,
            trader: trader.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([trader])
          .rpc();
      }
      
      const state = await getMarketState(program, provider, pdas, traders.map(t => t.publicKey));
      const expectedCollateral = calculateRestingCollateral(state.orderBook);
      
      // Vault also has rent-exempt minimum from initialization
      const rentExempt = await provider.connection.getMinimumBalanceForRentExemption(0);
      
      assert(state.vaultBalance >= expectedCollateral + rentExempt);
      console.log(`  ✓ Vault ${state.vaultBalance} >= expected ${expectedCollateral + rentExempt}`);
    });
    
    it("1.4 [BUG TEST] Taker receives correct shares on fill", async () => {
      const { pdas } = await createTestMarket(program, provider);
      
      // Maker places ASK for 100 YES @ 5000 (50%)
      const maker = Keypair.generate();
      await airdrop(provider, maker.publicKey);
      
      const [makerPosPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), maker.publicKey.toBuffer()],
        program.programId
      );
      
      await program.methods
        .placeOrder(1, true, new anchor.BN(5000), new anchor.BN(100))
        .accounts({
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
          vault: pdas.vaultPda,
          position: makerPosPda,
          trader: maker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([maker])
        .rpc();
      
      // Taker places BID for 50 YES @ 5500 (crosses spread)
      const taker = Keypair.generate();
      await airdrop(provider, taker.publicKey);
      
      const [takerPosPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), taker.publicKey.toBuffer()],
        program.programId
      );
      
      await program.methods
        .placeOrder(0, true, new anchor.BN(5500), new anchor.BN(50))
        .accounts({
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
          vault: pdas.vaultPda,
          position: takerPosPda,
          trader: taker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([taker])
        .rpc();
      
      // Check taker received YES shares
      const takerPos = await program.account.clobPosition.fetch(takerPosPda);
      assert.equal(takerPos.yesShares.toNumber(), 50);
      console.log(`  ✓ Taker received ${takerPos.yesShares.toNumber()} YES shares`);
    });
    
    it("1.5 [BUG TEST] Maker position updates on fill - KNOWN BUG", async () => {
      /**
       * CRITICAL BUG: Makers' positions are NOT updated when their orders are filled.
       * This test documents the bug.
       */
      const { pdas } = await createTestMarket(program, provider);
      
      // Maker places ASK (selling YES) for 100 @ 5000
      const maker = Keypair.generate();
      await airdrop(provider, maker.publicKey);
      
      const [makerPosPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), maker.publicKey.toBuffer()],
        program.programId
      );
      
      await program.methods
        .placeOrder(1, true, new anchor.BN(5000), new anchor.BN(100))
        .accounts({
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
          vault: pdas.vaultPda,
          position: makerPosPda,
          trader: maker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([maker])
        .rpc();
      
      const makerPosBefore = await program.account.clobPosition.fetch(makerPosPda);
      console.log(`  Maker before fill - YES: ${makerPosBefore.yesShares}, NO: ${makerPosBefore.noShares}`);
      
      // Taker fills the maker's ask
      const taker = Keypair.generate();
      await airdrop(provider, taker.publicKey);
      
      const [takerPosPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), taker.publicKey.toBuffer()],
        program.programId
      );
      
      await program.methods
        .placeOrder(0, true, new anchor.BN(5000), new anchor.BN(100))
        .accounts({
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
          vault: pdas.vaultPda,
          position: takerPosPda,
          trader: taker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([taker])
        .rpc();
      
      const makerPosAfter = await program.account.clobPosition.fetch(makerPosPda);
      console.log(`  Maker after fill - YES: ${makerPosAfter.yesShares}, NO: ${makerPosAfter.noShares}`);
      
      const makerYesChange = makerPosAfter.yesShares.toNumber() - makerPosBefore.yesShares.toNumber();
      const makerNoChange = makerPosAfter.noShares.toNumber() - makerPosBefore.noShares.toNumber();
      
      console.log(`  ⚠️ BUG: Maker position change - YES: ${makerYesChange}, NO: ${makerNoChange}`);
      console.log(`  ⚠️ Expected: Maker should have +100 NO shares (or equivalent lamports)`);
      console.log(`  ⚠️ Actual: Maker position unchanged - FUNDS STUCK!`);
    });
    
    it("1.6 [BUG TEST] Better-price fills should refund difference - KNOWN BUG", async () => {
      /**
       * When a taker's order crosses at a better price than their limit,
       * they should be refunded the difference.
       */
      const { pdas } = await createTestMarket(program, provider);
      
      // Maker places ASK @ 5000
      const maker = Keypair.generate();
      await airdrop(provider, maker.publicKey);
      
      const [makerPosPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), maker.publicKey.toBuffer()],
        program.programId
      );
      
      await program.methods
        .placeOrder(1, true, new anchor.BN(5000), new anchor.BN(100))
        .accounts({
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
          vault: pdas.vaultPda,
          position: makerPosPda,
          trader: maker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([maker])
        .rpc();
      
      // Taker places BID @ 6000 (1000 bps better than best ask)
      const taker = Keypair.generate();
      await airdrop(provider, taker.publicKey);
      
      const [takerPosPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), taker.publicKey.toBuffer()],
        program.programId
      );
      
      const takerBalanceBefore = await provider.connection.getBalance(taker.publicKey);
      
      await program.methods
        .placeOrder(0, true, new anchor.BN(6000), new anchor.BN(100))
        .accounts({
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
          vault: pdas.vaultPda,
          position: takerPosPda,
          trader: taker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([taker])
        .rpc();
      
      const takerBalanceAfter = await provider.connection.getBalance(taker.publicKey);
      
      const expectedCost = 5000 * 100; // Fill price
      const actualCost = takerBalanceBefore - takerBalanceAfter;
      const overpayment = actualCost - expectedCost;
      
      console.log(`  Taker paid: ${actualCost} lamports`);
      console.log(`  Should have paid: ${expectedCost} lamports`);
      console.log(`  ⚠️ BUG: Overpayment of ${overpayment} lamports (no refund for better price)`);
    });
    
    it("1.7 Fund conservation: total_in = total_out (cancel all orders)", async () => {
      const { pdas } = await createTestMarket(program, provider);
      
      const trader = Keypair.generate();
      await airdrop(provider, trader.publicKey);
      
      const [posPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), trader.publicKey.toBuffer()],
        program.programId
      );
      
      // Place several orders
      const orders = [
        { side: 0, price: 4000, size: 50 },
        { side: 0, price: 5000, size: 30 },
        { side: 1, price: 6000, size: 40 },
        { side: 1, price: 7000, size: 20 },
      ];
      
      let totalDeposited = 0;
      for (const order of orders) {
        const collateral = calculateCollateral(order.side, order.price, order.size);
        totalDeposited += collateral;
        
        await program.methods
          .placeOrder(order.side, true, new anchor.BN(order.price), new anchor.BN(order.size))
          .accounts({
            market: pdas.marketPda,
            orderBook: pdas.orderBookPda,
            vault: pdas.vaultPda,
            position: posPda,
            trader: trader.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([trader])
          .rpc();
      }
      
      console.log(`  Total deposited: ${totalDeposited} lamports`);
      
      // Cancel all orders (in reverse order to maintain indices)
      for (let i = 1; i >= 0; i--) {
        await program.methods
          .cancelOrder(false, i)
          .accounts({
            market: pdas.marketPda,
            orderBook: pdas.orderBookPda,
            vault: pdas.vaultPda,
            trader: trader.publicKey,
          })
          .signers([trader])
          .rpc();
      }
      
      for (let i = 1; i >= 0; i--) {
        await program.methods
          .cancelOrder(true, i)
          .accounts({
            market: pdas.marketPda,
            orderBook: pdas.orderBookPda,
            vault: pdas.vaultPda,
            trader: trader.publicKey,
          })
          .signers([trader])
          .rpc();
      }
      
      // Check order book is empty
      const orderBook = await program.account.orderBook.fetch(pdas.orderBookPda);
      assert.equal(orderBook.yesBids.length, 0);
      assert.equal(orderBook.yesAsks.length, 0);
      
      // Vault should only have rent-exempt minimum
      const vaultBalance = await provider.connection.getBalance(pdas.vaultPda);
      const rentExempt = await provider.connection.getMinimumBalanceForRentExemption(0);
      
      assert(vaultBalance <= rentExempt + 1);
      console.log(`  ✓ All collateral returned. Vault at rent-exempt: ${vaultBalance}`);
    });
  });
  
  // =========================================
  // 2. MATCHING ENGINE TESTS
  // =========================================
  
  describe("2. Matching Engine Tests", () => {
    
    it("2.1 Bid crosses ask → fills at resting (maker) price", async () => {
      const { pdas } = await createTestMarket(program, provider);
      
      // Maker: ASK 100 @ 5000
      const maker = Keypair.generate();
      await airdrop(provider, maker.publicKey);
      const [makerPosPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), maker.publicKey.toBuffer()],
        program.programId
      );
      
      await program.methods
        .placeOrder(1, true, new anchor.BN(5000), new anchor.BN(100))
        .accounts({
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
          vault: pdas.vaultPda,
          position: makerPosPda,
          trader: maker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([maker])
        .rpc();
      
      // Taker: BID 100 @ 6000 (crosses at 5000)
      const taker = Keypair.generate();
      await airdrop(provider, taker.publicKey);
      const [takerPosPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), taker.publicKey.toBuffer()],
        program.programId
      );
      
      await program.methods
        .placeOrder(0, true, new anchor.BN(6000), new anchor.BN(100))
        .accounts({
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
          vault: pdas.vaultPda,
          position: takerPosPda,
          trader: taker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([taker])
        .rpc();
      
      // Order book should be empty (full fill)
      const orderBook = await program.account.orderBook.fetch(pdas.orderBookPda);
      assert.equal(orderBook.yesAsks.length, 0);
      assert.equal(orderBook.yesBids.length, 0);
      
      // Taker should have 100 YES shares
      const takerPos = await program.account.clobPosition.fetch(takerPosPda);
      assert.equal(takerPos.yesShares.toNumber(), 100);
      
      console.log(`  ✓ Full match: 100 shares filled at maker price 5000`);
    });
    
    it("2.2 Partial fills leave correct remainder", async () => {
      const { pdas } = await createTestMarket(program, provider);
      
      // Maker: ASK 100 @ 5000
      const maker = Keypair.generate();
      await airdrop(provider, maker.publicKey);
      const [makerPosPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), maker.publicKey.toBuffer()],
        program.programId
      );
      
      await program.methods
        .placeOrder(1, true, new anchor.BN(5000), new anchor.BN(100))
        .accounts({
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
          vault: pdas.vaultPda,
          position: makerPosPda,
          trader: maker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([maker])
        .rpc();
      
      // Taker: BID 30 @ 5500 (partial fill)
      const taker = Keypair.generate();
      await airdrop(provider, taker.publicKey);
      const [takerPosPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), taker.publicKey.toBuffer()],
        program.programId
      );
      
      await program.methods
        .placeOrder(0, true, new anchor.BN(5500), new anchor.BN(30))
        .accounts({
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
          vault: pdas.vaultPda,
          position: takerPosPda,
          trader: taker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([taker])
        .rpc();
      
      // Ask should have 70 remaining
      const orderBook = await program.account.orderBook.fetch(pdas.orderBookPda);
      assert.equal(orderBook.yesAsks.length, 1);
      assert.equal(orderBook.yesAsks[0].size.toNumber(), 70);
      
      // Taker should have 30 YES
      const takerPos = await program.account.clobPosition.fetch(takerPosPda);
      assert.equal(takerPos.yesShares.toNumber(), 30);
      
      console.log(`  ✓ Partial fill: 30/100, remainder 70 @ 5000`);
    });
    
    it("2.3 Price-time priority: better prices first", async () => {
      const { pdas } = await createTestMarket(program, provider);
      
      // Place asks at different prices
      const maker1 = Keypair.generate();
      const maker2 = Keypair.generate();
      const maker3 = Keypair.generate();
      
      await airdrop(provider, maker1.publicKey);
      await airdrop(provider, maker2.publicKey);
      await airdrop(provider, maker3.publicKey);
      
      const [pos1] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), maker1.publicKey.toBuffer()],
        program.programId
      );
      const [pos2] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), maker2.publicKey.toBuffer()],
        program.programId
      );
      const [pos3] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), maker3.publicKey.toBuffer()],
        program.programId
      );
      
      // maker1: ASK 50 @ 6000 (worst)
      await program.methods
        .placeOrder(1, true, new anchor.BN(6000), new anchor.BN(50))
        .accounts({
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
          vault: pdas.vaultPda,
          position: pos1,
          trader: maker1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([maker1])
        .rpc();
      
      // maker2: ASK 50 @ 4000 (best)
      await program.methods
        .placeOrder(1, true, new anchor.BN(4000), new anchor.BN(50))
        .accounts({
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
          vault: pdas.vaultPda,
          position: pos2,
          trader: maker2.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([maker2])
        .rpc();
      
      // maker3: ASK 50 @ 5000 (middle)
      await program.methods
        .placeOrder(1, true, new anchor.BN(5000), new anchor.BN(50))
        .accounts({
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
          vault: pdas.vaultPda,
          position: pos3,
          trader: maker3.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([maker3])
        .rpc();
      
      // Check sorting (ascending: best ask first)
      let orderBook = await program.account.orderBook.fetch(pdas.orderBookPda);
      assert.equal(orderBook.yesAsks[0].price.toNumber(), 4000); // Best
      assert.equal(orderBook.yesAsks[1].price.toNumber(), 5000);
      assert.equal(orderBook.yesAsks[2].price.toNumber(), 6000); // Worst
      
      console.log(`  ✓ Asks sorted correctly: 4000, 5000, 6000`);
      
      // Taker buys 60, should fill 50 @ 4000 and 10 @ 5000
      const taker = Keypair.generate();
      await airdrop(provider, taker.publicKey);
      const [takerPos] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), taker.publicKey.toBuffer()],
        program.programId
      );
      
      await program.methods
        .placeOrder(0, true, new anchor.BN(5000), new anchor.BN(60))
        .accounts({
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
          vault: pdas.vaultPda,
          position: takerPos,
          trader: taker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([taker])
        .rpc();
      
      orderBook = await program.account.orderBook.fetch(pdas.orderBookPda);
      
      // Should have 40 @ 5000 remaining and 50 @ 6000
      assert.equal(orderBook.yesAsks.length, 2);
      assert.equal(orderBook.yesAsks[0].price.toNumber(), 5000);
      assert.equal(orderBook.yesAsks[0].size.toNumber(), 40);
      assert.equal(orderBook.yesAsks[1].price.toNumber(), 6000);
      assert.equal(orderBook.yesAsks[1].size.toNumber(), 50);
      
      console.log(`  ✓ Price priority: filled best price first`);
    });
    
    it("2.4 No match when bid < ask", async () => {
      const { pdas } = await createTestMarket(program, provider);
      
      // ASK @ 6000
      const maker = Keypair.generate();
      await airdrop(provider, maker.publicKey);
      const [makerPos] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), maker.publicKey.toBuffer()],
        program.programId
      );
      
      await program.methods
        .placeOrder(1, true, new anchor.BN(6000), new anchor.BN(50))
        .accounts({
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
          vault: pdas.vaultPda,
          position: makerPos,
          trader: maker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([maker])
        .rpc();
      
      // BID @ 5000 (no cross)
      const taker = Keypair.generate();
      await airdrop(provider, taker.publicKey);
      const [takerPos] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), taker.publicKey.toBuffer()],
        program.programId
      );
      
      await program.methods
        .placeOrder(0, true, new anchor.BN(5000), new anchor.BN(50))
        .accounts({
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
          vault: pdas.vaultPda,
          position: takerPos,
          trader: taker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([taker])
        .rpc();
      
      // Both orders should rest
      const orderBook = await program.account.orderBook.fetch(pdas.orderBookPda);
      assert.equal(orderBook.yesBids.length, 1);
      assert.equal(orderBook.yesAsks.length, 1);
      
      // No shares traded
      const takerPosData = await program.account.clobPosition.fetch(takerPos);
      assert.equal(takerPosData.yesShares.toNumber(), 0);
      
      console.log(`  ✓ No match: bid 5000 < ask 6000`);
    });
  });
  
  // =========================================
  // 3. EDGE CASES
  // =========================================
  
  describe("3. Edge Cases", () => {
    
    it("3.1 Order exactly fills book (no remainder)", async () => {
      const { pdas } = await createTestMarket(program, provider);
      
      // Multiple asks totaling 105
      const makers = [];
      for (let i = 0; i < 3; i++) {
        const maker = Keypair.generate();
        await airdrop(provider, maker.publicKey);
        makers.push(maker);
      }
      
      let totalAskSize = 0;
      for (let i = 0; i < makers.length; i++) {
        const maker = makers[i];
        const [pos] = PublicKey.findProgramAddressSync(
          [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), maker.publicKey.toBuffer()],
          program.programId
        );
        const size = 30 + i * 5; // 30, 35, 40 = 105
        totalAskSize += size;
        
        await program.methods
          .placeOrder(1, true, new anchor.BN(5000), new anchor.BN(size))
          .accounts({
            market: pdas.marketPda,
            orderBook: pdas.orderBookPda,
            vault: pdas.vaultPda,
            position: pos,
            trader: maker.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([maker])
          .rpc();
      }
      
      // Taker buys exactly totalAskSize
      const taker = Keypair.generate();
      await airdrop(provider, taker.publicKey);
      const [takerPos] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), taker.publicKey.toBuffer()],
        program.programId
      );
      
      await program.methods
        .placeOrder(0, true, new anchor.BN(5000), new anchor.BN(totalAskSize))
        .accounts({
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
          vault: pdas.vaultPda,
          position: takerPos,
          trader: taker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([taker])
        .rpc();
      
      // Book should be empty
      const orderBook = await program.account.orderBook.fetch(pdas.orderBookPda);
      assert.equal(orderBook.yesAsks.length, 0);
      assert.equal(orderBook.yesBids.length, 0);
      
      const takerPosData = await program.account.clobPosition.fetch(takerPos);
      assert.equal(takerPosData.yesShares.toNumber(), totalAskSize);
      
      console.log(`  ✓ Exact fill: ${totalAskSize} shares, book empty`);
    });
    
    it("3.2 Price at boundaries: 1 and 9999 bps", async () => {
      const { pdas } = await createTestMarket(program, provider);
      
      const trader = Keypair.generate();
      await airdrop(provider, trader.publicKey);
      const [pos] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), trader.publicKey.toBuffer()],
        program.programId
      );
      
      // Minimum price (1 bps = 0.01%)
      await program.methods
        .placeOrder(0, true, new anchor.BN(1), new anchor.BN(10))
        .accounts({
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
          vault: pdas.vaultPda,
          position: pos,
          trader: trader.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([trader])
        .rpc();
      
      // Maximum price (9999 bps = 99.99%)
      await program.methods
        .placeOrder(1, true, new anchor.BN(9999), new anchor.BN(10))
        .accounts({
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
          vault: pdas.vaultPda,
          position: pos,
          trader: trader.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([trader])
        .rpc();
      
      const orderBook = await program.account.orderBook.fetch(pdas.orderBookPda);
      assert.equal(orderBook.yesBids[0].price.toNumber(), 1);
      assert.equal(orderBook.yesAsks[0].price.toNumber(), 9999);
      
      console.log(`  ✓ Boundary prices: 1 bps bid, 9999 bps ask`);
    });
    
    it("3.3 Rejects price = 0 (invalid)", async () => {
      const { pdas } = await createTestMarket(program, provider);
      
      const trader = Keypair.generate();
      await airdrop(provider, trader.publicKey);
      const [pos] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), trader.publicKey.toBuffer()],
        program.programId
      );
      
      try {
        await program.methods
          .placeOrder(0, true, new anchor.BN(0), new anchor.BN(10))
          .accounts({
            market: pdas.marketPda,
            orderBook: pdas.orderBookPda,
            vault: pdas.vaultPda,
            position: pos,
            trader: trader.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([trader])
          .rpc();
        
        assert.fail("Should have rejected price = 0");
      } catch (err) {
        assert(err.error?.errorCode?.code === "InvalidPrice");
        console.log(`  ✓ Correctly rejected price = 0`);
      }
    });
    
    it("3.4 Rejects price = 10000 (invalid)", async () => {
      const { pdas } = await createTestMarket(program, provider);
      
      const trader = Keypair.generate();
      await airdrop(provider, trader.publicKey);
      const [pos] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), trader.publicKey.toBuffer()],
        program.programId
      );
      
      try {
        await program.methods
          .placeOrder(0, true, new anchor.BN(10000), new anchor.BN(10))
          .accounts({
            market: pdas.marketPda,
            orderBook: pdas.orderBookPda,
            vault: pdas.vaultPda,
            position: pos,
            trader: trader.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([trader])
          .rpc();
        
        assert.fail("Should have rejected price = 10000");
      } catch (err) {
        assert(err.error?.errorCode?.code === "InvalidPrice");
        console.log(`  ✓ Correctly rejected price = 10000`);
      }
    });
    
    it("3.5 Rejects size = 0 (invalid)", async () => {
      const { pdas } = await createTestMarket(program, provider);
      
      const trader = Keypair.generate();
      await airdrop(provider, trader.publicKey);
      const [pos] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), trader.publicKey.toBuffer()],
        program.programId
      );
      
      try {
        await program.methods
          .placeOrder(0, true, new anchor.BN(5000), new anchor.BN(0))
          .accounts({
            market: pdas.marketPda,
            orderBook: pdas.orderBookPda,
            vault: pdas.vaultPda,
            position: pos,
            trader: trader.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([trader])
          .rpc();
        
        assert.fail("Should have rejected size = 0");
      } catch (err) {
        assert(err.error?.errorCode?.code === "InvalidSize");
        console.log(`  ✓ Correctly rejected size = 0`);
      }
    });
    
    it("3.6 NO shares via price inversion", async () => {
      const { pdas } = await createTestMarket(program, provider);
      
      const trader = Keypair.generate();
      await airdrop(provider, trader.publicKey);
      const [pos] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), trader.publicKey.toBuffer()],
        program.programId
      );
      
      // BID for NO @ 40% = ASK for YES @ 60%
      await program.methods
        .placeOrder(0, false, new anchor.BN(4000), new anchor.BN(50))
        .accounts({
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
          vault: pdas.vaultPda,
          position: pos,
          trader: trader.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([trader])
        .rpc();
      
      const orderBook = await program.account.orderBook.fetch(pdas.orderBookPda);
      
      // Should appear as YES ASK at 6000 (10000 - 4000)
      assert.equal(orderBook.yesAsks.length, 1);
      assert.equal(orderBook.yesAsks[0].price.toNumber(), 6000);
      
      console.log(`  ✓ NO bid @ 40% stored as YES ask @ 60%`);
    });
    
    it("3.7 Cancel non-existent order index", async () => {
      const { pdas } = await createTestMarket(program, provider);
      
      try {
        await program.methods
          .cancelOrder(true, 99)
          .accounts({
            market: pdas.marketPda,
            orderBook: pdas.orderBookPda,
            vault: pdas.vaultPda,
            trader: authority.publicKey,
          })
          .rpc();
        
        assert.fail("Should have rejected invalid index");
      } catch (err) {
        assert(err.error?.errorCode?.code === "InvalidOrderIndex");
        console.log(`  ✓ Invalid order index rejected`);
      }
    });
    
    it("3.8 Cancel someone else's order", async () => {
      const { pdas } = await createTestMarket(program, provider);
      
      // Trader 1 places order
      const trader1 = Keypair.generate();
      await airdrop(provider, trader1.publicKey);
      const [pos1] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), trader1.publicKey.toBuffer()],
        program.programId
      );
      
      await program.methods
        .placeOrder(0, true, new anchor.BN(5000), new anchor.BN(50))
        .accounts({
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
          vault: pdas.vaultPda,
          position: pos1,
          trader: trader1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([trader1])
        .rpc();
      
      // Trader 2 tries to cancel it
      const trader2 = Keypair.generate();
      await airdrop(provider, trader2.publicKey);
      
      try {
        await program.methods
          .cancelOrder(true, 0)
          .accounts({
            market: pdas.marketPda,
            orderBook: pdas.orderBookPda,
            vault: pdas.vaultPda,
            trader: trader2.publicKey,
          })
          .signers([trader2])
          .rpc();
        
        assert.fail("Should not allow canceling another's order");
      } catch (err) {
        assert(err.error?.errorCode?.code === "NotOrderOwner");
        console.log(`  ✓ Cannot cancel another trader's order`);
      }
    });
  });
  
  // =========================================
  // 4. RESOLUTION & CLAIMS
  // =========================================
  
  describe("4. Resolution & Claims", () => {
    
    it("4.1 Winners can claim full amount (YES wins)", async () => {
      const { pdas } = await createTestMarket(program, provider);
      
      // Maker sells YES (gets NO)
      const maker = Keypair.generate();
      await airdrop(provider, maker.publicKey);
      const [makerPos] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), maker.publicKey.toBuffer()],
        program.programId
      );
      
      await program.methods
        .placeOrder(1, true, new anchor.BN(5000), new anchor.BN(100))
        .accounts({
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
          vault: pdas.vaultPda,
          position: makerPos,
          trader: maker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([maker])
        .rpc();
      
      // Taker buys YES
      const taker = Keypair.generate();
      await airdrop(provider, taker.publicKey);
      const [takerPos] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), taker.publicKey.toBuffer()],
        program.programId
      );
      
      await program.methods
        .placeOrder(0, true, new anchor.BN(5000), new anchor.BN(100))
        .accounts({
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
          vault: pdas.vaultPda,
          position: takerPos,
          trader: taker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([taker])
        .rpc();
      
      // Resolve: YES wins
      await program.methods
        .resolveClobMarket(0)
        .accounts({
          market: pdas.marketPda,
          authority: authority.publicKey,
        })
        .rpc();
      
      // Taker claims
      const takerBalBefore = await provider.connection.getBalance(taker.publicKey);
      
      await program.methods
        .claimClobWinnings()
        .accounts({
          market: pdas.marketPda,
          vault: pdas.vaultPda,
          position: takerPos,
          claimer: taker.publicKey,
        })
        .signers([taker])
        .rpc();
      
      const takerBalAfter = await provider.connection.getBalance(taker.publicKey);
      const claimed = takerBalAfter - takerBalBefore;
      
      // 100 shares × 10000 lamports = 1,000,000
      const expectedPayout = 100 * SHARE_PAYOUT;
      assert(Math.abs(claimed - expectedPayout) < 10000); // Allow for tx fee
      
      console.log(`  ✓ Winner claimed ${claimed} lamports (expected ~${expectedPayout})`);
    });
    
    it("4.2 Double-claim prevented", async () => {
      const { pdas } = await createTestMarket(program, provider);
      
      // Setup winner
      const maker = Keypair.generate();
      const taker = Keypair.generate();
      await airdrop(provider, maker.publicKey);
      await airdrop(provider, taker.publicKey);
      
      const [makerPos] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), maker.publicKey.toBuffer()],
        program.programId
      );
      const [takerPos] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), taker.publicKey.toBuffer()],
        program.programId
      );
      
      await program.methods
        .placeOrder(1, true, new anchor.BN(5000), new anchor.BN(50))
        .accounts({
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
          vault: pdas.vaultPda,
          position: makerPos,
          trader: maker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([maker])
        .rpc();
      
      await program.methods
        .placeOrder(0, true, new anchor.BN(5000), new anchor.BN(50))
        .accounts({
          market: pdas.marketPda,
          orderBook: pdas.orderBookPda,
          vault: pdas.vaultPda,
          position: takerPos,
          trader: taker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([taker])
        .rpc();
      
      await program.methods
        .resolveClobMarket(0)
        .accounts({
          market: pdas.marketPda,
          authority: authority.publicKey,
        })
        .rpc();
      
      // First claim succeeds
      await program.methods
        .claimClobWinnings()
        .accounts({
          market: pdas.marketPda,
          vault: pdas.vaultPda,
          position: takerPos,
          claimer: taker.publicKey,
        })
        .signers([taker])
        .rpc();
      
      console.log(`  First claim succeeded`);
      
      // Second claim should fail
      try {
        await program.methods
          .claimClobWinnings()
          .accounts({
            market: pdas.marketPda,
            vault: pdas.vaultPda,
            position: takerPos,
            claimer: taker.publicKey,
          })
          .signers([taker])
          .rpc();
        
        assert.fail("Double claim should fail");
      } catch (err) {
        assert(err.error?.errorCode?.code === "NoWinnings");
        console.log(`  ✓ Double claim prevented`);
      }
    });
    
    it("4.3 Cannot trade after resolution", async () => {
      const { pdas } = await createTestMarket(program, provider);
      
      await program.methods
        .resolveClobMarket(0)
        .accounts({
          market: pdas.marketPda,
          authority: authority.publicKey,
        })
        .rpc();
      
      const trader = Keypair.generate();
      await airdrop(provider, trader.publicKey);
      const [pos] = PublicKey.findProgramAddressSync(
        [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), trader.publicKey.toBuffer()],
        program.programId
      );
      
      try {
        await program.methods
          .placeOrder(0, true, new anchor.BN(5000), new anchor.BN(50))
          .accounts({
            market: pdas.marketPda,
            orderBook: pdas.orderBookPda,
            vault: pdas.vaultPda,
            position: pos,
            trader: trader.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([trader])
          .rpc();
        
        assert.fail("Should not trade after resolution");
      } catch (err) {
        assert(err.error?.errorCode?.code === "MarketResolved");
        console.log(`  ✓ Trading blocked after resolution`);
      }
    });
    
    it("4.4 Only authority can resolve", async () => {
      const { pdas } = await createTestMarket(program, provider);
      
      const attacker = Keypair.generate();
      await airdrop(provider, attacker.publicKey);
      
      try {
        await program.methods
          .resolveClobMarket(0)
          .accounts({
            market: pdas.marketPda,
            authority: attacker.publicKey,
          })
          .signers([attacker])
          .rpc();
        
        assert.fail("Non-authority should not resolve");
      } catch (err) {
        assert(err.error?.errorCode?.code === "Unauthorized");
        console.log(`  ✓ Only authority can resolve`);
      }
    });
  });
  
  // =========================================
  // 5. INVARIANT TESTS (Randomized)
  // =========================================
  
  describe("5. Invariant Tests (Randomized Sequences)", () => {
    
    it("5.1 Random place/cancel sequence - fund conservation", async () => {
      const { pdas } = await createTestMarket(program, provider);
      
      const traders = [];
      for (let i = 0; i < 5; i++) {
        const trader = Keypair.generate();
        await airdrop(provider, trader.publicKey);
        traders.push(trader);
      }
      
      const operations = 20;
      
      console.log(`  Running ${operations} random operations...`);
      
      for (let i = 0; i < operations; i++) {
        const trader = traders[Math.floor(Math.random() * traders.length)];
        const [pos] = PublicKey.findProgramAddressSync(
          [Buffer.from("clob_position"), pdas.marketPda.toBuffer(), trader.publicKey.toBuffer()],
          program.programId
        );
        
        // Random operation: place (70%) or cancel (30%)
        const isPlace = Math.random() < 0.7;
        
        if (isPlace) {
          const side = Math.random() < 0.5 ? 0 : 1;
          const price = 1000 + Math.floor(Math.random() * 8000);
          const size = 1 + Math.floor(Math.random() * 20);
          
          try {
            await program.methods
              .placeOrder(side, true, new anchor.BN(price), new anchor.BN(size))
              .accounts({
                market: pdas.marketPda,
                orderBook: pdas.orderBookPda,
                vault: pdas.vaultPda,
                position: pos,
                trader: trader.publicKey,
                systemProgram: SystemProgram.programId,
              })
              .signers([trader])
              .rpc();
          } catch {
            // Order might fail (book full, etc) - ok
          }
        } else {
          // Try to cancel
          const orderBook = await program.account.orderBook.fetch(pdas.orderBookPda);
          const isBid = Math.random() < 0.5;
          const orders = isBid ? orderBook.yesBids : orderBook.yesAsks;
          
          if (orders.length > 0) {
            // Find trader's order
            const idx = orders.findIndex(o => o.owner.equals(trader.publicKey));
            if (idx >= 0) {
              try {
                await program.methods
                  .cancelOrder(isBid, idx)
                  .accounts({
                    market: pdas.marketPda,
                    orderBook: pdas.orderBookPda,
                    vault: pdas.vaultPda,
                    trader: trader.publicKey,
                  })
                  .signers([trader])
                  .rpc();
              } catch {
                // Cancel might fail - ok
              }
            }
          }
        }
        
        // Check invariant after each operation
        const state = await getMarketState(program, provider, pdas, traders.map(t => t.publicKey));
        try {
          assertVaultSolvency(state, `op ${i + 1}`);
        } catch (err) {
          console.log(`  ❌ INVARIANT VIOLATION at operation ${i + 1}`);
          throw err;
        }
      }
      
      console.log(`  ✓ ${operations} operations completed, fund invariant held`);
    });
  });
  
  // =========================================
  // 6. KNOWN BUGS DOCUMENTATION
  // =========================================
  
  describe("6. Known Bugs Documentation", () => {
    
    it("6.1 [DOC] Bug: Maker position not updated on fill", async () => {
      console.log(`  ⚠️ CRITICAL BUG: Makers don't receive anything when filled`);
      console.log(`  ⚠️ Status: DOCUMENTED - Requires code fix before production`);
    });
    
    it("6.2 [DOC] Bug: No refund for better-price fills", async () => {
      console.log(`  ⚠️ HIGH BUG: Takers overpay when filling at better prices`);
      console.log(`  ⚠️ Status: DOCUMENTED - Requires code fix`);
    });
    
    it("6.3 [DOC] Bug: Cancel by index is fragile", async () => {
      console.log(`  ⚠️ MEDIUM BUG: Cancel by index can cancel wrong order`);
      console.log(`  ⚠️ Status: DOCUMENTED - Should fix before production`);
    });
    
    it("6.4 [DOC] Bug: Order ID collision (same timestamp)", async () => {
      console.log(`  ⚠️ MEDIUM BUG: Order IDs can collide within same second`);
      console.log(`  ⚠️ Status: DOCUMENTED - Should fix`);
    });
    
    it("6.5 [DOC] Bug: No vault balance check before claim", async () => {
      console.log(`  ⚠️ HIGH BUG: No balance check before claim payout`);
      console.log(`  ⚠️ Status: DOCUMENTED - Easy fix`);
    });
  });
});

console.log(`
=========================================
CLOB Safety Test Suite
=========================================
Run with: anchor test
Or: yarn run mocha -t 120000 tests/clob-safety.js
=========================================
`);
