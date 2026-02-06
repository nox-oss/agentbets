import { Connection, Keypair, Transaction, PublicKey } from '@solana/web3.js';
import { readFileSync } from 'fs';

const RPC_URL = 'https://api.devnet.solana.com';
const API_URL = 'https://agentbets-api-production.up.railway.app';

async function placeBet(marketId: string, outcomeIndex: number, amountLamports: number) {
  const keypairData = JSON.parse(readFileSync(`${process.env.HOME}/.config/solana/agentbets.json`, 'utf-8'));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  const connection = new Connection(RPC_URL, 'confirmed');
  
  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`Betting ${amountLamports / 1e9} SOL on outcome ${outcomeIndex} in market ${marketId}`);
  
  // Get unsigned tx from API
  const res = await fetch(`${API_URL}/markets/${marketId}/bet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      outcomeIndex,
      amount: amountLamports,
      buyerPubkey: wallet.publicKey.toBase58()
    })
  });
  
  const data = await res.json();
  if (data.error) {
    console.error('Error:', data.error);
    return;
  }
  
  console.log('Got unsigned tx, signing...');
  
  // Deserialize, sign, and submit
  const txBuffer = Buffer.from(data.unsignedTx, 'base64');
  const tx = Transaction.from(txBuffer);
  tx.sign(wallet);
  
  const signedTx = tx.serialize().toString('base64');
  
  // Submit signed tx
  const submitRes = await fetch(`${API_URL}/markets/${marketId}/bet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signedTx })
  });
  
  const result = await submitRes.json();
  console.log('Result:', result);
}

// Parse args
const [marketId, outcomeIndex, amountSol] = process.argv.slice(2);
if (!marketId || outcomeIndex === undefined || !amountSol) {
  console.log('Usage: npx tsx bet.ts <marketId> <outcomeIndex> <amountSol>');
  process.exit(1);
}

placeBet(marketId, parseInt(outcomeIndex), parseFloat(amountSol) * 1e9);
