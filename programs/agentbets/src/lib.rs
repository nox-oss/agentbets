use anchor_lang::prelude::*;
use anchor_lang::system_program::{Transfer, transfer};

declare_id!("FtNvaXJs5ZUbxPPq91XayvM4MauZyPgxJRrV16fGfn6H");

// === CLOB Constants ===
pub const MAX_ORDERS: usize = 50;
pub const SHARE_PAYOUT: u64 = 10_000; // Lamports per share if wins
pub const BPS_MAX: u64 = 10_000;

#[program]
pub mod agentbets {
    use super::*;

    // ===========================================
    // PARIMUTUEL INSTRUCTIONS (existing markets)
    // ===========================================

    /// Create a new prediction market (parimutuel)
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

    /// Buy shares in an outcome (parimutuel)
    pub fn buy_shares(
        ctx: Context<BuyShares>,
        outcome_index: u8,
        amount: u64,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(!market.resolved, ErrorCode::MarketResolved);
        require!((outcome_index as usize) < market.outcomes.len(), ErrorCode::InvalidOutcome);
        
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: market.to_account_info(),
            },
        );
        anchor_lang::system_program::transfer(cpi_context, amount)?;

        let shares = amount;
        market.outcome_pools[outcome_index as usize] += shares;
        market.total_pool += amount;

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

    /// Resolve market with winning outcome (parimutuel)
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

    /// Claim winnings after resolution (parimutuel)
    pub fn claim_winnings(ctx: Context<ClaimWinnings>) -> Result<()> {
        let market = &ctx.accounts.market;
        let position = &mut ctx.accounts.position;
        
        require!(market.resolved, ErrorCode::MarketNotResolved);
        
        let winning_outcome = market.winning_outcome.unwrap() as usize;
        let winner_shares = position.shares[winning_outcome];
        require!(winner_shares > 0, ErrorCode::NoWinningShares);

        let total_winning_shares = market.outcome_pools[winning_outcome];
        let payout = (winner_shares as u128)
            .checked_mul(market.total_pool as u128)
            .unwrap()
            .checked_div(total_winning_shares as u128)
            .unwrap() as u64;

        let fee = payout / 50; // 2%
        let net_payout = payout - fee;

        position.shares[winning_outcome] = 0;

        **ctx.accounts.market.to_account_info().try_borrow_mut_lamports()? -= net_payout;
        **ctx.accounts.claimer.to_account_info().try_borrow_mut_lamports()? += net_payout;

        msg!("Claimed {} lamports (fee: {})", net_payout, fee);
        Ok(())
    }

    // ===========================================
    // CLOB INSTRUCTIONS (new order book markets)
    // ===========================================

    /// Create a CLOB market with order book
    pub fn create_clob_market(
        ctx: Context<CreateClobMarket>,
        market_id: String,
        question: String,
        resolution_time: i64,
    ) -> Result<()> {
        require!(market_id.len() <= 32, ClobError::MarketIdTooLong);
        require!(question.len() <= 256, ClobError::QuestionTooLong);
        
        let market = &mut ctx.accounts.market;
        market.authority = ctx.accounts.authority.key();
        market.market_id = market_id;
        market.question = question;
        market.resolution_time = resolution_time;
        market.resolved = false;
        market.winning_side = None;
        market.created_at = Clock::get()?.unix_timestamp;
        market.total_yes_volume = 0;
        market.total_no_volume = 0;
        market.bump = ctx.bumps.market;

        let order_book = &mut ctx.accounts.order_book;
        order_book.market = market.key();
        order_book.yes_bids = Vec::new();
        order_book.yes_asks = Vec::new();
        order_book.bump = ctx.bumps.order_book;

        // Fund the vault with minimum rent-exempt balance
        // Vault just holds lamports, doesn't need account data
        let rent = Rent::get()?;
        let vault_lamports = rent.minimum_balance(0);
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.authority.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        transfer(cpi_ctx, vault_lamports)?;

        msg!("CLOB Market created: {}", market.question);
        Ok(())
    }

    /// Place an order in the CLOB
    /// side: 0 = BID (buy), 1 = ASK (sell)
    /// is_yes: true = YES shares, false = NO shares
    /// price: basis points 0-10000 (0% to 100%)
    /// size: number of shares
    pub fn place_order(
        ctx: Context<PlaceOrder>,
        side: u8,
        is_yes: bool,
        price: u64,
        size: u64,
    ) -> Result<()> {
        require!(price > 0 && price < BPS_MAX, ClobError::InvalidPrice);
        require!(size > 0, ClobError::InvalidSize);
        
        let market = &ctx.accounts.market;
        require!(!market.resolved, ClobError::MarketResolved);
        
        let clock = Clock::get()?;
        require!(clock.unix_timestamp < market.resolution_time, ClobError::MarketExpired);
        
        // Convert to YES-denominated order
        let (effective_side, effective_price) = if is_yes {
            (side, price)
        } else {
            let flipped_side = if side == 0 { 1 } else { 0 };
            (flipped_side, BPS_MAX - price)
        };
        
        // Calculate required collateral
        let collateral_required = if effective_side == 0 {
            effective_price.checked_mul(size).ok_or(ClobError::Overflow)?
        } else {
            (BPS_MAX - effective_price).checked_mul(size).ok_or(ClobError::Overflow)?
        };
        
        // Transfer collateral from user to vault
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.trader.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        transfer(cpi_ctx, collateral_required)?;
        
        let order_book = &mut ctx.accounts.order_book;
        let position = &mut ctx.accounts.position;
        
        // Initialize position if needed
        if position.owner == Pubkey::default() {
            position.owner = ctx.accounts.trader.key();
            position.market = market.key();
            position.yes_shares = 0;
            position.no_shares = 0;
            position.bump = ctx.bumps.position;
        }
        
        let order_id = clock.unix_timestamp as u64;
        let mut remaining_size = size;
        
        if effective_side == 0 {
            // Buying YES: match against asks
            remaining_size = match_against_asks(
                order_book,
                position,
                effective_price,
                remaining_size,
            )?;
            
            if remaining_size > 0 {
                require!(order_book.yes_bids.len() < MAX_ORDERS, ClobError::OrderBookFull);
                
                let order = Order {
                    owner: ctx.accounts.trader.key(),
                    price: effective_price,
                    size: remaining_size,
                    timestamp: clock.unix_timestamp,
                    order_id,
                };
                
                let insert_idx = order_book.yes_bids
                    .iter()
                    .position(|o| o.price < effective_price)
                    .unwrap_or(order_book.yes_bids.len());
                order_book.yes_bids.insert(insert_idx, order);
                
                msg!("Resting BID: {} YES @ {} bps", remaining_size, effective_price);
            }
        } else {
            // Selling YES: match against bids
            remaining_size = match_against_bids(
                order_book,
                position,
                effective_price,
                remaining_size,
            )?;
            
            if remaining_size > 0 {
                require!(order_book.yes_asks.len() < MAX_ORDERS, ClobError::OrderBookFull);
                
                let order = Order {
                    owner: ctx.accounts.trader.key(),
                    price: effective_price,
                    size: remaining_size,
                    timestamp: clock.unix_timestamp,
                    order_id,
                };
                
                let insert_idx = order_book.yes_asks
                    .iter()
                    .position(|o| o.price > effective_price)
                    .unwrap_or(order_book.yes_asks.len());
                order_book.yes_asks.insert(insert_idx, order);
                
                msg!("Resting ASK: {} YES @ {} bps", remaining_size, effective_price);
            }
        }
        
        let filled = size - remaining_size;
        msg!("Order placed: {} shares, {} filled, {} resting", size, filled, remaining_size);
        Ok(())
    }

    /// Cancel an order
    pub fn cancel_order(
        ctx: Context<CancelOrder>,
        is_bid: bool,
        order_index: u8,
    ) -> Result<()> {
        let order_book = &mut ctx.accounts.order_book;
        let trader = ctx.accounts.trader.key();
        
        let orders = if is_bid {
            &mut order_book.yes_bids
        } else {
            &mut order_book.yes_asks
        };
        
        require!((order_index as usize) < orders.len(), ClobError::InvalidOrderIndex);
        
        let order = &orders[order_index as usize];
        require!(order.owner == trader, ClobError::NotOrderOwner);
        
        let refund = if is_bid {
            order.price.checked_mul(order.size).ok_or(ClobError::Overflow)?
        } else {
            (BPS_MAX - order.price).checked_mul(order.size).ok_or(ClobError::Overflow)?
        };
        
        orders.remove(order_index as usize);
        
        **ctx.accounts.vault.try_borrow_mut_lamports()? -= refund;
        **ctx.accounts.trader.try_borrow_mut_lamports()? += refund;
        
        msg!("Order cancelled, refunded {} lamports", refund);
        Ok(())
    }

    /// Resolve the CLOB market
    pub fn resolve_clob_market(
        ctx: Context<ResolveClobMarket>,
        winning_side: u8,
    ) -> Result<()> {
        require!(winning_side <= 1, ClobError::InvalidOutcome);
        
        let market = &mut ctx.accounts.market;
        require!(!market.resolved, ClobError::AlreadyResolved);
        require!(ctx.accounts.authority.key() == market.authority, ClobError::Unauthorized);
        
        market.resolved = true;
        market.winning_side = Some(winning_side);
        
        msg!("CLOB Market resolved: {} wins", if winning_side == 0 { "YES" } else { "NO" });
        Ok(())
    }

    /// Claim winnings from a CLOB market
    pub fn claim_clob_winnings(ctx: Context<ClaimClobWinnings>) -> Result<()> {
        let market = &ctx.accounts.market;
        require!(market.resolved, ClobError::NotResolved);
        
        let position = &mut ctx.accounts.position;
        let winning_side = market.winning_side.unwrap();
        
        let payout = if winning_side == 0 {
            position.yes_shares.checked_mul(SHARE_PAYOUT).ok_or(ClobError::Overflow)?
        } else {
            position.no_shares.checked_mul(SHARE_PAYOUT).ok_or(ClobError::Overflow)?
        };
        
        require!(payout > 0, ClobError::NoWinnings);
        
        position.yes_shares = 0;
        position.no_shares = 0;
        
        **ctx.accounts.vault.try_borrow_mut_lamports()? -= payout;
        **ctx.accounts.claimer.try_borrow_mut_lamports()? += payout;
        
        msg!("Claimed {} lamports", payout);
        Ok(())
    }
}

