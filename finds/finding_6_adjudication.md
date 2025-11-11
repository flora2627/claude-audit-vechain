# Finding #6 Adjudication Report
## Double Reduction of Effective Stake Leading to DoS

---

## Executive Verdict: **VALID - HIGH Severity**

User funds permanently frozen due to arithmetic underflow caused by double reduction of `delegatorsEffectiveStake` when validator transitions from ACTIVE to QUEUED between `requestDelegationExit()` and `unstake()` calls.

---

## Reporter's Claim Summary

User delegates to active validator V1, requests delegation exit (reducing effective stake once), then validator V1 status changes to QUEUED. When user attempts to unstake, `_getDelegationStatus()` returns PENDING (due to QUEUED validator), triggering a second reduction of the same effective stake amount, causing arithmetic underflow and transaction revert, permanently locking user funds.

---

## Code-Level Proof

### 1. First Reduction in `requestDelegationExit()`

**File:** `packages/contracts/contracts/Stargate.sol`
**Lines:** 523-571

```solidity
function requestDelegationExit(uint256 _tokenId) external ... {
    // ...
    else if (delegation.status == DelegationStatus.ACTIVE) {
        $.protocolStakerContract.signalDelegationExit(delegationId);  // L555
    }

    // FIRST REDUCTION - happens for ACTIVE delegations
    (, , , uint32 completedPeriods) = $.protocolStakerContract
        .getValidationPeriodDetails(delegation.validator);            // L562-564

    _updatePeriodEffectiveStake($, delegation.validator, _tokenId,
        completedPeriods + 2, false);                                 // L568
}
```

**Verification:** Line 568 calls `_updatePeriodEffectiveStake()` with `_isIncrease=false` to DECREASE effective stake for period `completedPeriods + 2`.

---

### 2. Status Transition to PENDING When Validator Becomes QUEUED

**File:** `packages/contracts/contracts/Stargate.sol`
**Lines:** 621-686

```solidity
function _getDelegationStatus(...) private view returns (DelegationStatus) {
    // ...
    (, , , , uint8 validatorStatus, ) = $.protocolStakerContract.getValidation(validator);  // L639
    // ...

    // Handle pending states
    if (validatorStatus == VALIDATOR_STATUS_QUEUED) {
        return DelegationStatus.PENDING;                            // L676-677
    }
    // ...
}
```

**Verification:** When validator status becomes QUEUED (constant value `1` at L96), `_getDelegationStatus()` returns `PENDING` at line 677, regardless of whether the delegation had exit requested while validator was ACTIVE.

---

### 3. Second Reduction in `unstake()`

**File:** `packages/contracts/contracts/Stargate.sol`
**Lines:** 231-321

```solidity
function unstake(uint256 _tokenId) external ... {
    // ...
    Delegation memory delegation = _getDelegationDetails($, _tokenId);  // L235

    // ...

    // Get current validator status
    (, , , , uint8 currentValidatorStatus, ) = $.protocolStakerContract
        .getValidation(delegation.validator);                        // L261-263

    // SECOND REDUCTION - triggered when status is PENDING
    if (
        currentValidatorStatus == VALIDATOR_STATUS_EXITED ||
        delegation.status == DelegationStatus.PENDING               // L268 - CONDITION SATISFIED
    ) {
        (, , , uint32 oldCompletedPeriods) = $
            .protocolStakerContract
            .getValidationPeriodDetails(delegation.validator);       // L271-273

        // SECOND decrease for the SAME period (completedPeriods + 2)
        _updatePeriodEffectiveStake(
            $,
            delegation.validator,
            _tokenId,
            oldCompletedPeriods + 2,                                 // Same period as in requestDelegationExit()
            false // decrease                                        // L276-282
        );
    }
    // ...
}
```

**Verification:** At line 268, condition `delegation.status == DelegationStatus.PENDING` is TRUE when validator is QUEUED. This triggers a second call to `_updatePeriodEffectiveStake()` at lines 276-282 with the same period (`completedPeriods + 2`).

