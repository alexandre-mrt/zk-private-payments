// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Constants — shared constants for the ZK Private Payments protocol
library PoolConstants {
    /// @notice Merkle tree depth
    uint32 internal constant DEFAULT_TREE_HEIGHT = 20;

    /// @notice Root history buffer size
    uint32 internal constant ROOT_HISTORY_SIZE = 30;

    /// @notice BN254 scalar field size
    uint256 internal constant FIELD_SIZE =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    /// @notice Timelock delay for governance actions
    uint256 internal constant TIMELOCK_DELAY = 1 days;

    /// @notice Maximum number of notes in a batch operation
    uint256 internal constant MAX_BATCH_SIZE = 10;
}
