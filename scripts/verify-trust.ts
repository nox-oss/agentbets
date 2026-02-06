#!/usr/bin/env npx ts-node
/**
 * AgentBets Trust Verification Script
 * 
 * Run this to independently verify that AgentBets is trustworthy.
 * Checks on-chain state matches API, vaults have correct balances, etc.
 * 
 * Usage:
 *   npx ts-node scripts/verify-trust.ts
 *   # or via API:
 *   curl https://agentbets-api-production.up.railway.app/verify-all
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

const API_URL = 'https://agentbets-api-production.up.railway.app';
const RPC_URL = 'https://api.devnet.solana.com';
const PROGRAM_ID = 'G59nkJ7khC1aKMr6eaRX1SssfeUuP7Ln8BpDj7ELkkcu';
const EXPECTED_AUTHORITY = 'DAS1DbaCVn7PuruRLo7gbn84f8SqTcVUPDW4S5qfZRL2';

interface VerificationResult {
  passed: boolean;
  check: string;
  details: string;
  evidence?: any;
}

async function main() {
  const results: VerificationResult[] = [];
  const connection = new Connection(RPC_URL, 'confirmed');

  console.log('🔍 AgentBets Trust Verification');
  console.log('================================\n');

  // 1. Verify program exists on-chain
  console.log('1️⃣ Checking program exists on-chain...');
  try {
    const programInfo = await connection.getAccountInfo(new PublicKey(PROGRAM_ID));
    const passed = programInfo !== null && programInfo.executable;
    results.push({
      passed,
      check: 'Program exists',
      details: passed 
        ? `Program ${PROGRAM_ID} is deployed and executable`
        : 'Program not found or not executable'
    });
    console.log(passed ? '   ✅ PASS' : '   ❌ FAIL');
  } catch (e) {
    results.push({
      passed: false,
      check: 'Program exists',
      details: `Error checking program: ${e}`
    });
    console.log('   ❌ FAIL');
  }

  // 2. Fetch markets from API
  console.log('\n2️⃣ Fetching markets from API...');
  let apiMarkets: any[] = [];
  try {
    const response = await fetch(`${API_URL}/markets`);
    const data = await response.json() as { markets: any[] };
    apiMarkets = data.markets;
    results.push({
      passed: apiMarkets.length > 0,
      check: 'API returns markets',
      details: `Found ${apiMarkets.length} markets`
    });
    console.log(`   ✅ Found ${apiMarkets.length} markets`);
  } catch (e) {
    results.push({
      passed: false,
      check: 'API returns markets',
      details: `Error fetching markets: ${e}`
    });
    console.log('   ❌ FAIL');
  }

  // 3. Verify each market's authority matches expected
  console.log('\n3️⃣ Verifying market authorities...');
  let authorityMatches = 0;
  for (const market of apiMarkets) {
    if (market.authority === EXPECTED_AUTHORITY) {
      authorityMatches++;
    }
  }
  const authorityPassed = authorityMatches === apiMarkets.length;
  results.push({
    passed: authorityPassed,
    check: 'Market authorities match',
    details: `${authorityMatches}/${apiMarkets.length} markets have expected authority (${EXPECTED_AUTHORITY})`
  });
  console.log(authorityPassed ? '   ✅ PASS' : '   ⚠️ PARTIAL');

  // 4. Check vault balances on-chain match reported pools
  console.log('\n4️⃣ Verifying vault balances match on-chain...');
  let vaultMatches = 0;
  let vaultMismatches: string[] = [];
  
  for (const market of apiMarkets) {
    try {
      // Derive vault PDA
      const [vaultPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('vault'), Buffer.from(market.marketId)],
        new PublicKey(PROGRAM_ID)
      );
      
      const vaultBalance = await connection.getBalance(vaultPDA);
      const reportedPool = parseFloat(market.totalPoolSol) * LAMPORTS_PER_SOL;
      
      // Allow 0.01 SOL tolerance for rent
      const diff = Math.abs(vaultBalance - reportedPool);
      if (diff < 0.01 * LAMPORTS_PER_SOL) {
        vaultMatches++;
      } else {
        vaultMismatches.push(`${market.marketId}: on-chain=${vaultBalance/LAMPORTS_PER_SOL} SOL, API=${market.totalPoolSol} SOL`);
      }
    } catch (e) {
      vaultMismatches.push(`${market.marketId}: error checking vault - ${e}`);
    }
  }
  
  const vaultPassed = vaultMatches === apiMarkets.length;
  results.push({
    passed: vaultPassed,
    check: 'Vault balances match',
    details: vaultPassed 
      ? `All ${apiMarkets.length} vaults match on-chain balances`
      : `${vaultMatches}/${apiMarkets.length} match. Mismatches: ${vaultMismatches.join(', ')}`
  });
  console.log(vaultPassed ? '   ✅ PASS' : `   ⚠️ ${vaultMatches}/${apiMarkets.length} match`);

  // 5. Check resolution criteria documentation exists
  console.log('\n5️⃣ Checking resolution criteria documentation...');
  try {
    const pendingRes = await fetch(`${API_URL}/resolutions/pending`);
    const pending = await pendingRes.json() as { count: number };
    results.push({
      passed: true,
      check: 'Resolution criteria endpoint',
      details: `/resolutions/pending returns ${pending.count} pending resolutions`
    });
    console.log('   ✅ PASS');
  } catch (e) {
    results.push({
      passed: false,
      check: 'Resolution criteria endpoint',
      details: `Error: ${e}`
    });
    console.log('   ❌ FAIL');
  }

  // 6. Check verify endpoints work for verifiable markets
  console.log('\n6️⃣ Testing verify endpoints for verifiable markets...');
  const verifiableMarkets = ['submissions-over-400', 'submissions-over-350'];
  let verifyWorks = 0;
  
  for (const marketId of verifiableMarkets) {
    try {
      const res = await fetch(`${API_URL}/markets/${marketId}/verify`);
      if (res.ok) {
        const data = await res.json();
        if (data.currentData && data.expectedResolution) {
          verifyWorks++;
        }
      }
    } catch (e) {
      // skip
    }
  }
  
  const verifyPassed = verifyWorks === verifiableMarkets.length;
  results.push({
    passed: verifyPassed,
    check: 'Verify endpoints work',
    details: `${verifyWorks}/${verifiableMarkets.length} verifiable markets have working /verify endpoints`
  });
  console.log(verifyPassed ? '   ✅ PASS' : `   ⚠️ ${verifyWorks}/${verifiableMarkets.length} work`);

  // 7. Check for skin in the game (counter-positions)
  console.log('\n7️⃣ Checking for skin in the game...');
  const skinMarket = apiMarkets.find(m => m.marketId === 'winner-uses-anchor');
  if (skinMarket) {
    const pools = skinMarket.outcomePools.map((p: string) => parseFloat(p));
    const hasBothSides = pools.filter((p: number) => p > 0).length >= 2;
    results.push({
      passed: hasBothSides,
      check: 'Skin in the game',
      details: hasBothSides 
        ? `Market 'winner-uses-anchor' has positions on both sides (Yes: ${pools[0]} SOL, No: ${pools[1]} SOL)`
        : 'No counter-positions found'
    });
    console.log(hasBothSides ? '   ✅ PASS' : '   ⚠️ PARTIAL');
  }

  // 8. Calculate trust score
  console.log('\n================================');
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  const trustScore = Math.round((passed / total) * 100);
  
  console.log(`\n🎯 TRUST SCORE: ${trustScore}% (${passed}/${total} checks passed)\n`);
  
  // Print summary
  console.log('Summary:');
  for (const r of results) {
    const icon = r.passed ? '✅' : '❌';
    console.log(`  ${icon} ${r.check}: ${r.details.substring(0, 80)}`);
  }

  // Grade
  let grade = 'F';
  if (trustScore >= 90) grade = 'A';
  else if (trustScore >= 80) grade = 'B';
  else if (trustScore >= 70) grade = 'C';
  else if (trustScore >= 60) grade = 'D';
  
  console.log(`\n📊 GRADE: ${grade}`);
  console.log('\n🔗 Verify yourself:');
  console.log(`   Program: https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet`);
  console.log(`   API: ${API_URL}/markets`);
  console.log(`   Resolution criteria: ${API_URL}/resolutions/pending`);

  return { trustScore, grade, results };
}

main().catch(console.error);
