标题：重复扣减有效质押导致退出后无法赎回 VET（借贷不平 / 不变量被损坏）🚨

结论：当用户按流程请求退出并等待验证者完成周期后，再调用 `unstake` 或尝试重新 `delegate` 时，会再次对同一 `Checkpoints.Trace224` 做“减数”为零的扣减，`upperLookup` 返回 0 触发 Solidity 0.8 的下溢回退。结果是：退出资产无法赎回、也无法重新委托，协议对该 NFT 持有人的 VET 负债无法结清，属于严重的复式记账失衡与不变量破坏。

证据（代码引用）

1) 退出请求阶段已对未来期间执行一次有效质押扣减：

```520:570:packages/contracts/contracts/Stargate.sol
        (, , , uint32 completedPeriods) = $.protocolStakerContract.getValidationPeriodDetails(
            delegation.validator
        );
        (, uint32 exitBlock) = $.protocolStakerContract.getDelegationPeriodDetails(delegationId);

        // decrease the effective stake
        _updatePeriodEffectiveStake($, delegation.validator, _tokenId, completedPeriods + 2, false);
```

2) 退出完成后在 `unstake` 中再次扣减同一 token，有可能对同一 checkpoint 再减一次：

```240:283:packages/contracts/contracts/Stargate.sol
        if (
            currentValidatorStatus == VALIDATOR_STATUS_EXITED ||
            delegation.status == DelegationStatus.PENDING
        ) {
            (, , , uint32 oldCompletedPeriods) = $
                .protocolStakerContract
                .getValidationPeriodDetails(delegation.validator);
            _updatePeriodEffectiveStake(
                $,
                delegation.validator,
                _tokenId,
                oldCompletedPeriods + 2,
                false // decrease
            );
        }
```

同样的重复扣减也存在于换验证者路径：

```370:413:packages/contracts/contracts/Stargate.sol
        if (status == DelegationStatus.EXITED || status == DelegationStatus.PENDING) {
            ...
            if (
                currentValidatorStatus == VALIDATOR_STATUS_EXITED ||
                status == DelegationStatus.PENDING
            ) {
                (, , , uint32 oldCompletedPeriods) = $
                    .protocolStakerContract
                    .getValidationPeriodDetails(currentValidator);
                _updatePeriodEffectiveStake(
                    $,
                    currentValidator,
                    _tokenId,
                    oldCompletedPeriods + 2,
                    false // decrease
                );
            }
        }
```

3) `_updatePeriodEffectiveStake` 直接在当前值为 0 时执行减法，下溢即回退；而 `upperLookup` 返回的是“最后一个 ≤ key 的值”：

```994:1012:packages/contracts/contracts/Stargate.sol
        uint256 currentValue = $.delegatorsEffectiveStake[_validator].upperLookup(_period);
        uint256 updatedValue = _isIncrease
            ? currentValue + effectiveStake
            : currentValue - effectiveStake;
        $.delegatorsEffectiveStake[_validator].push(_period, SafeCast.toUint224(updatedValue));
```

```22:61:node_modules/@openzeppelin/contracts/utils/structs/Checkpoints.sol
    function upperLookup(Trace224 storage self, uint32 key) internal view returns (uint224) {
        uint256 len = self._checkpoints.length;
        uint256 pos = _upperBinaryLookup(self._checkpoints, key, 0, len);
        return pos == 0 ? 0 : _unsafeAccess(self._checkpoints, pos - 1)._value;
    }
```

原理分析
- 初次委托时 `_delegate` 会在 `completedPeriods + 2` 建立一条 checkpoint，数值为 `effectiveStake`。
- 用户调用 `requestDelegationExit` 后，立即对相同 period 执行一次 `false` 扣减，使该 checkpoint 归零。
- 验证者完成下一周期，`getValidationPeriodDetails` 返回的 `oldCompletedPeriods` 增加 1（或保持不变）。`unstake` / 再 `delegate` 时再调用 `_updatePeriodEffectiveStake`，其中 `_period = oldCompletedPeriods + 2`，`upperLookup` 读取上一条 checkpoint（值为 0），计算 `0 - effectiveStake` 触发下溢，整笔交易回退。
- 即使 `oldCompletedPeriods` 发生变化，`upperLookup` 始终拿到最近一次（值为 0）checkpoint，因此无论 `_period` 取 `completedPeriods+2` 还是 `completedPeriods+3`，都会回退。

