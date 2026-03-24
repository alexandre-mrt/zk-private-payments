// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IHasher
/// @notice Interface for the Poseidon hash precompile or deployed contract
interface IHasher {
    /// @notice Computes the Poseidon hash of two field elements
    /// @param inputs Array of exactly two field elements to hash
    /// @return The Poseidon hash digest as a field element
    function poseidon(uint256[2] calldata inputs) external pure returns (uint256);
}

/// @title MerkleTree
/// @notice Incremental Merkle tree using Poseidon hashing over the BN254 scalar field.
/// @dev Leaves are appended left-to-right. The tree keeps a rolling history of
///      ROOT_HISTORY_SIZE recent roots so that ZK proofs generated against a slightly
///      stale root remain valid even after subsequent deposits. The ring-buffer of roots
///      is stored in `roots` and the current write position in `currentRootIndex`.
///
///      Zero-value initialisation: every subtree that has not received a leaf yet is
///      treated as if it were filled with the canonical zero leaf (value 0). The initial
///      zero values for each level are pre-computed in the constructor by hashing
///      Poseidon(0,0) repeatedly up the tree. `filledSubtrees[i]` always holds the
///      rightmost non-empty subtree hash at level i, falling back to the zero value for
///      that level when no leaf has been inserted on the right-hand side yet.
contract MerkleTree {
    /// @notice The BN254 (alt_bn128) scalar field size. All leaf and node values must be
    ///         strictly less than this constant to remain valid field elements.
    uint256 public constant FIELD_SIZE =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    /// @notice Number of recent roots retained in the ring buffer.
    /// @dev A ZK proof referencing any of the last ROOT_HISTORY_SIZE roots will be
    ///      accepted. This window accommodates the time between proof generation and
    ///      on-chain submission without requiring regeneration after every deposit.
    uint32 public constant ROOT_HISTORY_SIZE = 30;

    /// @notice The deployed Poseidon hasher used for all tree node computations
    IHasher public immutable hasher;

    /// @notice Depth of the Merkle tree; the tree can hold 2^levels leaves
    uint32 public immutable levels;

    /// @notice Stores the current right-most filled subtree hash at each level.
    /// @dev Index 0 corresponds to the leaf level, index `levels-1` to the level just
    ///      below the root. When a new leaf is appended at an even position, the element
    ///      at that level is updated to the new leaf hash so subsequent odd-index siblings
    ///      can use it.
    uint256[] public filledSubtrees;

    /// @notice Ring buffer storing the last ROOT_HISTORY_SIZE Merkle roots
    uint256[] public roots;

    /// @notice Index into `roots` pointing to the most recently written root
    uint32 public currentRootIndex;

    /// @notice Index of the next leaf slot to be filled (0-based)
    uint32 public nextIndex;

    /// @notice Deploys the Merkle tree and precomputes zero-value subtrees for all levels
    /// @dev Iterates from level 0 upward, deriving each zero value as
    ///      Poseidon(zeroBelow, zeroBelow). The empty-tree root is stored at roots[0].
    /// @param _levels Depth of the tree (1 – 32 inclusive)
    /// @param _hasher Address of the deployed IHasher (Poseidon) contract
    constructor(uint32 _levels, address _hasher) {
        require(_levels > 0 && _levels <= 32, "MerkleTree: levels out of range");
        require(_hasher != address(0), "MerkleTree: hasher is zero address");
        levels = _levels;
        hasher = IHasher(_hasher);

        uint256 currentZero = 0;
        for (uint32 i = 0; i < _levels; i++) {
            filledSubtrees.push(currentZero);
            currentZero = hashLeftRight(currentZero, currentZero);
        }
        roots = new uint256[](ROOT_HISTORY_SIZE);
        roots[0] = currentZero;
    }

    /// @notice Computes Poseidon(_left, _right) for two field elements
    /// @dev Both inputs must be strictly less than FIELD_SIZE; reverts otherwise.
    /// @param _left  Left child hash
    /// @param _right Right child hash
    /// @return The parent node hash
    function hashLeftRight(uint256 _left, uint256 _right) public view returns (uint256) {
        require(_left < FIELD_SIZE, "MerkleTree: left overflow");
        require(_right < FIELD_SIZE, "MerkleTree: right overflow");
        return hasher.poseidon([_left, _right]);
    }

    /// @notice Appends a new leaf to the tree and recomputes the root path
    /// @dev For each level i, the algorithm determines whether the current node sits on
    ///      an even (left) or odd (right) position. If even, it becomes the new
    ///      filledSubtrees[i] and pairs with the stored zero sibling. If odd, it pairs
    ///      with the previously stored filledSubtrees[i]. The resulting root is written
    ///      to the ring buffer at the next slot. Reverts when the tree is full.
    /// @param _leaf Leaf value to insert; must be a valid field element
    /// @return index The zero-based leaf index at which the leaf was inserted
    function _insert(uint256 _leaf) internal returns (uint32 index) {
        uint32 _nextIndex = nextIndex;
        require(_nextIndex < uint32(2) ** levels, "MerkleTree: tree is full");
        uint32 currentIndex = _nextIndex;
        uint256 currentLevelHash = _leaf;

        for (uint32 i = 0; i < levels; i++) {
            uint256 left;
            uint256 right;
            if (currentIndex % 2 == 0) {
                left = currentLevelHash;
                right = filledSubtrees[i];
                filledSubtrees[i] = currentLevelHash;
            } else {
                left = filledSubtrees[i];
                right = currentLevelHash;
            }
            currentLevelHash = hashLeftRight(left, right);
            currentIndex /= 2;
        }

        uint32 newRootIndex = (currentRootIndex + 1) % ROOT_HISTORY_SIZE;
        currentRootIndex = newRootIndex;
        roots[newRootIndex] = currentLevelHash;
        nextIndex = _nextIndex + 1;
        return _nextIndex;
    }

    /// @notice Checks whether a given root is present in the recent-root ring buffer
    /// @dev Traverses the ring buffer backwards from the most recent root. A zero root
    ///      is always rejected to prevent accidental acceptance of an uninitialised slot.
    ///      The search wraps around the ring buffer and stops after a full traversal.
    /// @param _root The Merkle root to look up
    /// @return True if `_root` matches one of the last ROOT_HISTORY_SIZE roots, false otherwise
    function isKnownRoot(uint256 _root) public view returns (bool) {
        if (_root == 0) {
            return false;
        }
        uint32 _currentRootIndex = currentRootIndex;
        uint32 i = _currentRootIndex;
        do {
            if (_root == roots[i]) {
                return true;
            }
            if (i == 0) {
                i = ROOT_HISTORY_SIZE;
            }
            i--;
        } while (i != _currentRootIndex);
        return false;
    }

    /// @notice Returns the most recently computed Merkle root
    /// @return The root hash at the current ring-buffer position
    function getLastRoot() public view returns (uint256) {
        return roots[currentRootIndex];
    }

    /// @notice Returns the maximum number of leaves the tree can hold
    function getTreeCapacity() external view returns (uint256) {
        return uint256(2) ** levels;
    }

    /// @notice Returns the current tree utilization as a percentage (0-100)
    function getTreeUtilization() external view returns (uint256) {
        uint256 capacity = uint256(2) ** levels;
        if (capacity == 0) return 0;
        return (uint256(nextIndex) * 100) / capacity;
    }

    /// @notice Returns true if the tree still has space for new deposits
    function hasCapacity() external view returns (bool) {
        return nextIndex < uint32(2) ** levels;
    }

    /// @notice Returns all roots in the history buffer (including zero entries for unused slots)
    function getRootHistory() external view returns (uint256[] memory) {
        uint256[] memory history = new uint256[](ROOT_HISTORY_SIZE);
        for (uint32 i = 0; i < ROOT_HISTORY_SIZE; i++) {
            history[i] = roots[i];
        }
        return history;
    }

    /// @notice Returns the number of valid (non-zero) roots in history
    function getValidRootCount() external view returns (uint32) {
        uint32 count = 0;
        for (uint32 i = 0; i < ROOT_HISTORY_SIZE; i++) {
            if (roots[i] != 0) count++;
        }
        return count;
    }
}
