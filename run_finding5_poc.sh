#!/bin/bash

echo "Finding 5: Double Decrease Effective Stake POC"
echo "=============================================="

cd packages/contracts
VITE_APP_ENV=local yarn hardhat test test/unit/Stargate/Finding5_POC.test.ts --network hardhat

