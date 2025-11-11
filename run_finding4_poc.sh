#!/bin/bash
set -e

echo "========================================="
echo "Finding #4 POC Verification Script"
echo "========================================="
echo ""

# Check if nvm is installed
if [ ! -f ~/.nvm/nvm.sh ]; then
    echo "Error: nvm is not installed"
    exit 1
fi

# Load nvm
source ~/.nvm/nvm.sh

# Use Node.js 20
echo "Switching to Node.js 20..."
nvm use 20

# Navigate to project root
cd "$(dirname "$0")"

# Set environment variable
export VITE_APP_ENV=local

echo ""
echo "Running POC test..."
echo "Test file: packages/contracts/test/unit/Stargate/Finding4_POC.test.ts"
echo ""

# Run the POC test
cd packages/contracts
yarn hardhat test --network hardhat test/unit/Stargate/Finding4_POC.test.ts

echo ""
echo "========================================="
echo "POC Execution Complete"
echo "========================================="
echo ""
echo "See POC_Finding_4_Summary.md for detailed analysis"

