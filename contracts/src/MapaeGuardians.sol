// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IEntropyV2} from "@pythnetwork/entropy-sdk-solidity/IEntropyV2.sol";
import {IEntropyConsumer} from "@pythnetwork/entropy-sdk-solidity/IEntropyConsumer.sol";
import {GuardianTraits} from "./GuardianTraits.sol";

/// @notice GIWA testnet guardians. NFT custody never grants authority over any owner's funds.
/// @dev Birth is permanent. A separate server signer attests verified paid game results.
contract MapaeGuardians is ERC721Enumerable, Ownable2Step, ReentrancyGuard, EIP712, IEntropyConsumer {
    using Strings for uint256;

    uint256 public constant MAX_SUPPLY = 10_000;
    uint256 public constant MAX_OWNED = 3;
    uint256 public constant MAX_LIFETIME_MINTS = 3;
    uint32 public constant TRAITS_VERSION = 1;
    uint32 public constant MIN_RULESET = 3;
    uint32 public constant MAX_SCORE = 1_000_000_000;
    uint32 public constant CALLBACK_GAS_LIMIT = 500_000;
    bytes32 public constant RESULT_TYPEHASH = keccak256(
        "Result(bytes32 resultId,uint256 tokenId,address actor,uint64 ownershipEpoch,bytes32 paymentTx,bytes32 traitsHash,bytes32 inputsHash,uint32 ruleset,uint32 seed,uint8 game,uint32 score,bool victory)"
    );

    struct Birth {
        bytes32 seed;
        uint64 sequence;
        bool revealed;
    }

    struct Result {
        bytes32 resultId;
        uint256 tokenId;
        address actor;
        uint64 ownershipEpoch;
        bytes32 paymentTx;
        bytes32 traitsHash;
        bytes32 inputsHash;
        uint32 ruleset;
        uint32 seed;
        uint8 game;
        uint32 score;
        bool victory;
    }

    struct Progress {
        uint64 plays;
        uint64 victories;
        uint64 experience;
        uint64[3] gamePlays;
        uint64[3] gameVictories;
        uint32[3] bestScores;
    }

    IEntropyV2 public immutable entropy;
    address public immutable entropyProvider;
    string public imageBaseURI;
    address public resultSigner;
    bool public mintPaused = true;
    mapping(address => uint256) public pendingMint;
    mapping(address => uint256) public mintedBy;
    mapping(uint256 => uint64) public ownershipEpoch;
    mapping(bytes32 => bool) public claimedResults;
    mapping(bytes32 => bool) public claimedPayments;
    mapping(uint256 => Birth) private _births;
    mapping(uint64 => uint256) private _sequenceToken;
    mapping(uint256 => Progress) private _progress;

    error InvalidConfiguration();
    error MintPaused();
    error MintLimit();
    error PendingDraw();
    error WrongFee(uint256 required, uint256 supplied, uint256 maximum);
    error InvalidEntropyRequest();
    error InvalidResult();
    error InvalidResultSignature();
    error AlreadyClaimed();

    event MintRequested(address indexed owner, uint256 indexed tokenId, uint64 indexed sequence, bytes32 contribution);
    event BirthRevealed(uint256 indexed tokenId, uint64 indexed sequence, bytes32 seed);
    event ResultClaimed(bytes32 indexed resultId, uint256 indexed tokenId, bytes32 indexed paymentTx, address actor);
    event ResultSignerChanged(address indexed previousSigner, address indexed newSigner);
    event MintPauseChanged(bool paused);
    event MetadataUpdate(uint256 tokenId);
    event BatchMetadataUpdate(uint256 fromTokenId, uint256 toTokenId);

    constructor(address admin, address signer, address entropyAddress, address provider, string memory imageBase)
        ERC721("Mapae Guardians", "MAPAE")
        Ownable(admin)
        EIP712("Mapae Guardians", "1")
    {
        if (
            signer == address(0) || signer == admin || signer == msg.sender || signer.code.length != 0
                || entropyAddress.code.length == 0 || provider == address(0)
        ) revert InvalidConfiguration();
        bytes memory uri = bytes(imageBase);
        // Intentionally compare only the eight-byte scheme prefix after checking minimum length.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (uri.length < 9 || bytes8(uri) != bytes8("https://") || uri[uri.length - 1] != "/") {
            revert InvalidConfiguration();
        }
        entropy = IEntropyV2(entropyAddress);
        entropyProvider = provider;
        imageBaseURI = imageBase;
        resultSigner = signer;
    }

    function mintFee() public view returns (uint256) {
        return entropy.getFeeV2(entropyProvider, CALLBACK_GAS_LIMIT);
    }

    function mint(bytes32 userContribution, uint256 maxFee)
        external
        payable
        nonReentrant
        returns (uint256 tokenId, uint64 sequence)
    {
        if (mintPaused) revert MintPaused();
        if (pendingMint[msg.sender] != 0) revert PendingDraw();
        if (
            totalSupply() >= MAX_SUPPLY || mintedBy[msg.sender] >= MAX_LIFETIME_MINTS
                || balanceOf(msg.sender) >= MAX_OWNED
        ) revert MintLimit();
        uint256 fee = mintFee();
        if (fee > maxFee || msg.value != fee) revert WrongFee(fee, msg.value, maxFee);
        tokenId = totalSupply() + 1;
        pendingMint[msg.sender] = tokenId;
        ++mintedBy[msg.sender];
        // Receiver acceptance happens before randomness is requested, so it cannot reject a known draw.
        _safeMint(msg.sender, tokenId);
        sequence = entropy.requestV2{value: fee}(entropyProvider, userContribution, CALLBACK_GAS_LIMIT);
        if (sequence == 0 || _sequenceToken[sequence] != 0) revert InvalidEntropyRequest();
        _sequenceToken[sequence] = tokenId;
        _births[tokenId].sequence = sequence;
        emit MintRequested(msg.sender, tokenId, sequence, userContribution);
    }

    function birth(uint256 tokenId) external view returns (bytes32 seed, uint64 sequence, bool revealed) {
        _requireOwned(tokenId);
        Birth memory value = _births[tokenId];
        return (value.seed, value.sequence, value.revealed);
    }

    function progress(uint256 tokenId) external view returns (Progress memory) {
        _requireOwned(tokenId);
        return _progress[tokenId];
    }

    function traitsHash(uint256 tokenId) public view returns (bytes32) {
        _requireOwned(tokenId);
        if (!_births[tokenId].revealed) revert PendingDraw();
        return keccak256(abi.encode(_births[tokenId].seed));
    }

    function aptitudes(uint256 tokenId) external view returns (uint8[3] memory) {
        _requireOwned(tokenId);
        if (!_births[tokenId].revealed) revert PendingDraw();
        return GuardianTraits.aptitudes(_births[tokenId].seed);
    }

    function resultDigest(Result calldata result) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(RESULT_TYPEHASH, result)));
    }

    function claimResult(Result calldata result, bytes calldata signature) external nonReentrant {
        _requireOwned(result.tokenId);
        if (!_births[result.tokenId].revealed) revert PendingDraw();
        if (
            result.resultId == bytes32(0) || result.paymentTx == bytes32(0) || result.actor == address(0)
                || result.inputsHash == bytes32(0) || result.ownershipEpoch == 0
                || result.ownershipEpoch > ownershipEpoch[result.tokenId] || result.game > 2
                || result.ruleset < MIN_RULESET || result.score > MAX_SCORE
                || result.traitsHash != traitsHash(result.tokenId)
        ) revert InvalidResult();
        if (claimedResults[result.resultId] || claimedPayments[result.paymentTx]) revert AlreadyClaimed();
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(resultDigest(result), signature);
        if (error != ECDSA.RecoverError.NoError || recovered != resultSigner) revert InvalidResultSignature();
        // Historical valid results survive transfer. The signer attests the actor/epoch at departure.
        claimedResults[result.resultId] = true;
        claimedPayments[result.paymentTx] = true;
        Progress storage p = _progress[result.tokenId];
        ++p.plays;
        ++p.gamePlays[result.game];
        p.experience += result.victory ? 15 : 10;
        if (result.victory) {
            ++p.victories;
            ++p.gameVictories[result.game];
        }
        if (result.score > p.bestScores[result.game]) p.bestScores[result.game] = result.score;
        emit ResultClaimed(result.resultId, result.tokenId, result.paymentTx, result.actor);
        emit MetadataUpdate(result.tokenId);
    }

    function setMintPaused(bool paused) external onlyOwner {
        mintPaused = paused;
        emit MintPauseChanged(paused);
    }

    function setResultSigner(address signer) external onlyOwner {
        if (signer == address(0) || signer == owner() || signer == pendingOwner() || signer.code.length != 0) {
            revert InvalidConfiguration();
        }
        emit ResultSignerChanged(resultSigner, signer);
        resultSigner = signer;
    }

    function _transferOwnership(address newOwner) internal override {
        if (newOwner == resultSigner && newOwner != address(0)) revert InvalidConfiguration();
        super._transferOwnership(newOwner);
    }

    function getEntropy() internal view override returns (address) {
        return address(entropy);
    }

    function entropyCallback(uint64 sequence, address provider, bytes32 randomNumber) internal override {
        uint256 tokenId = _sequenceToken[sequence];
        if (provider != entropyProvider || tokenId == 0 || _births[tokenId].revealed) revert InvalidEntropyRequest();
        Birth storage value = _births[tokenId];
        value.seed = GuardianTraits.birthSeed(randomNumber, tokenId, block.chainid, address(this));
        value.revealed = true;
        delete pendingMint[ownerOf(tokenId)];
        emit BirthRevealed(tokenId, sequence, value.seed);
        emit MetadataUpdate(tokenId);
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && !_births[tokenId].revealed) revert PendingDraw();
        if (to != address(0) && to != from && balanceOf(to) >= MAX_OWNED) revert MintLimit();
        address previous = super._update(to, tokenId, auth);
        ++ownershipEpoch[tokenId];
        return previous;
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == bytes4(0x49064906) || super.supportsInterface(interfaceId);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        Birth memory b = _births[tokenId];
        string memory attributes = b.revealed ? _birthAttributes(b.seed) : _text("Status", "Awaiting reveal");
        if (b.revealed) attributes = string.concat(attributes, ",", _growthAttributes(_progress[tokenId]));
        bytes memory json = abi.encodePacked(
            '{"name":"Mapae Guardian #',
            tokenId.toString(),
            '","description":"A GIWA Sepolia testnet guardian with verifiable birth and verified arcade growth.","image":"',
            Strings.escapeJSON(string.concat(imageBaseURI, tokenId.toString(), "/image.svg")),
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
            _number("Traits version", TRAITS_VERSION)
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
