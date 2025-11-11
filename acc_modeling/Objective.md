| 模块名        | 有资产？ | 有负债？ | 有权益？ | 是否拆分账目（是/否） | 合约入口                                                                 | 说明备注 |
|---------------|----------|----------|----------|------------------------|--------------------------------------------------------------------------|----------|
| Stargate      | ✅        | ✅        | ❌        | 是                     | packages/contracts/contracts/Stargate.sol：`stake()`, `unstake()`, `delegate()`, `stakeAndDelegate()`, `migrateAndDelegate()`, `claimRewards()`, `requestDelegationExit()` | 持有并转移 VET；持有并发放 VTHO；记录并处理委托与奖励，存在对用户的赎回与奖励支付义务 |
| StargateNFT   | ✅        | ❌        | ❌        | 是                     | packages/contracts/contracts/StargateNFT/StargateNFT.sol：`mint()`, `burn()`, `boost()`, `transferBalance()` | V3 后主要为状态与铸烧控制；仍可能暂存 VET（`transferBalance`），无费用留存；`vetAmountStaked` 为元数据 |
| StargateProxy | ❌        | ❌        | ❌        | 否                     | packages/contracts/contracts/StargateProxy.sol                           | 仅代理转发，不持有会计意义上的资产/负债 |
| ProtocolStaker（外部） | ✅ | ❌ | ❌ | 否（外部依赖） | packages/contracts/contracts/interfaces/IProtocolStaker.sol               | 外部托管与计奖方，不纳入本仓库账套；用于跨主体恒等式对账 |


