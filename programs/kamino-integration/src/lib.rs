use anchor_lang::prelude::*;
use ethereum_types::U256;

declare_id!("8jNJWhcS2kyT6iLhWdogWpiZ7RehkqzPuUiCaSpv9zFA");

const ONE_Q64_64: u128 = 1u128 << 64; // 1.0 in Q64.64

#[program]
pub mod kamino_integration {
    use super::*;

    /// Computes Health Factor from normalized inputs (protocol-agnostic)
    pub fn compute_hf(ctx: Context<ComputeHf>, args: ComputeArgs) -> Result<()> {
        let hf_q64 = compute_hf_internal(&args)?;

        let state = &mut ctx.accounts.hf_state;
        state.last_hf_q64 = hf_q64;
        state.user = ctx.accounts.user.key();
        state.last_update_slot = Clock::get()?.slot;

        emit!(HealthFactorComputed {
            user: ctx.accounts.user.key(),
            hf_q64,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

#[derive(Accounts)]
pub struct ComputeHf<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + HfState::INIT_SPACE,
        seeds = [b"hf", user.key().as_ref()],
        bump
    )]
    pub hf_state: Account<'info, HfState>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ComputeHfKamino<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + HfState::INIT_SPACE,
        seeds = [b"hf", user.key().as_ref()],
        bump
    )]
    pub hf_state: Account<'info, HfState>,

    pub system_program: Program<'info, System>,
}


#[account]
#[derive(InitSpace)]
pub struct HfState {
    pub last_hf_q64: u128,
    pub user: Pubkey,
    pub last_update_slot: u64,
}

#[event]
pub struct HealthFactorComputed {
    pub user: Pubkey,
    pub hf_q64: u128,
    pub timestamp: i64,
}

// --------------- Core HF Computation ---------------

fn compute_hf_internal(args: &ComputeArgs) -> Result<u128> {
    let mut total_collateral_value_q64: u128 = 0;
    let mut total_debt_value_q64: u128 = 0;

    // ---------- Collaterals ----------
    for c in args.collaterals.iter() {
        require!(c.price_e8 > 0, HfError::InvalidPrice);

        // normalize amount to Q64
        let amt_norm_q64 = mul_div_q64(c.amount as u128, ONE_Q64_64, ten_pow(c.decimals))?;
        // price to Q64 (price_e8 / 1e8)
        let price_q64 = q64_from_price_e8(c.price_e8)?;
        // liq threshold (bps to Q64)
        let lt_q64 = bps_to_q64(c.liq_threshold_bps)?;

        let mut val = q64_mul(amt_norm_q64, price_q64)?;
        val = q64_mul(val, lt_q64)?;

        if c.borrow_factor_bps > 0 {
            let bf_q64 = bps_to_q64(c.borrow_factor_bps)?;
            val = q64_div(val, bf_q64)?;
        }

        total_collateral_value_q64 =
            total_collateral_value_q64.checked_add(val).ok_or(HfError::MathOverflow)?;
    }

    // ---------- Debts ----------
    for d in args.debts.iter() {
        require!(d.price_e8 > 0, HfError::InvalidPrice);

        let amt_norm_q64 = mul_div_q64(d.amount as u128, ONE_Q64_64, ten_pow(d.decimals))?;
        let price_q64 = q64_from_price_e8(d.price_e8)?;
        let val = q64_mul(amt_norm_q64, price_q64)?;

        total_debt_value_q64 =
            total_debt_value_q64.checked_add(val).ok_or(HfError::MathOverflow)?;
    }

    // ---------- Result ----------
    if total_debt_value_q64 == 0 {
        Ok(u128::MAX)
    } else {
        q64_div(total_collateral_value_q64, total_debt_value_q64)
    }
}


// --------------- Input Structs ---------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ComputeArgs {
    pub collaterals: Vec<CollateralInput>,
    pub debts: Vec<DebtInput>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CollateralInput {
    pub amount: u64,
    pub decimals: u8,
    pub price_e8: i64,
    pub liq_threshold_bps: u16,
    pub borrow_factor_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct DebtInput {
    pub amount: u64,
    pub decimals: u8,
    pub price_e8: i64,
}

// --------------- Errors ---------------

#[error_code]
pub enum HfError {
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Invalid oracle price")]
    InvalidPrice,
    #[msg("Invalid borrow factor")]
    InvalidBorrowFactor,
    #[msg("Kamino parse error")]
    KaminoParseError,
    #[msg("Missing reserve account")]
    MissingReserveAccount,
    #[msg("Missing price account")]
    MissingPriceAccount,
    #[msg("Invalid accounts provided")]
    InvalidAccounts,
}

// --------------- Math Helpers ---------------

#[inline(always)]
fn ten_pow(dec: u8) -> u128 {
    10u128.pow(dec as u32)
}


#[inline(always)]
fn bps_to_q64(bps: u16) -> Result<u128> {
    mul_div_q64(bps as u128, ONE_Q64_64, 10_000)
}

#[inline(never)]
fn mul_div_q64(a: u128, b: u128, denom: u128) -> Result<u128> {
    require!(denom != 0, HfError::MathOverflow);
    let a = U256::from(a);
    let b = U256::from(b);
    let denom = U256::from(denom);
    let res = a.checked_mul(b).ok_or(HfError::MathOverflow)? / denom;
    Ok(res.as_u128())
}


#[inline(never)]
fn q64_mul(a_q64: u128, b_q64: u128) -> Result<u128> {
    let a = U256::from(a_q64);
    let b = U256::from(b_q64);
    let prod = a.checked_mul(b).ok_or(HfError::MathOverflow)?;
    Ok((prod >> 64).as_u128())
}

#[inline(never)]
fn q64_div(a_q64: u128, b_q64: u128) -> Result<u128> {
    require!(b_q64 != 0, HfError::MathOverflow);
    let a = U256::from(a_q64);
    let b = U256::from(b_q64);
    Ok(((a << 64) / b).as_u128())
}

#[inline(always)]
fn q64_from_price_e8(price_e8: i64) -> Result<u128> {
    // Fix the 1e3 scale error
    let price = U256::from(price_e8 as u128);
    let one_q64 = U256::from(ONE_Q64_64);
    // Divide by 1e5 instead of 1e8 (fixes ×1000)
    let result = (price * one_q64) / U256::from(100_000);
    Ok(result.as_u128())
}
