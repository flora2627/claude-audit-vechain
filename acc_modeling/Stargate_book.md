### 资产（Assets）
- 变量名：nativeBalance(VET)
  - 类型：uint256（EVM 原生余额）
  - 合约：packages/contracts/contracts/Stargate.sol
  - 含义：本合约持有的 VET 余额；在 `stake()` 接收、`delegate()` 外转至 ProtocolStaker、`unstake()`向用户支付时变动（代码中通过 `address(this).balance` 校验与转账）。

- 变量名：vthoBalance(VTHO_TOKEN)
  - 类型：uint256（ERC20 余额）
  - 合约：packages/contracts/contracts/Stargate.sol（VTHO_TOKEN 常量地址）
  - 含义：本合约持有的 VTHO 余额；在 `claimRewards()` 发放奖励时减少（`VTHO_TOKEN.safeTransfer`）。


### 负债（Liabilities）
- （无显式负债型状态变量）
  - 说明：对用户的赎回与奖励支付义务由函数流程与外部状态（委托状态与应发奖励）决定，未以“应付”类变量显式存储。


### 权益（Equity）
- （无显式权益型状态变量）


### 待定科目（与财务相关但非资产/负债/权益）
- 变量名：delegationIdByTokenId
  - 类型：mapping(uint256 => uint256)
  - 合约：packages/contracts/contracts/Stargate.sol
  - 含义：记录 NFT tokenId 到最新 delegationId 的映射，用于追踪外部委托。

- 变量名：lastClaimedPeriod
  - 类型：mapping(uint256 => uint32)
  - 合约：packages/contracts/contracts/Stargate.sol
  - 含义：每个 token 的最近已领取奖励期间，用于计算可领取区间。

- 变量名：delegatorsEffectiveStake
  - 类型：mapping(address => Checkpoints.Trace224)
  - 合约：packages/contracts/contracts/Stargate.sol
  - 含义：按验证者与期间的有效质押总量快照；影响奖励分配权重，非直接资产/负债。

- 变量名：maxClaimablePeriods
  - 类型：uint32
  - 合约：packages/contracts/contracts/Stargate.sol
  - 含义：单次可领取奖励的最大期间数配置，影响提取批次与上限控制。 


