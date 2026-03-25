// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/utils/Base64.sol";

/// @title DepositReceipt — soulbound ERC721 receipt for confidential pool deposits
/// @notice Minted on each deposit as a non-transferable record (soulbound).
/// Does NOT grant withdrawal rights — the ZK proof is what proves ownership.
contract DepositReceipt is ERC721 {
    address public immutable pool;
    uint256 private _nextTokenId;

    /// @notice Maps token ID to the note commitment recorded at deposit time
    mapping(uint256 => uint256) public tokenCommitment;

    /// @notice Maps token ID to the ETH amount deposited (in wei)
    mapping(uint256 => uint256) public tokenAmount;

    /// @notice Maps token ID to the block timestamp of the deposit
    mapping(uint256 => uint256) public tokenTimestamp;

    modifier onlyPool() {
        require(msg.sender == pool, "DepositReceipt: only pool");
        _;
    }

    constructor(address _pool) ERC721("ZK Private Payment Receipt", "ZKPR") {
        require(_pool != address(0), "DepositReceipt: zero pool");
        pool = _pool;
    }

    /// @notice Mint a receipt NFT to `_to` for the given commitment and amount.
    /// @dev Only callable by the pool contract.
    /// @param _to         Address of the depositor.
    /// @param _commitment Poseidon commitment recorded on the token.
    /// @param _amount     ETH amount in wei deposited.
    /// @return tokenId    The minted token ID.
    function mint(
        address _to,
        uint256 _commitment,
        uint256 _amount
    ) external onlyPool returns (uint256) {
        uint256 tokenId = _nextTokenId++;
        _safeMint(_to, tokenId);
        tokenCommitment[tokenId] = _commitment;
        tokenAmount[tokenId] = _amount;
        tokenTimestamp[tokenId] = block.timestamp;
        return tokenId;
    }

    /// @notice Returns on-chain base64-encoded JSON metadata for the given token.
    /// @param tokenId The token to query.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);

        string memory json = string(abi.encodePacked(
            '{"name":"Deposit Receipt #', Strings.toString(tokenId),
            '","description":"ZK Privacy Pool deposit receipt (soulbound)",',
            '"attributes":[',
            '{"trait_type":"Commitment","value":"', Strings.toHexString(tokenCommitment[tokenId], 32), '"},',
            '{"trait_type":"Amount","value":"', Strings.toString(tokenAmount[tokenId]), '"},',
            '{"trait_type":"Timestamp","value":"', Strings.toString(tokenTimestamp[tokenId]), '"}',
            ']}'
        ));

        return string(abi.encodePacked(
            "data:application/json;base64,",
            Base64.encode(bytes(json))
        ));
    }

    /// @notice Soulbound — disable all transfers.
    /// @dev Overrides ERC721._update to allow only mint (from == address(0)) and burn (to == address(0)).
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        require(
            from == address(0) || to == address(0),
            "DepositReceipt: soulbound"
        );
        return super._update(to, tokenId, auth);
    }
}
