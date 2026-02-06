import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getClient } from '../client.js';

export const sellCommand = new Command('sell')
  .description('Sell shares in a market outcome')
  .argument('<market-id>', 'Market public key')
  .argument('<outcome>', 'Outcome index (0, 1, etc.) or name')
  .argument('<amount>', 'Amount of shares to sell')
  .option('--dry-run', 'Simulate the transaction without executing')
  .option('--slippage <percent>', 'Maximum slippage tolerance', '1')
  .action(async (marketId: string, outcome: string, amount: string, options) => {
    const client = getClient();
    
    // Resolve outcome to index
    let outcomeIndex: number;
    if (/^\d+$/.test(outcome)) {
      outcomeIndex = parseInt(outcome, 10);
    } else {
      const market = await client.getMarket(marketId);
      if (!market) {
        console.log(chalk.red(`Market not found: ${marketId}`));
        process.exit(1);
      }
      outcomeIndex = market.outcomes.findIndex(
        o => o.toLowerCase() === outcome.toLowerCase()
      );
      if (outcomeIndex === -1) {
        console.log(chalk.red(`Unknown outcome: ${outcome}`));
        console.log(chalk.gray(`Available: ${market.outcomes.join(', ')}`));
        process.exit(1);
      }
    }
    
    const shares = parseFloat(amount);
    if (isNaN(shares) || shares <= 0) {
      console.log(chalk.red('Invalid amount'));
      process.exit(1);
    }
    
    console.log(chalk.blue('💰 Sell Order\n'));
    console.log(`  Market:   ${marketId.slice(0, 8)}...`);
    console.log(`  Outcome:  ${outcomeIndex}`);
    console.log(`  Shares:   ${shares}`);
    console.log(`  Slippage: ${options.slippage}%`);
    console.log('');
    
    if (options.dryRun) {
      console.log(chalk.yellow('🔍 Dry run - transaction not executed'));
      console.log(chalk.gray('\nWould execute sell instruction with:'));
      console.log(chalk.gray(`  - market: ${marketId}`));
      console.log(chalk.gray(`  - outcome: ${outcomeIndex}`));
      console.log(chalk.gray(`  - amount: ${shares}`));
      return;
    }
    
    const spinner = ora('Submitting transaction...').start();
    
    try {
      const txSignature = await client.sellShares({
        marketId,
        outcome: outcomeIndex,
        amount: shares,
      });
      
      spinner.succeed('Transaction submitted!');
      console.log('');
      console.log(chalk.green(`✅ Sold ${shares} shares`));
      console.log(chalk.gray(`   Tx: ${txSignature}`));
    } catch (error) {
      spinner.fail('Transaction failed');
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });
