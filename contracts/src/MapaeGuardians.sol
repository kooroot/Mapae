// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IEntropyV2} from "@pythnetwork/entropy-sdk-solidity/IEntropyV2.sol";
import {IEntropyConsumer} from "@pythnetwork/entropy-sdk-solidity/IEntropyConsumer.sol";
import {GuardianTraits} from "./GuardianTraits.sol";
import {GuardianMetadata} from "./GuardianMetadata.sol";

/// @notice GIWA testnet guardians. NFT custody never grants authority over any owner's funds.
/// @dev Birth traits come only from the Pyth reveal and no function of this implementation rewrites them. The
/// owner can upgrade the implementation, so every piece of state (birth, growth, ownership) ultimately trusts
/// the owner key. A separate server signer attests verified paid game results; the owner can rotate it.
/// Deployed behind an ERC-1967 UUPS proxy; the proxy address is the collection address everywhere
/// (EIP-712 verifyingContract, birth seed, Pyth requester). The Pyth contract and provider are
/// implementation immutables: changing either requires deploying a new implementation and upgrading.
/// Requests are keyed by (Entropy, provider, sequence), so a new pair can never collide with old requests,
/// and a birth stranded by such a change is re-requested by its minter through `rerequestBirth`. Each request also
/// records the token's attempt number, so only a token's latest request can ever reveal it.
contract MapaeGuardians is
    Initializable,
    ERC721Upgradeable,
    Ownable2StepUpgradeable,
    EIP712Upgradeable,
    UUPSUpgradeable,
    ReentrancyGuardTransient,
    IEntropyConsumer
{
    uint256 public constant MAX_SUPPLY = 10_000;
    uint256 public constant MAX_OWNED = 3;
    uint256 public constant MAX_LIFETIME_MINTS = 3;
    uint32 public constant TRAITS_VERSION = GuardianTraits.VERSION;
    uint32 public constant MIN_RULESET = 3;
    uint32 public constant MAX_SCORE = 1_000_000_000;
    uint32 public constant CALLBACK_GAS_LIMIT = 500_000;
    bytes32 public constant RESULT_TYPEHASH = keccak256(
        "Result(bytes32 resultId,uint256 tokenId,address actor,uint64 ownershipEpoch,bytes32 paymentTx,bytes32 traitsHash,bytes32 inputsHash,uint32 ruleset,uint32 seed,uint8 game,uint32 score,bool victory)"
    );

    string private constant NAME = "Mapae Guardians";
    string private constant DOMAIN_VERSION = "1";
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256(bytes(NAME));
    bytes32 private constant VERSION_HASH = keccak256(bytes(DOMAIN_VERSION));

    // keccak256(abi.encode(uint256(keccak256("mapae.storage.MapaeGuardians")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant GUARDIANS_STORAGE_LOCATION =
        0x20a1645a3ff8adae4f50a28770fc14f2758bca625a9bd5a6d043f3d420b0bf00;

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

    /// @dev One slot per account, written together on mint and by `_update` on every ownership change.
    /// `owned` is exactly MAX_OWNED 16-bit lanes wide, and `_update` casts lane writes to uint48. Raising MAX_OWNED
    /// in an upgrade must widen `owned` to MAX_OWNED * 16 bits as well (it is the slot's last field, so widening is
    /// layout-safe); otherwise the extra lane is silently truncated and the index desynchronises from balanceOf.
    struct Account {
        uint16 pendingMint; // token ID awaiting reveal, 0 when none (IDs are 1..MAX_SUPPLY)
        uint8 minted; // lifetime mints, at most MAX_LIFETIME_MINTS
        uint48 owned; // owned token IDs, MAX_OWNED 16-bit lanes in no particular order, 0 = empty lane
    }

    /// @dev Two slots per token. Totals are derived: plays and victories are the per-game sums and
    /// experience is 10 per play plus 5 per victory. Lane carries are excluded by assumption, not checked: a lane
    /// would only carry into the next one after 2**40 signer-attested results, each with a unique paymentTx.
    struct Growth {
        uint256 counters; // lane g (40 bits): plays in game g; lane 3 + g: victories in game g
        uint256 bestScores; // lane g (32 bits): best score in game g, at most MAX_SCORE < 2**32
    }

    /// @dev Slot 0 is the seed; slot 1 packs the fields `_update`, mint and claimResult touch together.
    struct Token {
        bytes32 seed;
        uint64 sequence; // latest request's sequence, under the pair that was current when it was made
        uint64 ownershipEpoch;
        bool revealed;
        uint32 attempt; // number of birth requests made for this token; the latest request carries this value
    }

    /// @custom:storage-location erc7201:mapae.storage.MapaeGuardians
    struct GuardiansStorage {
        // Slot 0 packs everything mint and claimResult read unconditionally.
        address resultSigner;
        bool mintPaused;
        /// @dev Never decreases (the collection has no burn), so it is the draw counter, not totalSupply().
        uint16 drawn;
        string imageBaseURI;
        mapping(address => Account) accounts;
        mapping(uint256 => Token) tokens;
        mapping(uint256 => Growth) growth;
        /// @dev keccak256(abi.encode(entropy, provider, sequence)) => tokenId | attempt << 16; deleted on reveal.
        /// Sequence numbers are only unique per Entropy contract and provider, so the pair is part of the key.
        /// Superseded entries under a retired pair cannot be found again and stay, but their attempt is stale.
        mapping(bytes32 => uint256) requestToken;
        mapping(bytes32 => bool) claimedPayments;
        /// @dev Lazy Fisher-Yates pool over token IDs, sixteen 16-bit lanes per word.
        /// A zero lane holds its default ID `slot + 1`.
        mapping(uint256 => uint256) idPool;
    }

    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    IEntropyV2 public immutable entropy;
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    address public immutable entropyProvider;

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
    event BirthRerequested(
        address indexed owner, uint256 indexed tokenId, uint64 indexed sequence, bytes32 contribution
    );
    event BirthRevealed(uint256 indexed tokenId, uint64 indexed sequence, bytes32 seed);
    event ResultClaimed(bytes32 indexed resultId, uint256 indexed tokenId, bytes32 indexed paymentTx, address actor);
    event ResultSignerChanged(address indexed previousSigner, address indexed newSigner);
    event MintPauseChanged(bool paused);
    event MetadataUpdate(uint256 tokenId);
    event BatchMetadataUpdate(uint256 fromTokenId, uint256 toTokenId);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address entropyAddress, address provider) {
        if (entropyAddress.code.length == 0 || provider == address(0)) revert InvalidConfiguration();
        entropy = IEntropyV2(entropyAddress);
        entropyProvider = provider;
        // The bare implementation can never be initialized, so close its own mint as well; otherwise anyone could
        // mint look-alike guardians (with working Pyth callbacks) at the implementation address. Proxies are
        // unaffected: this writes the implementation's storage, not theirs.
        _guardians().mintPaused = true;
        _disableInitializers();
    }

    /// @notice Starts paused. Must run atomically in the ERC1967Proxy constructor so nobody can front-run it.
    function initialize(address admin, address signer, string calldata imageBase) external initializer {
        __ERC721_init(NAME, "MAPAE");
        // Runs before the signer exists, so the owner/signer check in _transferOwnership passes; the
        // signer is then checked against the admin below. A zero admin reverts with OwnableInvalidOwner.
        __Ownable_init(admin);
        __Ownable2Step_init();
        // __EIP712_init is deliberately not called: _EIP712Name/_EIP712Version are overridden with
        // constants, so it would only write storage that is never read.
        if (signer == address(0) || signer == admin || signer == msg.sender || signer.code.length != 0) {
            revert InvalidConfiguration();
        }
        bytes memory uri = bytes(imageBase);
        // Intentionally compare only the eight-byte scheme prefix after checking minimum length.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (uri.length < 9 || bytes8(uri) != bytes8("https://") || uri[uri.length - 1] != "/") {
            revert InvalidConfiguration();
        }
        GuardiansStorage storage $ = _guardians();
        $.resultSigner = signer;
        $.mintPaused = true;
        $.imageBaseURI = imageBase;
        emit ResultSignerChanged(address(0), signer);
        emit MintPauseChanged(true);
    }

    function resultSigner() external view returns (address) {
        return _guardians().resultSigner;
    }

    function mintPaused() external view returns (bool) {
        return _guardians().mintPaused;
    }

    function imageBaseURI() external view returns (string memory) {
        return _guardians().imageBaseURI;
    }

    function pendingMint(address account) external view returns (uint256) {
        return _guardians().accounts[account].pendingMint;
    }

    function mintedBy(address account) external view returns (uint256) {
        return _guardians().accounts[account].minted;
    }

    function ownershipEpoch(uint256 tokenId) external view returns (uint64) {
        return _guardians().tokens[tokenId].ownershipEpoch;
    }

    function claimedPayments(bytes32 paymentTx) external view returns (bool) {
        return _guardians().claimedPayments[paymentTx];
    }

    /// @notice Every token minted so far; the collection has no burn, so this is the draw counter.
    function totalSupply() external view returns (uint256) {
        return _guardians().drawn;
    }

    /// @notice The account's token IDs (at most MAX_OWNED), in no particular order.
    function tokensOfOwner(address account) external view returns (uint256[] memory ids) {
        uint256 owned = _guardians().accounts[account].owned;
        ids = new uint256[](balanceOf(account));
        uint256 n;
        for (uint256 lane; lane < MAX_OWNED; ++lane) {
            uint256 id = (owned >> (lane << 4)) & 0xffff;
            if (id != 0) ids[n++] = id;
        }
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
        GuardiansStorage storage $ = _guardians();
        if ($.mintPaused) revert MintPaused();
        Account memory account = $.accounts[msg.sender];
        if (account.pendingMint != 0) revert PendingDraw();
        uint256 drawn = $.drawn;
        if (drawn >= MAX_SUPPLY || account.minted >= MAX_LIFETIME_MINTS || _freeLane(account.owned) == MAX_OWNED) {
            revert MintLimit();
        }
        uint256 fee = _checkedFee(maxFee);
        tokenId = _drawTokenId($, drawn, userContribution);
        // Bounded above: tokenId <= MAX_SUPPLY < 2**16 and minted < MAX_LIFETIME_MINTS.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint16 pending = uint16(tokenId);
        $.accounts[msg.sender] = Account({pendingMint: pending, minted: account.minted + 1, owned: account.owned});
        // Receiver acceptance happens before randomness is requested, so it cannot reject a known draw.
        _safeMint(msg.sender, tokenId);
        sequence = _requestBirth($, tokenId, userContribution, fee);
        emit MintRequested(msg.sender, tokenId, sequence, userContribution);
    }

    /// @notice Re-requests the caller's pending birth after an upgrade changed the Entropy contract or provider,
    /// which leaves the original request undeliverable. Refused while the current pair can still deliver the
    /// existing request, so a minter never holds two live draws to choose between. Works while minting is paused.
    function rerequestBirth(uint256 tokenId, bytes32 userContribution, uint256 maxFee)
        external
        payable
        nonReentrant
        returns (uint64 sequence)
    {
        GuardiansStorage storage $ = _guardians();
        // A pending token cannot be transferred, so its holder's pendingMint names it until it is revealed.
        if (tokenId == 0 || $.accounts[msg.sender].pendingMint != tokenId) revert InvalidEntropyRequest();
        Token storage token = $.tokens[tokenId];
        if ($.requestToken[_requestKey(token.sequence)] == _request(tokenId, token.attempt)) revert PendingDraw();
        sequence = _requestBirth($, tokenId, userContribution, _checkedFee(maxFee));
        emit BirthRerequested(msg.sender, tokenId, sequence, userContribution);
    }

    function _checkedFee(uint256 maxFee) private view returns (uint256 fee) {
        fee = mintFee();
        if (fee > maxFee || msg.value != fee) revert WrongFee(fee, msg.value, maxFee);
    }

    function _requestBirth(GuardiansStorage storage $, uint256 tokenId, bytes32 userContribution, uint256 fee)
        private
        returns (uint64 sequence)
    {
        sequence = entropy.requestV2{value: fee}(entropyProvider, userContribution, CALLBACK_GAS_LIMIT);
        bytes32 key = _requestKey(sequence);
        if (sequence == 0 || $.requestToken[key] != 0) revert InvalidEntropyRequest();
        Token storage token = $.tokens[tokenId];
        uint32 attempt = token.attempt + 1;
        $.requestToken[key] = _request(tokenId, attempt);
        token.sequence = sequence;
        token.attempt = attempt;
    }

    function _requestKey(uint64 sequence) private view returns (bytes32) {
        return keccak256(abi.encode(address(entropy), entropyProvider, sequence));
    }

    /// @dev requestToken value: the token ID (< 2**16) in the low lane and the request's attempt above it.
    function _request(uint256 tokenId, uint32 attempt) private pure returns (uint256) {
        return tokenId | (uint256(attempt) << 16);
    }

    /// @dev Draws an unused ID from 1..MAX_SUPPLY without replacement. The ID is cosmetic (it only picks the
    /// display name) and its mint-time entropy is grindable; every trait still comes from the later Pyth reveal.
    /// Lanes at or above the shrinking `remaining` bound are never read again, so the vacated last lane is
    /// left as is rather than cleared.
    function _drawTokenId(GuardiansStorage storage $, uint256 drawn, bytes32 userContribution)
        private
        returns (uint256 tokenId)
    {
        uint256 remaining = MAX_SUPPLY - drawn;
        uint256 slot = uint256(
            keccak256(abi.encode(block.prevrandao, msg.sender, userContribution, remaining, address(this)))
        ) % remaining;
        uint256 last = remaining - 1;
        tokenId = _poolAt($, slot);
        if (slot != last) {
            uint256 shift = (slot & 15) << 4;
            uint256 word = $.idPool[slot >> 4];
            $.idPool[slot >> 4] = (word & ~(uint256(0xffff) << shift)) | (_poolAt($, last) << shift);
        }
        // drawn < MAX_SUPPLY was checked by the caller.
        // forge-lint: disable-next-line(unsafe-typecast)
        $.drawn = uint16(drawn + 1);
    }

    function _poolAt(GuardiansStorage storage $, uint256 slot) private view returns (uint256 id) {
        id = ($.idPool[slot >> 4] >> ((slot & 15) << 4)) & 0xffff;
        if (id == 0) id = slot + 1;
    }

    function birth(uint256 tokenId) external view returns (bytes32 seed, uint64 sequence, bool revealed) {
        _requireOwned(tokenId);
        Token memory token = _guardians().tokens[tokenId];
        return (token.seed, token.sequence, token.revealed);
    }

    function progress(uint256 tokenId) external view returns (GuardianMetadata.Progress memory) {
        _requireOwned(tokenId);
        return _progress(_guardians().growth[tokenId]);
    }

    function _progress(Growth storage g) private view returns (GuardianMetadata.Progress memory p) {
        uint256 counters = g.counters;
        uint256 scores = g.bestScores;
        for (uint256 game; game < 3; ++game) {
            // Lanes are 40 and 32 bits wide, so both casts are lossless.
            // forge-lint: disable-next-line(unsafe-typecast)
            p.gamePlays[game] = uint64((counters >> (game * 40)) & 0xffffffffff);
            // forge-lint: disable-next-line(unsafe-typecast)
            p.gameVictories[game] = uint64((counters >> ((game + 3) * 40)) & 0xffffffffff);
            // forge-lint: disable-next-line(unsafe-typecast)
            p.bestScores[game] = uint32(scores >> (game << 5));
            p.plays += p.gamePlays[game];
            p.victories += p.gameVictories[game];
        }
        p.experience = 10 * p.plays + 5 * p.victories;
    }

    function traitsHash(uint256 tokenId) external view returns (bytes32) {
        return keccak256(abi.encode(_revealedSeed(tokenId)));
    }

    function aptitudes(uint256 tokenId) external view returns (uint8[3] memory) {
        return GuardianTraits.aptitudes(_revealedSeed(tokenId));
    }

    function _revealedSeed(uint256 tokenId) private view returns (bytes32) {
        _requireOwned(tokenId);
        Token storage token = _guardians().tokens[tokenId];
        if (!token.revealed) revert PendingDraw();
        return token.seed;
    }

    function resultDigest(Result calldata result) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(RESULT_TYPEHASH, result)));
    }

    /// @notice Grows a revealed guardian from a signer-attested paid result. The contract only enforces that the
    /// result's ownershipEpoch is not in the future; `actor`, the epoch at departure, `ruleset` validity above
    /// MIN_RULESET, `seed` and `inputsHash` are attestations owned by the signer. Anyone may relay a signature.
    /// Each paymentTx grows at most one result.
    function claimResult(Result calldata result, bytes calldata signature) external nonReentrant {
        GuardiansStorage storage $ = _guardians();
        _requireOwned(result.tokenId);
        Token memory token = $.tokens[result.tokenId];
        if (!token.revealed) revert PendingDraw();
        if (
            result.resultId == bytes32(0) || result.paymentTx == bytes32(0) || result.actor == address(0)
                || result.inputsHash == bytes32(0) || result.ownershipEpoch == 0
                || result.ownershipEpoch > token.ownershipEpoch || result.game > 2 || result.ruleset < MIN_RULESET
                || result.score > MAX_SCORE || result.traitsHash != keccak256(abi.encode(token.seed))
        ) revert InvalidResult();
        if ($.claimedPayments[result.paymentTx]) revert AlreadyClaimed();
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(resultDigest(result), signature);
        if (error != ECDSA.RecoverError.NoError || recovered != $.resultSigner) revert InvalidResultSignature();
        // Historical valid results survive transfer. The signer attests the actor/epoch at departure.
        $.claimedPayments[result.paymentTx] = true;
        Growth storage g = $.growth[result.tokenId];
        uint256 game = result.game;
        g.counters += (uint256(1) << (game * 40)) | (result.victory ? uint256(1) << ((game + 3) * 40) : 0);
        uint256 shift = game << 5;
        uint256 scores = g.bestScores;
        // Truncation to the 32-bit lane is the point of the cast.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (result.score > uint32(scores >> shift)) {
            g.bestScores = (scores & ~(uint256(0xffffffff) << shift)) | (uint256(result.score) << shift);
        }
        emit ResultClaimed(result.resultId, result.tokenId, result.paymentTx, result.actor);
        emit MetadataUpdate(result.tokenId);
    }

    function setMintPaused(bool paused) external onlyOwner {
        _guardians().mintPaused = paused;
        emit MintPauseChanged(paused);
    }

    function setResultSigner(address signer) external onlyOwner {
        if (signer == address(0) || signer == owner() || signer == pendingOwner() || signer.code.length != 0) {
            revert InvalidConfiguration();
        }
        GuardiansStorage storage $ = _guardians();
        emit ResultSignerChanged($.resultSigner, signer);
        $.resultSigner = signer;
    }

    function _transferOwnership(address newOwner) internal override {
        if (newOwner == _guardians().resultSigner && newOwner != address(0)) revert InvalidConfiguration();
        super._transferOwnership(newOwner);
    }

    /// @dev Rendered metadata (linked GuardianMetadata, trait tables, image base) lives in implementation code, so
    /// every upgrade tells ERC-4906 indexers to refresh the whole collection. An upgrade that changes the Entropy
    /// contract or provider strands pending requests until their minters call `rerequestBirth`.
    function _authorizeUpgrade(address) internal override onlyOwner {
        emit BatchMetadataUpdate(1, MAX_SUPPLY);
    }

    /// @dev Pyth calls the proxy, which delegates here; the immutable is read from implementation code.
    function getEntropy() internal view override returns (address) {
        return address(entropy);
    }

    /// @dev msg.sender is the current Entropy (checked by IEntropyConsumer). Only the current provider is accepted:
    /// after a provider change on the same Entropy contract, the old provider's requests stay revealable on Pyth's
    /// side but must not reach this contract, or a re-requested birth would have two live draws. The request must
    /// also carry the token's latest attempt. Sequence numbers restart on a fresh pair, so comparing them would let
    /// a superseded request through when an old pair is reinstated; the attempt number never repeats per token.
    function entropyCallback(uint64 sequence, address provider, bytes32 randomNumber) internal override {
        GuardiansStorage storage $ = _guardians();
        bytes32 key = _requestKey(sequence);
        uint256 request = $.requestToken[key];
        uint256 tokenId = request & 0xffff;
        Token storage token = $.tokens[tokenId];
        if (provider != entropyProvider || tokenId == 0 || token.revealed || request >> 16 != token.attempt) {
            revert InvalidEntropyRequest();
        }
        delete $.requestToken[key];
        bytes32 seed = GuardianTraits.birthSeed(randomNumber, tokenId, block.chainid, address(this));
        token.seed = seed;
        token.revealed = true;
        // A pending token cannot be transferred, so its owner is still the minter.
        $.accounts[_ownerOf(tokenId)].pendingMint = 0;
        emit BirthRevealed(tokenId, sequence, seed);
        emit MetadataUpdate(tokenId);
    }

    /// @dev Keeps each account's owned-ID lanes in step with ERC721 ownership and enforces MAX_OWNED on receivers.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        GuardiansStorage storage $ = _guardians();
        Token storage token = $.tokens[tokenId];
        address from = _ownerOf(tokenId);
        if (from != address(0) && !token.revealed) revert PendingDraw();
        if (from != to) {
            if (from != address(0)) {
                Account storage sender = $.accounts[from];
                uint256 owned = sender.owned;
                uint256 lane;
                while (lane < MAX_OWNED && (owned >> (lane << 4)) & 0xffff != tokenId) ++lane;
                // The owner's lanes always hold the token; a miss means the index is corrupt.
                assert(lane < MAX_OWNED);
                // forge-lint: disable-next-line(unsafe-typecast)
                sender.owned = uint48(owned & ~(uint256(0xffff) << (lane << 4)));
            }
            if (to != address(0)) {
                Account storage receiver = $.accounts[to];
                uint256 owned = receiver.owned;
                uint256 lane = _freeLane(owned);
                if (lane == MAX_OWNED) revert MintLimit();
                // tokenId <= MAX_SUPPLY < 2**16 and lane < MAX_OWNED, so the result fits 48 bits.
                // forge-lint: disable-next-line(unsafe-typecast)
                receiver.owned = uint48(owned | (tokenId << (lane << 4)));
            }
        }
        address previous = super._update(to, tokenId, auth);
        ++token.ownershipEpoch;
        return previous;
    }

    /// @dev First empty owned-ID lane, or MAX_OWNED when every lane is taken.
    function _freeLane(uint256 owned) private pure returns (uint256 lane) {
        while (lane < MAX_OWNED && (owned >> (lane << 4)) & 0xffff != 0) ++lane;
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == bytes4(0x49064906) || super.supportsInterface(interfaceId);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        GuardiansStorage storage $ = _guardians();
        Token storage token = $.tokens[tokenId];
        return
            GuardianMetadata.tokenURI(tokenId, $.imageBaseURI, token.revealed, token.seed, _progress($.growth[tokenId]));
    }

    /// @dev Same digest as EIP712Upgradeable, with the constant name and version hashes precomputed. The
    /// verifyingContract is address(this), i.e. the proxy, so the separator cannot be cached as an immutable.
    function _hashTypedDataV4(bytes32 structHash) internal view override returns (bytes32) {
        return MessageHashUtils.toTypedDataHash(
            keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this))), structHash
        );
    }

    /// @dev Read by eip712Domain(); must match NAME_HASH/VERSION_HASH used in _hashTypedDataV4.
    function _EIP712Name() internal pure override returns (string memory) {
        return NAME;
    }

    function _EIP712Version() internal pure override returns (string memory) {
        return DOMAIN_VERSION;
    }

    function _guardians() internal pure returns (GuardiansStorage storage $) {
        assembly {
            $.slot := GUARDIANS_STORAGE_LOCATION
        }
    }
}