// === Matching Engine ===

fn match_against_asks(
    order_book: &mut OrderBook,
    position: &mut ClobPosition,
    max_price: u64,
    mut size: u64,
) -> Result<u64> {
    while size > 0 && !order_book.yes_asks.is_empty() {
        let best_ask = &order_book.yes_asks[0];
        
        if max_price < best_ask.price {
            break;
        }
        
        let fill_size = size.min(best_ask.size);
        let fill_price = best_ask.price;
        
        position.yes_shares = position.yes_shares
            .checked_add(fill_size)
            .ok_or(ClobError::Overflow)?;
        
        if fill_size == order_book.yes_asks[0].size {
            order_book.yes_asks.remove(0);
        } else {
            order_book.yes_asks[0].size -= fill_size;
        }
        
        size -= fill_size;
        msg!("Matched {} YES @ {} bps", fill_size, fill_price);
    }
    
    Ok(size)
}

fn match_against_bids(
    order_book: &mut OrderBook,
    position: &mut ClobPosition,
    min_price: u64,
    mut size: u64,
) -> Result<u64> {
    while size > 0 && !order_book.yes_bids.is_empty() {
        let best_bid = &order_book.yes_bids[0];
        
        if min_price > best_bid.price {
            break;
        }
        
        let fill_size = size.min(best_bid.size);
        let fill_price = best_bid.price;
        
        position.no_shares = position.no_shares
            .checked_add(fill_size)
            .ok_or(ClobError::Overflow)?;
        
        if fill_size == order_book.yes_bids[0].size {
            order_book.yes_bids.remove(0);
        } else {
            order_book.yes_bids[0].size -= fill_size;
        }
        
        size -= fill_size;
        msg!("Matched {} YES @ {} bps", fill_size, fill_price);
    }
    
    Ok(size)
}

