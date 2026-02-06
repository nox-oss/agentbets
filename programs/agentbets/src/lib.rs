use anchor_lang::prelude::*;

declare_id!("G59nkJ7khC1aKMr6eaRX1SssfeUuP7Ln8BpDj7ELkkcu");

#[program]
pub mod agentbets {
    use super::*;

    /// Create a new prediction market
    pub fn create_market(
        ctx: Context<CreateMarket>,
        market_id: String,
        question: String,
        outcomes: Vec<String>,
        resolution_time: i64,
    ) -> Result<()> {
        require!(outcomes.len() >= 2 && outcomes.len() <= 10, ErrorCode::InvalidOutcomeCount);
        require!(market_id.len() <= 32, ErrorCode::MarketIdTooLong);
        require!(question.len() <= 256, ErrorCode::QuestionTooLong);
        
        let market = &mut ctx.accounts.market;
        market.authority = ctx.accounts.authority.key();
        market.market_id = market_id;
        market.question = question;
        market.outcomes = outcomes.clone();
        market.outcome_pools = vec![0u64; outcomes.len()];
        market.total_pool = 0;
        market.resolution_time = resolution_time;
        market.resolved = false;
        market.winning_outcome = None;
        market.created_at = Clock::get()?.unix_timestamp;
        market.bump = ctx.bumps.market;

        msg!("Market created: {}", market.question);
        Ok(())
    }

    /// Buy shares in an outcome (AMM-based)
    pub fn buy_shares(
        ctx: Context<BuyShares>,
        outcome_index: u8,
        amount: u64,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(!market.resolved, ErrorCode::MarketResolved);
        require!((outcome_index as usize) < market.outcomes.len(), ErrorCode::InvalidOutcome);
        
        // Transfer SOL from buyer to market vault
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        anchor_lang::system_program::transfer(cpi_context, amount)?;

        // Calculate shares using constant product AMM
        // For simplicity in MVP: 1 SOL = 1 share (will improve with proper AMM)
        let shares = amount;
        
        // Update market pools
        market.outcome_pools[outcome_index as usize] += shares;
        market.total_pool += amount;

        // Update or create position
        let position = &mut ctx.accounts.position;
        if position.shares.is_empty() {
            position.owner = ctx.accounts.buyer.key();
            position.market = market.key();
            position.shares = vec![0u64; market.outcomes.len()];
            position.bump = ctx.bumps.position;
        }
        position.shares[outcome_index as usize] += shares;

        msg!("Bought {} shares of outcome {}", shares, outcome_index);
        Ok(())
    }

    /// Resolve market with winning outcome
    pub fn resolve_market(
        ctx: Context<ResolveMarket>,
        winning_outcome: u8,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(!market.resolved, ErrorCode::MarketAlreadyResolved);
        require!(ctx.accounts.authority.key() == market.authority, ErrorCode::Unauthorized);
        require!((winning_outcome as usize) < market.outcomes.len(), ErrorCode::InvalidOutcome);

        market.resolved = true;
        market.winning_outcome = Some(winning_outcome);

        msg!("Market resolved: outcome {} wins", winning_outcome);
        Ok(())
    }

    /// Claim winnings after resolution
    pub fn claim_winnings(ctx: Context<ClaimWinnings>) -> Result<()> {
        let market = &ctx.accounts.market;
        let position = &ctx.accounts.position;
        
        require!(market.resolved, ErrorCode::MarketNotResolved);
        
        let winning_outcome = market.winning_outcome.unwrap() as usize;
        let winner_shares = position.shares[winning_outcome];
        require!(winner_shares > 0, ErrorCode::NoWinningShares);

        // Calculate payout: winner_shares / total_winning_shares * total_pool
        let total_winning_shares = market.outcome_pools[winning_outcome];
        let payout = (winner_shares as u128)
            .checked_mul(market.total_pool as u128)
            .unwrap()
            .checked_div(total_winning_shares as u128)
            .unwrap() as u64;

        // Apply 2% fee
        let fee = payout / 50; // 2%
        let net_payout = payout - fee;

        // Transfer from vault to winner
        **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= net_payout;
        **ctx.accounts.claimer.to_account_info().try_borrow_mut_lamports()? += net_payout;

        msg!("Claimed {} lamports (fee: {})", net_payout, fee);
        Ok(())
    }
}

// === Account Structures ===

#[account]
pub struct Market {
    pub authority: Pubkey,           // Oracle/resolver
    pub market_id: String,           // Unique identifier
    pub question: String,            // "Who wins the hackathon?"
    pub outcomes: Vec<String>,       // ["ProjectA", "ProjectB", ...]
    pub outcome_pools: Vec<u64>,     // Shares per outcome
    pub total_pool: u64,             // Total SOL in market
    pub resolution_time: i64,        // Unix timestamp
    pub resolved: bool,
    pub winning_outcome: Option<u8>,
    pub created_at: i64,
    pub bump: u8,
}

#[account]
pub struct Position {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub shares: Vec<u64>,  // Shares per outcome
    pub bump: u8,
}

// === Contexts ===

#[derive(Accounts)]
#[instruction(market_id: String)]
pub struct CreateMarket<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + 32 + 36 + 260 + 4 + 10*36 + 4 + 10*8 + 8 + 8 + 1 + 2 + 8 + 1,
        seeds = [b"market", market_id.as_bytes()],
        bump
    )]
    pub market: Account<'info, Market>,
    
    #[account(mut)]
    pub authority: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuyShares<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
    
    #[account(
        init_if_needed,
        payer = buyer,
        space = 8 + 32 + 32 + 4 + 10*8 + 1,
        seeds = [b"position", market.key().as_ref(), buyer.key().as_ref()],
        bump
    )]
    pub position: Account<'info, Position>,
    
    /// CHECK: Vault PDA for holding market funds
    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump
    )]
    pub vault: UncheckedAccount<'info>,
    
    #[account(mut)]
    pub buyer: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResolveMarket<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
    
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimWinnings<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
    
    #[account(
        mut,
        seeds = [b"position", market.key().as_ref(), claimer.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == claimer.key()
    )]
    pub position: Account<'info, Position>,
    
    /// CHECK: Vault PDA
    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump
    )]
    pub vault: UncheckedAccount<'info>,
    
    #[account(mut)]
    pub claimer: Signer<'info>,
}

// === Errors ===

#[error_code]
pub enum ErrorCode {
    #[msg("Market must have 2-10 outcomes")]
    InvalidOutcomeCount,
    #[msg("Market ID too long (max 32 chars)")]
    MarketIdTooLong,
    #[msg("Question too long (max 256 chars)")]
    QuestionTooLong,
    #[msg("Invalid outcome index")]
    InvalidOutcome,
    #[msg("Market already resolved")]
    MarketAlreadyResolved,
    #[msg("Market not yet resolved")]
    MarketNotResolved,
    #[msg("Market is resolved, no more trading")]
    MarketResolved,
    #[msg("No winning shares to claim")]
    NoWinningShares,
    #[msg("Unauthorized")]
    Unauthorized,
}
