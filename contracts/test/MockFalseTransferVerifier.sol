// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Test helper: transfer verifier that always returns false.
/// Used to reliably trigger "ConfidentialPool: invalid transfer proof" in tests.
/// NEVER deploy to production.
contract MockFalseTransferVerifier {
    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[4] calldata
    ) external pure returns (bool) {
        return false;
    }
}