// ===========================================
// PARIMUTUEL ACCOUNT STRUCTURES
// ===========================================

#[account]
pub struct Market {
    pub authority: Pubkey,
    pub market_id: String,
    pub question: String,
    pub outcomes: Vec<String>,
    pub outcome_pools: Vec<u64>,
    pub total_pool: u64,
    pub resolution_time: i64,
    pub resolved: bool,
    pub winning_outcome: Option<u8>,
    pub created_at: i64,
    pub bump: u8,
}

#[account]
pub struct Position {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub shares: Vec<u64>,
    pub bump: u8,
}

// ===========================================
// CLOB ACCOUNT STRUCTURES
// ===========================================

#[account]
#[derive(InitSpace)]
pub struct ClobMarket {
    pub authority: Pubkey,
    #[max_len(32)]
    pub market_id: String,
    #[max_len(256)]
    pub question: String,
    pub resolution_time: i64,
    pub resolved: bool,
    pub winning_side: Option<u8>,
    pub created_at: i64,
    pub total_yes_volume: u64,
    pub total_no_volume: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct OrderBook {
    pub market: Pubkey,
    #[max_len(50)]
    pub yes_bids: Vec<Order>,
    #[max_len(50)]
    pub yes_asks: Vec<Order>,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct Order {
    pub owner: Pubkey,
    pub price: u64,
    pub size: u64,
    pub timestamp: i64,
    pub order_id: u64,
}

#[account]
#[derive(InitSpace)]
pub struct ClobPosition {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub yes_shares: u64,
    pub no_shares: u64,
    pub bump: u8,
}

// ===========================================
// PARIMUTUEL CONTEXTS
// ===========================================

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
    
    #[account(mut)]
    pub claimer: Signer<'info>,
}

// ===========================================
// CLOB CONTEXTS
// ===========================================

#[derive(Accounts)]
#[instruction(market_id: String)]
pub struct CreateClobMarket<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + ClobMarket::INIT_SPACE,
        seeds = [b"clob_market", market_id.as_bytes()],
        bump
    )]
    pub market: Account<'info, ClobMarket>,
    
    #[account(
        init,
        payer = authority,
        space = 8 + OrderBook::INIT_SPACE,
        seeds = [b"order_book", market.key().as_ref()],
        bump
    )]
    pub order_book: Account<'info, OrderBook>,
    
    /// CHECK: Vault PDA - initialized here to hold collateral
    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump
    )]
    pub vault: AccountInfo<'info>,
    
    #[account(mut)]
    pub authority: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    #[account(mut)]
    pub market: Account<'info, ClobMarket>,
    
    #[account(
        mut,
        seeds = [b"order_book", market.key().as_ref()],
        bump = order_book.bump
    )]
    pub order_book: Account<'info, OrderBook>,
    
    /// CHECK: Vault PDA that holds collateral
    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump
    )]
    pub vault: AccountInfo<'info>,
    
    #[account(
        init_if_needed,
        payer = trader,
        space = 8 + ClobPosition::INIT_SPACE,
        seeds = [b"clob_position", market.key().as_ref(), trader.key().as_ref()],
        bump
    )]
    pub position: Account<'info, ClobPosition>,
    
    #[account(mut)]
    pub trader: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    pub market: Account<'info, ClobMarket>,
    
    #[account(
        mut,
        seeds = [b"order_book", market.key().as_ref()],
        bump = order_book.bump
    )]
    pub order_book: Account<'info, OrderBook>,
    
    /// CHECK: Vault PDA
    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump
    )]
    pub vault: AccountInfo<'info>,
    
    #[account(mut)]
    pub trader: Signer<'info>,
}

