const { Connection, Keypair, Transaction } = require('@solana/web3.js');
const fs = require('fs');

async function main() {
  const marketId = process.argv[2];
  const outcomeIndex = parseInt(process.argv[3]);
  const amountLamports = parseInt(process.argv[4]);
  
  if (!marketId || outcomeIndex === undefined || !amountLamports) {
    console.log('Usage: node seed-market.js <marketId> <outcomeIndex> <amountLamports>');
    process.exit(1);
  }

  const keypairPath = process.env.HOME + '/.config/solana/agentbets.json';
  const keypairData = JSON.parse(fs.readFileSync(keypairPath));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  
  console.log('Wallet:', wallet.publicKey.toBase58());
  
  // Get unsigned tx
  const API = 'https://agentbets-api-production.up.railway.app';
  const res = await fetch(`${API}/markets/${marketId}/bet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      outcomeIndex,
      amount: amountLamports,
      buyerPubkey: wallet.publicKey.toBase58()
    })
  });
  
  const data = await res.json();
  if (!data.unsignedTx) {
    console.error('Error:', data);
    process.exit(1);
  }
  
  // Sign tx
  const tx = Transaction.from(Buffer.from(data.unsignedTx, 'base64'));
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.sign(wallet);
  
  // Submit
  const submitRes = await fetch(`${API}/markets/${marketId}/bet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      signedTx: tx.serialize().toString('base64')
    })
  });
  
  const result = await submitRes.json();
  console.log('Result:', result);
}

main().catch(console.error);
