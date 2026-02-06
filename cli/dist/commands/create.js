import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getClient } from '../client.js';
export const createCommand = new Command('create')
    .description('Create a new prediction market (oracle only)')
    .option('-q, --question <question>', 'Market question')
    .option('-o, --outcomes <outcomes>', 'Comma-separated outcomes (e.g., "Yes,No")')
    .option('-e, --end-time <datetime>', 'Market end time (ISO 8601 format)')
    .option('-l, --liquidity <amount>', 'Initial liquidity in lamports', '10000000')
    .option('--dry-run', 'Simulate the transaction without executing')
    .action(async (options) => {
    // Validate required options
    if (!options.question) {
        console.log(chalk.red('Error: --question is required'));
        console.log(chalk.gray('\nExample:'));
        console.log(chalk.gray('  agentbets create --question "Will SOL reach $500?" --outcomes "Yes,No" --end-time "2026-12-31"'));
        process.exit(1);
    }
    if (!options.outcomes) {
        console.log(chalk.red('Error: --outcomes is required'));
        process.exit(1);
    }
    if (!options.endTime) {
        console.log(chalk.red('Error: --end-time is required'));
        process.exit(1);
    }
    const outcomes = options.outcomes.split(',').map((o) => o.trim());
    if (outcomes.length < 2) {
        console.log(chalk.red('Error: At least 2 outcomes required'));
        process.exit(1);
    }
    const endTime = new Date(options.endTime);
    if (isNaN(endTime.getTime())) {
        console.log(chalk.red('Error: Invalid end-time format'));
        process.exit(1);
    }
    if (endTime <= new Date()) {
        console.log(chalk.red('Error: End time must be in the future'));
        process.exit(1);
    }
    const liquidity = parseInt(options.liquidity, 10);
    if (isNaN(liquidity) || liquidity <= 0) {
        console.log(chalk.red('Error: Invalid liquidity amount'));
        process.exit(1);
    }
    console.log(chalk.blue('🎯 Create Market\n'));
    console.log(`  Question:  ${options.question}`);
    console.log(`  Outcomes:  ${outcomes.join(', ')}`);
    console.log(`  End Time:  ${endTime.toLocaleString()}`);
    console.log(`  Liquidity: ${liquidity.toLocaleString()} lamports`);
    console.log('');
    if (options.dryRun) {
        console.log(chalk.yellow('🔍 Dry run - transaction not executed'));
        console.log(chalk.gray('\nWould create market with above parameters'));
        return;
    }
    const spinner = ora('Creating market...').start();
    try {
        const client = getClient();
        const result = await client.createMarket({
            question: options.question,
            outcomes,
            endTime,
            initialLiquidity: liquidity,
        });
        spinner.succeed('Market created!');
        console.log('');
        console.log(chalk.green('✅ Market created successfully'));
        console.log(chalk.cyan(`   Market ID: ${result.marketId}`));
        console.log(chalk.gray(`   Tx: ${result.txSignature}`));
        console.log('');
        console.log(chalk.gray('View market:'));
        console.log(chalk.gray(`  agentbets market ${result.marketId}`));
    }
    catch (error) {
        spinner.fail('Failed to create market');
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
    }
});