#[derive(Accounts)]
pub struct ResolveClobMarket<'info> {
    #[account(mut)]
    pub market: Account<'info, ClobMarket>,
    
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimClobWinnings<'info> {
    pub market: Account<'info, ClobMarket>,
    
    /// CHECK: Vault PDA
    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump
    )]
    pub vault: AccountInfo<'info>,
    
    #[account(
        mut,
        seeds = [b"clob_position", market.key().as_ref(), claimer.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == claimer.key()
    )]
    pub position: Account<'info, ClobPosition>,
    
    #[account(mut)]
    pub claimer: Signer<'info>,
}

// ===========================================
// ERRORS
// ===========================================

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

#[error_code]
pub enum ClobError {
    #[msg("Market ID too long (max 32 chars)")]
    MarketIdTooLong,
    #[msg("Question too long (max 256 chars)")]
    QuestionTooLong,
    #[msg("Invalid price (must be 1-9999 bps)")]
    InvalidPrice,
    #[msg("Invalid size (must be > 0)")]
    InvalidSize,
    #[msg("Market is resolved")]
    MarketResolved,
    #[msg("Market has expired")]
    MarketExpired,
    #[msg("Order book is full")]
    OrderBookFull,
    #[msg("Invalid order index")]
    InvalidOrderIndex,
    #[msg("Not the order owner")]
    NotOrderOwner,
    #[msg("Invalid outcome")]
    InvalidOutcome,
    #[msg("Market already resolved")]
    AlreadyResolved,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Market not resolved yet")]
    NotResolved,
    #[msg("No winnings to claim")]
    NoWinnings,
    #[msg("Arithmetic overflow")]
    Overflow,
}