触发条件 / 调用序列
1. 正常质押并委托：`stake` → `_delegate` 完成。
2. 在委托激活状态下调用 `requestDelegationExit`，等待一个验证者周期结束（`completedPeriods` 前进，validator 状态变为 `EXITED`）。
3. 任何一笔 `unstake(tokenId)` 或再次 `delegate(tokenId, newValidator)` 都会命中 `_updatePeriodEffectiveStake(... false)` 的第二次扣减并回退。
4. 回退发生在顺序流程早期（在 `_claimRewards`、`burn`、返还 VET 之前），导致用户无法赎回本金也无法重新委托。

会计影响（复式记账视角）
- `acc_modeling/account_ivar.md` 的跨主体恒等式 1 要求：当 token 可赎回时，`Stargate` 应能兑现 `tokens[tokenId].vetAmountStaked`。然而该缺陷阻断赎回流程，协议对该 NFT 的 VET 负债无法结清，[借贷不平]。
- 由于赎回受阻，同一资金在 `StargateNFT.tokens[tokenId].vetAmountStaked` 中仍计作应付，而资产侧无法完成对外支付，违反“资产可覆盖到期义务”的核心不变量，[不变量被损坏]。
- 该回退也阻止重新委托，形成资金与会计记录之间的永久悬挂账项。

影响
- 任意用户只要经历一次正常退出流程，其 VET 将无限期被锁定，既不能赎回，也无法迁移到其他验证者。
- 协议无法履行对退出用户的本金支付义务，带来严重信任与合规风险；锁仓规模与 stake 总额成正比，影响范围系统性。

待补数据
- 建议在本地或测试网编写单元测试，覆盖“请求退出→等待一个周期→调用 `unstake`”的流程，确认自动回退堆栈与 revert reason。

风险等级：高

---

## STRICT ADJUDICATION (2025-11-11)

### 1) Executive Verdict
**VALID (with corrected trigger scenario) - HIGH severity**
报告人的核心漏洞逻辑正确（重复扣减导致下溢），但触发场景描述错误。实际触发条件需要验证者退出网络或状态变化，而非"正常等待周期完成"。

### 2) Reporter's Claim Summary (Neutral Restatement)
报告称：用户按正常流程请求退出 (requestDelegationExit) 并等待验证者完成周期后，调用 unstake 或 delegate 时会对已归零的 checkpoint 再次执行减法，导致下溢回退，用户资金永久锁定。

### 3) Code-Level Analysis & Disproof of "Normal Case"

#### Critical Finding: Reporter's Trigger Scenario is INCORRECT

**Reporter's Claim (Line 88):**
> "等待一个验证者周期结束（completedPeriods 前进，validator 状态变为 EXITED）"

**Disproof:**
验证者周期完成 ≠ 验证者状态变为 EXITED。周期完成仅使 delegation status 从 ACTIVE 变为 EXITED，但 validator status 仍为 ACTIVE。

**Evidence from _getDelegationStatus (Stargate.sol:647-662):**
```solidity
uint32 currentValidatorPeriod = validatorCompletedPeriods + 1;
bool delegationEnded = userRequestedExit && delegationEndPeriod < currentValidatorPeriod;

// Delegation becomes EXITED when period ends
if (delegationEnded) {
    return DelegationStatus.EXITED;  // delegation EXITED, validator still ACTIVE
}
```

**Condition Check in unstake (Line 266-269):**
```solidity
if (
    currentValidatorStatus == VALIDATOR_STATUS_EXITED ||  // Validator exited, NOT delegation
    delegation.status == DelegationStatus.PENDING
) {
    _updatePeriodEffectiveStake(..., false);  // Only executes if condition TRUE
}
```

