# Strict Audit Report: Finding #2 - Effective Stake Snapshot Asymmetry

## Executive Verdict
**Informational / Low Severity** - Logic flaw confirmed but lacks practical economic risk. Reporter's claim is partially incorrect. This is a protocol design limitation, not a critical vulnerability.

**Rationale:** The effective stake calculation asymmetry exists but (1) requires privileged admin action, (2) has no permanent fund loss, (3) is reversible by admin, and (4) one key claim about `vetAmountRequiredToStake` is factually incorrect.

---

## Reporter's Claim Summary
Reporter alleges that `delegatorsEffectiveStake` uses current parameters for both increase/decrease operations, causing asymmetry when admin updates `level.scaledRewardFactor` or `vetAmountRequiredToStake`. Claims this leads to:
1. Underflow revert blocking user operations (DOS)
2. Accounting invariant breakage affecting reward distribution

---

## Code-Level Analysis

### Logic Existence: **PARTIALLY CONFIRMED**

**Confirmed Flaw:**
- `Stargate.sol:1020-1030` - `_calculateEffectiveStake` uses **current** `level.scaledRewardFactor`:
```solidity
function _calculateEffectiveStake(...) private view returns (uint256) {
    DataTypes.Token memory token = $.stargateNFTContract.getToken(_tokenId);
    DataTypes.Level memory level = $.stargateNFTContract.getLevel(token.levelId);
    return (token.vetAmountStaked * level.scaledRewardFactor) / SCALING_FACTOR;
}
```

- `Stargate.sol:993-1013` - Both increase and decrease paths recalculate effective stake:
```solidity
function _updatePeriodEffectiveStake(..., bool _isIncrease) private {
    uint256 effectiveStake = _calculateEffectiveStake($, _tokenId); // Uses current params
    uint256 currentValue = $.delegatorsEffectiveStake[_validator].upperLookup(_period);
    uint256 updatedValue = _isIncrease ? currentValue + effectiveStake : currentValue - effectiveStake;
    $.delegatorsEffectiveStake[_validator].push(_period, SafeCast.toUint224(updatedValue));
}
```

- `Levels.sol:285-316` - Admin can update `scaledRewardFactor` at any time via `LEVEL_OPERATOR_ROLE`.

**INCORRECT Claim:**
- Reporter states `vetAmountRequiredToStake` affects existing tokens → **FALSE**
- `vetAmountRequiredToStake` only gates NEW token minting (Stargate.sol:224)
- Existing tokens use stored `token.vetAmountStaked` which is **immutable** post-mint
- **Only `scaledRewardFactor` affects effective stake calculation for existing tokens**

---

## Call Chain Trace

**Scenario: User unstakes after admin updates scaledRewardFactor**

1. **EOA → Stargate.unstake(_tokenId)**
   - Caller: User EOA
   - msg.sender: User address
   - Function: External, requires `onlyTokenOwner` modifier
   - Context: User-initiated transaction

2. **Stargate.unstake → _updatePeriodEffectiveStake(..., false)**
   - Caller: Stargate (line 276)
   - Callee: Internal private function
   - Call type: Internal
   - Context: Same contract storage ($), no msg.sender change
   - Key argument: `_isIncrease = false` (decrease path)

3. **_updatePeriodEffectiveStake → _calculateEffectiveStake($_tokenId)**
   - Caller: Internal (line 1001)
   - Callee: Internal view function
   - Call type: Internal read-only
   - Returns: `effectiveStake` using **current** parameters

4. **_calculateEffectiveStake → StargateNFT.getToken() & getLevel()**
   - Caller: Stargate contract
   - Callee: StargateNFT (external contract, line 1024-1025)
   - Call type: External view (staticcall)
   - msg.sender: Stargate address
   - Returns: Current `token.vetAmountStaked` and current `level.scaledRewardFactor`

5. **Arithmetic operation (line 1009):**
   - `updatedValue = currentValue - effectiveStake`
   - If `effectiveStake > currentValue` → **Solidity 0.8 unchecked arithmetic reverts**
   - Revert propagates: _updatePeriodEffectiveStake → unstake → User transaction fails

**No reentrancy windows identified.** All external calls are view-only staticcalls.

---

## State Scope & Context Audit

### Storage Variables:

1. **`$.delegatorsEffectiveStake[_validator]`**
   - Location: `Stargate` contract storage
   - Type: `mapping(address => Checkpoints.Trace224)`
   - Scope: **Global per validator**
   - Key derivation: Direct validator address (no assembly)
   - Checkpoint mechanism: OpenZeppelin `Checkpoints.Trace224`
   - Tracks: Effective stake sum across all delegators, checkpointed by period
   - Access pattern: `upperLookup(_period)` reads, `push(_period, value)` writes

2. **`$.levels[_levelId].scaledRewardFactor`**
   - Location: `StargateNFT` contract storage
   - Type: `uint64` within `DataTypes.Level` struct
   - Scope: **Global per level ID**
   - Key derivation: Direct levelId mapping key
   - Mutability: **Admin-writable** via `Levels.updateLevel()` (LEVEL_OPERATOR_ROLE)
   - No historical versioning - updates overwrite

