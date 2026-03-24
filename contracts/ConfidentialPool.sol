// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./MerkleTree.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface ITransferVerifier {
    function verifyProof(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256[4] calldata _pubSignals // [root, nullifier, outputCommitment1, outputCommitment2]
    ) external view returns (bool);
}

interface IWithdrawVerifier {
    function verifyProof(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256[5] calldata _pubSignals // [root, nullifier, amount, recipient, changeCommitment]
    ) external view returns (bool);
}

contract ConfidentialPool is MerkleTree, ReentrancyGuard, Pausable, Ownable {
    ITransferVerifier public immutable transferVerifier;
    IWithdrawVerifier public immutable withdrawVerifier;

    mapping(uint256 => bool) public nullifiers;
    mapping(uint256 => bool) public commitments;

    event Deposit(
        uint256 indexed commitment,
        uint32 leafIndex,
        uint256 amount,
        uint256 timestamp
    );
    event Transfer(
        uint256 indexed nullifier,
        uint256 outputCommitment1,
        uint256 outputCommitment2
    );
    event Withdrawal(
        uint256 indexed nullifier,
        uint256 amount,
        address recipient,
        uint256 changeCommitment
    );

    constructor(
        address _transferVerifier,
        address _withdrawVerifier,
        uint32 _merkleTreeHeight,
        address _hasher
    ) MerkleTree(_merkleTreeHeight, _hasher) Ownable(msg.sender) {
        require(_transferVerifier != address(0), "ConfidentialPool: zero transfer verifier");
        require(_withdrawVerifier != address(0), "ConfidentialPool: zero withdraw verifier");
        transferVerifier = ITransferVerifier(_transferVerifier);
        withdrawVerifier = IWithdrawVerifier(_withdrawVerifier);
    }

    /// @notice Pause the pool — only owner, for emergency use
    function pause() external onlyOwner { _pause(); }

    /// @notice Unpause the pool — only owner
    function unpause() external onlyOwner { _unpause(); }

    /// @notice Deposit ETH and create a note commitment
    /// @param _commitment Poseidon(amount, blinding, ownerPubKeyX)
    function deposit(uint256 _commitment) external payable nonReentrant whenNotPaused {
        require(msg.value > 0, "ConfidentialPool: zero deposit");
        require(_commitment != 0, "ConfidentialPool: zero commitment");
        require(_commitment < FIELD_SIZE, "ConfidentialPool: commitment >= field size");
        require(!commitments[_commitment], "ConfidentialPool: duplicate commitment");

        uint32 insertedIndex = _insert(_commitment);
        commitments[_commitment] = true;

        emit Deposit(_commitment, insertedIndex, msg.value, block.timestamp);
    }

    /// @notice Confidential transfer — spend a note, create 2 new notes
    function transfer(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256 _root,
        uint256 _nullifier,
        uint256 _outputCommitment1,
        uint256 _outputCommitment2
    ) external nonReentrant whenNotPaused {
        require(!nullifiers[_nullifier], "ConfidentialPool: nullifier already spent");
        require(isKnownRoot(_root), "ConfidentialPool: unknown root");
        require(
            _outputCommitment1 != 0 && _outputCommitment2 != 0,
            "ConfidentialPool: zero output commitment"
        );
        require(
            _outputCommitment1 < FIELD_SIZE && _outputCommitment2 < FIELD_SIZE,
            "ConfidentialPool: output commitment >= field size"
        );

        uint256[4] memory pubSignals = [
            _root,
            _nullifier,
            _outputCommitment1,
            _outputCommitment2
        ];

        require(
            transferVerifier.verifyProof(_pA, _pB, _pC, pubSignals),
            "ConfidentialPool: invalid transfer proof"
        );

        nullifiers[_nullifier] = true;

        _insert(_outputCommitment1);
        commitments[_outputCommitment1] = true;

        _insert(_outputCommitment2);
        commitments[_outputCommitment2] = true;

        emit Transfer(_nullifier, _outputCommitment1, _outputCommitment2);
    }

    /// @notice Withdraw to plaintext ETH
    function withdraw(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256 _root,
        uint256 _nullifier,
        uint256 _amount,
        address payable _recipient,
        uint256 _changeCommitment
    ) external nonReentrant whenNotPaused {
        require(!nullifiers[_nullifier], "ConfidentialPool: nullifier already spent");
        require(isKnownRoot(_root), "ConfidentialPool: unknown root");
        require(_recipient != address(0), "ConfidentialPool: zero recipient");
        require(_amount > 0, "ConfidentialPool: zero withdrawal amount");
        require(address(this).balance >= _amount, "ConfidentialPool: insufficient pool balance");

        uint256[5] memory pubSignals = [
            _root,
            _nullifier,
            _amount,
            uint256(uint160(address(_recipient))),
            _changeCommitment
        ];

        require(
            withdrawVerifier.verifyProof(_pA, _pB, _pC, pubSignals),
            "ConfidentialPool: invalid withdrawal proof"
        );

        // All state writes before ETH transfer (reentrancy protection)
        nullifiers[_nullifier] = true;

        if (_changeCommitment != 0) {
            require(
                _changeCommitment < FIELD_SIZE,
                "ConfidentialPool: change commitment >= field size"
            );
            _insert(_changeCommitment);
            commitments[_changeCommitment] = true;
        }

        (bool success, ) = _recipient.call{value: _amount}("");
        require(success, "ConfidentialPool: ETH transfer failed");

        emit Withdrawal(_nullifier, _amount, _recipient, _changeCommitment);
    }
}
