// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// NIGHT-SHIFT-REVIEW: Placeholder — replace with snarkjs-generated verifier once circuits are compiled
contract WithdrawVerifier {
    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[5] calldata
    ) external view returns (bool) {
        require(block.chainid == 31337, "WithdrawVerifier: placeholder, Hardhat only");
        return true;
    }
}
