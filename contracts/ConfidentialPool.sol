// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./MerkleTree.sol";
import "./DepositReceipt.sol";
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

    /// @notice Chain ID at deployment time — used to prevent cross-chain replay attacks.
    uint256 public immutable deployedChainId;

    /// @notice Tracks spent nullifiers to prevent double-spending
    /// @dev Maps nullifier hash → true once the corresponding note has been spent
    mapping(uint256 => bool) public nullifiers;

    /// @notice Tracks inserted commitments to prevent duplicate deposits
    /// @dev Maps commitment hash → true once inserted into the Merkle tree
    mapping(uint256 => bool) public commitments;

    /// @notice Maps a commitment to its leaf index in the Merkle tree.
    /// Allows clients to look up the tree position of any commitment without scanning events.
    mapping(uint256 => uint32) public commitmentIndex;

    /// @notice Reverse lookup: maps a leaf index to its commitment.
    /// Allows clients to retrieve the commitment at any tree position without scanning events.
    mapping(uint32 => uint256) public indexToCommitment;

    /// @notice Denomination allow-list for deposits
    /// @dev When non-empty, every `deposit` call must send exactly one of the listed
    ///      amounts. Maps denomination (in wei) → true if allowed.
    mapping(uint256 => bool) public allowedDenominations;

    /// @notice Ordered list of all denominations ever added (including removed ones that
    ///         are now false in `allowedDenominations`)
    /// @dev Used by `getDenominations` to enumerate the list without an extra mapping.
    ///      Callers must cross-reference `allowedDenominations` for the current status.
    uint256[] public denominationList;

    /// @notice Maximum ETH amount allowed per withdrawal transaction (in wei)
    /// @dev When set to 0, no per-transaction cap is enforced.
    uint256 public maxWithdrawAmount;

    /// @notice Block number of the most recent deposit (single or batch)
    /// @dev Updated on every deposit call. Used to enforce the minimum deposit age.
    uint256 public lastDepositBlock;

    /// @notice Minimum number of blocks that must elapse after the last deposit before any withdrawal is allowed
    /// @dev When set to 0 (default), the restriction is disabled. Prevents flash-in / flash-out attacks.
    uint256 public minDepositAge;

    /// @notice Whether the depositor allowlist is active
    /// @dev When false (default), any address may deposit. When true, only allowlisted addresses may deposit.
    bool public allowlistEnabled;

    /// @notice Tracks addresses approved to deposit when the allowlist is active
    /// @dev Maps address → true if allowed to deposit
    mapping(address => bool) public allowlisted;

    /// @notice Maximum number of deposits allowed per address (0 = unlimited).
    /// @dev Prevents a single address from dominating the anonymity set.
    uint256 public maxDepositsPerAddress;

    /// @notice Tracks the number of deposits made by each address.
    mapping(address => uint256) public depositsPerAddress;

    /// @notice Minimum seconds that must elapse between deposits from the same address (0 = no cooldown).
    uint256 public depositCooldown;

    /// @notice Tracks the last deposit timestamp per address for cooldown enforcement.
    mapping(address => uint256) public lastDepositTime;

    // -------------------------------------------------------------------------
    // Analytics / stats
    // -------------------------------------------------------------------------

    /// @notice Cumulative ETH deposited into the pool (in wei)
    uint256 public totalDeposited;

    /// @notice Cumulative ETH withdrawn from the pool (in wei)
    uint256 public totalWithdrawn;

    /// @notice Total number of confidential transfers executed
    uint256 public totalTransfers;

    /// @notice Total number of withdrawal operations executed
    uint256 public withdrawalCount;

    // -------------------------------------------------------------------------
    // Withdrawal receipts
    // -------------------------------------------------------------------------

    /// @notice Immutable record of a single withdrawal for auditability
    struct WithdrawalRecord {
        uint256 nullifier;
        uint256 amount;
        address recipient;
        uint256 timestamp;
        uint256 blockNumber;
    }

    /// @notice Ordered list of every withdrawal record (append-only)
    WithdrawalRecord[] public withdrawalRecords;

    // -------------------------------------------------------------------------
    // Deposit receipt NFT
    // -------------------------------------------------------------------------

    /// @notice Optional soulbound ERC721 receipt minted on every deposit.
    /// @dev When set to the zero address (default), no receipt is minted.
    DepositReceipt public depositReceipt;

    /// @notice Tracks whether an address has ever deposited (for unique depositor count)
    /// @dev Private — callers use `uniqueDepositorCount` for the aggregated metric.
    mapping(address => bool) private uniqueDepositors;

    /// @notice Number of distinct addresses that have deposited at least once
    uint256 public uniqueDepositorCount;

    // -------------------------------------------------------------------------
    // Timelock governance
    // -------------------------------------------------------------------------

    /// @notice Mandatory delay between queuing a sensitive parameter change and executing it
    uint256 public constant TIMELOCK_DELAY = 1 days;

    /// @notice Represents a governance action pending execution after the timelock delay
    struct PendingAction {
        bytes32 actionHash;
        uint256 executeAfter;
    }

    /// @notice The single pending governance action (only one may be queued at a time)
    PendingAction public pendingAction;

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
    /// @param relayer         Address that submitted the transaction on behalf of the user (address(0) if self-relay)
    /// @param fee             Fee in wei paid to the relayer (0 if self-relay)
    event Withdrawal(
        uint256 indexed nullifier,
        uint256 amount,
        address recipient,
        uint256 changeCommitment,
        address relayer,
        uint256 fee
    );

    /// @notice Emitted when a new denomination is added to the allow-list
    /// @param denomination The denomination value in wei
    event DenominationAdded(uint256 denomination);

    /// @notice Emitted when a denomination is removed from the allow-list
    /// @param denomination The denomination value in wei
    event DenominationRemoved(uint256 denomination);

    /// @notice Emitted when a governance action is queued with its scheduled execution timestamp
    /// @param actionHash  keccak256 hash identifying the action
    /// @param executeAfter Unix timestamp after which the action may be executed
    event ActionQueued(bytes32 indexed actionHash, uint256 executeAfter);

    /// @notice Emitted when a queued governance action is successfully executed
    /// @param actionHash keccak256 hash of the executed action
    event ActionExecuted(bytes32 indexed actionHash);

    /// @notice Emitted when a queued governance action is cancelled by the owner
    /// @param actionHash keccak256 hash of the cancelled action
    event ActionCancelled(bytes32 indexed actionHash);

    /// @notice Emitted when the per-transaction withdrawal cap is updated
    /// @param newMax New maximum withdrawal amount in wei (0 = no limit)
    event MaxWithdrawAmountUpdated(uint256 newMax);

    /// @notice Emitted when the owner drains the pool balance in an emergency
    /// @param to      Recipient address that received the funds
    /// @param amount  ETH amount in wei transferred
    event EmergencyDrain(address indexed to, uint256 amount);

    /// @notice Emitted when the minimum deposit age is updated
    /// @param newAge New minimum age in blocks (0 = disabled)
    event MinDepositAgeUpdated(uint256 newAge);

    /// @notice Emitted when the depositor allowlist is enabled or disabled
    /// @param enabled New state of the allowlist
    event AllowlistToggled(bool enabled);

    /// @notice Emitted when an account is added to or removed from the allowlist
    /// @param account The account whose status changed
    /// @param allowed Whether the account is now allowed
    event AllowlistUpdated(address indexed account, bool allowed);

    /// @notice Emitted when the per-address deposit limit is updated
    /// @param newMax New maximum deposits per address (0 = unlimited)
    event MaxDepositsPerAddressUpdated(uint256 newMax);

    /// @notice Emitted when the deposit cooldown period is updated
    /// @param newCooldown New cooldown duration in seconds (0 = no cooldown)
    event DepositCooldownUpdated(uint256 newCooldown);

    /// @notice Emitted when the deposit receipt contract address is updated
    /// @param receipt New receipt contract address (address(0) to disable)
    event DepositReceiptSet(address indexed receipt);

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
        deployedChainId = block.chainid;
    }

    /// @notice Reverts if the current chain differs from the deployment chain.
    modifier onlyDeployedChain() {
        require(block.chainid == deployedChainId, "wrong chain");
        _;
    }

    /// @notice Validates that the given action is queued and the timelock has expired,
    ///         then clears the pending slot and emits ActionExecuted after the guarded body runs.
    modifier timelockReady(bytes32 _actionHash) {
        require(pendingAction.actionHash == _actionHash, "ConfidentialPool: action not queued");
        require(block.timestamp >= pendingAction.executeAfter, "ConfidentialPool: timelock not expired");
        _;
        delete pendingAction;
        emit ActionExecuted(_actionHash);
    }

    /// @notice Queues a governance action identified by its hash
    /// @dev Only one action may be queued at a time. The action becomes executable
    ///      after TIMELOCK_DELAY seconds. Callers should compute the hash off-chain
    ///      as keccak256(abi.encode(functionSelector, ...params)).
    /// @param _actionHash keccak256 hash identifying the intended action and its parameters
    function queueAction(bytes32 _actionHash) external onlyOwner {
        pendingAction = PendingAction(_actionHash, block.timestamp + TIMELOCK_DELAY);
        emit ActionQueued(_actionHash, block.timestamp + TIMELOCK_DELAY);
    }

    /// @notice Cancels the currently queued governance action
    /// @dev Reverts if no action is pending.
    function cancelAction() external onlyOwner {
        require(pendingAction.actionHash != bytes32(0), "ConfidentialPool: no pending action");
        emit ActionCancelled(pendingAction.actionHash);
        delete pendingAction;
    }

    /// @notice Check if a nullifier has been spent
    function isSpent(uint256 _nullifier) external view returns (bool) {
        return nullifiers[_nullifier];
    }

    /// @notice Check if a commitment exists
    function isCommitted(uint256 _commitment) external view returns (bool) {
        return commitments[_commitment];
    }

    /// @notice Return the leaf index of a commitment in the Merkle tree.
    /// @dev Reverts if the commitment is not present in the tree.
    /// @param _commitment The commitment whose tree position is requested.
    /// @return The zero-based leaf index assigned when the commitment was inserted.
    function getCommitmentIndex(uint256 _commitment) external view returns (uint32) {
        require(commitments[_commitment], "commitment not found");
        return commitmentIndex[_commitment];
    }

    /// @notice Get a range of commitments by index (for pagination)
    /// @param _from  First leaf index to return (inclusive)
    /// @param _count Maximum number of commitments to return
    /// @return Array of commitments from index _from up to min(_from + _count, nextIndex)
    function getCommitments(uint32 _from, uint32 _count) external view returns (uint256[] memory) {
        uint32 end = _from + _count;
        if (end > nextIndex) end = nextIndex;
        if (_from >= end) return new uint256[](0);
        uint256[] memory result = new uint256[](end - _from);
        for (uint32 i = _from; i < end; i++) {
            result[i - _from] = indexToCommitment[i];
        }
        return result;
    }

    /// @notice Get the current deposit count
    function getDepositCount() external view returns (uint32) {
        return nextIndex;
    }

    /// @notice Get pool balance
    function getPoolBalance() external view returns (uint256) {
        return address(this).balance;
    }

    /// @notice Returns the size of the active UTXO set (total insertions - spent nullifiers)
    /// @dev Each deposit inserts 1 commitment (nextIndex++). Each transfer spends 1 nullifier
    ///      and inserts 2 commitments. Each withdrawal spends 1 nullifier and optionally inserts
    ///      a change commitment. The nullifier count equals withdrawalCount + totalTransfers.
    ///      Active notes = total insertions (nextIndex) - total nullifiers spent.
    function getActiveNoteCount() external view returns (uint256) {
        return uint256(nextIndex) - (withdrawalCount + totalTransfers);
    }

    /// @notice Returns comprehensive pool health metrics in one call
    /// @return activeNotes        Current active UTXO note count
    /// @return treeUtilization    Percentage of Merkle tree capacity used (0-100)
    /// @return poolBalance        Current pool ETH balance in wei
    /// @return isPaused           Whether the pool is currently paused
    /// @return isAllowlisted      Whether the depositor allowlist is active
    /// @return currentMaxWithdraw Per-transaction withdrawal cap in wei (0 = no limit)
    /// @return currentMinAge      Minimum block age before withdrawal is allowed (0 = disabled)
    function getPoolHealth() external view returns (
        uint256 activeNotes,
        uint256 treeUtilization,
        uint256 poolBalance,
        bool isPaused,
        bool isAllowlisted,
        uint256 currentMaxWithdraw,
        uint256 currentMinAge
    ) {
        uint256 capacity = uint256(2) ** levels;
        return (
            uint256(nextIndex) - (withdrawalCount + totalTransfers),
            capacity > 0 ? (uint256(nextIndex) * 100) / capacity : 0,
            address(this).balance,
            paused(),
            allowlistEnabled,
            maxWithdrawAmount,
            minDepositAge
        );
    }

    /// @notice Returns a snapshot of all cumulative pool analytics
    /// @return _totalDeposited   Cumulative ETH deposited (wei)
    /// @return _totalWithdrawn   Cumulative ETH withdrawn (wei)
    /// @return _totalTransfers   Total confidential transfers executed
    /// @return _depositCount     Total deposit operations (equals nextIndex)
    /// @return _withdrawalCount  Total withdrawal operations executed
    /// @return _uniqueDepositors Number of distinct depositor addresses
    /// @return _poolBalance      Current pool ETH balance (wei)
    function getPoolStats() external view returns (
        uint256 _totalDeposited,
        uint256 _totalWithdrawn,
        uint256 _totalTransfers,
        uint256 _depositCount,
        uint256 _withdrawalCount,
        uint256 _uniqueDepositors,
        uint256 _poolBalance
    ) {
        return (
            totalDeposited,
            totalWithdrawn,
            totalTransfers,
            nextIndex,
            withdrawalCount,
            uniqueDepositorCount,
            address(this).balance
        );
    }

    /// @notice Sets the maximum number of deposits allowed per address.
    /// @dev Set to 0 to remove the limit (default). Only callable by the owner after timelock.
    ///      Queue with: keccak256(abi.encode("setMaxDepositsPerAddress", _max))
    /// @param _max Maximum deposits per address (0 = unlimited).
    function setMaxDepositsPerAddress(uint256 _max)
        external
        onlyOwner
        timelockReady(keccak256(abi.encode("setMaxDepositsPerAddress", _max)))
    {
        maxDepositsPerAddress = _max;
        emit MaxDepositsPerAddressUpdated(_max);
    }

    /// @notice Sets the per-address deposit cooldown period.
    /// @dev Set to 0 to disable the cooldown (default). Only callable by the owner after timelock.
    ///      Queue with: keccak256(abi.encode("setDepositCooldown", _cooldown))
    /// @param _cooldown Minimum seconds between deposits from the same address (0 = no cooldown).
    function setDepositCooldown(uint256 _cooldown)
        external
        onlyOwner
        timelockReady(keccak256(abi.encode("setDepositCooldown", _cooldown)))
    {
        depositCooldown = _cooldown;
        emit DepositCooldownUpdated(_cooldown);
    }

    /// @notice Returns how many more deposits an address can make.
    /// @dev Returns type(uint256).max when no limit is configured.
    /// @param _addr The address to query.
    /// @return Remaining deposits allowed (type(uint256).max if unlimited).
    function getRemainingDeposits(address _addr) external view returns (uint256) {
        if (maxDepositsPerAddress == 0) return type(uint256).max;
        uint256 used = depositsPerAddress[_addr];
        return used >= maxDepositsPerAddress ? 0 : maxDepositsPerAddress - used;
    }

    /// @notice Pauses all deposit, transfer, and withdrawal operations
    /// @dev Only callable by the owner. Use in emergencies to halt the pool.
    function pause() external onlyOwner { _pause(); }

    /// @notice Unpauses the pool and resumes normal operation
    /// @dev Only callable by the owner.
    function unpause() external onlyOwner { _unpause(); }

    /// @notice Sets the maximum ETH amount that can be withdrawn in a single transaction
    /// @dev Set to 0 to disable the cap. Only callable by the owner after timelock.
    ///      Queue with: keccak256(abi.encode("setMaxWithdrawAmount", _maxAmount))
    /// @param _maxAmount New cap in wei (0 = no limit)
    function setMaxWithdrawAmount(uint256 _maxAmount)
        external
        onlyOwner
        timelockReady(keccak256(abi.encode("setMaxWithdrawAmount", _maxAmount)))
    {
        maxWithdrawAmount = _maxAmount;
        emit MaxWithdrawAmountUpdated(_maxAmount);
    }

    /// @notice Sets the minimum number of blocks that must pass after the last deposit before any withdrawal
    /// @dev Set to 0 to disable (default). Applies pool-wide — not per deposit.
    ///      This prevents flash-loan-style deposit-then-withdraw-in-same-block attacks.
    ///      Only callable by the owner after timelock.
    ///      Queue with: keccak256(abi.encode("setMinDepositAge", _age))
    /// @param _age Minimum block gap required (0 = no restriction)
    function setMinDepositAge(uint256 _age)
        external
        onlyOwner
        timelockReady(keccak256(abi.encode("setMinDepositAge", _age)))
    {
        minDepositAge = _age;
        emit MinDepositAgeUpdated(_age);
    }

    /// @notice Drains the entire pool balance to a target address
    /// @dev Only callable by the owner when the pool is paused. Use in emergencies only.
    /// @param _to Payable address that will receive all pool funds
    function emergencyDrain(address payable _to) external onlyOwner whenPaused {
        require(_to != address(0), "ConfidentialPool: zero drain address");
        uint256 balance = address(this).balance;
        require(balance > 0, "ConfidentialPool: no balance to drain");
        (bool success, ) = _to.call{value: balance}("");
        require(success, "ConfidentialPool: drain transfer failed");
        emit EmergencyDrain(_to, balance);
    }

    /// @notice Enables or disables the depositor allowlist
    /// @dev When enabled, only addresses in `allowlisted` may call `deposit` or `batchDeposit`.
    ///      Only callable by the owner.
    /// @param _enabled True to enable the allowlist, false to disable it
    function setAllowlistEnabled(bool _enabled) external onlyOwner {
        allowlistEnabled = _enabled;
        emit AllowlistToggled(_enabled);
    }

    /// @notice Sets the deposit receipt contract address
    /// @dev Pass address(0) to disable receipt minting. Only callable by the owner.
    ///      Low-risk admin function — no timelock required.
    /// @param _receipt Address of the deployed DepositReceipt contract (or address(0) to disable)
    function setDepositReceipt(address _receipt) external onlyOwner {
        depositReceipt = DepositReceipt(_receipt);
        emit DepositReceiptSet(_receipt);
    }

    /// @notice Adds or removes a single address from the depositor allowlist
    /// @dev Only callable by the owner.
    /// @param _account Address to update
    /// @param _allowed True to allow, false to revoke
    function setAllowlisted(address _account, bool _allowed) external onlyOwner {
        allowlisted[_account] = _allowed;
        emit AllowlistUpdated(_account, _allowed);
    }

    /// @notice Adds or removes multiple addresses from the depositor allowlist in one call
    /// @dev Only callable by the owner.
    /// @param _accounts Array of addresses to update
    /// @param _allowed  True to allow all, false to revoke all
    function batchSetAllowlisted(address[] calldata _accounts, bool _allowed) external onlyOwner {
        for (uint256 i = 0; i < _accounts.length; i++) {
            allowlisted[_accounts[i]] = _allowed;
            emit AllowlistUpdated(_accounts[i], _allowed);
        }
    }

    /// @notice Adds a denomination to the allow-list
    /// @dev When the list is non-empty, deposits must match an allowed denomination.
    ///      Only callable by the owner after timelock. Reverts if the denomination is already present.
    ///      Queue with: keccak256(abi.encode("addDenomination", _denomination))
    /// @param _denomination The deposit amount in wei to allow
    function addDenomination(uint256 _denomination)
        external
        onlyOwner
        timelockReady(keccak256(abi.encode("addDenomination", _denomination)))
    {
        require(_denomination > 0, "ConfidentialPool: zero denomination");
        require(!allowedDenominations[_denomination], "ConfidentialPool: denomination exists");
        allowedDenominations[_denomination] = true;
        denominationList.push(_denomination);
        emit DenominationAdded(_denomination);
    }

    /// @notice Removes a denomination from the allow-list
    /// @dev The denomination is marked as disallowed but remains in `denominationList`.
    ///      Only callable by the owner after timelock. Reverts if the denomination was not previously added.
    ///      Queue with: keccak256(abi.encode("removeDenomination", _denomination))
    /// @param _denomination The deposit amount in wei to disallow
    function removeDenomination(uint256 _denomination)
        external
        onlyOwner
        timelockReady(keccak256(abi.encode("removeDenomination", _denomination)))
    {
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
    function deposit(uint256 _commitment) external payable nonReentrant whenNotPaused onlyDeployedChain {
        if (allowlistEnabled) {
            require(allowlisted[msg.sender], "ConfidentialPool: sender not allowlisted");
        }
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
        if (maxDepositsPerAddress > 0) {
            require(depositsPerAddress[msg.sender] < maxDepositsPerAddress, "ConfidentialPool: deposit limit reached");
        }
        if (depositCooldown > 0) {
            require(block.timestamp >= lastDepositTime[msg.sender] + depositCooldown, "ConfidentialPool: deposit cooldown active");
        }

        uint32 insertedIndex = _insert(_commitment);
        commitments[_commitment] = true;
        commitmentIndex[_commitment] = insertedIndex;
        indexToCommitment[insertedIndex] = _commitment;
        lastDepositBlock = block.number;
        lastDepositTime[msg.sender] = block.timestamp;
        depositsPerAddress[msg.sender]++;

        totalDeposited += msg.value;
        if (!uniqueDepositors[msg.sender]) {
            uniqueDepositors[msg.sender] = true;
            uniqueDepositorCount++;
        }

        emit Deposit(_commitment, insertedIndex, msg.value, block.timestamp);

        if (address(depositReceipt) != address(0)) {
            depositReceipt.mint(msg.sender, _commitment, msg.value);
        }
    }

    /// @notice Deposit multiple notes in a single transaction for gas efficiency.
    /// @param _commitments Array of note commitments
    /// @param _amounts Array of ETH amounts for each commitment
    function batchDeposit(
        uint256[] calldata _commitments,
        uint256[] calldata _amounts
    ) external payable nonReentrant whenNotPaused onlyDeployedChain {
        if (allowlistEnabled) {
            require(allowlisted[msg.sender], "ConfidentialPool: sender not allowlisted");
        }
        require(_commitments.length == _amounts.length, "ConfidentialPool: arrays length mismatch");
        require(_commitments.length > 0, "ConfidentialPool: empty batch");
        require(_commitments.length <= 10, "ConfidentialPool: batch too large");
        if (maxDepositsPerAddress > 0) {
            require(
                depositsPerAddress[msg.sender] + _commitments.length <= maxDepositsPerAddress,
                "ConfidentialPool: deposit limit reached"
            );
        }
        if (depositCooldown > 0) {
            require(block.timestamp >= lastDepositTime[msg.sender] + depositCooldown, "ConfidentialPool: deposit cooldown active");
        }

        uint256 totalAmount = 0;
        for (uint256 i = 0; i < _amounts.length; i++) {
            totalAmount += _amounts[i];
        }
        require(msg.value == totalAmount, "ConfidentialPool: incorrect total amount");

        for (uint256 i = 0; i < _commitments.length; i++) {
            require(_commitments[i] != 0, "ConfidentialPool: zero commitment");
            require(_commitments[i] < FIELD_SIZE, "ConfidentialPool: commitment >= field size");
            require(!commitments[_commitments[i]], "ConfidentialPool: duplicate commitment");
            require(_amounts[i] > 0, "ConfidentialPool: zero amount in batch");

            if (denominationList.length > 0) {
                require(allowedDenominations[_amounts[i]], "ConfidentialPool: amount not an allowed denomination");
            }

            uint32 insertedIndex = _insert(_commitments[i]);
            commitments[_commitments[i]] = true;
            commitmentIndex[_commitments[i]] = insertedIndex;
            indexToCommitment[insertedIndex] = _commitments[i];

            emit Deposit(_commitments[i], insertedIndex, _amounts[i], block.timestamp);

            if (address(depositReceipt) != address(0)) {
                depositReceipt.mint(msg.sender, _commitments[i], _amounts[i]);
            }
        }
        lastDepositBlock = block.number;
        lastDepositTime[msg.sender] = block.timestamp;
        depositsPerAddress[msg.sender] += _commitments.length;

        totalDeposited += msg.value;
        if (!uniqueDepositors[msg.sender]) {
            uniqueDepositors[msg.sender] = true;
            uniqueDepositorCount++;
        }
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
    ) external nonReentrant whenNotPaused onlyDeployedChain {
        require(_nullifier < FIELD_SIZE, "ConfidentialPool: nullifier >= field size");
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

        uint32 index1 = _insert(_outputCommitment1);
        commitments[_outputCommitment1] = true;
        commitmentIndex[_outputCommitment1] = index1;
        indexToCommitment[index1] = _outputCommitment1;

        uint32 index2 = _insert(_outputCommitment2);
        commitments[_outputCommitment2] = true;
        commitmentIndex[_outputCommitment2] = index2;
        indexToCommitment[index2] = _outputCommitment2;

        totalTransfers++;

        emit Transfer(_nullifier, _outputCommitment1, _outputCommitment2);
    }

    /// @notice Returns the withdrawal record at the given index
    /// @param _index Zero-based index into the withdrawalRecords array
    function getWithdrawalRecord(uint256 _index) external view returns (WithdrawalRecord memory) {
        require(_index < withdrawalRecords.length, "ConfidentialPool: invalid record index");
        return withdrawalRecords[_index];
    }

    /// @notice Returns the total number of withdrawal records stored
    function getWithdrawalRecordCount() external view returns (uint256) {
        return withdrawalRecords.length;
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
    ///
    ///      NIGHT-SHIFT-REVIEW: _relayer and _fee are NOT part of the circuit public signals.
    ///      This means a malicious tx submitter could swap the relayer address or inflate the fee
    ///      without invalidating the ZK proof. In production, both should be added as circuit
    ///      signals (as done in zk-mixer) so they are bound by the proof. For now they are
    ///      accepted as unchecked calldata — the user must trust the relayer they designated.
    /// @param _pA              Groth16 proof element A
    /// @param _pB              Groth16 proof element B
    /// @param _pC              Groth16 proof element C
    /// @param _root            Merkle root the proof was generated against
    /// @param _nullifier       Nullifier of the input note being spent
    /// @param _amount          ETH amount in wei to send to `_recipient`
    /// @param _recipient       Payable address that will receive the ETH
    /// @param _changeCommitment Commitment of the change note; use 0 if no change
    /// @param _relayer         Address that submitted the tx on behalf of the user; use address(0) for self-relay
    /// @param _fee             Fee in wei deducted from `_amount` and sent to `_relayer`; use 0 for self-relay
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
    ) external nonReentrant whenNotPaused onlyDeployedChain {
        require(_fee <= _amount, "ConfidentialPool: fee exceeds amount");
        require(_nullifier < FIELD_SIZE, "ConfidentialPool: nullifier >= field size");
        require(!nullifiers[_nullifier], "ConfidentialPool: nullifier already spent");
        require(isKnownRoot(_root), "ConfidentialPool: unknown root");
        require(_recipient != address(0), "ConfidentialPool: zero recipient");
        require(_amount > 0, "ConfidentialPool: zero withdrawal amount");
        if (maxWithdrawAmount > 0) {
            require(_amount <= maxWithdrawAmount, "ConfidentialPool: amount exceeds withdrawal limit");
        }
        require(address(this).balance >= _amount, "ConfidentialPool: insufficient pool balance");
        if (minDepositAge > 0) {
            require(
                block.number >= lastDepositBlock + minDepositAge,
                "ConfidentialPool: withdrawal too soon after last deposit"
            );
        }

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

        // All state writes before ETH transfers (checks-effects-interactions)
        nullifiers[_nullifier] = true;
        totalWithdrawn += _amount;
        withdrawalCount++;

        withdrawalRecords.push(WithdrawalRecord({
            nullifier: _nullifier,
            amount: _amount,
            recipient: _recipient,
            timestamp: block.timestamp,
            blockNumber: block.number
        }));

        if (_changeCommitment != 0) {
            require(
                _changeCommitment < FIELD_SIZE,
                "ConfidentialPool: change commitment >= field size"
            );
            uint32 changeIndex = _insert(_changeCommitment);
            commitments[_changeCommitment] = true;
            commitmentIndex[_changeCommitment] = changeIndex;
            indexToCommitment[changeIndex] = _changeCommitment;
        }

        uint256 recipientAmount = _amount - _fee;

        (bool success, ) = _recipient.call{value: recipientAmount}("");
        require(success, "ConfidentialPool: recipient transfer failed");

        if (_fee > 0) {
            require(_relayer != address(0), "ConfidentialPool: zero relayer for non-zero fee");
            (bool feeSuccess, ) = _relayer.call{value: _fee}("");
            require(feeSuccess, "ConfidentialPool: relayer transfer failed");
        }

        emit Withdrawal(_nullifier, _amount, _recipient, _changeCommitment, _relayer, _fee);
    }
}
