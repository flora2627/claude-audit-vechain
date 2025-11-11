标题：期间奖励分配向下取整残差未披露/未归集，存在账面累积与报表偏差（报表层面）⚠️

结论：单期奖励分配按比例取整（整数除法）计算到 token 级，累计和严格小于等于总额；差额残留在 `Stargate` 的 VTHO 余额中，未见归集/再分配/披露路径与事件。该问题不影响资金安全，但影响期间报表“守恒呈现”与对账可读性，属于披露/计量层面的不足。

证据（代码引用）

1) 单期分配按比例整数除法，向下取整产生残差

```842:855:packages/contracts/contracts/Stargate.sol
        // get the effective stake of the token
        uint256 effectiveStake = _calculateEffectiveStake($, _tokenId);
        // get the effective stake of the delegator in the period
        uint256 delegatorsEffectiveStake = $.delegatorsEffectiveStake[validator].upperLookup(
            _period
        );
        // avoid division by zero
        if (delegatorsEffectiveStake == 0) {
            return 0;
        }

        // return the claimable amount
        return (effectiveStake * delegationPeriodRewards) / delegatorsEffectiveStake;
```

2) 实际转账仅向用户侧转出各自取整后的金额

```766:775:packages/contracts/contracts/Stargate.sol
        emit DelegationRewardsClaimed(
            tokenOwner,
            _tokenId,
            $.delegationIdByTokenId[_tokenId],
            claimableAmount,
            firstClaimablePeriod,
            lastClaimablePeriod
        );
```

现象与影响
- 残差累积：各 token 金额向下取整后，单期全体 `sum(tokenShare)` ≤ `delegationPeriodRewards`，差额累积留存在合约的 VTHO 余额。  
- 披露缺失：未见残差归集/二次分配/定期提列的机制或事件；会导致“期间奖励=用户已领”在凭证层面不成立。  
- 会计呈现：影响期间“守恒”展示与索引器对账，需要额外披露残差口径或提供归集事件以闭环。  

待补数据
- 需要导出若干期间的 `delegationPeriodRewards` 与用户侧 `DelegationRewardsClaimed` 合计差额，确认残差规模与趋势。  
- 需要管理方说明是否存在链下/后续版本的归集与披露设计（若有，应形成在链上可重建的凭证链）。  

风险等级：低（信息披露/呈现）

范围与边界
- 不涉及用户资金被盗或不变量被破坏（金额留存在合约），但属于报表口径与披露维度的缺失，应在对外报表与索引器中明确。  


