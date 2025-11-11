# Finding 5 POC: Double Decrease Effective Stake on Exit

## 漏洞概述

用户在请求委托退出后，当验证者退出网络或状态变化时，会因重复扣减有效质押导致算术下溢，从而锁定用户资金。

## 核心问题

```solidity
// 第一次扣减：requestDelegationExit (line 568)
_updatePeriodEffectiveStake($, validator, tokenId, completedPeriods + 2, false);

// 第二次扣减：unstake (line 276-282) 当 validator EXITED 或 delegation PENDING
if (currentValidatorStatus == VALIDATOR_STATUS_EXITED || delegation.status == PENDING) {
    _updatePeriodEffectiveStake($, validator, tokenId, oldCompletedPeriods + 2, false);
    // currentValue = upperLookup(period) = 0 (已被第一次扣减归零)
    // updatedValue = 0 - effectiveStake → 下溢回退
}
```

## POC 验证场景

### 场景 1: 验证者退出网络
```typescript
// 1. 用户质押并委托（delegation 状态 = ACTIVE）
stake() → delegate() → requestDelegationExit()

// 2. 验证者退出网络
validatorStatus = EXITED

// 3. 用户尝试 unstake → 回退
unstake(tokenId) // ❌ Arithmetic underflow
```

### 场景 2: 验证者状态变为 QUEUED
```typescript
// 1. 用户质押并委托（delegation 状态 = ACTIVE）
stake() → delegate() → requestDelegationExit()

// 2. 验证者状态变为 QUEUED（delegation 自动变为 PENDING）
validatorStatus = QUEUED → delegationStatus = PENDING

// 3. 用户尝试 unstake → 回退
unstake(tokenId) // ❌ Arithmetic underflow
```

### 场景 3: 无法重新委托
```typescript
// 1. 用户质押并委托验证者 1
stake() → delegate(validator1) → requestDelegationExit()

// 2. 验证者 1 退出网络
validator1.status = EXITED

// 3. 用户尝试重新委托给验证者 2 → 回退
delegate(tokenId, validator2) // ❌ Arithmetic underflow (delegate 也有相同逻辑)
```

## 测试结果

```bash
✔ should revert unstake due to double effective stake decrease
✔ should revert unstake when delegation becomes PENDING
✔ should revert re-delegation due to double effective stake decrease

3 passing (847ms)
```

## 关键输出

```
Locked stake: 1.0 VET
Protocol debt: 1.0 VET
Delegation status: 1 (PENDING)
User cannot unstake OR re-delegate - funds permanently locked
```

## 影响

- **本金损失**: 100%（VET 永久锁定）
- **影响范围**: 所有经历正常退出流程且遇到验证者退出/状态变化的用户
- **恢复路径**: 仅通过合约升级（需要 `DEFAULT_ADMIN_ROLE`）

## 修复建议

在 `unstake` / `delegate` 中添加守卫检查：

```solidity
if (
    (currentValidatorStatus == VALIDATOR_STATUS_EXITED ||
     delegation.status == DelegationStatus.PENDING) &&
    !_hasRequestedExit(_tokenId)  // 缺失的守卫检查
) {
    _updatePeriodEffectiveStake(..., false);
}
```

## 运行 POC

```bash
./run_finding5_poc.sh
```

或直接运行：

```bash
cd packages/contracts
VITE_APP_ENV=local yarn hardhat test test/unit/Stargate/Finding5_POC.test.ts --network hardhat
```

---

**严重程度**: HIGH  
**验证状态**: ✅ 完全确认  
**测试文件**: `packages/contracts/test/unit/Stargate/Finding5_POC.test.ts`

