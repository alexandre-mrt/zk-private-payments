// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./MerkleTree.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title ITransferVerifier
/// @notice Interface for the Groth16 verifier generated from the transfer circuit
/// @dev Public signals layout (index → meaning):
///        0  root              — Merkle root the spent note was proven against
///        1  nullifier         — Unique nullifier of the input note (prevents double-spend)
///        2  outputCommitment1 — Commitment of the first output note
///        3  outputCommitment2 — Commitment of the second output note
interface ITransferVerifier {
    /// @notice Verifies a Groth16 proof for the transfer circuit
    /// @param _pA     Proof element A (G1 point)
    /// @param _pB     Proof element B (G2 point)
    /// @param _pC     Proof element C (G1 point)
    /// @param _pubSignals Public signals: [root, nullifier, outputCommitment1, outputCommitment2]
    /// @return True if the proof is valid for the given public signals
    function verifyProof(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256[4] calldata _pubSignals // [root, nullifier, outputCommitment1, outputCommitment2]
    ) external view returns (bool);
}

/// @title IWithdrawVerifier
/// @notice Interface for the Groth16 verifier generated from the withdraw circuit
/// @dev Public signals layout (index → meaning):
///        0  root             — Merkle root the spent note was proven against
///        1  nullifier        — Unique nullifier of the input note (prevents double-spend)
///        2  amount           — Plaintext ETH amount being withdrawn (in wei)
///        3  recipient        — Recipient address cast to uint256
///        4  changeCommitment — Commitment of the change note (0 if no change)
interface IWithdrawVerifier {
    /// @notice Verifies a Groth16 proof for the withdraw circuit
    /// @param _pA     Proof element A (G1 point)
    /// @param _pB     Proof element B (G2 point)
    /// @param _pC     Proof element C (G1 point)
    /// @param _pubSignals Public signals: [root, nullifier, amount, recipient, changeCommitment]
    /// @return True if the proof is valid for the given public signals
    function verifyProof(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256[5] calldata _pubSignals // [root, nullifier, amount, recipient, changeCommitment]
    ) external view returns (bool);
}

