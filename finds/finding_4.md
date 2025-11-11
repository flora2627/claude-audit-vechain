标题：退出后仍可无限领取 VTHO 奖励导致资产超发（借贷不平 / 不变量被损坏）🚨

结论：当委托已退出且已领取至 `endPeriod` 后，`_claimableDelegationPeriods` 的边界判断错误会继续返回后续期间，攻击者无需再次质押即可无限提取其他委托人的 VTHO 奖励。该缺陷直接打破“奖励守恒”不变量，造成资产负债表中 VTHO 资产被无抵消地转出，属于严重的复式记账失衡。

证据（代码引用）

```880:934:packages/contracts/contracts/Stargate.sol
    function _claimableDelegationPeriods(
        StargateStorage storage $,
        uint256 _tokenId
    ) private view returns (uint32, uint32) {
        ...
        if (
            endPeriod != type(uint32).max &&
            endPeriod < currentValidatorPeriod &&
            endPeriod > nextClaimablePeriod
        ) {
            return (nextClaimablePeriod, endPeriod);
        }

        if (nextClaimablePeriod < currentValidatorPeriod) {
            return (nextClaimablePeriod, completedPeriods);
        }
        ...
    }
```

```793:855:packages/contracts/contracts/Stargate.sol
    function _claimableRewards(
        StargateStorage storage $,
        uint256 _tokenId,
        uint32 _batch
    ) private view returns (uint256) {
        (uint32 firstClaimablePeriod, uint32 lastClaimablePeriod) = _claimableDelegationPeriods(
            $,
            _tokenId
        );
        ...
        for (uint32 period = batchStart; period <= batchEnd; period++) {
            claimableAmount += _claimableRewardsForPeriod($, _tokenId, period);
        }
        ...
    }

    function _claimableRewardsForPeriod(
        StargateStorage storage $,
        uint256 _tokenId,
        uint32 _period
    ) private view returns (uint256) {
        ...
        uint256 delegatorsEffectiveStake = $.delegatorsEffectiveStake[validator].upperLookup(
            _period
        );
        if (delegatorsEffectiveStake == 0) {
            return 0;
        }

        return (effectiveStake * delegationPeriodRewards) / delegatorsEffectiveStake;
    }
```

原理分析
- 委托退出后，`endPeriod` 等于协议记录的最后可得奖励期间。若用户已领取至 `endPeriod`，则 `nextClaimablePeriod = endPeriod + 1`。
- 由于 `_claimableDelegationPeriods` 使用严格大于号 `endPeriod > nextClaimablePeriod`，当 `nextClaimablePeriod` 恰好等于 `endPeriod + 1` 时，判断失败并落入后一分支，返回 `(endPeriod + 1, completedPeriods)`。
- `completedPeriods` 会持续随验证者推进而增大，导致后续期间持续被视为“可领取”。  
- `_claimableRewardsForPeriod` 计算时仍使用旧的 `effectiveStake`，但分母 `delegatorsEffectiveStake` 已不再包含该 NFT；存在其他委托人时，攻击者可获得 `(effectiveStake / othersStake) * rewards` 的正额奖励，实现“空手套白狼”。
- 该行为可无限重复，直至合约内的 VTHO 被榨干，破坏“奖励守恒”与“资产=负债”不变量，属于借贷不平与欺诈级风险。

影响
- 攻击者可在退出后无限领取无对应质押的 VTHO，消耗合约中全部奖励资金。
- 真实委托人被稀释，奖励记账与链上实际资产严重失衡。
- 该漏洞可远程利用，仅需控制任意已退出的 NFT；无需修改状态或额外权限。

建议（不提供修复方案，仅提示问题）
- 需在 `_claimableDelegationPeriods` 中正确截断 `lastClaimablePeriod`，确保退出后不再产生可领取区间；或在 `_claimableRewardsForPeriod` 中明确校验委托状态与期间。

待补数据
- 无链上交易样本，尚未在主网复现；建议在测试环境编写单元/模糊测试确认攻击路径。

风险等级：高