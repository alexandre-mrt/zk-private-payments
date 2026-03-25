// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Test helper: withdraw verifier that always returns false.
/// Used to reliably trigger "ConfidentialPool: invalid withdrawal proof" in tests.
/// NEVER deploy to production.
contract MockFalseWithdrawVerifier {
    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[5] calldata
    ) external pure returns (bool) {
        return false;
    }
}
