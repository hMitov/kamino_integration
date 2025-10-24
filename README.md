# Kamino Finance Integration

A Solana Anchor program that integrates with Kamino Finance for lending operations, featuring flash-assist deposits, health factor computation, and automated liquidation capabilities.

## Features

- **Flash-Assist Deposits**: Automatically borrow missing SOL via flash loans to complete deposits
- **Health Factor Computation**: Real-time calculation of user position health using Q64.64 fixed-point arithmetic
- **Automated Liquidation**: Liquidate undercollateralized positions when health factor drops below threshold
- **Kamino SDK Integration**: Full integration with Kamino Finance lending markets

## Project Structure

```
├── programs/kamino-integration/src/lib.rs    # Anchor program with HF computation
├── tests/
│   ├── kamino-integration.ts                # Main integration tests
│   ├── kamino-sdk-operations.ts/
│   │   └── kamino_operations.ts            # Kamino SDK operation helpers
│   ├── utils/
│   │   └── kamino-utils.ts                 # Utility functions and helpers
│   └── types/
│       └── kamino-types.ts                 # TypeScript type definitions
└── README.md
```

## Setup

### Prerequisites

- Node.js 18+
- Rust 1.70+
- Solana CLI 1.16+
- Anchor Framework

### Installation of Surpool
```bash
# macOS (Homebrew)
brew install txtx/taps/surfpool

# Linux (Snap Store)
snap install surfpool

# Clone the repository
git clone https://github.com/hMitov/kamino_integration.git
cd kamino-integration

# Install dependencies
npm install

# Build the program
anchor build
```

### How to run and test the program

#### Complete Setup and Test Workflow
```bash
# 1. Install dependencies
yarn install

# 2. Sync Anchor keys - there is a possibility of missmatch between program id in the lib.rs and Anchor.toml. This command will fix it.
anchor keys sync

# 3. Start Surfpool with watch mode
surfpool start --watch

# 4. Build the program
anchor build

# 5. Run tests
anchor test
```

#### Run Specific Tests
```bash
# Run tests on Surfnet
anchor test

# Or run specific test files
yarn test tests/kamino-integration.test.ts
```

### Surfpool Features Used

- **Surfnet**: Local validator with mainnet fork for realistic testing
- **Runbooks**: Infrastructure as code for deployments
- **Surfpool Studio**: Web UI for transaction introspection

## Architecture

### Core Components

#### 1. Health Factor Computation (`lib.rs`)

The Anchor program provides a `compute_hf` instruction that calculates user health factors using Q64.64 fixed-point arithmetic:

```rust
pub fn compute_hf(ctx: Context<ComputeHf>, args: ComputeArgs) -> Result<()>
```

**Formula**: `HF = (Σ collateral_i * price_i * liq_threshold_i) / (Σ debt_j * price_j)`

#### 2. Automated Liquidation

When health factor drops below 1.0, the system automatically liquidates positions:

```typescript
if (hfDecimal < HEALTH_FACTOR_THRESHOLD) {
  await executeKaminoLiquidation(/* liquidation parameters */);
}
```

## Usage

### Basic Integration Test

```typescript
describe("kamino_integration with deposit and withdraw", () => {
  before(async () => {
    // Setup: Deposit SOL and borrow USDC
    await executeKaminoDeposit(depositAmount, loadedMarket, solReserve, signer, rpc, ws);
    await executeKaminoBorrow(borrowAmount, loadedMarket, usdcReserve, signer, rpc, ws, refreshInstructions);
  });

  it("computes HF using live Kamino account", async () => {
    // Compute health factor using on-chain data
    const hfDecimal = convertHfQ64ToDecimal(hfState);
    
    // Auto-liquidate if HF < 1.0
    if (hfDecimal < HEALTH_FACTOR_THRESHOLD) {
      await executeKaminoLiquidation(/* ... */);
    }
  });
});
```

## Health Factor Computation

The health factor is computed using high-precision Q64.64 fixed-point arithmetic:

### Input Parameters

- **Collaterals**: Amount, decimals, price, liquidation threshold, borrow factor
- **Debts**: Amount, decimals, price

### Mathematical Operations

```rust
// Convert amounts to Q64.64 precision
let amt_norm_q64 = mul_div_q64(amount, ONE_Q64_64, ten_pow(decimals))?;

// Apply liquidation threshold
let val = q64_mul(amt_norm_q64, price_q64)?;
val = q64_mul(val, lt_q64)?;

// Apply borrow factor if present
if borrow_factor_bps > 0 {
    val = q64_div(val, bf_q64)?;
}
```

## Flash Loan Integration

### Flash-Assist Deposit Flow

1. **Balance Check**: Compare wallet balance vs target deposit
2. **Shortfall Calculation**: Compute missing amount
3. **Flash Loan**: Borrow shortfall from Kamino
4. **Deposit**: Deposit full target amount (wallet + borrowed)
5. **Repay**: Repay flash loan + fee atomically

## Testing

### Running Tests

```bash
# Run all tests
anchor test

# Run specific test
anchor test -- --grep "computes HF using live Kamino account"
```
### Test Scenarios

1. **Normal Deposit**: Sufficient wallet balance
2. **Flash-Assist Deposit**: Insufficient balance, requires flash loan
3. **Health Factor Computation**: Real-time HF calculation with live market data
4. **Liquidation**: Auto-liquidation when HF < 1.0
5. **Market Conditions**: Test with real price volatility and reserve states

## Key Utilities

### `kamino-utils.ts`

- **`loadReserveData`**: Load market and reserve data
- **`sendAndConfirmTx`**: Transaction building and confirmation
- **`convertHfQ64ToDecimal`**: Convert Q64.64 HF to decimal
- **`extractAssetFromObligation`**: Extract asset metadata from obligations

### `kamino_operations.ts`

- **`executeKaminoDeposit`**: Standard deposit operations
- **`executeKaminoBorrow`**: Borrow operations
- **`executeKaminoLiquidation`**: Liquidation operations
- **`executeKaminoFlashAssistDeposit`**: Flash-assist deposit operations

## Configuration

### Market Addresses

```typescript
const MAIN_MARKET_ADDRESS = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
const SOL_MINT_ADDRESS = "So11111111111111111111111111111111111111112";
const USDC_MINT_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
```

### Health Factor Threshold

```typescript
const HEALTH_FACTOR_THRESHOLD = 1.0;
```

## Error Handling

The integration includes comprehensive error handling:

- **Math Overflow Protection**: U256 arithmetic for large numbers
- **Input Validation**: Price, decimals, and threshold validation
- **Transaction Failure Recovery**: Detailed error logging and retry logic
- **Market State Validation**: Reserve and market data validation

## API Reference

### Anchor Program Instructions

- `compute_hf`: Compute user health factor
- `ComputeArgs`: Input parameters for HF computation
- `HfState`: On-chain storage for HF state

### Kamino SDK Operations

- `KaminoAction.buildDepositTxns`: Build deposit transactions
- `KaminoAction.buildBorrowTxns`: Build borrow transactions
- `KaminoAction.buildLiquidateTxns`: Build liquidation transactions
- `getFlashLoanInstructions`: Build flash loan instructions

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Submit a pull request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Links

- [Kamino Finance Documentation](https://docs.kamino.finance/)
- [Solana Anchor Framework](https://www.anchor-lang.com/)
- [Kamino SDK](https://github.com/Kamino-Finance/klend-sdk)
- [SuRpool Documentation](https://docs.surpool.com/) - Mainnet forking service
- [SuRpool API](https://api.surpool.com) - Fork mainnet for testing
