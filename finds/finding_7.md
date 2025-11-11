标题：验证者 UNKNOWN 状态导致有效质押残留，奖励分配持续被稀释（借贷不平 / 不变量被损坏）🚨

结论：当委托退出后，协议依赖 `ProtocolStaker.getValidation` 返回的验证者状态来决定是否调用 `_updatePeriodEffectiveStake` 扣减分母。若验证者被标记为 `UNKNOWN`（status=0），`Stargate` 将委托状态判定为 EXITED，但在 `unstake` 与重新 `delegate` 的路径中都不会执行有效质押扣减。结果是：`delegatorsEffectiveStake` 仍保留退出者的有效质押残差，后续合法委托人的奖励按被放大的分母计算，被系统性稀释。该问题破坏 `acc_modeling/account_ivar.md` 中“期间奖励守恒”及“资产=负债”恒等式，可由任意普通账户借由选择退出时机触发，影响持续存在。

证据（代码引用）

1) `_getDelegationStatus` 在验证者 UNKNOWN 时直接返回 EXITED  
```652:662:packages/contracts/contracts/Stargate.sol
        if (
            validatorStatus == VALIDATOR_STATUS_UNKNOWN ||
            validatorStatus == VALIDATOR_STATUS_EXITED
        ) {
            return DelegationStatus.EXITED;
        }
```

2) `unstake()` 仅在验证者 EXITED 或委托 PENDING 时调用 `_updatePeriodEffectiveStake(..., false)`  
```261:283:packages/contracts/contracts/Stargate.sol
        (, , , , uint8 currentValidatorStatus, ) = $.protocolStakerContract.getValidation(
            delegation.validator
        );
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
                false
            );
        }
```

3) `_delegate()` 的再委托路径同样遗漏 UNKNOWN 分支，残留分母被带入新委托  
```392:413:packages/contracts/contracts/Stargate.sol
            (, , , , uint8 currentValidatorStatus, ) = $.protocolStakerContract.getValidation(
                currentValidator
            );
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
                    false
                );
            }
```

4) POC 单测：当验证者被标记为 UNKNOWN 时，退出者成功赎回但 `delegatorsEffectiveStake` 仍保持退出前总量，导致剩余持有人仅能领取一半应得奖励  
```98:214:packages/contracts/test/unit/Stargate/Finding7_POC.test.ts
    it("dilutes honest delegators after validator becomes UNKNOWN", async () => {
        // ... 两个账户委托至同一验证者
        await protocolStakerMock.helper__setValidatorStatus(
            validator.address,
            VALIDATOR_STATUS_UNKNOWN
        );
        await expect(stargateContract.connect(exitingUser).unstake(exitingTokenId)).to.not.be
            .reverted;
        const totalEffectiveAfterExit = await stargateContract.getDelegatorsEffectiveStake(
            validator.address,
            probePeriod
        );
        expect(totalEffectiveAfterExit).to.equal(stakeAmount * 2n);

        const claimable = await stargateContract.callStatic.claimableRewards(victimTokenId);
        expect(claimable * 2n).to.equal(
            totalRewards,
            "victim only receives a fraction of period rewards"
        );
```

影响

- Loss：委托退出者无需篡改数据，仅等待验证者被协议标记为 `UNKNOWN`（可由节点故障、主动下线等现实事件触发），即可保留自身有效质押在 `delegatorsEffectiveStake` 分母中。剩余委托人的单期奖励变为 `R_active = R_total × S_active/(S_active + S_residual)`，当 `S_active = S_residual` 时每期损失 50%，资产被持续性挪用。  
- 会计不变量：`sum_token(share) = rewards(v, p)` 恒等式被破坏，残差奖励滞留在 `Stargate` 的 VTHO 余额中，无法匹配已发放奖励，导致“资产=负债”口径失衡。  
- 攻击者只需多账户协同行为，即可通过多次退出在多个验证者造成长期分母污染，与 `Finding 4` 的无限领取漏洞叠加时进一步放大损失。

待补数据

- 需从链上事件中提取验证者状态切换（active→unknown）的真实频率，以估算累计损失的下界。  
- 建议运维侧提供实际 `ProtocolStaker` 状态机说明，确认 UNKNOWN/TRIM 流程是否经常出现。

状态：Confirmed / Loss

