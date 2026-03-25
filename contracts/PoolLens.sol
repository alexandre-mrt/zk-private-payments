// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ConfidentialPool.sol";

/// @title PoolLens — read-only aggregator for ConfidentialPool data
/// @notice Reduces RPC calls by fetching all dashboard data in one call
contract PoolLens {
    struct PoolSnapshot {
        // Pool stats
        uint256 totalDeposited;
        uint256 totalWithdrawn;
        uint256 totalTransfers;
        uint256 depositCount;
        uint256 withdrawalCount;
        uint256 uniqueDepositors;
        uint256 poolBalance;
        // Tree info
        uint256 activeNotes;
        uint256 treeCapacity;
        uint256 treeUtilization;
        uint256 lastRoot;
        // Config
        bool isPaused;
        bool allowlistEnabled;
        uint256 maxWithdrawAmount;
        uint256 minDepositAge;
        uint256 maxDepositsPerAddress;
        address owner;
        string version;
    }

    /// @notice Aggregates all ConfidentialPool dashboard data into a single call
    /// @param _pool Address of the ConfidentialPool contract to query
    /// @return snapshot All relevant pool state at the current block
    function getSnapshot(address _pool) external view returns (PoolSnapshot memory snapshot) {
        ConfidentialPool pool = ConfidentialPool(payable(_pool));

        (
            uint256 td,
            uint256 tw,
            uint256 tt,
            uint256 dc,
            uint256 wc,
            uint256 ud,
            uint256 pb
        ) = pool.getPoolStats();

        snapshot = PoolSnapshot({
            totalDeposited: td,
            totalWithdrawn: tw,
            totalTransfers: tt,
            depositCount: dc,
            withdrawalCount: wc,
            uniqueDepositors: ud,
            poolBalance: pb,
            activeNotes: pool.getActiveNoteCount(),
            treeCapacity: pool.getTreeCapacity(),
            treeUtilization: pool.getTreeUtilization(),
            lastRoot: pool.getLastRoot(),
            isPaused: pool.paused(),
            allowlistEnabled: pool.allowlistEnabled(),
            maxWithdrawAmount: pool.maxWithdrawAmount(),
            minDepositAge: pool.minDepositAge(),
            maxDepositsPerAddress: pool.maxDepositsPerAddress(),
            owner: pool.owner(),
            version: pool.getVersion()
        });
    }
}
