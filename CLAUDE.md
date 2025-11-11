# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**VeChain Stargate** is a staking platform where users stake VET tokens, delegate to validators, and earn rewards for each block produced by their chosen validator. Staking positions are represented by NFTs (StargateNFT), which must mature before delegation is possible. This is a **security audit repository** containing smart contract audits with findings, prior knowledge base, and accounting model documentation.

## Repository Context

This is a **monorepo using Turborepo** with three main areas:
1. **Smart Contracts** (`packages/contracts/`) - The audited Solidity contracts
2. **Frontend** (`apps/frontend/`) - React/Vite application for interacting with contracts
3. **Audit Documentation** (`finds/`, `acc_modeling/`, `pk.md`) - Security audit findings and analysis

## Key Commands

### Smart Contract Development

```bash
# Compile contracts
yarn contracts:compile

# Run unit tests (Hardhat network)
yarn contracts:test:unit
yarn contracts:test:unit:verbose          # With logs
yarn contracts:test:unit:coverage         # With coverage report

# Run integration tests (Thor Solo network)
yarn contracts:test:integration
yarn contracts:test:integration:verbose   # With logs

# Deploy contracts
yarn contracts:deploy:solo                # Local thor-solo
yarn contracts:deploy:testnet             # VeChain testnet
yarn contracts:deploy:mainnet             # VeChain mainnet

# Generate documentation
yarn contracts:generate-docs

# Verify contracts on Sourcify
yarn contracts:verify:testnet <contract-address> <contract-name>
yarn contracts:verify:mainnet <contract-address> <contract-name>
```

### Local Development Environment

```bash
# Setup
nvm use                                   # Align Node.js version
yarn                                      # Install dependencies
cp .env.example .env                      # Create environment file

# Start local VeChain network
yarn solo-up                              # Spin up thor-solo Docker container
yarn solo-down                            # Stop thor-solo
yarn solo-clean                           # Clean thor-solo volumes

# Run development environment
yarn dev                                  # Deploy contracts + start frontend (local)
yarn dev:testnet                          # Against testnet
yarn dev:mainnet                          # Against mainnet

# Utilities for testing
BLOCKS=10 yarn solo:mine-blocks           # Mine specific number of blocks
PERIODS=1 yarn solo:fast-forward-periods  # Fast forward validator periods
```

### Testing

```bash
# Unit tests only
yarn contracts:test:unit

# Integration tests only
yarn contracts:test:integration

# Open coverage report
open packages/contracts/coverage/index.html
```

### Linting & Formatting

```bash
yarn format                               # Check all files
yarn format:contracts                     # Check contracts only
yarn format:contracts:write               # Auto-format contracts

yarn lint                                 # Lint all packages
yarn lint:contracts                       # Lint contracts only
```

## Architecture

### Contract System Design

**Entry Point**: `Stargate.sol` - Main contract for staking, delegation, and reward management

**Core Contracts**:
- **Stargate.sol** - Handles VET staking, validator delegation, reward distribution
- **StargateNFT.sol** - ERC-721 NFT representing staking positions
- **StargateProxy.sol** - UUPS upgradeable proxy

**Library Architecture** (StargateNFT uses library pattern):
- **MintingLogic.sol** - Token minting and burning logic
- **Token.sol** - Token state management and queries
- **TokenManager.sol** - Token migration from deprecated contracts
- **Clock.sol** - Time and block management utilities
- **Levels.sol** - NFT level calculations based on stake amount
- **Settings.sol** - Protocol parameters (fees, maturity periods)
- **DataTypes.sol** - Shared struct definitions
- **Errors.sol** - Custom error definitions

**Key Interfaces**:
- **IStargate.sol** - Stargate contract interface
- **IStargateNFT.sol** - StargateNFT contract interface
- **IProtocolStaker.sol** - VeChain protocol staking interface
- **ITokenAuction.sol** - Token auction interface

### Delegation Flow

1. **Stake**: User calls `Stargate.stake()` with VET → NFT minted via `StargateNFT.mint()`
2. **Maturity**: NFT must mature (specific blocks pass) or can be boosted via VTHO payment
3. **Delegate**: User calls `Stargate.delegate(tokenId, validatorAddress)` → VET transferred to ProtocolStaker
4. **Activation**: Delegation becomes active at start of validator's next period
5. **Rewards**: User claims rewards via `Stargate.claimRewards()` for completed periods
6. **Exit**: User calls `Stargate.requestDelegationExit()` → unlocks at next period
7. **Unstake**: User calls `Stargate.unstake(tokenId)` → burns NFT, returns VET

### State Management

**Upgradability**: UUPS pattern (UUPSUpgradeable)
- Proxy contract delegates to implementation
- Only `DEFAULT_ADMIN_ROLE` can upgrade

**Access Control Roles**:
- `DEFAULT_ADMIN_ROLE` - Contract upgrades, role management
- `PAUSER_ROLE` - Pause/unpause contract
- `LEVEL_OPERATOR_ROLE` - Update level parameters (StargateNFT)
- `SETTINGS_OPERATOR_ROLE` - Update protocol settings

**Pausability**: Critical functions can be paused by `PAUSER_ROLE`

### Reward Distribution Mechanism

