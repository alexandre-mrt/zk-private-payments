// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title StealthRegistry
/// @notice On-chain registry for stealth-address viewing keys and payment announcements.
///
/// @dev ## Stealth address scheme
///      This contract supports the BabyJubjub ECDH-based stealth address protocol:
///
///      1. The recipient generates a long-lived spending key pair (S, s) and a viewing
///         key pair (V, v) on the BabyJubjub curve where V = v·G and S = s·G.
///      2. The recipient publishes their viewing public key (V) by calling
///         `registerViewingKey`.
///      3. The sender generates a per-payment ephemeral key pair (E, e) where E = e·G,
///         derives a shared secret k = Poseidon(e·V) = Poseidon(v·E), and computes a
///         one-time stealth public key P = S + k·G.
///      4. The sender deposits into ConfidentialPool using a commitment that encodes P
///         as the owner key, then calls `announceStealthPayment` with E and P so that the
///         recipient (scanning the event log) can test each announcement with their own v.
///
///      ## Viewing key registration
///      Recipients register once (or update) by calling `registerViewingKey`. The registry
///      maps their Ethereum address to the BabyJubjub affine coordinates (pubKeyX, pubKeyY)
///      of their viewing public key.
///
///      ## Stealth payment announcement
///      After depositing, the sender emits a `StealthPayment` event containing the
///      ephemeral public key and the one-time stealth public key. The recipient scans
///      these events off-chain, computes the shared secret using their viewing key, and
///      determines whether the stealth key matches — recovering the note if it does.
contract StealthRegistry {
    /// @notice BabyJubjub affine public key
    /// @dev Coordinates are field elements over the BN254 scalar field
    struct ViewingKey {
        /// @dev X coordinate of the BabyJubjub public key
        uint256 pubKeyX;
        /// @dev Y coordinate of the BabyJubjub public key
        uint256 pubKeyY;
    }

    /// @notice Maps each Ethereum address to its registered viewing public key
    /// @dev A zero-coordinate key (0, 0) indicates the address has not registered.
    mapping(address => ViewingKey) public viewingKeys;

    /// @notice Emitted when a user registers or updates their viewing public key
    /// @param owner    The Ethereum address that owns this viewing key
    /// @param pubKeyX  X coordinate of the BabyJubjub viewing public key
    /// @param pubKeyY  Y coordinate of the BabyJubjub viewing public key
    event ViewingKeyRegistered(address indexed owner, uint256 pubKeyX, uint256 pubKeyY);

    /// @notice Emitted when a sender announces a stealth payment
    /// @dev Listeners scan this event and check each announcement with their viewing key
    ///      to discover notes intended for them.
    /// @param commitment       Poseidon commitment of the deposited note (indexed for filtering)
    /// @param ephemeralPubKeyX X coordinate of the sender's ephemeral BabyJubjub public key
    /// @param ephemeralPubKeyY Y coordinate of the sender's ephemeral BabyJubjub public key
    /// @param stealthPubKeyX   X coordinate of the recipient's one-time stealth public key
    /// @param stealthPubKeyY   Y coordinate of the recipient's one-time stealth public key
    event StealthPayment(
        uint256 indexed commitment,
        uint256 ephemeralPubKeyX,
        uint256 ephemeralPubKeyY,
        uint256 stealthPubKeyX,
        uint256 stealthPubKeyY
    );

    /// @notice Registers or updates the caller's BabyJubjub viewing public key
    /// @dev Both coordinates being zero is rejected as it would produce an invalid key.
    ///      A subsequent call from the same address overwrites the previous registration.
    /// @param _pubKeyX X coordinate of the BabyJubjub viewing public key
    /// @param _pubKeyY Y coordinate of the BabyJubjub viewing public key
    function registerViewingKey(uint256 _pubKeyX, uint256 _pubKeyY) external {
        require(_pubKeyX != 0 || _pubKeyY != 0, "StealthRegistry: zero key");
        viewingKeys[msg.sender] = ViewingKey(_pubKeyX, _pubKeyY);
        emit ViewingKeyRegistered(msg.sender, _pubKeyX, _pubKeyY);
    }

    /// @notice Returns the registered viewing public key for a given address
    /// @dev Returns (0, 0) if the address has not registered a viewing key.
    /// @param _owner The Ethereum address whose viewing key is requested
    /// @return pubKeyX X coordinate of the BabyJubjub viewing public key
    /// @return pubKeyY Y coordinate of the BabyJubjub viewing public key
    function getViewingKey(address _owner) external view returns (uint256 pubKeyX, uint256 pubKeyY) {
        ViewingKey memory vk = viewingKeys[_owner];
        return (vk.pubKeyX, vk.pubKeyY);
    }

    /// @notice Announces a stealth payment so the recipient can discover it off-chain
    /// @dev This function only emits an event — it performs no state changes. The caller
    ///      (sender) should call this after depositing into ConfidentialPool with a
    ///      commitment derived from the stealth public key. The recipient scans
    ///      `StealthPayment` events and for each one computes:
    ///          sharedSecret = Poseidon(viewingKey · ephemeralPubKey)
    ///          derivedStealth = spendingPubKey + sharedSecret · G
    ///      If `derivedStealth == (stealthPubKeyX, stealthPubKeyY)`, the note belongs to them.
    /// @param _commitment       Poseidon commitment of the note deposited in ConfidentialPool
    /// @param _ephemeralPubKeyX X coordinate of the sender's ephemeral BabyJubjub public key
    /// @param _ephemeralPubKeyY Y coordinate of the sender's ephemeral BabyJubjub public key
    /// @param _stealthPubKeyX   X coordinate of the recipient's one-time stealth public key
    /// @param _stealthPubKeyY   Y coordinate of the recipient's one-time stealth public key
    function announceStealthPayment(
        uint256 _commitment,
        uint256 _ephemeralPubKeyX,
        uint256 _ephemeralPubKeyY,
        uint256 _stealthPubKeyX,
        uint256 _stealthPubKeyY
    ) external {
        emit StealthPayment(
            _commitment,
            _ephemeralPubKeyX,
            _ephemeralPubKeyY,
            _stealthPubKeyX,
            _stealthPubKeyY
        );
    }
}
