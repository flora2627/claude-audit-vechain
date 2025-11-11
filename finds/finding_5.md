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