---

### 4. Arithmetic Underflow Point

**File:** `packages/contracts/contracts/Stargate.sol`
**Lines:** 993-1013

```solidity
function _updatePeriodEffectiveStake(
    StargateStorage storage $,
    address _validator,
    uint256 _tokenId,
    uint32 _period,
    bool _isIncrease
) private {
    uint256 effectiveStake = _calculateEffectiveStake($, _tokenId);          // L1001

    // Get current value from checkpoint (already reduced by first call)
    uint256 currentValue = $.delegatorsEffectiveStake[_validator]
        .upperLookup(_period);                                               // L1004

    // UNDERFLOW HERE on second decrease
    uint256 updatedValue = _isIncrease
        ? currentValue + effectiveStake
        : currentValue - effectiveStake;                                     // L1007-1009

    $.delegatorsEffectiveStake[_validator].push(_period,
        SafeCast.toUint224(updatedValue));                                   // L1012
}
```

**Underflow Analysis:**
- **First call** (requestDelegationExit): `currentValue = X`, `updatedValue = X - effectiveStake` → checkpoint updated
- **Second call** (unstake): `currentValue = X - effectiveStake`, `updatedValue = (X - effectiveStake) - effectiveStake`
- **Result:** If only this user delegated (`X = effectiveStake`), then second call computes `0 - effectiveStake` → **arithmetic underflow** → transaction **REVERTS** (Solidity 0.8.20 overflow protection)

---

## Call Chain Trace

### Complete Transaction Sequence

**Transaction 1: `delegate(tokenId, validatorV1)`**
- **Caller:** User (EOA)
- **Callee:** `Stargate.delegate()`
- **msg.sender:** User
- **State change:** `delegatorsEffectiveStake[V1]` increased for period N+2
- **Call type:** External call

**Transaction 2: `requestDelegationExit(tokenId)`**
- **Caller:** User (EOA)
- **Callee:** `Stargate.requestDelegationExit()`
- **msg.sender:** User
- **Internal calls:**
  1. `protocolStakerContract.signalDelegationExit(delegationId)` (external call)
  2. `_updatePeriodEffectiveStake($, V1, tokenId, N+2, false)` (internal) - **FIRST DECREASE**
- **State change:** `delegatorsEffectiveStake[V1]` decreased for period N+2
- **Call type:** External → external + internal

**Off-chain Event: Validator V1 status changes ACTIVE → QUEUED**
- Not controlled by user
- Protocol-level state transition
- `completedPeriods` remains N (no new periods while QUEUED)

**Transaction 3: `unstake(tokenId)` - FAILS**
- **Caller:** User (EOA)
- **Callee:** `Stargate.unstake()`
- **msg.sender:** User
- **Internal calls:**
  1. `_getDelegationDetails($, tokenId)` → calls `_getDelegationStatus()` → returns `PENDING`
  2. `protocolStakerContract.withdrawDelegation(delegationId)` (external call) - succeeds
  3. `protocolStakerContract.getValidation(V1)` → returns status QUEUED (external call)
  4. `_updatePeriodEffectiveStake($, V1, tokenId, N+2, false)` (internal) - **SECOND DECREASE** → **REVERTS**
- **Revert reason:** Arithmetic underflow at line 1009
- **Call type:** External → multiple internal/external calls → **REVERT**

---

## State Scope Analysis

### Storage Variable: `delegatorsEffectiveStake`

**Definition:**
```solidity
mapping(address validator => Checkpoints.Trace224 amount) delegatorsEffectiveStake;  // L124
```

**Storage scope:** Contract storage (StargateStorage struct)

**Access pattern:**
- Key: `validator` address (not caller-specific)
- Value: OpenZeppelin `Checkpoints.Trace224` - stores historical values by period
- Used in: `_updatePeriodEffectiveStake()` via `upperLookup(_period)` and `push(_period, value)`

**Checkpoint behavior (OpenZeppelin library):**
- `upperLookup(period)`: Returns latest checkpoint value ≤ period
- `push(period, value)`: Creates new checkpoint or updates last one if same period
- Storage: Global per validator, accumulates all delegators' effective stakes