**Normal Case Trace:**
1. 用户 delegate，状态 ACTIVE (period P+2)，checkpoint: (P+2 → effectiveStake)
2. 用户 requestDelegationExit (period P+1)，checkpoint: (P+3 → 0)
3. 验证者完成 period P+2，delegation status → EXITED，**validator status 仍为 ACTIVE**
4. 用户 unstake:
   - `currentValidatorStatus = VALIDATOR_STATUS_ACTIVE` (NOT EXITED)
   - `delegation.status = DelegationStatus.EXITED` (NOT PENDING)
   - **Condition FALSE → No second decrease → No underflow**

**Conclusion:** 正常流程不会触发重复扣减，报告人对 delegation status 与 validator status 理解错误。

### 4) Code-Level Proof of ACTUAL Vulnerability

#### Actual Trigger Scenario 1: Validator Exits Network

**When it occurs:**
验证者本身退出网络 (misbehavior, voluntary exit, slashing) → validator status becomes VALIDATOR_STATUS_EXITED

**Trace:**
1. 用户 delegate (period P)，checkpoint: (P+2 → effectiveStake)
2. 用户 requestDelegationExit (period P+1)，checkpoint: (P+3 → 0)
3. **验证者退出网络**，`validatorStatus = VALIDATOR_STATUS_EXITED`
4. 用户 unstake:
   - Line 261-263: `currentValidatorStatus = VALIDATOR_STATUS_EXITED`
   - Line 267: **Condition TRUE** (first clause satisfied)
   - Line 271-282: Get `oldCompletedPeriods = P+2`, call `_updatePeriodEffectiveStake($, validator, tokenId, P+4, false)`
   - Line 1004: `currentValue = upperLookup(P+4) = 0` (returns checkpoint P+3 value since P+3 ≤ P+4)
   - Line 1009: `updatedValue = 0 - effectiveStake` → **Underflow! Transaction reverts**

**Same issue in delegate() (Stargate.sol:398-413):** 相同条件检查，相同下溢。

#### Actual Trigger Scenario 2: Validator Status Changes to QUEUED

**When it occurs:**
验证者从 ACTIVE 降级为 QUEUED (network reconfiguration, temporary suspension)

**Evidence from _getDelegationStatus (Line 676-678):**
```solidity
if (validatorStatus == VALIDATOR_STATUS_QUEUED) {
    return DelegationStatus.PENDING;  // Delegation becomes PENDING if validator QUEUED
}
```

**Trace:**
1. 用户 delegate + requestDelegationExit，checkpoints同上
2. 验证者状态变为 QUEUED → delegation status 变为 PENDING (Line 676)
3. 用户 unstake:
   - Line 268: `delegation.status == DelegationStatus.PENDING` → **Condition TRUE**
   - 触发重复扣减 → **Underflow!**

### 5) Call Chain Trace (Strict Format)

**Call Chain for Trigger Scenario 1 (Validator Exits):**

| Step | Caller | Callee | Function | msg.sender | Call Type | Key Args | State Change |
|------|--------|--------|----------|------------|-----------|----------|--------------|
| 1 | User EOA | Stargate | delegate(tokenId, V) | User | call | validator=V | checkpoint(V): (P+2 → effectiveStake) |
| 2 | User EOA | Stargate | requestDelegationExit(tokenId) | User | call | - | checkpoint(V): (P+3 → 0) |
| 3 | - | ProtocolStaker | [validator V exits network] | - | - | - | validatorStatus[V] = EXITED |
| 4a | User EOA | Stargate | unstake(tokenId) | User | call | - | - |
| 4b | Stargate | ProtocolStaker | withdrawDelegation(delegationId) | Stargate | call | - | Reverts before execution |
| 4c | Stargate | Stargate (internal) | _updatePeriodEffectiveStake(..., false) | - | internal | period=P+4, validator=V | **Underflow revert** |

