// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IHasher {
    function poseidon(uint256[2] calldata inputs) external pure returns (uint256);
}

contract MerkleTree {
    uint256 public constant FIELD_SIZE =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint32 public constant ROOT_HISTORY_SIZE = 30;

    IHasher public immutable hasher;
    uint32 public immutable levels;

    uint256[] public filledSubtrees;
    uint256[] public roots;
    uint32 public currentRootIndex;
    uint32 public nextIndex;

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

    function hashLeftRight(uint256 _left, uint256 _right) public view returns (uint256) {
        require(_left < FIELD_SIZE, "MerkleTree: left overflow");
        require(_right < FIELD_SIZE, "MerkleTree: right overflow");
        return hasher.poseidon([_left, _right]);
    }

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

    function getLastRoot() public view returns (uint256) {
        return roots[currentRootIndex];
    }
}