3. **`$.tokens[_tokenId].vetAmountStaked`**
   - Location: `StargateNFT` contract storage
   - Type: `uint256` within `DataTypes.Token` struct
   - Scope: **Per tokenId**
   - Mutability: **Immutable** after mint (set once in mint, read in calculations)
   - Not affected by level parameter updates

### Context Variable Usage:
- `msg.sender`: Used for authorization in `onlyTokenOwner` modifier (line 177-184)
- No assembly storage slot manipulation
- No delegatecall usage in traced paths

---

## Exploit Feasibility

**Can unprivileged EOA execute end-to-end exploit? NO**

### Prerequisites:
1. Admin with `LEVEL_OPERATOR_ROLE` must call `StargateNFT.updateLevel()` to modify `scaledRewardFactor`
2. This must occur AFTER tokens have been delegated with old parameters
3. User then attempts unstake/delegate/requestDelegationExit

### Attack Classification:
- **NOT an unprivileged exploit** (violates Core-4 requirement)
- **Requires privileged admin action** performing normal operations (Core-7 applies)
- **Not social engineering** - admin performs documented function
- **Not governance manipulation** - direct role-based access control

### Per Core-4:
> "Only accept attacks that a normal, unprivileged account can initiate."

This fails Core-4. However, Core-7 states:
> "If impact depends on a privileged user performing fully normal/ideal actions, confirm that the loss arises from an intrinsic protocol logic flaw."

**Assessment:** Admin updating reward parameters is **normal/expected protocol operation** (not malicious). The DOS arises from **intrinsic design flaw** (not saving historical parameters). This qualifies under Core-7 but is downgraded in severity due to admin dependency.

### Per Core-5:
> "Centralization issues are out of scope for this audit."

**Assessment:** This is NOT purely centralization. While triggered by admin, the root cause is a **logic bug** (asymmetric accounting), not admin privilege itself. If admin can cause protocol malfunction through normal operations, it's a protocol design issue, not centralization risk.

---

## Economic Analysis

### Scenario 1: Admin **increases** `scaledRewardFactor`

**Example:**
- T0: User delegates tokenId #1 with 10,000 VET, `scaledRewardFactor = 150`
  - `effectiveStake = 10,000 * 150 / 100 = 15,000`
  - `delegatorsEffectiveStake[validator] += 15,000 → 15,000`
- T1: Admin updates `scaledRewardFactor = 200` (to incentivize staking)
- T2: User attempts unstake:
  - New `effectiveStake = 10,000 * 200 / 100 = 20,000`
  - Decrease operation: `15,000 - 20,000 = underflow`
  - **Transaction reverts** (Solidity 0.8 overflow protection)

**Impact:**
- User **cannot unstake**, **cannot exit delegation**, **cannot change validator**
- Funds **temporarily locked** (not permanently lost)
- **Workaround exists:** Admin reverts `scaledRewardFactor` to ≤150, user can then exit
- **User can still claim rewards** during lock period

**Attacker P&L:** N/A (no attacker, user is victim of protocol limitation)

**User Loss:** Liquidity locked + opportunity cost. No principal loss if admin corrects parameters.

### Scenario 2: Admin **decreases** `scaledRewardFactor`

**Example:**
- T0: User delegates with 10,000 VET, `scaledRewardFactor = 150`
  - `delegatorsEffectiveStake[validator] = 15,000`
- T1: Admin updates `scaledRewardFactor = 100`
- T2: User unstakes:
  - New `effectiveStake = 10,000 * 100 / 100 = 10,000`
  - Decrease: `15,000 - 10,000 = 5,000` (residual remains)
  - **Succeeds but leaves 5,000 accounting residual**

**Impact on reward calculation (Stargate.sol:829-855):**
```solidity
return (effectiveStake * delegationPeriodRewards) / delegatorsEffectiveStake;
```
- Denominator `delegatorsEffectiveStake` is **inflated** by residual
- User receives **lower rewards** than entitled
- Residual dilutes all future delegators' rewards for that validator

**Economic Loss:**
- Per-user loss: Small percentage reduction in rewards
- Cumulative: Depends on validator's total delegations and residual magnitude
- **NOT exploitable by attacker** - harm is diffuse across all delegators

**Sensitivity:**
- Severity scales with parameter change magnitude
- Larger decreases → larger residual → more significant dilution

### Economic Viability Assessment:

**Attacker ROI:** N/A - No attacker exists (admin is not attacker)

**Protocol Risk:**
- Scenario 1: **Temporary DOS**, reversible, no permanent loss → **Low economic risk**
- Scenario 2: **Accounting drift**, affects future rewards, small per-user impact → **Low economic risk**

**Per Core-3:**
> "Trace one end-to-end attack/business flow and analyze the true input–output ratio (ROI/EV)."

This is NOT an attack flow. No malicious actor profits. This is a **protocol operational risk**, not an exploitable vulnerability.

---

## Dependency/Library Reading Notes

### OpenZeppelin Checkpoints Library (v4.x)

