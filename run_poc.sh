#!/bin/bash

cd packages/contracts

echo "=== Running Post-Exit Exploit POC ==="
echo ""

# Run the specific test
npx hardhat test test/integration/PostExitExploit.test.ts --network vechain_solo --grep "EXPLOIT"

echo ""
echo "=== POC Execution Complete ==="
