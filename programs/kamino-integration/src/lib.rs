use anchor_lang::prelude::*;
use ethereum_types::U256;

declare_id!("8jNJWhcS2kyT6iLhWdogWpiZ7RehkqzPuUiCaSpv9zFA");

const ONE_Q64_64: u128 = 1u128 << 64; // 1.0 in Q64.64

#[program]
pub mod kamino_integration {
    use super::*;

    /* Computes a user’s Health Factor (HF) = total collateral / total debt.
    - Collaterals are weighted by liquidation thresholds and borrow factors.
    - HF < 1.0 indicates risk of liquidation. */
    pub fn compute_hf(ctx: Context<ComputeHf>, args: ComputeArgs) -> Result<()> {
        let hf_q64 = compute_hf_internal(&args)?;

        let state: &mut Account<'_, HfState> = &mut ctx.accounts.hf_state;
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

/* Context for computing and storing a user’s HF. */
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

/* Account for storing a user’s HF state. */
#[account]
#[derive(InitSpace)]
pub struct HfState {
    pub last_hf_q64: u128,
    pub user: Pubkey,
    pub last_update_slot: u64,
}

/* Input arguments for computing HF. */
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ComputeArgs {
    pub collaterals: Vec<CollateralInput>,
    pub debts: Vec<DebtInput>,
}

/* Input arguments for collateral. */
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CollateralInput {
    pub amount: u64,
    pub decimals: u8,
    pub price_e8: i64,
    pub liq_threshold_bps: u16,
    pub borrow_factor_bps: u16,
}

/* Input arguments for debt. */
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct DebtInput {
    pub amount: u64,
    pub decimals: u8,
    pub price_e8: i64,
}

/* Computes the Health Factor (HF) for a given set of collateral and debt assets. */
///
/// ### Formula
/// HF = (Σ (collateral_i * price_i * liq_threshold_i / borrow_factor_i))
///       / (Σ (debt_j * price_j))
///
/// ### How It Works
/// - Converts all token amounts to **Q64.64 fixed-point precision**.
/// - Collateral values are adjusted by their liquidation thresholds and optional borrow factors.
/// - Debt values are normalized by token decimals and multiplied by oracle price.
/// - Uses `mul_div_q64`, `q64_mul`, and `q64_div` to safely perform high-precision arithmetic.
/// - Returns:
///   - `u128::MAX` if total debt = 0 (infinite HF),
///   - Otherwise `(total_collateral / total_debt)` as a Q64.64 number.
fn compute_hf_internal(args: &ComputeArgs) -> Result<u128> {
    let mut total_collateral_value_q64: u128 = 0;
    let mut total_debt_value_q64: u128 = 0;

    // ---------- Collaterals ----------
    for c in args.collaterals.iter() {
        require!(c.price_e8 > 0, HfError::InvalidPrice);
        require!(c.decimals <= 18, HfError::InvalidDecimals);
        require!(c.liq_threshold_bps <= 10_000, HfError::InvalidLiqThreshold);
        require!(
            c.borrow_factor_bps == 0 || 
            (c.borrow_factor_bps >= 1_000 && c.borrow_factor_bps <= 10_000),
            HfError::InvalidBorrowFactor
        );
        // normalize amount to Q64
        let amt_norm_q64 = mul_div_q64(c.amount as u128, ONE_Q64_64, ten_pow(c.decimals))?;
        // price to Q64 (price_e8 / 1e8)
        let price_q64 = q64_from_price_e8(c.price_e8)?;
        // liq threshold (bps to Q64)
        let lt_q64 = bps_to_q64(c.liq_threshold_bps)?;

        // Base collateral value = amount * price * liq_threshold
        let mut val = q64_mul(amt_norm_q64, price_q64)?;
        val = q64_mul(val, lt_q64)?;

        // Apply borrow factor if present (higher = lower effective collateral)
        if c.borrow_factor_bps > 0 {
            let bf_q64 = bps_to_q64(c.borrow_factor_bps)?;
            val = q64_div(val, bf_q64)?;
        }

        // Sum collateral values
        total_collateral_value_q64 = total_collateral_value_q64
            .checked_add(val)
            .ok_or(HfError::MathOverflow)?;
    }

    // ---------- Debts ----------
    for d in args.debts.iter() {
        require!(d.price_e8 > 0, HfError::InvalidPrice);
        require!(d.decimals <= 18, HfError::InvalidDecimals);

        // normalize amount to Q64
        let amt_norm_q64 = mul_div_q64(d.amount as u128, ONE_Q64_64, ten_pow(d.decimals))?;
        // price to Q64 (price_e8 / 1e8)
        let price_q64 = q64_from_price_e8(d.price_e8)?;
        // debt value = amount * price
        let val = q64_mul(amt_norm_q64, price_q64)?;

        // Sum debt values
        total_debt_value_q64 = total_debt_value_q64
            .checked_add(val)
            .ok_or(HfError::MathOverflow)?;
    }

    // ---- Final HF result ----
    if total_debt_value_q64 == 0 {
        Ok(u128::MAX)
    } else {
        q64_div(total_collateral_value_q64, total_debt_value_q64)
    }
}

// --------------- Math Helpers ---------------

/* Calculates 10^dec. */
#[inline(always)]
fn ten_pow(dec: u8) -> u128 {
    10u128.pow(dec as u32)
}

/* Converts basis points (bps) to Q64.64 fixed-point precision. */
#[inline(always)]
fn bps_to_q64(bps: u16) -> Result<u128> {
    mul_div_q64(bps as u128, ONE_Q64_64, 10_000)
}

/* Multiplies two Q64.64 numbers and divides by a third Q64.64 number. */
#[inline(never)]
fn mul_div_q64(a: u128, b: u128, denom: u128) -> Result<u128> {
    require!(denom != 0, HfError::MathOverflow);
    let a = U256::from(a);
    let b = U256::from(b);
    let denom = U256::from(denom);
    let res = a.checked_mul(b).ok_or(HfError::MathOverflow)? / denom;

    Ok(res.as_u128())
}

/* Multiplies two Q64.64 numbers. */
#[inline(never)]
fn q64_mul(a_q64: u128, b_q64: u128) -> Result<u128> {
    let a = U256::from(a_q64);
    let b = U256::from(b_q64);
    let prod = a.checked_mul(b).ok_or(HfError::MathOverflow)?;

    Ok((prod >> 64).as_u128())
}

/* Divides two Q64.64 numbers. */
#[inline(never)]
fn q64_div(a_q64: u128, b_q64: u128) -> Result<u128> {
    require!(b_q64 != 0, HfError::MathOverflow);
    let a = U256::from(a_q64);
    let b = U256::from(b_q64);

    Ok(((a << 64) / b).as_u128())
}

/* Converts a price from e8 format to Q64.64 fixed-point precision. */
#[inline(always)]
fn q64_from_price_e8(price_e8: i64) -> Result<u128> {
    let price = U256::from(price_e8 as u128);
    let one_q64 = U256::from(ONE_Q64_64);
    let result = (price * one_q64) / U256::from(100_000);

    Ok(result.as_u128())
}

// --------------- Errors ---------------

#[error_code]
pub enum HfError {
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Invalid oracle price")]
    InvalidPrice,
    #[msg("Invalid decimals")]
    InvalidDecimals,
    #[msg("Invalid liquidation threshold")]
    InvalidLiqThreshold,
    #[msg("Invalid borrow factor")]
    InvalidBorrowFactor
}

// --------------- Events ---------------

/* Event for when a user’s HF is computed. */
#[event]
pub struct HealthFactorComputed {
    pub user: Pubkey,
    pub hf_q64: u128,
    pub timestamp: i64,
}