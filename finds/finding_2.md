标题：委托有效质押快照回滚不对称，参数变更可致不变量破坏与用户操作受阻（实现层面）  

结论：`delegatorsEffectiveStake` 的增减是用“当前参数计算的有效质押”做加减法，但“增加时使用的参数值”未被快照保存；当管理员按设计正常更新 `level.scaledRewardFactor`（或 `vetAmountRequiredToStake` 导致后续有效质押变化）后，再执行“减少”路径会与当初“增加”时的数值不一致，出现：
- 减少时计算的数值大于当前快照值 → 减法下溢（Solidity 0.8 自动回退）导致用户操作（如 `unstake`、换验证者的 `delegate` 路径）直接 Revert；
- 或减少数值小于当前快照值 → 快照残留“多计入”的有效质押，破坏期间奖励分母一致性，影响分配准确性。  
这属于实现层面对期间会计不变量的破坏风险，[不变量被损坏]。

证据（代码引用）

1) 减少/增加的实现使用“当前值计算”的有效质押做差/和，未保存原始入账基数

```994:1013:packages/contracts/contracts/Stargate.sol
    function _updatePeriodEffectiveStake(
        StargateStorage storage $,
        address _validator,
        uint256 _tokenId,
        uint32 _period,
        bool _isIncrease
    ) private {
        // calculate the effective stake
        uint256 effectiveStake = _calculateEffectiveStake($, _tokenId);

        // get the current effective stake
        uint256 currentValue = $.delegatorsEffectiveStake[_validator].upperLookup(_period);

        // calculate the updated effective stake
        uint256 updatedValue = _isIncrease
            ? currentValue + effectiveStake
            : currentValue - effectiveStake;

        // push the updated effective stake
        $.delegatorsEffectiveStake[_validator].push(_period, SafeCast.toUint224(updatedValue));
    }
```

2) 有效质押依赖“当前”等级参数（可被运营角色更新）

```1020:1030:packages/contracts/contracts/Stargate.sol
    function _calculateEffectiveStake(
        StargateStorage storage $,
        uint256 _tokenId
    ) private view returns (uint256) {
        DataTypes.Token memory token = $.stargateNFTContract.getToken(_tokenId);
        DataTypes.Level memory level = $.stargateNFTContract.getLevel(token.levelId);

        return
            (token.vetAmountStaked * level.scaledRewardFactor) /
            $.stargateNFTContract.REWARD_MULTIPLIER_SCALING_FACTOR();
    }
```

3) 等级参数可以被正常运维更新（非异常操作）

```299:305:packages/contracts/contracts/StargateNFT/libraries/Levels.sol
        $.levels[_levelId].name = _name;
        $.levels[_levelId].isX = _isX;
        $.levels[_levelId].maturityBlocks = _maturityBlocks;
        $.levels[_levelId].scaledRewardFactor = _scaledRewardFactor;
        $.levels[_levelId].vetAmountRequiredToStake = _vetAmountRequiredToStake;
```

4) 触发“减少”的典型调用栈（示例一：unstake）

```260:283:packages/contracts/contracts/Stargate.sol
        // if the delegation is pending or the validator is exited or unknown
        // decrease the effective stake of the previous validator
        if (
            currentValidatorStatus == VALIDATOR_STATUS_EXITED ||
            delegation.status == DelegationStatus.PENDING
        ) {
            // get the completed periods of the previous validator
            (, , , uint32 oldCompletedPeriods) = $
                .protocolStakerContract
                .getValidationPeriodDetails(delegation.validator);

            // decrease the effective stake of the previous validator
            _updatePeriodEffectiveStake(
                $,
                delegation.validator,
                _tokenId,
                oldCompletedPeriods + 2,
                false // decrease
            );
        }
```

影响
- 用户影响：在参数被正常更新后，用户执行 `unstake` / 变更委托等路径可能因“减少时的有效质押大于快照值”而下溢 Revert，造成资金提取受阻（业务中断）。  
- 会计不变量：期间 `delegatorsEffectiveStake`（作为奖励分配分母的快照）不再保证“增加与减少对称”，存在残留或不足，破坏“期间守恒”的会计口径与报表一致性。  
- 审计/对账：同一 token 在不同时间点以不一致参数入账与出账，将需要离线重建历史参数序列才能复原净额，复杂度陡增。  

待补数据
- 需要链上交易样本与参数变更历史（`Levels.updateLevel` 事件日志）以验证在主网/测试网是否已出现下溢 Revert 或分配偏差的具体事务。  
- 需要导出若干验证者/期间的 `delegatorsEffectiveStake` 快照序列与当期已分配奖励合计，复核是否存在系统性残差。

风险等级：高

备注（范围声明）
- 该问题由“正常的运维更新等级参数”即可触发，不依赖恶意或异常权限滥用，符合本轮“特权角色在正常操作下仍导致会计失衡即为问题”的口径。  


