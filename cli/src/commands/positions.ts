import { Command } from 'commander';
import chalk from 'chalk';
import { getClient } from '../client.js';

export const positionsCommand = new Command('positions')
  .description('Show your positions across all markets')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    console.log(chalk.blue('📈 Fetching your positions...\n'));
    
    const client = getClient();
    const positions = await client.getPositions();
    
    if (options.json) {
      console.log(JSON.stringify(positions, null, 2));
      return;
    }
    
    if (positions.length === 0) {
      console.log(chalk.yellow('No positions found.'));
      console.log(chalk.gray('\nBuy shares with: agentbets buy <market-id> <outcome> <amount>'));
      return;
    }
    
    let totalValue = 0;
    let totalCost = 0;
    
    for (const position of positions) {
      const totalShares = position.shares.reduce((a, b) => a + b, 0);
      
      // TODO: Calculate actual current value using market prices
      const estimatedValue = position.costBasis * 1.1; // placeholder
      const pnl = estimatedValue - position.costBasis;
      const pnlPercent = (pnl / position.costBasis) * 100;
      
      totalValue += estimatedValue;
      totalCost += position.costBasis;
      
      console.log(chalk.bold.white(`📌 Market: ${position.market.toBase58().slice(0, 8)}...`));
      console.log(chalk.gray(`   Owner: ${position.owner.toBase58().slice(0, 8)}...`));
      
      position.shares.forEach((shares, i) => {
        if (shares > 0) {
          console.log(`   Outcome ${i}: ${chalk.cyan(shares.toLocaleString())} shares`);
        }
      });
      
      console.log(`   Cost Basis: ${position.costBasis.toLocaleString()} lamports`);
      console.log(`   Est. Value: ${estimatedValue.toLocaleString()} lamports`);
      
      const pnlColor = pnl >= 0 ? chalk.green : chalk.red;
      const sign = pnl >= 0 ? '+' : '';
      console.log(`   P&L: ${pnlColor(sign + pnl.toLocaleString())} (${sign}${pnlPercent.toFixed(1)}%)`);
      console.log('');
    }
    
    // Summary
    const totalPnl = totalValue - totalCost;
    const totalPnlPercent = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
    const pnlColor = totalPnl >= 0 ? chalk.green : chalk.red;
    const sign = totalPnl >= 0 ? '+' : '';
    
    console.log(chalk.bold('═══════════════════════════════════'));
    console.log(chalk.bold('Portfolio Summary'));
    console.log(`  Total Cost:  ${totalCost.toLocaleString()} lamports`);
    console.log(`  Total Value: ${totalValue.toLocaleString()} lamports`);
    console.log(`  Total P&L:   ${pnlColor(sign + totalPnl.toLocaleString())} (${sign}${totalPnlPercent.toFixed(1)}%)`);
  });