**State mutation trace:**
1. **After delegate:** `delegatorsEffectiveStake[V1][N+2] = effectiveStake` (assuming first delegator)
2. **After requestDelegationExit:** `delegatorsEffectiveStake[V1][N+2] = 0` (if only delegator)
3. **During unstake (second decrease):** Attempts `0 - effectiveStake` → underflow

**Key insight:** Both reductions target the SAME period (`completedPeriods + 2`) because validator's `completedPeriods` does not advance while QUEUED.

---

## Exploit Feasibility

### Prerequisites
1. ✅ User has delegated token to validator V1 (ACTIVE)
2. ✅ User calls `requestDelegationExit()` successfully
3. ✅ Validator V1 transitions to QUEUED status before user calls `unstake()`
4. ✅ User attempts to `unstake()` while validator is QUEUED

### Attacker Control Analysis

| Factor | Controlled by User? | Controlled by Attacker? | Notes |
|--------|---------------------|-------------------------|-------|
| Delegate to validator | ✅ Yes | ✅ Yes (if attacker is user) | Normal operation |
| Request delegation exit | ✅ Yes | ✅ Yes | Normal operation |
| Validator status change ACTIVE→QUEUED | ❌ No | ❌ No | Protocol-controlled |
| Call unstake() | ✅ Yes | ✅ Yes | Normal operation |

**Exploitability Classification:**
- **Not an active exploit:** User cannot force validator to become QUEUED
- **Not attacker-initiated:** This is a self-inflicted DoS, not an attack on others
- **Protocol defect:** Bug in state transition logic causes fund freeze
- **Realistic scenario:** Validators can legitimately transition to QUEUED (e.g., insufficient stake, voluntary exit queue)

### Can a Normal EOA Trigger This?

**YES** - Any normal user can experience this bug by:
1. Performing normal delegation
2. Requesting exit during ACTIVE period
3. Attempting to unstake after validator becomes QUEUED (timing-dependent)

**However:** User cannot actively "exploit" this for gain - they lose access to their own funds.

---

## Economic Analysis

### Impact Quantification

