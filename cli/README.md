# AgentBets CLI

Command-line interface for AgentBets prediction markets on Solana.

## Installation

```bash
npm install
npm run build
```

## Usage

```bash
# List all markets
agentbets markets
agentbets markets --json

# View market details
agentbets market <market-id>

# Buy shares
agentbets buy <market-id> <outcome> <amount>
agentbets buy <market-id> Yes 100 --dry-run

# Sell shares
agentbets sell <market-id> <outcome> <amount>
agentbets sell <market-id> 0 50 --slippage 2

# View your positions
agentbets positions
agentbets positions --json

# Create a new market (oracle only)
agentbets create \
  --question "Will SOL reach $500 by end of 2026?" \
  --outcomes "Yes,No" \
  --end-time "2026-12-31" \
  --liquidity 10000000
```

## Development

```bash
# Run in development mode
npm run dev -- markets

# Build
npm run build

# Run built version
npm start -- markets
```

## Commands

| Command | Description |
|---------|-------------|
| `markets` | List all active prediction markets |
| `market <id>` | Show details for a specific market |
| `buy <market-id> <outcome> <amount>` | Buy shares in a market outcome |
| `sell <market-id> <outcome> <amount>` | Sell shares in a market outcome |
| `positions` | Show your positions across all markets |
| `create` | Create a new prediction market (oracle only) |

## Options

### Global Options
- `-V, --version` - Output version number
- `-h, --help` - Display help

### markets
- `-a, --all` - Include resolved markets
- `--json` - Output as JSON

### market
- `--json` - Output as JSON

### buy / sell
- `--dry-run` - Simulate transaction without executing
- `--slippage <percent>` - Maximum slippage tolerance (default: 1%)

### create
- `-q, --question <question>` - Market question (required)
- `-o, --outcomes <outcomes>` - Comma-separated outcomes (required)
- `-e, --end-time <datetime>` - Market end time in ISO 8601 format (required)
- `-l, --liquidity <amount>` - Initial liquidity in lamports (default: 10000000)
- `--dry-run` - Simulate transaction without executing

## Architecture

```
src/
├── index.ts          # CLI entry point
├── client.ts         # AgentBets client (Solana integration)
├── types.ts          # TypeScript types
└── commands/
    ├── markets.ts    # List markets
    ├── market.ts     # Market details
    ├── buy.ts        # Buy shares
    ├── sell.ts       # Sell shares
    ├── positions.ts  # User positions
    └── create.ts     # Create market
```

## TODO

- [ ] Integrate with deployed Anchor program
- [ ] Add wallet configuration
- [ ] Implement LMSR price calculation
- [ ] Add transaction confirmation tracking
- [ ] Add market resolution command
- [ ] Add claim winnings command
