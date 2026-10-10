// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Version 1 birth mapping, shared byte-for-byte with @mapae/arcade/guardians.
library GuardianTraits {
    uint32 internal constant VERSION = 1;

    function birthSeed(bytes32 randomNumber, uint256 tokenId, uint256 chainId, address collection)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(randomNumber, tokenId, chainId, collection, VERSION));
    }

    function index(bytes32 seed, uint8 domain, uint256 length) internal pure returns (uint8) {
        // All callers use fixed trait arrays with lengths between 3 and 12.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint8(uint256(keccak256(abi.encodePacked(seed, domain))) % length);
    }

    function aptitudes(bytes32 seed) internal pure returns (uint8[3] memory) {
        uint8[3][6] memory choices = [
            [uint8(4), 5, 6], [uint8(4), 6, 5], [uint8(5), 4, 6], [uint8(5), 6, 4], [uint8(6), 4, 5], [uint8(6), 5, 4]
        ];
        return choices[index(seed, 8, 6)];
    }

    function zodiac(bytes32 seed) internal pure returns (string memory) {
        string[12] memory values =
            ["rat", "ox", "tiger", "rabbit", "dragon", "snake", "horse", "goat", "monkey", "rooster", "dog", "pig"];
        return values[index(seed, 0, 12)];
    }

    function hat(bytes32 seed) internal pure returns (string memory) {
        string[9] memory values =
            ["none", "topknot", "gat", "satgat", "samo", "ikseongwan", "jeonrip", "paeraengi", "headwrap"];
        return values[index(seed, 1, 9)];
    }

    function outfit(bytes32 seed) internal pure returns (string memory) {
        string[8] memory values =
            ["gonryongpo", "minister", "official", "military", "scholar", "artisan", "hemp", "performer"];
        return values[index(seed, 2, 8)];
    }

    function shoes(bytes32 seed) internal pure returns (string memory) {
        string[5] memory values = ["jipsin", "namaksin", "taesahye", "heukhwa", "beoseon"];
        return values[index(seed, 3, 5)];
    }

    function backdrop(bytes32 seed) internal pure returns (string memory) {
        string[4] memory values = ["dawn", "moon", "jade", "ember"];
        return values[index(seed, 4, 4)];
    }

    function charm(bytes32 seed) internal pure returns (string memory) {
        string[4] memory values = ["mapae", "scroll", "pouch", "none"];
        return values[index(seed, 5, 4)];
    }

    function color(bytes32 seed) internal pure returns (string memory) {
        string[3] memory values = ["red", "jade", "ink"];
        return values[index(seed, 6, 3)];
    }

    function temperament(bytes32 seed) internal pure returns (string memory) {
        string[3] memory values = ["curious", "bold", "calm"];
        return values[index(seed, 7, 3)];
    }
}
