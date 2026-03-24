// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract StealthRegistry {
    struct ViewingKey {
        uint256 pubKeyX;
        uint256 pubKeyY;
    }

    mapping(address => ViewingKey) public viewingKeys;

    event ViewingKeyRegistered(address indexed owner, uint256 pubKeyX, uint256 pubKeyY);
    event StealthPayment(
        uint256 indexed commitment,
        uint256 ephemeralPubKeyX,
        uint256 ephemeralPubKeyY,
        uint256 stealthPubKeyX,
        uint256 stealthPubKeyY
    );

    function registerViewingKey(uint256 _pubKeyX, uint256 _pubKeyY) external {
        require(_pubKeyX != 0 || _pubKeyY != 0, "StealthRegistry: zero key");
        viewingKeys[msg.sender] = ViewingKey(_pubKeyX, _pubKeyY);
        emit ViewingKeyRegistered(msg.sender, _pubKeyX, _pubKeyY);
    }

    function getViewingKey(address _owner) external view returns (uint256 pubKeyX, uint256 pubKeyY) {
        ViewingKey memory vk = viewingKeys[_owner];
        return (vk.pubKeyX, vk.pubKeyY);
    }

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
