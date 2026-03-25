// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IConfidentialPool {
    function withdraw(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256 _root,
        uint256 _nullifier,
        uint256 _amount,
        address payable _recipient,
        uint256 _changeCommitment,
        address payable _relayer,
        uint256 _fee
    ) external;
}

/// @notice Malicious contract that attempts to reenter ConfidentialPool.withdraw inside receive().
/// Used only in tests to verify the ReentrancyGuard blocks reentrant calls.
contract ReentrancyAttacker {
    IConfidentialPool public pool;
    uint256 public attackCount;

    uint256 public savedRoot;
    uint256 public savedNullifier;
    uint256 public savedAmount;

    constructor(address _pool) {
        pool = IConfidentialPool(_pool);
    }

    function attack(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256 _root,
        uint256 _nullifier,
        uint256 _amount
    ) external {
        savedRoot = _root;
        savedNullifier = _nullifier;
        savedAmount = _amount;
        pool.withdraw(
            _pA,
            _pB,
            _pC,
            _root,
            _nullifier,
            _amount,
            payable(address(this)),
            0,
            payable(address(0)),
            0
        );
    }

    receive() external payable {
        attackCount++;
        if (attackCount < 3) {
            uint256 newNullifier = savedNullifier + attackCount;
            uint256[2] memory zero2 = [uint256(0), 0];
            uint256[2][2] memory zero22 = [[uint256(0), 0], [uint256(0), 0]];
            try pool.withdraw(
                zero2,
                zero22,
                zero2,
                savedRoot,
                newNullifier,
                savedAmount,
                payable(address(this)),
                0,
                payable(address(0)),
                0
            ) {
                // Should never reach here — ReentrancyGuard must block this
            } catch {
                // Expected: reentrant call is rejected
            }
        }
    }
}