**Reentrancy Window:** None (reverts before external calls complete)
**Cross-Contract Dependency:** Relies on ProtocolStaker returning validatorStatus

### 6) State Scope & Context Audit

#### Storage Scope Analysis

**`$.delegatorsEffectiveStake[_validator]`:**
- **Storage Location:** `StargateStorage`, mapping(address => Checkpoints.Trace224)
- **Scope:** Per-validator global state (NOT per-user)
- **Key Derivation:** `keccak256(abi.encode(_validator, storageSlot))`
- **Access Pattern:** All users delegating to same validator share this checkpoint array

**Checkpoint Array Structure:**
```solidity
struct Trace224 {
    Checkpoint224[] _checkpoints;  // Array of (uint32 _key, uint224 _value) pairs
}
```

#### msg.sender Usage Audit

| Function | Line | Context Var | Purpose | Storage Slot Dependency |
|----------|------|-------------|---------|------------------------|
| unstake | 233 | msg.sender | onlyTokenOwner check | None (modifier only) |
| _updatePeriodEffectiveStake | 1004 | N/A | No msg.sender used | Uses _validator param as mapping key |

**Critical:** 有效质押跟踪基于 validator address，而非 msg.sender。这意味着同一验证者的所有委托者共享同一 checkpoint 数组。但每个 tokenId 有独立的 effectiveStake 计算，不会导致跨用户污染。

**Assembly Analysis:** No assembly in relevant code paths (Checkpoints library uses pure Solidity).

### 7) Exploit Feasibility

#### Prerequisites
1. User must have active delegation (✓ Normal user action)
2. User must call requestDelegationExit (✓ Normal user action)
3. **Validator must exit network** (✗ NOT user-controlled) OR **Validator status changes to QUEUED** (✗ NOT user-controlled)
4. User attempts unstake/re-delegate (✓ Normal user action)

#### Unprivileged EOA Test (Core-4)
- **Can unprivileged user trigger alone?** NO
- **Requires external event:** Validator exit or status change (network-level event)
- **Requires privilege escalation:** NO
- **Social engineering needed:** NO
- **Probabilistic dependency:** YES (depends on validator behavior/network events)

**Core-6 Compliance:** Attack path is NOT 100% attacker-controlled (depends on validator exit), but user IS the victim of protocol flaw once condition met.

#### Victim Profile (Core-9)
用户行为：技术背景普通用户，严格遵守规则，正常操作 requestDelegationExit → 等待周期 → unstake。
**用户无过错，协议逻辑缺陷导致资金锁定。**

### 8) Economic Analysis

#### Inputs & Assumptions
- 假设用户质押: 100,000 VET
- Gas cost (unstake): ~0.001 VET
- Validator exit probability: Unknown (network-dependent)

#### Attacker P&L
**Not applicable** - 这不是可提取价值的攻击，而是协议缺陷导致的资金锁定。

#### Victim Loss Calculation
- **Principal locked:** 100,000 VET (indefinite until contract upgrade)
- **Opportunity cost:** Cannot re-delegate to earn rewards
- **Recovery path:** Only via contract upgrade (requires DEFAULT_ADMIN_ROLE)

#### Sensitivity Analysis
- **If validator exit rate = 1% per year:** 1% of exiting delegators affected
- **If validator exit rate = 10% per year:** 10% of exiting delegators affected
- **Aggregate exposure:** Proportional to (validator exit rate × user exit requests)

**Economic Materiality:** ✅ Exceeds 0.01% threshold - user loses 100% of principal.

### 9) Dependency/Library Reading Notes

#### OpenZeppelin Checkpoints.sol (Conceptual - Not in repo)

**upperLookup Semantics:**
```solidity
function upperLookup(Trace224 storage self, uint32 key) internal view returns (uint224) {
    // Returns value of last checkpoint with _key <= key
    // Returns 0 if no such checkpoint exists
}
```

