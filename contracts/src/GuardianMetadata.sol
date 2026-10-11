// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {GuardianTraits} from "./GuardianTraits.sol";

/// @notice On-chain token metadata for MapaeGuardians. Deployed once and linked, so the trait tables and
/// JSON assembly live outside the collection implementation and leave it room under EIP-170 for upgrades.
/// @dev Pure and stateless: the collection reaches it by DELEGATECALL from tokenURI only.
library GuardianMetadata {
    using Strings for uint256;

    struct Progress {
        uint64 plays;
        uint64 victories;
        uint64 experience;
        uint64[3] gamePlays;
        uint64[3] gameVictories;
        uint32[3] bestScores;
    }

    function tokenURI(uint256 tokenId, string memory imageBase, bool revealed, bytes32 seed, Progress memory p)
        external
        pure
        returns (string memory)
    {
        string memory attributes = revealed
            ? string.concat(_birthAttributes(seed), ",", _growthAttributes(p))
            : _text("Status", "Awaiting reveal");
        bytes memory json = abi.encodePacked(
            '{"name":"Mapae Guardian #',
            tokenId.toString(),
            '","description":"A GIWA Sepolia testnet guardian with verifiable birth and verified arcade growth.","image":"',
            Strings.escapeJSON(string.concat(imageBase, tokenId.toString(), "/image.svg")),
            '","attributes":[',
            attributes,
            "]}"
        );
        return string.concat("data:application/json;base64,", Base64.encode(json));
    }

    function _birthAttributes(bytes32 seed) private pure returns (string memory) {
        string memory attributes = string.concat(
            _text("Zodiac", GuardianTraits.zodiac(seed)),
            ",",
            _text("Hat", GuardianTraits.hat(seed)),
            ",",
            _text("Outfit", GuardianTraits.outfit(seed)),
            ",",
            _text("Shoes", GuardianTraits.shoes(seed)),
            ",",
            _text("Backdrop", GuardianTraits.backdrop(seed)),
            ",",
            _text("Charm", GuardianTraits.charm(seed))
        );
        uint8[3] memory a = GuardianTraits.aptitudes(seed);
        return string.concat(
            attributes,
            ",",
            _text("Color", GuardianTraits.color(seed)),
            ",",
            _text("Temperament", GuardianTraits.temperament(seed)),
            ",",
            _number("Stamp aptitude", a[0]),
            ",",
            _number("Race aptitude", a[1]),
            ",",
            _number("Shop aptitude", a[2]),
            ",",
            _number("Traits version", GuardianTraits.VERSION)
        );
    }

    function _growthAttributes(Progress memory p) private pure returns (string memory attributes) {
        attributes = string.concat(
            _number("Plays", p.plays),
            ",",
            _number("Victories", p.victories),
            ",",
            _number("Experience", p.experience),
            ",",
            _number("Level", 1 + p.experience / 100)
        );
        string[3] memory names = ["Stamp", "Race", "Shop"];
        for (uint256 i; i < 3; ++i) {
            attributes = string.concat(
                attributes,
                ",",
                _number(string.concat(names[i], " plays"), p.gamePlays[i]),
                ",",
                _number(string.concat(names[i], " victories"), p.gameVictories[i]),
                ",",
                _number(string.concat(names[i], " best score"), p.bestScores[i])
            );
        }
    }

    function _text(string memory name, string memory value) private pure returns (string memory) {
        return string.concat('{"trait_type":"', name, '","value":"', value, '"}');
    }

    function _number(string memory name, uint256 value) private pure returns (string memory) {
        return string.concat('{"trait_type":"', name, '","value":', value.toString(), "}");
    }
}
