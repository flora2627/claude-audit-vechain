# Finding 5: Arithmetic Underflow in Effective Stake Accounting Causes Permanent Loss of Funds

## 1. Summary

A logic flaw in the stake accounting mechanism leads to a double-decrease of a user's effective stake under specific, non-user-controlled conditions. When a user requests a delegation exit and the associated validator subsequently exits the network or has its status changed to `QUEUED`, any attempt by the user to `unstake` or re-`delegate` will trigger an arithmetic underflow. This reverts the transaction, permanently locking the user's VET principal in the protocol with no available recovery mechanism for the user.

## 2. Vulnerability Details

The vulnerability is triggered by a sequence of legitimate user actions combined with a subsequent change in validator status, which is outside the user's control.

1.  A user stakes VET and delegates to a validator. A checkpoint is created for their `effectiveStake`.
2.  The user calls `requestDelegationExit()`. This function correctly decreases the `effectiveStake` for future periods by writing a new checkpoint with a value of zero. This constitutes the **first decrease**.
3.  The validator's on-chain status changes. This can happen in two ways:
    *   The validator exits the network (its status becomes `VALIDATOR_STATUS_EXITED`).
    *   The validator's status is changed to `QUEUED`, which in turn changes the user's `delegation.status` to `PENDING`.
4.  The user then calls `unstake()` or `delegate()` to a new validator. Both functions contain a conditional check that is now satisfied due to the validator's status change.

    ```solidity
    // Location: Stargate.sol#unstake()
    if (
        currentValidatorStatus == VALIDATOR_STATUS_EXITED ||
        delegation.status == DelegationStatus.PENDING
    ) {
        // ...
        _updatePeriodEffectiveStake(
            // ...
            false // decrease
        );
    }
    ```

    This block is now executed, triggering the **second decrease** on a stake that has already been zeroed out in preparation for exit.

5.  Inside `_updatePeriodEffectiveStake()`, the `Checkpoints.upperLookup` function retrieves the most recent checkpoint value, which is `0` (from the first decrease). The code then attempts to calculate `currentValue - effectiveStake` (i.e., `0 - effectiveStake`), which causes an arithmetic underflow and reverts the entire transaction.

## 3. Impact

*   **Permanent Loss of Funds:** Users who encounter this scenario will have their VET tokens permanently locked in the `ProtocolStaker` contract. The `unstake` and `delegate` functions become irrevocably unusable for their NFT, preventing them from ever retrieving their principal investment.
*   **Protocol Insolvency for Affected Delegations:** The protocol's liability (the `vetAmountStaked` recorded in the NFT) can no longer be settled. This breaks the core accounting invariant that all staked funds must be redeemable.
*   **No User-Side Mitigation:** Once funds are locked, there is no action a user can take to recover them. The only recovery path is through a privileged contract upgrade performed by the `DEFAULT_ADMIN_ROLE`.
*   **Systemic Risk:** While the trigger is conditional on validator status, validator churn is an expected and normal part of any proof-of-stake network's lifecycle. Therefore, any user who has requested to exit their delegation is at risk of permanent fund loss if their validator exits or is temporarily suspended for any reason. The vulnerability punishes users for following the intended protocol flow.

## 4. References

*   **Proof of Concept:** [`packages/contracts/test/unit/Stargate/Finding5_POC.test.ts`](./packages/contracts/test/unit/Stargate/Finding5_POC.test.ts)
*   **Flawed Logic in `unstake()`:** [`packages/contracts/contracts/Stargate.sol#L266-L283`](./packages/contracts/contracts/Stargate.sol#L266-L283)
*   **Flawed Logic in `delegate()`:** [`packages/contracts/contracts/Stargate.sol#L398-L413`](./packages/contracts/contracts/Stargate.sol#L398-L413)
*   **Underflow Location in `_updatePeriodEffectiveStake()`:** [`packages/contracts/contracts/Stargate.sol#L994-L1012`](./packages/contracts/contracts/Stargate.sol#L994-L1012)