**push Semantics:**
```solidity
function push(Trace224 storage self, uint32 key, uint224 value) internal {
    // Appends or updates checkpoint at key
    // DOES NOT check if value >= previous value
}
```

**Key Property:** Checkpoints 不阻止数值减少到 0 或负数（通过下溢），这是调用者责任，而非库责任。

#### VeChain ProtocolStaker Interface

**getValidation returns (Stargate.sol:261-263):**
- validatorStatus: uint8 (0=UNKNOWN, 1=QUEUED, 2=ACTIVE, 3=EXITED)
- **Not documented:** 何时 validator status 会变为 EXITED/QUEUED (out of audit scope)

### 10) Final Feature-vs-Bug Assessment

#### Is this intended behavior?

**NO - This is a BUG.**

**Evidence:**
1. **Logic Contradiction:** requestDelegationExit 的目的是准备退出，不应阻止后续 unstake 操作
2. **Missing Guard:** Lines 266-283 缺少"是否已请求退出"检查，导致重复扣减
3. **Asymmetric Increase/Decrease:** delegate 增加一次，但 requestDelegationExit + unstake 可能扣减两次（不对称）
4. **User Impact:** 正常用户操作流程被阻断，违反基本可用性要求

#### Correct Behavior Should Be:

在 unstake/delegate 中增加检查：
```solidity
if (
    (currentValidatorStatus == VALIDATOR_STATUS_EXITED ||
     delegation.status == DelegationStatus.PENDING) &&
    !_hasRequestedExit(_tokenId)  // <-- Missing check
) {
    _updatePeriodEffectiveStake(..., false);
}
```

或者在 requestDelegationExit 中设置标记，避免 unstake 时重复扣减。

### 11) Corrected Verdict Summary

| Aspect | Reporter's Claim | Actual Truth |
|--------|-----------------|--------------|
| **Trigger Scenario** | "正常等待周期完成" | ❌ 错误 - 需要验证者退出/状态变化 |
| **Double Decrease** | ✅ 正确 | ✅ 确实存在重复扣减逻辑缺陷 |
| **Underflow Revert** | ✅ 正确 | ✅ 确实会触发 Solidity 0.8 下溢回退 |
| **Fund Locking** | ✅ 正确 | ✅ VET 锁定在 ProtocolStaker，无法取回 |
| **Severity** | 高 | ✅ 同意 HIGH (条件触发下 100% 资金锁定) |

### 12) Final Ruling

**Verdict: VALID - HIGH Severity**

**Rationale:**
1. **Logic Flaw Confirmed:** 代码在两个场景下会对同一 checkpoint 执行两次扣减（requestDelegationExit + unstake/delegate）
2. **Trigger Condition:** 需要验证者退出网络或状态变化（非 100% 用户可控，但合理预期会发生）
3. **Impact:** 用户资金永久锁定（100% principal loss），仅可通过合约升级恢复
4. **Scope:** 符合 Core-4（用户无需特权）, Core-6（虽依赖外部事件但属于协议内在缺陷）, Core-9（用户行为正常）

**Why Not False Positive:**
- 虽然触发需要验证者退出（非攻击者直接可控），但这是协议应正常处理的场景
- 一旦触发，影响是确定性的（100% 回退），而非概率性的
- 违反核心不变量："用户应能取回已请求退出的质押"

**Corrected Risk Assessment:**
- **Likelihood:** Medium (depends on validator exit frequency)
- **Impact:** Critical (100% fund loss for affected users)
- **Overall Severity:** **HIGH** (Medium likelihood × Critical impact)

**Recommended Fix:**
在 unstake/delegate 的条件检查中增加"未请求退出"判断，或在 requestDelegationExit 中设置标记阻止重复扣减。

---

**Adjudication Date:** 2025-11-11
**Adjudicator:** Claude Code Audit Agent (Strict Mode)
**Prior Knowledge Applied:** Core-1 (经济风险), Core-4 (非特权攻击), Core-6 (链上确定性), Core-7 (协议内在缺陷), Core-9 (用户行为假设)