- Rewards calculated proportionally: `userReward = (userEffectiveStake * periodReward) / totalEffectiveStake`
- Uses **integer division** (rounds down) - see `pk.md` Finding #3 for why this is correct
- Rewards locked until period completes
- Max 832 periods claimable per transaction (gas limit consideration)
- Auto-claim on unstake/re-delegate

### Testing Architecture

**Unit Tests** (`test/unit/`):
- Run on Hardhat network
- Use mocked contracts (`test/mocks/`)
- Coverage reports available

**Integration Tests** (`test/integration/`):
- Run on thor-solo (local VeChain network)
- Test full contract interactions
- No coverage (thor-solo incompatibility)

**Test Sharding**: Uses shard IDs in `describe()` blocks for parallel CI execution
- Integration: `describe("shard-i1: ...)`
- Unit: `describe("shard-u1: ...)`

## Security Audit Workflow

### Important Files for Auditors

1. **Prior Knowledge Base**: `pk.md` - Learnings from previous false positive findings
2. **Audit Scope**: `.cursor/rules/audit-scope.mdc` - Scope boundaries and attacker model
3. **Audit Rules**: `.cursor/rules/audit-iteration-and-findings.mdc` - Workflow for findings
4. **Contract Scope**: `scope.txt` - In-scope contracts for this audit
5. **Findings**: `finds/finding_*.md` - Existing audit findings (both valid and invalid)
6. **Accounting Models**: `acc_modeling/` - Invariants and accounting analysis

### Audit Workflow (MANDATORY)

Before starting any audit task:

1. **Read Prior Knowledge**: Review `pk.md` to understand previous false positive patterns
2. **Review Existing Findings**: List all `finds/finding_*.md` files and note invalid/covered issues
3. **Skip Invalid Findings**: Do NOT re-audit issues already marked as invalid or false positive
4. **Focus on New Paths**: Look for uncovered code paths, new function combinations, unexplored call chains
5. **Check Invariants**: Use `acc_modeling/` to identify accounting invariants to break

### Creating New Findings

```bash
# Check existing finding IDs
ls finds/finding_*.md

# Create new finding with next available ID
# Format: finds/finding_N.md where N is next number
```

**Never overwrite existing findings** - increment ID if file exists.

### Key Audit Principles (from pk.md)

**False Positive Pattern Recognition**:
1. **Privilege-based attacks** (Core-4, Core-5) → Usually out of scope
2. **Integer division dust** in proportional distributions → Industry standard, intentional
3. **Missing events** → Trace FULL call chain before claiming (events may be in libraries)
4. **Economic materiality** → Impact must exceed gas costs to be valid

**Attack Scope**:
- Only unprivileged account attacks are in scope
- Centralization issues out of scope
- Admin/operator role requirements → Usually false positive
- Must trace complete call chains including delegatecalls to libraries

## VeChain-Specific Details

**Native Tokens**:
- VET: Native currency (like ETH)
- VTHO: Gas/energy token (address: `0x0000000000000000000000000000456E65726779`)

**Network Configuration**:
- Uses VeChain Thor blockchain (not Ethereum)
- Hardhat config with `@vechain/sdk-hardhat-plugin`
- Special derivation path: `m/44'/818'/0'/0`

**Protocol Staking**:
- VeChain has built-in protocol staking via `IProtocolStaker` interface
- Validators have periods (not fixed like Ethereum epochs)
- Each validator has different period durations

## Configuration Files

- `hardhat.config.ts` - Solidity 0.8.20, Paris EVM, optimizer runs=1
- `slither.config.json` - Static analysis suppressions (mark false positives here)
- `turbo.json` - Turborepo pipeline configuration
- `packages/config/` - Network-specific configurations (local, testnet, mainnet)

## Common Pitfalls

1. **Redeploying Contracts**: Delete address from `packages/config/{network}.ts` before redeploying, or stop/restart solo network
2. **Test Gas Limits**: Integration tests may timeout - use `BLOCKS` env var to mine blocks faster
3. **Reward Claim Gas**: Max 832 periods per claim due to loop gas costs - use multiclauses for large claims
4. **NFT State Location**: VET amount tracked in StargateNFT contract (legacy design), not Stargate contract
5. **Event Tracing**: Events may be emitted in library contracts (MintingLogic) - don't stop at contract boundary

## Development Notes

- **Node.js**: v20 or later required
- **Package Manager**: Yarn 1.22.17
- **Solidity Version**: 0.8.20 (Paris EVM)
- **Testing Framework**: Hardhat + Mocha/Chai
- **Frontend**: React + Vite + Chakra UI + VeChain-Kit
- **Deployment**: Vercel (automatic via GitHub releases)

## Useful Patterns

**Finding Contract Addresses**:
```typescript
// Addresses stored in packages/config/{network}.ts
import { getConfig } from "@repo/config";
const config = getConfig("testnet");
console.log(config.stargateNFTContractAddress);
```

**Tracing Events in Libraries**:
```bash
# Don't just check Stargate.sol - trace into libraries
grep -r "emit.*Minted" packages/contracts/contracts/StargateNFT/libraries/
```

**Checking For Privileged Actions**:
```solidity
// Look for modifiers like:
onlyRole(DEFAULT_ADMIN_ROLE)
onlyRole(LEVEL_OPERATOR_ROLE)
// These indicate out-of-scope centralization issues
```
