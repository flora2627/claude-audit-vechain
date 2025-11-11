# VeChain Stargate 多主体会计安全模型

## 1. 核心会计主体识别
* 主体A: `Stargate.sol` - 入口合约；接收用户 VET、发起委托至 ProtocolStaker、发放 VTHO 奖励、处理赎回与退出。
* 主体B: `StargateNFT.sol` - NFT 状态与铸烧；记录 `vetAmountStaked` 元数据；支持 boost；迁移残余 VET 归集。
* （非主体）: `StargateProxy.sol` - 代理，无独立账套。
* （外部）: ProtocolStaker - 托管与计奖，非本仓库合约；作为对账方参与恒等式。

## 2. 主体内部会计模型

### 2.1 主体A: `Stargate.sol`
* 资产:
  - nativeBalance(VET)：本合约的 VET 余额。
  - vthoBalance(VTHO_TOKEN)：本合约的 VTHO 余额。
* 负债/权益:
  - 无显式“应付”或“权益”变量；对用户的赎回/奖励义务由状态与期间计算隐含表达。
* [!] 主体内会计恒等式:
  - 资产 = 对用户义务（赎回/奖励待付） + 其他净额（通过跨主体转移即时结清）
  - 对于任意时点：nativeBalance(VET) 与 vthoBalance(VTHO_TOKEN) 足以覆盖已到期可结清项（函数层面以校验与外部交互确保）。

### 2.2 主体B: `StargateNFT.sol`
* 资产:
  - nativeBalance(VET)：迁移收尾阶段可能存在的剩余 VET（可被 `transferBalance` 归集）。
* 负债/权益:
  - 无显式“应付/权益”变量；`tokens[tokenId].vetAmountStaked` 为元数据，不代表本合约持有资产或义务。
* [!] 主体内会计恒等式:
  - 资产（剩余 VET，如有） = 待清算移交额（向 `Stargate` 的转移额度）

## 3. 跨主体会计恒等式 (核心风险点)

### 3.1 交互对: (Stargate <> StargateNFT)
* 依赖关系描述: `Stargate` 负责资金流；`StargateNFT` 记录每个 token 的 `vetAmountStaked` 与生命周期事件（mint/burn/迁移）。两者需就 token 层面的“标称质押额”与资金托管位置（合约余额或 ProtocolStaker）保持一致。
* [!!] 跨主体恒等式 1（单 token 粒度）:
  - 当 token 可赎回（非 ACTIVE，且未销毁）时：`Stargate.nativeBalance(VET)` + “从 ProtocolStaker 可提回之 VET(该 token)” ≥ `StargateNFT.tokens[tokenId].vetAmountStaked`
* 风险场景: 若 `Stargate` 可用余额 + 可提回额 < 标称质押额，则可能出现赎回不足（资金错配或赎回路径阻断）。

* [!!] 跨主体恒等式 2（迁移归集）:
  - `StargateNFT.transferBalance` 后：`StargateNFT.nativeBalance(VET)` = 0，且 `Stargate.nativeBalance(VET)` 相应增加相同金额
* 风险场景: 若归集后 `StargateNFT` 仍残留 VET 或 `Stargate` 未收到等额 VET，存在迁移期资金挂账。

### 3.2 交互对: (Stargate <> ProtocolStaker)
* 依赖关系描述: `Stargate` 将 VET 委托至 ProtocolStaker 并按期间领取委托者奖励；奖励再按 token 有效质押占比分配并发放。
* [!!] 跨主体恒等式 3（奖励守恒，单期）:
  - 对任一验证者 v、期间 p：`sum_token( tokenEffStake(token,p) / totalEffStake(v,p) * rewards(v,p) )` = `rewards(v,p)`  
  其中 `totalEffStake(v,p)` 由 `Stargate.delegatorsEffectiveStake` 快照；`rewards(v,p)` 来自 ProtocolStaker。
* 风险场景: 若 `delegatorsEffectiveStake` 快照与 ProtocolStaker 的分母不一致，或 `Stargate` 实际可用 VTHO 余额不足以支付 `sum_token`，将导致奖励错配或拒付。

* [!!] 跨主体恒等式 4（委托资金位置）:
  - 对任一 token：在 ACTIVE 期间，`Stargate.nativeBalance(VET)` 不应包含该 token 的质押 VET；该部分应位于 ProtocolStaker。非 ACTIVE 期间允许资金回流至 `Stargate` 直至赎回。
* 风险场景: 若 ACTIVE 期间资金回落至 `Stargate` 余额，表示委托位置异常，影响奖励累计与赎回路径。

### 3.3 交互组合: (Stargate <> StargateNFT <> ProtocolStaker)
* 依赖关系描述: `StargateNFT.tokens[tokenId].vetAmountStaked` 为标称额；`Stargate` 管理真实资金与委托；ProtocolStaker 托管与计奖。
* [!!] 跨主体恒等式 5（端到端资金对账）:
  - `sum_over_all_existing_tokens(vetAmountStaked)` = VET_in_ProtocolStaker（由所有活跃/待结 token 组成） + VET_in_Stargate（待赎回/待委托）
* 风险场景: 若总额不等，说明存在未入账或重复入账的路径（如迁移残留、错误外转、重复计量）。

## 4. 关键操作的复式记账分析

### 4.1 操作: `stakeAndDelegate(uint8 levelId, address validator)`
* 业务描述: 用户支付 VET，铸造 NFT，并立即将等额 VET 外转委托到 ProtocolStaker。
* 会计分录:
  - 主体A（Stargate）:
    - 借: nativeBalance(VET)（接收）
    - 贷: nativeBalance(VET)（外转委托）
  - 主体B（StargateNFT）:
    - 借: tokens[tokenId].vetAmountStaked（元数据）
    - 贷: -（无资产/负债变化）
  - 对账检查: 跨主体恒等式 1、4、5 成立（净持有在 ProtocolStaker）。

### 4.2 操作: `unstake(uint256 tokenId)`
* 业务描述: 若非 ACTIVE 或已退出/待退出则可赎回；必要时先从 ProtocolStaker 提回，再向用户支付并烧毁 NFT。
* 会计分录:
  - 主体A（Stargate）:
    - 借: nativeBalance(VET)（如先从 ProtocolStaker 收回）
    - 贷: nativeBalance(VET)（向用户支付）
  - 主体B（StargateNFT）:
    - 贷: tokens[tokenId].vetAmountStaked（元数据清除）
  - 对账检查: 跨主体恒等式 1、4、5 仍成立（该 token 退出集合）。

### 4.3 操作: `claimRewards(uint256 tokenId)`
* 业务描述: 依据期间批量结算并向持有人发放 VTHO。
* 会计分录:
  - 主体A（Stargate）:
    - 贷: vthoBalance(VTHO_TOKEN)（向用户发放）
  - 主体B（StargateNFT）:
    - -（无）
  - 对账检查: 跨主体恒等式 3 成立（期间总额守恒，余额足额）。 


