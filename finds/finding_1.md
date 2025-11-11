标题：资金流事件披露缺失（Disclosure / Presentation）⚠️

结论：合约在发生 VET 入金与出金的关键路径上，缺少明确的资金流事件，影响链上复式记账的可追溯性与对账效率。未发现“借贷不平”或不变量被破坏的直接证据；该问题归类为报表层面（披露/呈现）。

证据（代码引用）

1) stake 与 migrateAndDelegate 入金未有专门资金事件（仅依赖函数调用上下文）

```215:229:packages/contracts/contracts/Stargate.sol
    function stake(
        uint8 _levelId
    ) external payable whenNotPaused nonReentrant returns (uint256 tokenId) {
        StargateStorage storage $ = _getStargateStorage();
        DataTypes.Level memory level = $.stargateNFTContract.getLevel(_levelId);
        // validate msg.value
        if (msg.value != level.vetAmountRequiredToStake) {
            revert VetAmountMismatch(_levelId, level.vetAmountRequiredToStake, msg.value);
        }
        return $.stargateNFTContract.mint(_levelId, msg.sender);
    }
```

```496:520:packages/contracts/contracts/Stargate.sol
    function migrateAndDelegate(
        uint256 _tokenId,
        address _validator
    ) external payable whenNotPaused onlyLegacyTokenOwner(_tokenId) nonReentrant {
        StargateStorage storage $ = _getStargateStorage();
        ...
        if (msg.value != vetAmountRequiredToStake) {
            revert VetAmountMismatch(level, vetAmountRequiredToStake, msg.value);
        }
        ...
        $.stargateNFTContract.migrate(_tokenId);
        _delegate($, _tokenId, _validator);
    }
```

2) unstake 出金（向用户支付 VET）未有专门资金事件（仅有 NFT burn 与内部事件）

```311:321:packages/contracts/contracts/Stargate.sol
        // transfer the VET to the caller (which is also the owner of the NFT since only the owner can unstake)
        (bool success, ) = msg.sender.call{ value: token.vetAmountStaked }("");
        if (!success) {
            revert VetTransferFailed(msg.sender, token.vetAmountStaked);
        }
```

3) StargateNFT 向 Stargate 归集残余 VET 未有专门资金事件

```646:657:packages/contracts/contracts/StargateNFT/StargateNFT.sol
    function transferBalance(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        DataTypes.StargateNFTStorage storage $ = _getStargateNFTStorage();
        uint256 balance = address(this).balance;
        if (amount > balance) {
            revert Errors.InsufficientContractBalance(balance, amount);
        }
        (bool success, ) = payable(address($.stargate)).call{ value: amount }("");
        if (!success) {
            revert Errors.VetTransferFailed(address($.stargate), amount);
        }
    }
```

相关已有事件（用于参考对比：奖励/委托路径有事件）

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

```463:471:packages/contracts/contracts/Stargate.sol
        emit DelegationInitiated(
            _tokenId,
            _validator,
            delegationId,
            token.vetAmountStaked,
            token.levelId,
            multiplier
        );
```

影响
- 披露与呈现：资金入金（stake、migrateAndDelegate）与出金（unstake）缺少明确的 VET 资金流事件；`StargateNFT.transferBalance` 归集操作亦无事件。对账需要依赖交易输入值或余额差，降低审计可读性、索引器与会计系统对账效率。
- 会计结论：从源码逻辑看，金额路径按定额传递（如 `token.vetAmountStaked`）、失败回滚，未见“借贷不平”或不变量被破坏的直接路径；但因披露不足，链上凭证不完备。

建议（不提供修复方案，仅指出问题）
- 为上述资金流动作补充专门事件以形成可追溯凭证：入金、出金、归集转账的金额、接收/支出方、tokenId/level 等关键维度。

待补数据
- 未提供链上交易日志与快照，无法对“借贷不平”进行事务级复核；需后续提供具体交易哈希与日志索引进行核对。

风险等级：中


