### 资产（Assets）
- 变量名：nativeBalance(VET)
  - 类型：uint256（EVM 原生余额）
  - 合约：packages/contracts/contracts/StargateNFT/StargateNFT.sol
  - 含义：V3 升级后理论上不再长期持有 VET，但在迁移收尾阶段可能仍有剩余 VET；可由 `transferBalance(uint256)` 向 `Stargate` 归集。


### 负债（Liabilities）
- （无显式负债型状态变量）


### 权益（Equity）
- （无显式权益型状态变量；`boost()` 将用户的 VTHO 直接转至 `address(0)`，不形成协议留存）


### 待定科目（与财务相关但非资产/负债/权益）
- 变量名：tokens[tokenId].vetAmountStaked
  - 类型：uint256
  - 合约：packages/contracts/contracts/StargateNFT/libraries/DataTypes.sol
  - 含义：每个 NFT 对应的“标称质押 VET 数量”元数据，用于后续委托与对账；不对应本合约实际持有资产。

- 变量名：boostPricePerBlock[levelId]
  - 类型：mapping(uint8 => uint256)
  - 合约：packages/contracts/contracts/StargateNFT/StargateNFT.sol
  - 含义：各等级的加速单价；`boost()` 时用户以 VTHO 支付并被销毁。

- 变量名：vthoToken
  - 类型：IERC20
  - 合约：packages/contracts/contracts/StargateNFT/StargateNFT.sol
  - 含义：VTHO 代币地址引用，用于 `boost()` 的转移；非余额记录。

- 变量名：legacyNodes（ITokenAuction）
  - 类型：ITokenAuction
  - 合约：packages/contracts/contracts/StargateNFT/StargateNFT.sol
  - 含义：迁移相关外部依赖，用于 `migrate()` 元数据读取与销毁旧 NFT。

- 变量名：stargate（IStargate）
  - 类型：IStargate
  - 合约：packages/contracts/contracts/StargateNFT/StargateNFT.sol
  - 含义：Hayabusa 主入口合约引用；铸烧/加速/查询等需受其授权或配合。 


