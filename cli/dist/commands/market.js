import { Command } from 'commander';
import chalk from 'chalk';
import { getClient } from '../client.js';
export const marketCommand = new Command('market')
    .description('Show details for a specific market')
    .argument('<id>', 'Market public key')
    .option('--json', 'Output as JSON')
    .action(async (id, options) => {
    console.log(chalk.blue(`📊 Fetching market ${id.slice(0, 8)}...\n`));
    const client = getClient();
    const market = await client.getMarket(id);
    if (!market) {
        console.log(chalk.red(`Market not found: ${id}`));
        process.exit(1);
    }
    if (options.json) {
        console.log(JSON.stringify(market, null, 2));
        return;
    }
    const endDate = new Date(market.endTime);
    const totalVolume = market.totalShares.reduce((a, b) => a + b, 0);
    const probs = market.totalShares.map(s => totalVolume > 0 ? ((s / totalVolume) * 100).toFixed(1) : '50.0');
    console.log(chalk.bold.white(`📌 ${market.question}\n`));
    console.log(chalk.gray('Details:'));
    console.log(`  ID:        ${chalk.cyan(market.publicKey.toBase58())}`);
    console.log(`  Authority: ${chalk.cyan(market.authority.toBase58().slice(0, 8))}...`);
    console.log(`  Oracle:    ${chalk.cyan(market.oracle.toBase58().slice(0, 8))}...`);
    console.log(`  End Time:  ${endDate.toLocaleString()}`);
    console.log(`  Status:    ${market.resolved ? chalk.yellow('Resolved') : chalk.green('Active')}`);
    if (market.resolved && market.winningOutcome !== null) {
        console.log(`  Winner:    ${chalk.green(market.outcomes[market.winningOutcome])}`);
    }
    console.log('');
    console.log(chalk.gray('Outcomes:'));
    market.outcomes.forEach((outcome, i) => {
        const prob = probs[i];
        const shares = market.totalShares[i];
        const color = parseFloat(prob) > 50 ? chalk.green : chalk.red;
        console.log(`  [${i}] ${outcome}`);
        console.log(`      Probability: ${color(prob + '%')}`);
        console.log(`      Total Shares: ${shares.toLocaleString()}`);
    });
    console.log('');
    console.log(chalk.gray('Liquidity:'));
    console.log(`  Pool:   ${market.liquidity.toLocaleString()} lamports`);
    console.log(`  Volume: ${totalVolume.toLocaleString()} shares`);
});
