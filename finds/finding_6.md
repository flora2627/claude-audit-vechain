
📝 检查总览

| 序号 | 分类         | 指标/模块                     | 位置/函数/tx                                      | 证据要点          | 风险 |
|----|--------------|-------------------------------|---------------------------------------------------|-------------------|------|
| 1  | Freeze / DoS | delegatorsEffectiveStake / unstake | packages/contracts/contracts/Stargate.sol::unstake L266 | S-F1, P1-P3 满足  | High |

---

🔍 详细说明

<Freeze> – <delegatorsEffectiveStake / unstake>
	•	**位置**: `packages/contracts/contracts/Stargate.sol` in `unstake()` (L266-283) and `delegate()` (L398-413)
	•	**触发条件 / 调用栈**:
        1. 用户在验证者 `V1` 处于 `ACTIVE` 状态时成功委托。
        2. 用户调用 `requestDelegationExit()` 请求退出。此时，`_updatePeriodEffectiveStake` 被**第一次**调用以扣减有效质押。
        3. 在委托退出周期完成前，验证者 `V1` 的状态从 `ACTIVE` 变为 `QUEUED`。
        4. 由于 `_getDelegationStatus` 的实现，当验证者为 `QUEUED` 时，用户的委托状态会被报告为 `PENDING`。
        5. 用户调用 `unstake()` 试图取回资金。
        6. 在 `unstake()` 内部，条件 `delegation.status == DelegationStatus.PENDING` (L268) 为真，导致 `_updatePeriodEffectiveStake` 被**第二次**调用。
        7. 第二次扣减在已为零的检查点上执行，导致算术下溢，交易回退。
	•	**二级公式与口径**: `updatedValue = currentValue - effectiveStake` where `currentValue` is 0 from the first subtraction, leading to underflow.
	•	**证据 (P1-P3)**:
        -	**交易序列**: `delegate()` → `requestDelegationExit()` → (validator status changes to `QUEUED`) → `unstake()` (reverts)
        -	**变量前后**: `delegatorsEffectiveStake` for the period is first reduced to 0 by `requestDelegationExit`. The subsequent call in `unstake` attempts `0 - effectiveStake`, causing a revert.
        -	**影响量化**: 任何遵循此路径的用户的全部质押VET将被永久冻结，无法赎回或重新委托。影响范围取决于验证者状态变为 `QUEUED` 的频率。
	•	**利用草图**:
        ```solidity
        // 1. User delegates to an active validator V1
        stargate.delegate(tokenId, V1);

        // 2. User requests exit
        stargate.requestDelegationExit(tokenId);
        // At this point, delegatorsEffectiveStake for V1 is decreased once.

        // 3. (Off-chain) Validator V1 status becomes QUEUED.
        // This is simulated by a mock ProtocolStaker contract in a test.

        // 4. User attempts to unstake
        // The call to _getDelegationStatus() now returns PENDING.
        // The check at unstake:268 passes, triggering a second decrease.
        vm.expectRevert(); // Arithmetic underflow
        stargate.unstake(tokenId);
        ```
	•	**根因标签**: `Inconsistency` / `Invariant-Broken`
	•	**状态**: Confirmed