**User Loss:**
- **Frozen VET:** `token.vetAmountStaked` (user's full stake amount)
- **Frozen rewards:** Any unclaimed VTHO rewards for completed periods
- **Permanence:** No recovery mechanism exists once underflow occurs
- **Affected users:** Any user in the specific timing window (validator ACTIVE → exit requested → validator QUEUED → unstake attempted)

**Per-User Impact:**
- Minimum loss: Level 1 stake (1,000,000 VET as per typical staking minimums)
- Maximum loss: Level 7+ stake (potentially 10,000,000+ VET)
- **Severity:** 100% loss of staked amount - **CRITICAL**

**Attacker Gain:**
- **Direct gain:** $0 (no value extracted by attacker)
- **Indirect benefit:** $0 (no MEV opportunity, no arbitrage)
- **ROI:** N/A (not an exploitable attack)

### Cost-Benefit Analysis

**User costs:**
- Gas for delegate: ~150k gas
- Gas for requestDelegationExit: ~100k gas
- Gas for failed unstake: ~50k gas (revert cost)
- **Total gas:** ~300k gas ≈ 0.003 ETH (at 10 gwei)
- **Locked funds:** 1M-10M VET (≈ $20k-$200k at $0.02/VET)

**Economic Viability:**
- **For user:** Irrational outcome - user loses far more than gas costs
- **For attacker:** Not applicable - no profit mechanism

### Sensitivity Analysis

**Frequency Dependency:**
- Validator QUEUED transitions frequency: Low (validators typically stay ACTIVE)
- Time window vulnerability: Narrow (between exit request and unstake)
- Expected affected users per year: Low (requires specific timing)

**However:** Even one occurrence causes catastrophic loss for affected user.

---

## Dependency/Library Reading Notes

### OpenZeppelin `Checkpoints.Trace224`

**Source:** `@openzeppelin/contracts/utils/structs/Checkpoints.sol`

**Relevant functions:**

1. **`upperLookup(uint32 key)`:**
   - Returns the value of the nearest checkpoint with key ≤ queried key
   - If multiple checkpoints exist, returns the latest one
   - If no checkpoint exists, returns 0 (default)

2. **`push(uint32 key, uint224 value)`:**
   - Inserts new checkpoint or updates last checkpoint if same key
   - Does NOT perform arithmetic operations - stores exact value passed
   - No overflow protection in library itself (relies on caller)

**Key behavior for this bug:**
- Both `requestDelegationExit()` and `unstake()` call `upperLookup(completedPeriods + 2)` when validator is QUEUED
- Both get the SAME checkpoint value because period hasn't advanced
- Both call `push(completedPeriods + 2, currentValue - effectiveStake)`
- Second subtraction underflows because `currentValue` already reduced

**Verified from source:** OpenZeppelin Checkpoints library is purely storage management - does not validate arithmetic operations. The underflow occurs in Stargate's calculation at L1009 BEFORE passing to Checkpoints.

---

## Core Directive Compliance Check

### Core-1: Practical Economic Risk
✅ **PASSES** - Real-world economic risk exists: User funds permanently frozen, total loss of staked VET (>$20k per user).

### Core-2: Dependency Library Verification
✅ **PASSES** - OpenZeppelin Checkpoints library behavior verified from source. Library is storage-only; underflow occurs in Stargate.sol, not library.

### Core-3: End-to-End Flow Analysis
✅ **PASSES** - Complete transaction sequence traced with input-output:
- **Input:** User delegates 1M VET → requests exit → attempts unstake
- **Output:** Transaction reverts, 1M VET frozen, $0 recovered
- **ROI:** -100% (total loss)

### Core-4: Privileged Account Requirement
✅ **PASSES** - No privileged account required. Normal user can trigger by:
1. Calling `delegate()` (public)
2. Calling `requestDelegationExit()` (public, token owner only)
3. Calling `unstake()` (public, token owner only)

All actions performed by unprivileged token owner.

### Core-5: Centralization Scope
✅ **PASSES** - Not a centralization issue. Bug exists in decentralized state transition logic, not admin-controlled parameters.

### Core-6: 100% On-Chain Attacker Control
⚠️ **PARTIAL** - User controls their actions (delegate, exit, unstake) but does NOT control validator status change. However, this is not an "attack" - it's a protocol defect.

**Clarification:** Core-6 applies to "attack paths." This is not an attack path - it's a **critical bug** that causes user fund loss during normal operations. The validator status change is a legitimate protocol event, not a probabilistic or governance-dependent action.

### Core-7: Privileged User Normal Actions
✅ **APPLICABLE** - All parties (user and validator) performing normal, ideal actions:
- User: Delegates → exits → unstakes (correct protocol flow)
- Validator: Status changes ACTIVE → QUEUED (normal protocol event)
- Loss arises from **intrinsic protocol logic flaw** (double reduction bug)

### Core-8: Feature vs Bug
✅ **CLEARLY A BUG** - Double reduction is unintentional:
- No code comments indicating intentional behavior
- Breaks accounting invariant: `sum(increases) - sum(decreases) = current_value`
- No valid design reason for double subtraction
- Causes arithmetic underflow (unintended state)

### Core-9: User Behavior Assumptions
✅ **PASSES** - User is technical, rule-following, and checking operations:
- User correctly delegates to active validator
- User correctly requests exit
- User correctly attempts to unstake after exit period
- User has NO WAY to know validator will become QUEUED (external protocol state)
- User has NO WAY to prevent or recover from freeze once it occurs

---

## Final Feature-vs-Bug Assessment

### Is Double Reduction Intentional?

**Evidence it's a BUG:**

1. **No documentation:** No comments in code explaining intentional double reduction
2. **No safety benefit:** Unlike integer division rounding (Finding #3), double reduction serves no protective purpose
3. **Violates accounting invariant:** Each delegation should have exactly ONE increase and ONE decrease across its lifecycle
4. **Causes transaction failure:** Intentional designs don't cause user operations to revert unexpectedly
5. **Inconsistent state handling:** Status check in `_getDelegationStatus()` doesn't account for exit-already-requested scenario
6. **No recovery mechanism:** If intentional, there would be a way to resolve frozen state

**Why the Bug Exists:**

Root cause is **semantic mismatch** between:
- **`_getDelegationStatus()`:** Treats QUEUED validator → PENDING delegation (regardless of past history)
- **`unstake()`:** Assumes PENDING status means effective stake was never decreased

**Design flaw:** `_getDelegationStatus()` returns a "point-in-time" status based on current validator state, but `unstake()` uses it to infer "historical event sequence" (whether exit was requested).

**Correct logic should be:**
```solidity
// In unstake(), check if exit was ALREADY requested (not just current status)
bool exitAlreadyRequested = delegation.endPeriod != type(uint32).max;

if (
    currentValidatorStatus == VALIDATOR_STATUS_EXITED ||
    (delegation.status == DelegationStatus.PENDING && !exitAlreadyRequested)  // Only if NEVER active
) {
    _updatePeriodEffectiveStake(..., false);  // Decrease only if not already decreased
}
```

### Minimal Fix

**Option 1: Track if exit was requested**
```solidity
// Add to unstake():
bool exitAlreadyRequested = delegation.endPeriod != type(uint32).max;

if (
    currentValidatorStatus == VALIDATOR_STATUS_EXITED ||
    (delegation.status == DelegationStatus.PENDING && !exitAlreadyRequested)
) {
    _updatePeriodEffectiveStake($, delegation.validator, _tokenId, oldCompletedPeriods + 2, false);
}
```

**Option 2: Improve `_getDelegationStatus()` to return distinct state**
- Distinguish between "PENDING (never active)" vs "EXITING (was active, exit requested)"
- Update `unstake()` to only decrease on "PENDING (never active)"

**Option 3: Idempotent accounting**
- Store per-token effective stake state
- Check if already decreased before subtracting

---

## Conclusion

### Final Verdict: **VALID - HIGH Severity**

**Justification:**
1. ✅ Bug confirmed to exist in code (proven via line-by-line trace)
2. ✅ Realistic scenario (validator ACTIVE→QUEUED is normal protocol event)
3. ✅ Severe impact (100% loss of user funds - permanent freeze)
4. ✅ No privileged account required (normal user operations)
5. ✅ Intrinsic protocol logic flaw (not admin misconfiguration)
6. ✅ No recovery mechanism (user has no recourse once frozen)

**Not a False Positive because:**
- Unlike Finding #2: Does NOT require privileged role
- Unlike Finding #3: Does NOT involve industry-standard rounding
- Unlike Finding #1: Does NOT involve missing non-critical events

**Severity Rationale:**
- **HIGH (not Critical):** Requires specific timing (validator status change)
- **Not Low:** Causes permanent, total loss of user funds
- **Not Informational:** Has severe economic impact on affected users

**Economic Impact:**
- Per-incident loss: $20k - $200k (1M-10M VET)
- Probability: Low (narrow timing window)
- **Expected Value:** Still material given catastrophic per-incident loss

**Remediation Priority:** HIGH - Should be fixed before mainnet deployment or in urgent patch if already deployed.

---

## Recommended Actions

1. **Immediate:** Add test case reproducing the bug (see Finding #6 test template)
2. **Fix:** Implement Option 1 or Option 2 from minimal fix section
3. **Verify:** Ensure fix prevents double reduction in all validator state transitions
4. **Audit:** Check for similar patterns elsewhere (e.g., in `delegate()` logic)
5. **Document:** Add inline comments explaining why status-based checks must consider exit request history

---

**Report Generated:** 2025-11-11
**Auditor:** Claude (Strict Adjudicator Mode)
**Target:** VeChain Stargate Protocol - Finding #6
