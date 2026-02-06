import { Command } from 'commander';
import chalk from 'chalk';
import { getClient } from '../client.js';
export const marketsCommand = new Command('markets')
    .description('List all active prediction markets')
    .option('-a, --all', 'Include resolved markets')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
    console.log(chalk.blue('📊 Fetching markets...\n'));
    const client = getClient();
    const markets = await client.getMarkets();
    if (options.json) {
        console.log(JSON.stringify(markets, null, 2));
        return;
    }
    if (markets.length === 0) {
        console.log(chalk.yellow('No markets found.'));
        return;
    }
    for (const market of markets) {
        const endDate = new Date(market.endTime).toLocaleDateString();
        const totalVolume = market.totalShares.reduce((a, b) => a + b, 0);
        // Calculate implied probabilities
        const probs = market.totalShares.map(s => totalVolume > 0 ? ((s / totalVolume) * 100).toFixed(1) : '50.0');
        console.log(chalk.bold.white(`📌 ${market.question}`));
        console.log(chalk.gray(`   ID: ${market.publicKey.toBase58().slice(0, 8)}...`));
        console.log(chalk.gray(`   Ends: ${endDate}`));
        market.outcomes.forEach((outcome, i) => {
            const prob = probs[i];
            const color = parseFloat(prob) > 50 ? chalk.green : chalk.red;
            console.log(`   ${outcome}: ${color(prob + '%')}`);
        });
        console.log(chalk.gray(`   Liquidity: ${market.liquidity.toLocaleString()} lamports`));
        console.log('');
    }
    console.log(chalk.gray(`Found ${markets.length} market(s)`));
});