/// @title ConfidentialPool
/// @notice Privacy-preserving ETH pool using a UTXO note model and Groth16 zero-knowledge proofs.
///
/// @dev ## UTXO note model
///      A "note" is a UTXO representing a hidden ETH amount. Its public identity on-chain
///      is a Poseidon commitment:
///          commitment = Poseidon(amount, blinding, ownerPubKeyX)
///      Notes are inserted as leaves into an incremental Poseidon Merkle tree (inherited
///      from MerkleTree). Spending a note requires a ZK proof that the caller knows the
///      preimage of a commitment in the tree, and that proof reveals only a nullifier
///      (Poseidon(commitment, spendingKey)) — never the commitment itself.
///
///      ## Three pool operations
///      1. deposit  — converts plaintext ETH into a note commitment inserted in the tree.
///      2. transfer — proves ownership of one input note and creates two output notes
///                    (no ETH leaves the pool; amounts are hidden inside commitments).
///      3. withdraw — proves ownership of one input note, extracts a plaintext ETH amount,
///                    and optionally creates a change note for the remainder.
///
///      ## Denomination system
///      When at least one denomination has been added via `addDenomination`, every deposit
///      must match an allowed denomination exactly. This provides a uniform privacy set
///      (all deposits look identical). When the list is empty, any non-zero deposit amount
///      is accepted.
///
///      ## Security
///      - ReentrancyGuard: all three pool operations are `nonReentrant`. In `withdraw` all
///        state mutations (nullifier mark, change-note insertion) happen before the ETH
///        transfer (checks-effects-interactions).
///      - Pausable: owner can halt deposits/transfers/withdrawals in an emergency.
///      - Ownable: admin controls denomination list and pause/unpause.
///      - Nullifier registry: once a nullifier is marked spent, the same proof can never
///        be replayed.
///      - Root history: proofs against any of the last ROOT_HISTORY_SIZE roots are valid,
///        preventing forced re-generation due to concurrent deposits.
contract ConfidentialPool is MerkleTree, ReentrancyGuard, Pausable, Ownable {
    /// @notice Verifier for the confidential transfer circuit
    ITransferVerifier public immutable transferVerifier;

    /// @notice Verifier for the withdraw circuit
    IWithdrawVerifier public immutable withdrawVerifier;

    /// @notice Tracks spent nullifiers to prevent double-spending
    /// @dev Maps nullifier hash → true once the corresponding note has been spent
    mapping(uint256 => bool) public nullifiers;

    /// @notice Tracks inserted commitments to prevent duplicate deposits
    /// @dev Maps commitment hash → true once inserted into the Merkle tree
    mapping(uint256 => bool) public commitments;

    /// @notice Denomination allow-list for deposits
    /// @dev When non-empty, every `deposit` call must send exactly one of the listed
    ///      amounts. Maps denomination (in wei) → true if allowed.
    mapping(uint256 => bool) public allowedDenominations;

    /// @notice Ordered list of all denominations ever added (including removed ones that
    ///         are now false in `allowedDenominations`)
    /// @dev Used by `getDenominations` to enumerate the list without an extra mapping.
    ///      Callers must cross-reference `allowedDenominations` for the current status.
    uint256[] public denominationList;

    /// @notice Emitted when a new note commitment is deposited into the pool
    /// @param commitment  Poseidon commitment of the new note
    /// @param leafIndex   Position in the Merkle tree where the commitment was inserted
    /// @param amount      ETH amount in wei sent with the deposit
    /// @param timestamp   Block timestamp at the time of deposit
    event Deposit(
        uint256 indexed commitment,
        uint32 leafIndex,
        uint256 amount,
        uint256 timestamp
    );

    /// @notice Emitted when a confidential transfer is executed
    /// @param nullifier        Nullifier of the consumed input note
    /// @param outputCommitment1 Commitment of the first output note
    /// @param outputCommitment2 Commitment of the second output note
    event Transfer(
        uint256 indexed nullifier,
        uint256 outputCommitment1,
        uint256 outputCommitment2
    );

    /// @notice Emitted when ETH is withdrawn from the pool
    /// @param nullifier       Nullifier of the consumed input note
    /// @param amount          ETH amount in wei transferred to the recipient
    /// @param recipient       Address that received the ETH
    /// @param changeCommitment Commitment of the change note (0 if no change)
    event Withdrawal(
        uint256 indexed nullifier,
        uint256 amount,
        address recipient,
        uint256 changeCommitment
    );

    /// @notice Emitted when a new denomination is added to the allow-list
    /// @param denomination The denomination value in wei
    event DenominationAdded(uint256 denomination);

    /// @notice Emitted when a denomination is removed from the allow-list
    /// @param denomination The denomination value in wei
    event DenominationRemoved(uint256 denomination);

    /// @notice Deploys the pool and wires up both verifiers and the Merkle tree
    /// @param _transferVerifier  Address of the deployed ITransferVerifier contract
    /// @param _withdrawVerifier  Address of the deployed IWithdrawVerifier contract
    /// @param _merkleTreeHeight  Depth of the incremental Merkle tree (passed to MerkleTree)
    /// @param _hasher            Address of the deployed Poseidon hasher contract
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

    /// @notice Pauses all deposit, transfer, and withdrawal operations
    /// @dev Only callable by the owner. Use in emergencies to halt the pool.
    function pause() external onlyOwner { _pause(); }

    /// @notice Unpauses the pool and resumes normal operation
    /// @dev Only callable by the owner.
    function unpause() external onlyOwner { _unpause(); }

    /// @notice Adds a denomination to the allow-list
    /// @dev When the list is non-empty, deposits must match an allowed denomination.
    ///      Only callable by the owner. Reverts if the denomination is already present.
    /// @param _denomination The deposit amount in wei to allow
    function addDenomination(uint256 _denomination) external onlyOwner {
        require(_denomination > 0, "ConfidentialPool: zero denomination");
        require(!allowedDenominations[_denomination], "ConfidentialPool: denomination exists");
        allowedDenominations[_denomination] = true;
        denominationList.push(_denomination);
        emit DenominationAdded(_denomination);
    }

    /// @notice Removes a denomination from the allow-list
    /// @dev The denomination is marked as disallowed but remains in `denominationList`.
    ///      Only callable by the owner. Reverts if the denomination was not previously added.
    /// @param _denomination The deposit amount in wei to disallow
    function removeDenomination(uint256 _denomination) external onlyOwner {
        require(allowedDenominations[_denomination], "ConfidentialPool: denomination not found");
        allowedDenominations[_denomination] = false;
        emit DenominationRemoved(_denomination);
    }

    /// @notice Returns the full list of denominations that have ever been added
    /// @dev The returned array may contain denominations that have since been removed.
    ///      Check `allowedDenominations[d]` for the current status of each entry.
    /// @return Array of denomination values in wei
    function getDenominations() external view returns (uint256[] memory) {
        return denominationList;
    }

    /// @notice Deposits ETH into the pool and inserts a note commitment into the Merkle tree
    /// @dev The caller computes the commitment off-chain as Poseidon(amount, blinding, ownerPubKeyX)
    ///      and sends `msg.value` equal to `amount`. If the denomination list is non-empty,
    ///      `msg.value` must match exactly one allowed denomination. The commitment must be a
    ///      valid field element and must not already exist in the tree.
    /// @param _commitment Poseidon(amount, blinding, ownerPubKeyX) — the note commitment
    function deposit(uint256 _commitment) external payable nonReentrant whenNotPaused {
        require(msg.value > 0, "ConfidentialPool: zero deposit");
        if (denominationList.length > 0) {
            require(
                allowedDenominations[msg.value],
                "ConfidentialPool: amount not an allowed denomination"
            );
        }
        require(_commitment != 0, "ConfidentialPool: zero commitment");
        require(_commitment < FIELD_SIZE, "ConfidentialPool: commitment >= field size");
        require(!commitments[_commitment], "ConfidentialPool: duplicate commitment");

        uint32 insertedIndex = _insert(_commitment);
        commitments[_commitment] = true;

        emit Deposit(_commitment, insertedIndex, msg.value, block.timestamp);
    }

    /// @notice Executes a confidential transfer: spends one input note and creates two output notes
    /// @dev No ETH moves in or out of the pool. The caller provides a Groth16 proof
    ///      demonstrating knowledge of the input note's preimage and that the input amount
    ///      equals the sum of the two output amounts (enforced inside the circuit).
    ///      Public signals passed to the verifier in order:
    ///        [0] _root              — Merkle root the input note was proven against
    ///        [1] _nullifier         — Nullifier of the input note
    ///        [2] _outputCommitment1 — Commitment of output note 1
    ///        [3] _outputCommitment2 — Commitment of output note 2
    /// @param _pA               Groth16 proof element A
    /// @param _pB               Groth16 proof element B
    /// @param _pC               Groth16 proof element C
    /// @param _root             Merkle root the proof was generated against
    /// @param _nullifier        Nullifier of the input note being spent
    /// @param _outputCommitment1 Commitment of the first output note
    /// @param _outputCommitment2 Commitment of the second output note
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

    /// @notice Withdraws a plaintext ETH amount from the pool to a recipient address
    /// @dev The caller provides a Groth16 proof demonstrating knowledge of an input note
    ///      whose amount covers `_amount`. Any remainder is committed as a change note
    ///      and re-inserted into the tree. Pass `_changeCommitment = 0` if the note is
    ///      consumed exactly with no change.
    ///      Public signals passed to the verifier in order:
    ///        [0] _root             — Merkle root the input note was proven against
    ///        [1] _nullifier        — Nullifier of the input note
    ///        [2] _amount           — Plaintext ETH amount to withdraw (in wei)
    ///        [3] _recipient        — Recipient address cast to uint256
    ///        [4] _changeCommitment — Change note commitment (0 if no change)
    ///      All state mutations (nullifier + change note) occur before the ETH transfer
    ///      to follow the checks-effects-interactions pattern and guard against reentrancy.
    /// @param _pA              Groth16 proof element A
    /// @param _pB              Groth16 proof element B
    /// @param _pC              Groth16 proof element C
    /// @param _root            Merkle root the proof was generated against
    /// @param _nullifier       Nullifier of the input note being spent
    /// @param _amount          ETH amount in wei to send to `_recipient`
    /// @param _recipient       Payable address that will receive the ETH
    /// @param _changeCommitment Commitment of the change note; use 0 if no change
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