**Trace224 Type:**
- Uses 224-bit values with 32-bit keys (periods)
- `upperLookup(key)`: Binary search for latest checkpoint ≤ key
- `push(key, value)`: Adds new checkpoint, overwrites if same key
- **No built-in historical parameter tracking**

**Critical Observation:**
The library stores VALUES at checkpoints, not the PARAMETERS used to compute those values. When parameters change, past checkpoints remain unchanged (correct), but future operations use new parameters (asymmetric if subtract/add are mismatched).

**Library Behavior Confirmed from Code:**
- No bugs in OpenZeppelin implementation
- The asymmetry is a **design issue in Stargate's usage**, not library fault
- Checkpoints work as intended; Stargate's logic assumes parameter immutability

---

## Feature-vs-Bug Assessment

**Is this intended behavior?**

**Evidence for "Feature":**
1. `Levels.sol:134-136` comment: "Use carefully, all fields are updated" - implies updates are allowed
2. No explicit guard preventing updates while tokens are delegated
3. LEVEL_OPERATOR_ROLE suggests operational parameter tuning is expected

**Evidence for "Bug":**
1. No documentation warning about impact on existing delegations
2. No event emission or user notification when parameters change
3. No grace period or migration mechanism for affected tokens
4. Violates accounting invariant: Σ(increases) should equal Σ(decreases) for same token

**Verdict: BUG (Design Flaw)**

This is **not** a intentional design. The protocol SHOULD:
- Option A: Store original effectiveStake at delegation time (snapshot parameters)
- Option B: Prevent level updates while tokens are delegated
- Option C: Implement parameter versioning with smooth transitions

Current behavior is **unintended consequence of incomplete design**, not a feature.

**Minimal Fix:**
Store `effectiveStake` value when increasing (line 461):
```solidity
uint256 effectiveStake = _calculateEffectiveStake($, _tokenId);
$.tokenEffectiveStakeSnapshot[_tokenId] = effectiveStake; // ADD THIS
```
Use snapshot when decreasing (line 568):
```solidity
uint256 effectiveStake = $.tokenEffectiveStakeSnapshot[_tokenId]; // USE SNAPSHOT
```

---

## Final Adjudication

### Verdict: **Informational / Low Severity**

### Reasoning:

**Why NOT False Positive:**
1. Logic flaw objectively exists in code
2. Can cause user-impacting DOS under specific conditions
3. Breaks accounting invariants (mathematical proof provided above)

**Why Downgraded from "High":**
1. **Violates Core-4:** Requires privileged admin action (normal users cannot trigger)
2. **No permanent economic loss:** Admin can reverse changes to unblock users
3. **No attacker profit motive:** This is operational risk, not exploitable vulnerability
4. **Incorrect claim included:** Reporter's `vetAmountRequiredToStake` claim is factually wrong
5. **Per Core-1:** No "practical economic risk in reality" - losses are temporary and reversible

**Why NOT "False Positive":**
1. **Core-7 applies:** Admin performing normal operations causing protocol malfunction IS in scope
2. **Not centralization (Core-5):** Root cause is logic bug, not admin power itself
3. **Per Core-8:** This is confirmed as BUG, not feature

### Classification:
- **Severity:** Informational / Low
- **Type:** Protocol Design Limitation
- **Exploitability:** None (requires admin)
- **Economic Impact:** Temporary, reversible
- **Accuracy:** Reporter 50% correct (scaledRewardFactor yes, vetAmountRequiredToStake no)

---

## Corrected Impact Assessment

**User Impact:**
- IF admin increases scaledRewardFactor: Temporary inability to unstake/exit (DOS)
- IF admin decreases scaledRewardFactor: Slight reduction in future rewards (accounting drift)
- NO principal loss in either case
- Admin can mitigate by reverting parameter changes

**Accounting Invariant:**
- Broken: `Σ(effectiveStake_increase) ≠ Σ(effectiveStake_decrease)` after parameter changes
- Impact: Period snapshots become inaccurate for future periods only
- Past periods unaffected (checkpoints are immutable)

**Audit/Reconciliation:**
- Requires off-chain tracking of parameter history to explain residuals
- Does NOT prevent on-chain operation (protocol remains functional)

---

## Recommendations

1. **Short-term:** Document that level parameter updates affect existing delegations; advise caution
2. **Medium-term:** Implement parameter update freeze during active delegation periods
3. **Long-term:** Refactor to snapshot effectiveStake at delegation time (store in mapping)

---

## 简要中文总结

**结论：信息类 / 低严重性（非误报）**

**确认的问题：**
- `scaledRewardFactor` 的更新确实会导致有效质押计算不对称
- 增加参数时可能导致用户无法退出（下溢回退）
- 减少参数时会留下记账残差

**错误的声明：**
- `vetAmountRequiredToStake` 不影响已有代币的有效质押计算（仅影响新铸造）

**为何降级：**
1. 需要管理员权限触发（违反 Core-4）
2. 无永久性资金损失（管理员可回退参数解锁）
3. 无攻击者获利（这是运营风险，非可利用漏洞）
4. 报告包含事实性错误（vetAmountRequiredToStake 部分）

**建议：**
- 在代理时快照 effectiveStake 值，而非每次重新计算
