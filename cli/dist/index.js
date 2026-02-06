#!/usr/bin/env node
import { Command } from 'commander';
import { marketsCommand } from './commands/markets.js';
import { marketCommand } from './commands/market.js';
import { buyCommand } from './commands/buy.js';
import { sellCommand } from './commands/sell.js';
import { positionsCommand } from './commands/positions.js';
import { createCommand } from './commands/create.js';
const program = new Command();
program
    .name('agentbets')
    .description('CLI for AgentBets prediction markets on Solana')
    .version('0.1.0');
// Register all commands
program.addCommand(marketsCommand);
program.addCommand(marketCommand);
program.addCommand(buyCommand);
program.addCommand(sellCommand);
program.addCommand(positionsCommand);
program.addCommand(createCommand);
program.parse();
