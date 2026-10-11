// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {MapaeGuardians} from "../src/MapaeGuardians.sol";
import {GuardianTraits} from "../src/GuardianTraits.sol";
import {GuardianMetadata} from "../src/GuardianMetadata.sol";
import {IEntropyConsumer} from "@pythnetwork/entropy-sdk-solidity/IEntropyConsumer.sol";
import {DeployGuardians} from "../script/DeployGuardians.s.sol";

/// @dev Deliberately adversarial transport. No test treats this as proof of oracle randomness/liveness.
contract GuardianEntropyTestDouble {
    address public provider;
    uint128 public fee = 15_000_000_000_001;
    uint64 public next = 1;
    bool public failRequest;
    mapping(uint64 => address) public requester;
    mapping(uint64 => bytes32) public contribution;
    mapping(uint64 => uint32) public callbackGas;

    constructor(address provider_) {
        provider = provider_;
    }

    /// @dev Models a provider change on the same Entropy contract; sequences keep counting.
    function setProvider(address value) external {
        provider = value;
    }

    function setFee(uint128 value) external {
        fee = value;
    }

    function setFailRequest(bool value) external {
        failRequest = value;
    }

    function getFeeV2(address p, uint32) external view returns (uint128) {
        require(p == provider);
        return fee;
    }

    function requestV2(address p, bytes32 c, uint32 gasLimit) external payable returns (uint64 sequence) {
        require(!failRequest && p == provider && msg.value == fee, "request rejected");
        sequence = next++;
        requester[sequence] = msg.sender;
        contribution[sequence] = c;
        callbackGas[sequence] = gasLimit;
    }

    function deliver(uint64 sequence, bytes32 randomWord) external returns (bool success, uint256 gasUsed) {
        return deliverWithGas(sequence, randomWord, callbackGas[sequence]);
    }

    function deliverWithGas(uint64 sequence, bytes32 randomWord, uint256 gasLimit)
        public
        returns (bool success, uint256 gasUsed)
    {
        uint256 beforeGas = gasleft();
        (success,) = requester[sequence].call{gas: gasLimit}(
            abi.encodeCall(IEntropyConsumer._entropyCallback, (sequence, provider, randomWord))
        );
        gasUsed = beforeGas - gasleft();
    }
}

contract GuardianReceiver is IERC721Receiver {
    MapaeGuardians public immutable nft;
    bool public mintReentrySucceeded;
    bool public transferReentrySucceeded;
    bool public revealWasVisible;
    bool public reject;

    constructor(MapaeGuardians nft_) {
        nft = nft_;
    }

    function draw() external payable {
        nft.mint{value: msg.value}(bytes32(uint256(7)), msg.value);
    }

    function setReject(bool value) external {
        reject = value;
    }

    function onERC721Received(address, address, uint256 id, bytes calldata) external returns (bytes4) {
        (,, revealWasVisible) = nft.birth(id);
        (mintReentrySucceeded,) =
            address(nft).call{value: nft.mintFee()}(abi.encodeCall(nft.mint, (bytes32(uint256(8)), nft.mintFee())));
        (transferReentrySucceeded,) =
            address(nft).call(abi.encodeCall(nft.transferFrom, (address(this), address(0xBEEF), id)));
        require(!reject, "reject NFT");
        return IERC721Receiver.onERC721Received.selector;
    }
}

/// @dev Rejects every draw except the ID it wants: a contract minter can choose its token ID (never its traits).
contract PickyReceiver is IERC721Receiver {
    MapaeGuardians public immutable nft;
    uint256 public wanted;

    constructor(MapaeGuardians nft_) {
        nft = nft_;
    }

    function setWanted(uint256 id) external {
        wanted = id;
    }

    function draw(bytes32 c) external payable {
        nft.mint{value: msg.value}(c, msg.value);
    }

    function onERC721Received(address, address, uint256 id, bytes calldata) external view returns (bytes4) {
        require(id == wanted, "not the ID I want");
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract DrainedGuardianCollection is MapaeGuardians {
    constructor(address e, address p) MapaeGuardians(e, p) {}

    function setDrawn(uint256 value) external {
        // forge-lint: disable-next-line(unsafe-typecast)
        _guardians().drawn = uint16(value);
    }

    function storageLocation() external pure returns (bytes32) {
        return GUARDIANS_STORAGE_LOCATION;
    }
}

contract MapaeGuardiansV2Mock is MapaeGuardians {
    constructor(address e, address p) MapaeGuardians(e, p) {}

    function version() external pure returns (uint256) {
        return 2;
    }
}

contract MapaeGuardiansTest is Test {
    MapaeGuardians internal nft;
    GuardianEntropyTestDouble internal entropy;
    address internal constant PROVIDER = address(0x1234);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    uint256 internal constant SIGNER_KEY = 0x123456;
    uint256 internal constant FEE = 15_000_000_000_001;
    string internal constant IMAGE_BASE = "https://mapae.io/api/arcade/guardians/";

    function setUp() public {
        vm.chainId(91342);
        entropy = new GuardianEntropyTestDouble(PROVIDER);
        nft = _proxy(address(new MapaeGuardians(address(entropy), PROVIDER)));
        nft.setMintPaused(false);
        vm.deal(ALICE, 1 ether);
        vm.deal(BOB, 1 ether);
    }

    function _proxy(address implementation) internal returns (MapaeGuardians) {
        bytes memory init = abi.encodeCall(MapaeGuardians.initialize, (address(this), vm.addr(SIGNER_KEY), IMAGE_BASE));
        return MapaeGuardians(address(new ERC1967Proxy(implementation, init)));
    }

    function _drained() internal returns (DrainedGuardianCollection) {
        return
            DrainedGuardianCollection(
                address(_proxy(address(new DrainedGuardianCollection(address(entropy), PROVIDER))))
            );
    }

    /// @dev Copies this collection's proxy to `at`, pointing at the same implementation.
    function _cloneProxyAt(address at) internal {
        vm.etch(at, address(nft).code);
        vm.store(at, ERC1967Utils.IMPLEMENTATION_SLOT, vm.load(address(nft), ERC1967Utils.IMPLEMENTATION_SLOT));
    }

    function _mint(address who) internal returns (uint256 id, uint64 sequence) {
        vm.prank(who);
        return nft.mint{value: FEE}(bytes32(uint256(42)), FEE);
    }

    function _ready(address who) internal returns (uint256 id) {
        uint64 sequence;
        (id, sequence) = _mint(who);
        (bool success,) = entropy.deliver(sequence, bytes32(uint256(42)));
        assertTrue(success);
    }

    function _result(uint256 id, uint256 n, uint8 game, uint32 score, bool victory)
        internal
        view
        returns (MapaeGuardians.Result memory)
    {
        return MapaeGuardians.Result({
            resultId: bytes32(n),
            tokenId: id,
            actor: ALICE,
            ownershipEpoch: nft.ownershipEpoch(id),
            paymentTx: bytes32(n + 1000),
            traitsHash: nft.traitsHash(id),
            inputsHash: keccak256("canonical inputs"),
            ruleset: 3,
            seed: 123,
            game: game,
            score: score,
            victory: victory
        });
    }

    function _sign(MapaeGuardians.Result memory r, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 a, bytes32 b) = vm.sign(key, nft.resultDigest(r));
        return abi.encodePacked(a, b, v);
    }

    function _claim(MapaeGuardians.Result memory r) internal {
        nft.claimResult(r, _sign(r, SIGNER_KEY));
    }

    function _json(uint256 id) internal view returns (string memory) {
        bytes memory uri = bytes(nft.tokenURI(id));
        bytes memory encoded = new bytes(uri.length - 29);
        for (uint256 i; i < encoded.length; ++i) {
            encoded[i] = uri[i + 29];
        }
        return string(Base64.decode(string(encoded)));
    }

    function test_mintReservesIdentityAndHonestCallbackWithinBudget() public {
        (uint256 id, uint64 sequence) = _mint(ALICE);
        assertGe(id, 1);
        assertLe(id, nft.MAX_SUPPLY());
        assertEq(sequence, 1);
        assertEq(nft.ownerOf(id), ALICE);
        assertEq(nft.pendingMint(ALICE), id);
        assertEq(nft.mintedBy(ALICE), 1);
        assertEq(nft.ownershipEpoch(id), 1);
        assertEq(entropy.contribution(sequence), bytes32(uint256(42)));
        assertEq(nft.tokensOfOwner(ALICE)[0], id);
        assertEq(nft.totalSupply(), 1);
        (bytes32 seed,, bool revealed) = nft.birth(id);
        assertEq(seed, bytes32(0));
        assertFalse(revealed);
        assertEq(vm.parseJsonString(_json(id), ".attributes[0].value"), "Awaiting reveal");
        // The real callback is a later transaction with cold consumer storage.
        vm.cool(address(nft));
        (bool success, uint256 used) = entropy.deliver(sequence, bytes32(uint256(42)));
        assertTrue(success);
        assertLt(used, 500_000);
        emit log_named_uint("callback gas", used);
        (seed,, revealed) = nft.birth(id);
        assertTrue(revealed);
        assertEq(seed, keccak256(abi.encode(bytes32(uint256(42)), id, uint256(91342), address(nft), uint32(1))));
        assertEq(nft.pendingMint(ALICE), 0);
        assertEq(nft.traitsHash(id), keccak256(abi.encode(seed)));
        assertEq(address(nft).balance, 0);
        assertEq(address(entropy).balance, FEE);
    }

    function test_callbackRejectsSpoofWrongProviderUnknownAndDuplicate() public {
        (uint256 id, uint64 sequence) = _mint(ALICE);
        vm.expectRevert("Only Entropy can call this function");
        nft._entropyCallback(sequence, PROVIDER, bytes32(uint256(7)));
        vm.prank(address(entropy));
        vm.expectRevert(MapaeGuardians.InvalidEntropyRequest.selector);
        nft._entropyCallback(sequence, BOB, bytes32(uint256(7)));
        vm.prank(address(entropy));
        vm.expectRevert(MapaeGuardians.InvalidEntropyRequest.selector);
        nft._entropyCallback(sequence + 1, PROVIDER, bytes32(uint256(7)));
        (bool success,) = entropy.deliver(sequence, bytes32(uint256(7)));
        assertTrue(success);
        (bytes32 fixedSeed,,) = nft.birth(id);
        (success,) = entropy.deliver(sequence, bytes32(uint256(8)));
        assertFalse(success);
        (bytes32 seed,,) = nft.birth(id);
        assertEq(seed, fixedSeed);
    }

    function test_pendingCannotTransferRerollAndSameRequestRecoversWhilePaused() public {
        (uint256 id, uint64 sequence) = _mint(ALICE);
        vm.prank(ALICE);
        vm.expectRevert(MapaeGuardians.PendingDraw.selector);
        nft.transferFrom(ALICE, BOB, id);
        vm.prank(ALICE);
        vm.expectRevert(MapaeGuardians.PendingDraw.selector);
        nft.mint{value: FEE}(bytes32(0), FEE);
        vm.expectRevert(MapaeGuardians.PendingDraw.selector);
        nft.traitsHash(id);
        nft.setMintPaused(true);
        (bool success,) = entropy.deliverWithGas(sequence, bytes32(uint256(7)), 1000);
        assertFalse(success);
        (,, bool revealed) = nft.birth(id);
        assertFalse(revealed);
        assertEq(nft.pendingMint(ALICE), id);
        (success,) = entropy.deliver(sequence, bytes32(uint256(7)));
        assertTrue(success);
        assertEq(entropy.next(), 2);
        assertEq(nft.pendingMint(ALICE), 0);
        vm.prank(ALICE);
        nft.transferFrom(ALICE, BOB, id);
        assertEq(nft.ownershipEpoch(id), 2);
    }

    function test_receiverCannotReenterOrRejectAfterSeeingRandomness() public {
        GuardianReceiver receiver = new GuardianReceiver(nft);
        vm.deal(address(receiver), 1 ether);
        receiver.draw{value: FEE}();
        assertFalse(receiver.revealWasVisible());
        assertFalse(receiver.mintReentrySucceeded());
        assertFalse(receiver.transferReentrySucceeded());
        assertEq(nft.balanceOf(address(receiver)), 1);
        (bool success,) = entropy.deliver(1, bytes32(uint256(99)));
        assertTrue(success);
        receiver.setReject(true);
        vm.expectRevert("reject NFT");
        receiver.draw{value: FEE}();
        assertEq(nft.mintedBy(address(receiver)), 1);
        assertEq(entropy.next(), 2);
        assertEq(nft.pendingMint(address(receiver)), 0);
    }

    function test_exactFeeAndQuoteIncreaseRevertWithoutConsumingEntitlement() public {
        vm.startPrank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(MapaeGuardians.WrongFee.selector, FEE, FEE - 1, FEE));
        nft.mint{value: FEE - 1}(bytes32(0), FEE);
        vm.expectRevert(abi.encodeWithSelector(MapaeGuardians.WrongFee.selector, FEE, FEE + 1, FEE + 1));
        nft.mint{value: FEE + 1}(bytes32(0), FEE + 1);
        entropy.setFee(uint128(FEE + 1));
        vm.expectRevert(abi.encodeWithSelector(MapaeGuardians.WrongFee.selector, FEE + 1, FEE + 1, FEE));
        nft.mint{value: FEE + 1}(bytes32(0), FEE);
        vm.stopPrank();
        assertEq(nft.totalSupply(), 0);
        assertEq(nft.mintedBy(ALICE), 0);
        assertEq(nft.pendingMint(ALICE), 0);
        assertEq(entropy.next(), 1);
    }

    function test_entropyFailureRollsBackMintAndFunds() public {
        entropy.setFailRequest(true);
        vm.prank(ALICE);
        vm.expectRevert("request rejected");
        nft.mint{value: FEE}(bytes32(0), FEE);
        assertEq(nft.totalSupply(), 0);
        assertEq(nft.mintedBy(ALICE), 0);
        assertEq(nft.pendingMint(ALICE), 0);
        assertEq(ALICE.balance, 1 ether);
    }

    function test_lifetimeAndOwnedCapacityIncludingIncomingTransfers() public {
        uint256 first = _ready(ALICE);
        _ready(ALICE);
        _ready(ALICE);
        vm.prank(ALICE);
        vm.expectRevert(MapaeGuardians.MintLimit.selector);
        nft.mint{value: FEE}(bytes32(0), FEE);
        uint256 bob = _ready(BOB);
        vm.prank(BOB);
        vm.expectRevert(MapaeGuardians.MintLimit.selector);
        nft.transferFrom(BOB, ALICE, bob);
        vm.prank(ALICE);
        nft.transferFrom(ALICE, BOB, first);
        vm.prank(ALICE);
        vm.expectRevert(MapaeGuardians.MintLimit.selector);
        nft.mint{value: FEE}(bytes32(0), FEE);
        vm.prank(BOB);
        nft.transferFrom(BOB, ALICE, bob);
        assertEq(nft.balanceOf(ALICE), 3);
        assertEq(nft.mintedBy(ALICE), 3);
        assertEq(nft.ownershipEpoch(first), 2);
    }

    function test_ownedCapCountsPendingTokens() public {
        _ready(ALICE);
        _ready(ALICE);
        _mint(ALICE);
        uint256 bob = _ready(BOB);
        vm.prank(BOB);
        vm.expectRevert(MapaeGuardians.MintLimit.selector);
        nft.transferFrom(BOB, ALICE, bob);
    }

    function test_supplyCapBoundary() public {
        DrainedGuardianCollection full = _drained();
        full.setMintPaused(false);
        full.setDrawn(full.MAX_SUPPLY() - 1);
        // One slot left and it was never swapped, so the last draw must be its default ID.
        vm.prank(ALICE);
        (uint256 id,) = full.mint{value: FEE}(bytes32(0), FEE);
        assertEq(id, 1);
        assertEq(full.ownerOf(1), ALICE);
        vm.prank(BOB);
        vm.expectRevert(MapaeGuardians.MintLimit.selector);
        full.mint{value: FEE}(bytes32(0), FEE);
    }

    function test_randomIdsAreInRangeDistinctAndNotSequential() public {
        uint256 count = 60;
        uint256[] memory ids = new uint256[](count);
        bool sequential = true;
        for (uint256 i; i < count; ++i) {
            address who = address(uint160(0x10000 + i));
            vm.deal(who, 1 ether);
            vm.prevrandao(bytes32(i * 31 + 7));
            (uint256 id, uint64 sequence) = _mint(who);
            assertGe(id, 1);
            assertLe(id, nft.MAX_SUPPLY());
            for (uint256 j; j < i; ++j) {
                assertTrue(ids[j] != id);
            }
            if (id != i + 1) sequential = false;
            ids[i] = id;
            assertEq(nft.pendingMint(who), id);
            assertEq(nft.ownerOf(id), who);
            (bool success,) = entropy.deliver(sequence, bytes32(i + 1));
            assertTrue(success);
            assertEq(nft.pendingMint(who), 0);
            assertEq(
                vm.parseJsonString(_json(id), ".image"),
                string.concat("https://mapae.io/api/arcade/guardians/", vm.toString(id), "/image.svg")
            );
        }
        assertFalse(sequential);
        assertEq(nft.totalSupply(), count);
    }

    function testFuzz_finalDrawsPermuteRemainingIds(uint256 salt) public {
        DrainedGuardianCollection small = _drained();
        small.setMintPaused(false);
        uint256 max = small.MAX_SUPPLY();
        small.setDrawn(max - 12);
        // The last 12 draws come from untouched slots 0..11, so they must be a permutation of IDs 1..12.
        bool[13] memory seen;
        for (uint256 i; i < 12; ++i) {
            address who = address(uint160(0x20000 + i));
            vm.deal(who, 1 ether);
            vm.prevrandao(bytes32(uint256(keccak256(abi.encode(salt, i)))));
            vm.prank(who);
            (uint256 id,) = small.mint{value: FEE}(bytes32(salt), FEE);
            assertGe(id, 1);
            assertLe(id, 12);
            assertFalse(seen[id]);
            seen[id] = true;
        }
    }

    function test_finalDrawsAcrossPackedPoolWordsPermuteRemainingIds() public {
        DrainedGuardianCollection small = _drained();
        small.setMintPaused(false);
        uint256 count = 40; // slots 0..39 span three 16-lane pool words
        small.setDrawn(small.MAX_SUPPLY() - count);
        bool[41] memory seen;
        for (uint256 i; i < count; ++i) {
            address who = address(uint160(0x30000 + i));
            vm.deal(who, 1 ether);
            vm.prevrandao(bytes32(uint256(keccak256(abi.encode("words", i)))));
            vm.prank(who);
            (uint256 id,) = small.mint{value: FEE}(bytes32(i), FEE);
            assertGe(id, 1);
            assertLe(id, count);
            assertFalse(seen[id]);
            seen[id] = true;
        }
        vm.prank(ALICE);
        vm.expectRevert(MapaeGuardians.MintLimit.selector);
        small.mint{value: FEE}(bytes32(0), FEE);
    }

    function test_growthAtomicCountersBestScoresAndGlobalReplay() public {
        uint256 id = _ready(ALICE);
        MapaeGuardians.Result memory first = _result(id, 1, 0, 50, true);
        _claim(first);
        _claim(_result(id, 2, 0, 40, false));
        _claim(_result(id, 3, 1, 75, true));
        _claim(_result(id, 4, 2, 60, false));
        GuardianMetadata.Progress memory p = nft.progress(id);
        assertEq(p.plays, 4);
        assertEq(p.victories, 2);
        assertEq(p.experience, 50);
        assertEq(p.gamePlays[0], 2);
        assertEq(p.gameVictories[0], 1);
        assertEq(p.bestScores[0], 50);
        assertEq(p.bestScores[1], 75);
        assertEq(p.bestScores[2], 60);
        assertTrue(nft.claimedPayments(first.paymentTx));
        bytes memory duplicateSignature = _sign(first, SIGNER_KEY);
        vm.expectRevert(MapaeGuardians.AlreadyClaimed.selector);
        nft.claimResult(first, duplicateSignature);
        MapaeGuardians.Result memory duplicatePayment = _result(_ready(BOB), 5, 1, 60, true);
        duplicatePayment.paymentTx = first.paymentTx;
        duplicateSignature = _sign(duplicatePayment, SIGNER_KEY);
        vm.expectRevert(MapaeGuardians.AlreadyClaimed.selector);
        nft.claimResult(duplicatePayment, duplicateSignature);
        assertEq(nft.progress(duplicatePayment.tokenId).plays, 0);
    }

    /// @dev A first claim writes exactly three slots: claimedPayments, growth counters and growth best scores.
    function test_firstClaimWritesThreeSlots() public {
        uint256 id = _ready(ALICE);
        MapaeGuardians.Result memory r = _result(id, 1, 2, 20, true);
        bytes memory sig = _sign(r, SIGNER_KEY);
        vm.record();
        nft.claimResult(r, sig);
        (, bytes32[] memory writes) = vm.accesses(address(nft));
        assertEq(_distinct(writes), 3);
        GuardianMetadata.Progress memory p = nft.progress(id);
        assertEq(p.plays, 1);
        assertEq(p.victories, 1);
        assertEq(p.experience, 15);
        assertEq(p.gamePlays[2], 1);
        assertEq(p.gameVictories[2], 1);
        assertEq(p.bestScores[2], 20);
    }

    function test_maxScoreAndCountersStayInTheirLanes() public {
        uint256 id = _ready(ALICE);
        _claim(_result(id, 1, 0, 1_000_000_000, true));
        _claim(_result(id, 2, 1, 1_000_000_000, false));
        _claim(_result(id, 3, 2, 1_000_000_000, true));
        _claim(_result(id, 4, 1, 999_999_999, true));
        GuardianMetadata.Progress memory p = nft.progress(id);
        assertEq(p.plays, 4);
        assertEq(p.victories, 3);
        assertEq(p.experience, 55);
        assertEq(p.gamePlays[0], 1);
        assertEq(p.gamePlays[1], 2);
        assertEq(p.gamePlays[2], 1);
        assertEq(p.gameVictories[0], 1);
        assertEq(p.gameVictories[1], 1);
        assertEq(p.gameVictories[2], 1);
        for (uint256 g; g < 3; ++g) {
            assertEq(p.bestScores[g], 1_000_000_000);
        }
    }

    function _distinct(bytes32[] memory writes) internal pure returns (uint256 distinct) {
        for (uint256 i; i < writes.length; ++i) {
            bool seen;
            for (uint256 j; j < i; ++j) {
                if (writes[j] == writes[i]) seen = true;
            }
            if (!seen) ++distinct;
        }
    }

    function test_historicalClaimsRemainValidAfterTransferAndReturn() public {
        uint256 id = _ready(ALICE);
        MapaeGuardians.Result memory r = _result(id, 1, 0, 20, false);
        bytes memory sig = _sign(r, SIGNER_KEY);
        vm.prank(ALICE);
        nft.transferFrom(ALICE, BOB, id);
        nft.claimResult(r, sig);
        vm.prank(BOB);
        nft.transferFrom(BOB, ALICE, id);
        assertEq(nft.ownershipEpoch(id), 3);
        vm.expectRevert(MapaeGuardians.AlreadyClaimed.selector);
        nft.claimResult(r, sig);
        r = _result(id, 2, 2, 30, true);
        r.ownershipEpoch = 1;
        _claim(r);
        assertEq(nft.progress(id).plays, 2);
    }

    function test_resultSignerRotationRequiresReissueButPreservesReplay() public {
        uint256 id = _ready(ALICE);
        MapaeGuardians.Result memory r = _result(id, 1, 0, 20, true);
        bytes memory oldSig = _sign(r, SIGNER_KEY);
        nft.setResultSigner(vm.addr(888));
        vm.expectRevert(MapaeGuardians.InvalidResultSignature.selector);
        nft.claimResult(r, oldSig);
        nft.claimResult(r, _sign(r, 888));
        nft.setResultSigner(vm.addr(SIGNER_KEY));
        vm.expectRevert(MapaeGuardians.AlreadyClaimed.selector);
        nft.claimResult(r, oldSig);
    }

    function test_tamperingEverySignedFieldCannotEarnGrowth() public {
        uint256 id = _ready(ALICE);
        _ready(BOB);
        MapaeGuardians.Result memory r = _result(id, 1, 0, 20, true);
        bytes memory sig = _sign(r, SIGNER_KEY);
        bytes memory canonical = abi.encode(r);
        for (uint256 field; field < 12; ++field) {
            bytes memory changed = abi.encode(r);
            // Every field occupies one ABI word; toggle its least significant bit (bool stays valid).
            changed[field * 32 + 31] = bytes1(uint8(changed[field * 32 + 31]) ^ 1);
            MapaeGuardians.Result memory tampered = abi.decode(changed, (MapaeGuardians.Result));
            vm.expectRevert();
            nft.claimResult(tampered, sig);
            assertEq(nft.progress(id).plays, 0);
            assertFalse(nft.claimedPayments(r.paymentTx));
        }
        assertEq(abi.encode(r), canonical);
        _claim(r);
        assertEq(nft.progress(id).plays, 1);
    }

    function test_invalidSignedFieldsRejectedEvenWithAuthorizedSignature() public {
        uint256 id = _ready(ALICE);
        MapaeGuardians.Result memory original = _result(id, 1, 0, 20, true);
        for (uint256 field; field < 10; ++field) {
            MapaeGuardians.Result memory r = abi.decode(abi.encode(original), (MapaeGuardians.Result));
            if (field == 0) r.resultId = bytes32(0);
            if (field == 1) r.paymentTx = bytes32(0);
            if (field == 2) r.actor = address(0);
            if (field == 3) r.inputsHash = bytes32(0);
            if (field == 4) r.ownershipEpoch = 0;
            if (field == 5) r.ownershipEpoch = 2;
            if (field == 6) r.game = 3;
            if (field == 7) r.ruleset = 2;
            if (field == 8) r.score = 1_000_000_001;
            if (field == 9) r.traitsHash = bytes32(0);
            bytes memory sig = _sign(r, SIGNER_KEY);
            vm.expectRevert(MapaeGuardians.InvalidResult.selector);
            nft.claimResult(r, sig);
            assertEq(nft.progress(id).plays, 0);
        }
    }

    function test_domainChainAndCollectionReplayRejected() public {
        uint256 id = _ready(ALICE);
        MapaeGuardians.Result memory r = _result(id, 1, 0, 20, true);
        bytes memory sig = _sign(r, SIGNER_KEY);
        vm.chainId(1);
        vm.expectRevert(MapaeGuardians.InvalidResultSignature.selector);
        nft.claimResult(r, sig);
        vm.chainId(91342);
        address other = address(0x5555);
        _cloneProxyAt(other);
        assertNotEq(MapaeGuardians(other).resultDigest(r), nft.resultDigest(r));
        _claim(r);
    }

    function test_adminOnlyPauseRotationAndRoleSeparation() public {
        vm.prank(ALICE);
        vm.expectRevert();
        nft.setMintPaused(true);
        vm.prank(ALICE);
        vm.expectRevert();
        nft.setResultSigner(ALICE);
        vm.expectRevert(MapaeGuardians.InvalidConfiguration.selector);
        nft.setResultSigner(address(this));
        vm.expectRevert(MapaeGuardians.InvalidConfiguration.selector);
        nft.setResultSigner(address(0));
        vm.expectRevert(MapaeGuardians.InvalidConfiguration.selector);
        nft.setResultSigner(address(entropy));
        nft.setMintPaused(true);
        vm.prank(ALICE);
        vm.expectRevert(MapaeGuardians.MintPaused.selector);
        nft.mint{value: FEE}(bytes32(0), FEE);
        nft.transferOwnership(vm.addr(SIGNER_KEY));
        vm.prank(vm.addr(SIGNER_KEY));
        vm.expectRevert(MapaeGuardians.InvalidConfiguration.selector);
        nft.acceptOwnership();
    }

    function test_metadataAllTraitsAndGameCounters() public {
        uint256 id = _ready(ALICE);
        (bytes32 seed,,) = nft.birth(id);
        string memory before = _json(id);
        assertEq(
            vm.parseJsonString(before, ".image"),
            string.concat("https://mapae.io/api/arcade/guardians/", vm.toString(id), "/image.svg")
        );
        assertEq(vm.parseJsonString(before, ".attributes[0].value"), GuardianTraits.zodiac(seed));
        assertEq(vm.parseJsonString(before, ".attributes[1].value"), GuardianTraits.hat(seed));
        assertEq(vm.parseJsonString(before, ".attributes[2].value"), GuardianTraits.outfit(seed));
        assertEq(vm.parseJsonString(before, ".attributes[3].value"), GuardianTraits.shoes(seed));
        assertEq(vm.parseJsonString(before, ".attributes[4].value"), GuardianTraits.backdrop(seed));
        assertEq(vm.parseJsonString(before, ".attributes[5].value"), GuardianTraits.charm(seed));
        assertEq(vm.parseJsonString(before, ".attributes[6].value"), GuardianTraits.color(seed));
        assertEq(vm.parseJsonString(before, ".attributes[7].value"), GuardianTraits.temperament(seed));
        uint8[3] memory a = GuardianTraits.aptitudes(seed);
        assertEq(vm.parseJsonUint(before, ".attributes[8].value"), a[0]);
        assertEq(vm.parseJsonUint(before, ".attributes[9].value"), a[1]);
        assertEq(vm.parseJsonUint(before, ".attributes[10].value"), a[2]);
        assertEq(vm.parseJsonUint(before, ".attributes[11].value"), 1);
        for (uint256 i; i < 7; ++i) {
            _claim(_result(id, i + 1, uint8(i % 3), uint32(20 + i), true));
        }
        string memory after_ = _json(id);
        assertEq(vm.parseJsonUint(after_, ".attributes[12].value"), 7);
        assertEq(vm.parseJsonUint(after_, ".attributes[13].value"), 7);
        assertEq(vm.parseJsonUint(after_, ".attributes[14].value"), 105);
        assertEq(vm.parseJsonUint(after_, ".attributes[15].value"), 2);
        assertEq(vm.parseJsonUint(after_, ".attributes[16].value"), 3);
        assertEq(vm.parseJsonUint(after_, ".attributes[17].value"), 3);
        assertEq(vm.parseJsonUint(after_, ".attributes[18].value"), 26);
        assertEq(vm.parseJsonUint(after_, ".attributes[19].value"), 2);
        assertEq(vm.parseJsonUint(after_, ".attributes[20].value"), 2);
        assertEq(vm.parseJsonUint(after_, ".attributes[21].value"), 24);
        assertEq(vm.parseJsonUint(after_, ".attributes[22].value"), 2);
        assertEq(vm.parseJsonUint(after_, ".attributes[23].value"), 2);
        assertEq(vm.parseJsonUint(after_, ".attributes[24].value"), 25);
        assertTrue(nft.supportsInterface(0x49064906));
        assertTrue(nft.supportsInterface(0x01ffc9a7));
        assertTrue(nft.supportsInterface(0x80ac58cd));
        assertTrue(nft.supportsInterface(0x5b5e139f));
        assertFalse(nft.supportsInterface(0x780e9d63));
        assertFalse(nft.supportsInterface(0xffffffff));
        vm.expectRevert();
        nft.tokenURI(999);
    }

    function testFuzz_aptitudesBalancedAndBounded(bytes32 seed) public pure {
        uint8[3] memory a = GuardianTraits.aptitudes(seed);
        assertEq(uint256(a[0]) + a[1] + a[2], 15);
        assertGe(a[0], 4);
        assertLe(a[0], 6);
        assertGe(a[1], 4);
        assertLe(a[1], 6);
        assertGe(a[2], 4);
        assertLe(a[2], 6);
        assertTrue(a[0] != a[1] && a[1] != a[2] && a[0] != a[2]);
    }

    function test_fixedTypeScriptTraitVectors() public pure {
        bytes32 seed = bytes32(uint256(42));
        assertEq(GuardianTraits.zodiac(seed), "horse");
        assertEq(GuardianTraits.hat(seed), "gat");
        assertEq(GuardianTraits.outfit(seed), "performer");
        assertEq(GuardianTraits.shoes(seed), "taesahye");
        assertEq(GuardianTraits.backdrop(seed), "dawn");
        assertEq(GuardianTraits.charm(seed), "mapae");
        assertEq(GuardianTraits.color(seed), "ink");
        assertEq(GuardianTraits.temperament(seed), "calm");
        uint8[3] memory a = GuardianTraits.aptitudes(seed);
        assertEq(a[0], 4);
        assertEq(a[1], 5);
        assertEq(a[2], 6);
        assertEq(keccak256(abi.encode(seed)), 0xbeced09521047d05b8960b7e7bcc1d1292cf3e4b2a6b63f48335cbde5f7545d2);
        seed = GuardianTraits.birthSeed(seed, 1, 91342, 0x1111111111111111111111111111111111111111);
        assertEq(seed, 0xb1f258260a7bf2dfa0aa3294b9a2732e3c2bb285b2e00bbad1ec64ba087c464c);
        assertEq(GuardianTraits.zodiac(seed), "rabbit");
        assertEq(GuardianTraits.hat(seed), "ikseongwan");
        assertEq(GuardianTraits.outfit(seed), "hemp");
        assertEq(GuardianTraits.shoes(seed), "heukhwa");
        assertEq(GuardianTraits.backdrop(seed), "jade");
        assertEq(GuardianTraits.charm(seed), "none");
        assertEq(GuardianTraits.color(seed), "ink");
        assertEq(GuardianTraits.temperament(seed), "calm");
        a = GuardianTraits.aptitudes(seed);
        assertEq(a[0], 6);
        assertEq(a[1], 4);
        assertEq(a[2], 5);
    }

    function test_runtimeDeployableAndDeploymentChainGuard() public {
        address implementation = address(uint160(uint256(vm.load(address(nft), ERC1967Utils.IMPLEMENTATION_SLOT))));
        assertLt(implementation.code.length, 24_576);
        emit log_named_uint("implementation runtime bytes", implementation.code.length);
        emit log_named_uint("proxy runtime bytes", address(nft).code.length);
        DeployGuardians script = new DeployGuardians();
        vm.chainId(1);
        vm.expectRevert("GIWA Sepolia only");
        script.run();
    }

    function test_constructorRejectsInvalidOracle() public {
        vm.expectRevert(MapaeGuardians.InvalidConfiguration.selector);
        new MapaeGuardians(ALICE, PROVIDER);
        vm.expectRevert(MapaeGuardians.InvalidConfiguration.selector);
        new MapaeGuardians(address(entropy), address(0));
    }

    function test_initializeRejectsInvalidAdminSignerAndImageConfig() public {
        address implementation = address(new MapaeGuardians(address(entropy), PROVIDER));
        address signer = vm.addr(SIGNER_KEY);
        bytes[7] memory bad = [
            abi.encodeCall(MapaeGuardians.initialize, (address(this), address(this), "https://mapae.io/")),
            abi.encodeCall(MapaeGuardians.initialize, (ALICE, address(this), "https://mapae.io/")),
            abi.encodeCall(MapaeGuardians.initialize, (address(this), address(0), "https://mapae.io/")),
            abi.encodeCall(MapaeGuardians.initialize, (address(this), address(entropy), "https://mapae.io/")),
            abi.encodeCall(MapaeGuardians.initialize, (address(this), signer, "http://mapae.io/")),
            abi.encodeCall(MapaeGuardians.initialize, (address(this), signer, "https://mapae.io")),
            abi.encodeCall(MapaeGuardians.initialize, (address(this), signer, "https://"))
        ];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(MapaeGuardians.InvalidConfiguration.selector);
            new ERC1967Proxy(implementation, bad[i]);
        }
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableInvalidOwner.selector, address(0)));
        new ERC1967Proxy(
            implementation, abi.encodeCall(MapaeGuardians.initialize, (address(0), signer, "https://mapae.io/"))
        );
        vm.expectEmit(true, true, false, false);
        emit MapaeGuardians.ResultSignerChanged(address(0), signer);
        vm.expectEmit();
        emit MapaeGuardians.MintPauseChanged(true);
        MapaeGuardians paused = MapaeGuardians(
            address(
                new ERC1967Proxy(
                    implementation,
                    abi.encodeCall(MapaeGuardians.initialize, (address(this), signer, "https://mapae.io/"))
                )
            )
        );
        assertTrue(paused.mintPaused());
        assertEq(paused.owner(), address(this));
        assertEq(paused.resultSigner(), signer);
        assertEq(paused.imageBaseURI(), "https://mapae.io/");
        assertEq(paused.name(), "Mapae Guardians");
        assertEq(paused.symbol(), "MAPAE");
        assertEq(address(paused.entropy()), address(entropy));
        assertEq(paused.entropyProvider(), PROVIDER);
    }

    function test_implementationCannotBeInitializedOrUpgradedDirectly() public {
        MapaeGuardians implementation = new MapaeGuardians(address(entropy), PROVIDER);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        implementation.initialize(address(this), vm.addr(SIGNER_KEY), IMAGE_BASE);
        vm.expectRevert(UUPSUpgradeable.UUPSUnauthorizedCallContext.selector);
        implementation.upgradeToAndCall(address(implementation), "");
        assertEq(implementation.owner(), address(0));
        assertTrue(implementation.mintPaused());
        vm.prank(ALICE);
        vm.expectRevert(MapaeGuardians.MintPaused.selector);
        implementation.mint{value: FEE}(bytes32(0), FEE);
    }

    function test_proxyCannotBeReinitialized() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        nft.initialize(ALICE, vm.addr(SIGNER_KEY), IMAGE_BASE);
        vm.prank(ALICE);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        nft.initialize(ALICE, vm.addr(SIGNER_KEY), IMAGE_BASE);
        assertEq(nft.owner(), address(this));
    }

    function test_onlyOwnerCanUpgradeAndTargetMustBeUUPS() public {
        address v2 = address(new MapaeGuardiansV2Mock(address(entropy), PROVIDER));
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, ALICE));
        nft.upgradeToAndCall(v2, "");
        // Not UUPS: proxiableUUID() is missing (contract) or returns nothing (EOA).
        vm.expectRevert(abi.encodeWithSelector(ERC1967Utils.ERC1967InvalidImplementation.selector, address(entropy)));
        nft.upgradeToAndCall(address(entropy), "");
        // An EOA returns no data, so decoding the try-call result reverts (without data) before the catch clause.
        vm.expectRevert();
        nft.upgradeToAndCall(ALICE, "");
        // proxiableUUID() is notDelegated, so another proxy is rejected as an implementation too.
        vm.expectRevert(abi.encodeWithSelector(ERC1967Utils.ERC1967InvalidImplementation.selector, address(nft)));
        nft.upgradeToAndCall(address(nft), "");
        nft.upgradeToAndCall(v2, "");
        assertEq(address(uint160(uint256(vm.load(address(nft), ERC1967Utils.IMPLEMENTATION_SLOT)))), v2);
        assertEq(MapaeGuardiansV2Mock(address(nft)).version(), 2);
    }

    function test_upgradePreservesStateAndPendingEntropyCallback() public {
        uint256 revealed = _ready(ALICE);
        _claim(_result(revealed, 1, 1, 77, true));
        vm.prank(ALICE);
        nft.transferFrom(ALICE, BOB, revealed);
        (uint256 pending, uint64 sequence) = _mint(ALICE);
        (bytes32 seed,,) = nft.birth(revealed);
        bytes32 traits = nft.traitsHash(revealed);
        bytes memory uri = bytes(nft.tokenURI(revealed));
        nft.setMintPaused(true);
        nft.transferOwnership(BOB);

        MapaeGuardians.Result memory unclaimed = _result(revealed, 2, 0, 5, false);
        bytes memory unclaimedSignature = _sign(unclaimed, SIGNER_KEY);
        vm.expectEmit(address(nft));
        emit MapaeGuardians.BatchMetadataUpdate(1, 10_000);
        nft.upgradeToAndCall(address(new MapaeGuardiansV2Mock(address(entropy), PROVIDER)), "");

        assertEq(MapaeGuardiansV2Mock(address(nft)).version(), 2);
        // The EIP-712 domain survives the upgrade, so signatures issued before it stay claimable.
        _assertDomainIsProxy();
        assertEq(nft.owner(), address(this));
        assertEq(nft.pendingOwner(), BOB);
        assertTrue(nft.mintPaused());
        assertEq(nft.resultSigner(), vm.addr(SIGNER_KEY));
        assertEq(nft.imageBaseURI(), IMAGE_BASE);
        assertEq(nft.totalSupply(), 2);
        assertEq(nft.ownerOf(revealed), BOB);
        assertEq(nft.ownerOf(pending), ALICE);
        assertEq(nft.tokensOfOwner(BOB)[0], revealed);
        assertEq(nft.ownershipEpoch(revealed), 2);
        assertEq(nft.mintedBy(ALICE), 2);
        assertEq(nft.pendingMint(ALICE), pending);
        (bytes32 seedAfter,,) = nft.birth(revealed);
        assertEq(seedAfter, seed);
        assertEq(nft.traitsHash(revealed), traits);
        assertEq(nft.progress(revealed).plays, 1);
        assertEq(nft.progress(revealed).bestScores[1], 77);
        assertTrue(nft.claimedPayments(bytes32(uint256(1001))));
        assertEq(keccak256(bytes(nft.tokenURI(revealed))), keccak256(uri));
        nft.claimResult(unclaimed, unclaimedSignature);
        assertEq(nft.progress(revealed).plays, 2);

        // Pyth still calls the proxy; the new implementation's immutables accept it.
        vm.cool(address(nft));
        (bool success, uint256 used) = entropy.deliver(sequence, bytes32(uint256(5)));
        assertTrue(success);
        assertLt(used, 500_000);
        (bytes32 pendingSeed,, bool done) = nft.birth(pending);
        assertTrue(done);
        assertEq(pendingSeed, GuardianTraits.birthSeed(bytes32(uint256(5)), pending, 91342, address(nft)));
        assertEq(nft.pendingMint(ALICE), 0);

        // The draw pool continues without reissuing an ID.
        nft.setMintPaused(false);
        (uint256 third,) = _mint(BOB);
        assertTrue(third != revealed && third != pending);
        assertEq(nft.totalSupply(), 3);
    }

    function test_storageSlotMatchesErc7201AndPacksHotFields() public {
        DrainedGuardianCollection drained = _drained();
        bytes32 expected =
            keccak256(abi.encode(uint256(keccak256("mapae.storage.MapaeGuardians")) - 1)) & ~bytes32(uint256(0xff));
        assertEq(drained.storageLocation(), expected);
        // Slot 0 of the namespace: resultSigner | mintPaused << 160 | drawn << 168.
        drained.setDrawn(0x1234);
        bytes32 word = vm.load(address(drained), expected);
        assertEq(uint256(word), uint256(uint160(vm.addr(SIGNER_KEY))) | (1 << 160) | (uint256(0x1234) << 168));
        // Sequential slots 0..49 are untouched by every parent; all state is namespaced.
        for (uint256 i; i < 50; ++i) {
            assertEq(vm.load(address(drained), bytes32(i)), bytes32(0));
        }
    }

    /// @dev Pins every GuardiansStorage field to its slot and packing inside the ERC-7201 namespace. `forge inspect
    /// storageLayout` is empty for namespaced storage, so this test is the upgrade layout check: a new
    /// implementation may only append fields, and this test must pass unchanged against it.
    function test_namespacedStorageLayoutIsPinned() public {
        uint256 base = uint256(
            keccak256(abi.encode(uint256(keccak256("mapae.storage.MapaeGuardians")) - 1)) & ~bytes32(uint256(0xff))
        );
        (uint256 id, uint64 sequence) = _mint(ALICE);
        // 1: imageBaseURI (long string: length * 2 + 1)
        assertEq(uint256(vm.load(address(nft), bytes32(base + 1))), bytes(IMAGE_BASE).length * 2 + 1);
        // 2: accounts => pendingMint | minted << 16 | owned << 24
        bytes32 account = keccak256(abi.encode(ALICE, base + 2));
        assertEq(uint256(vm.load(address(nft), account)), id | (1 << 16) | (id << 24));
        // 3: tokens => seed; sequence | ownershipEpoch << 64 | revealed << 128 | attempt << 136
        bytes32 tokenSlot = keccak256(abi.encode(id, base + 3));
        assertEq(
            uint256(vm.load(address(nft), bytes32(uint256(tokenSlot) + 1))), uint256(sequence) | (1 << 64) | (1 << 136)
        );
        // 5: requestToken[keccak256(entropy, provider, sequence)] = tokenId | attempt << 16, deleted on reveal
        bytes32 requestSlot =
            keccak256(abi.encode(keccak256(abi.encode(address(entropy), PROVIDER, sequence)), base + 5));
        assertEq(uint256(vm.load(address(nft), requestSlot)), id | (1 << 16));
        // 7: idPool, sixteen 16-bit lanes per word; the drawn slot now holds the former last ID
        {
            uint256 poolSlot = id - 1;
            bytes32 poolWord = keccak256(abi.encode(poolSlot >> 4, base + 7));
            assertEq((uint256(vm.load(address(nft), poolWord)) >> ((poolSlot & 15) << 4)) & 0xffff, 10_000);
        }

        entropy.deliver(sequence, bytes32(uint256(42)));
        (bytes32 seed,,) = nft.birth(id);
        assertEq(vm.load(address(nft), tokenSlot), seed);
        assertEq(
            uint256(vm.load(address(nft), bytes32(uint256(tokenSlot) + 1))),
            uint256(sequence) | (1 << 64) | (1 << 128) | (1 << 136)
        );
        assertEq(vm.load(address(nft), requestSlot), bytes32(0));
        assertEq(uint256(vm.load(address(nft), account)), (1 << 16) | (id << 24));

        _claim(_result(id, 1, 1, 77, true));
        // 4: growth => counters (40-bit lanes: plays by game, then victories by game); bestScores (32-bit lanes)
        bytes32 growth = keccak256(abi.encode(id, base + 4));
        assertEq(uint256(vm.load(address(nft), growth)), (1 << 40) | (1 << 160));
        assertEq(uint256(vm.load(address(nft), bytes32(uint256(growth) + 1))), 77 << 32);
        // 6: claimedPayments
        assertEq(uint256(vm.load(address(nft), keccak256(abi.encode(bytes32(uint256(1001)), base + 6)))), 1);
    }

    function test_twoStepOwnershipTransferControlsUpgrades() public {
        address v2 = address(new MapaeGuardiansV2Mock(address(entropy), PROVIDER));
        nft.transferOwnership(BOB);
        assertEq(nft.owner(), address(this));
        assertEq(nft.pendingOwner(), BOB);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, ALICE));
        nft.acceptOwnership();
        vm.prank(BOB);
        nft.acceptOwnership();
        assertEq(nft.owner(), BOB);
        assertEq(nft.pendingOwner(), address(0));
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, address(this)));
        nft.upgradeToAndCall(v2, "");
        vm.prank(BOB);
        nft.upgradeToAndCall(v2, "");
        assertEq(MapaeGuardiansV2Mock(address(nft)).version(), 2);
    }

    function test_eip712DomainIsTheProxy() public view {
        _assertDomainIsProxy();
    }

    function _assertDomainIsProxy() internal view {
        (bytes1 fields, string memory name, string memory version, uint256 chainId, address verifying,,) =
            nft.eip712Domain();
        assertEq(fields, hex"0f");
        assertEq(name, "Mapae Guardians");
        assertEq(version, "1");
        assertEq(chainId, 91342);
        assertEq(verifying, address(nft));
    }

    function test_fixedTypeScriptEIP712Vector() public {
        address collection = 0x1111111111111111111111111111111111111111;
        _cloneProxyAt(collection);
        MapaeGuardians.Result memory r = MapaeGuardians.Result({
            resultId: bytes32(uint256(1)),
            tokenId: 1,
            actor: 0x2222222222222222222222222222222222222222,
            ownershipEpoch: 1,
            paymentTx: bytes32(uint256(2)),
            traitsHash: 0xbeced09521047d05b8960b7e7bcc1d1292cf3e4b2a6b63f48335cbde5f7545d2,
            inputsHash: bytes32(uint256(3)),
            ruleset: 3,
            seed: 123,
            game: 1,
            score: 42,
            victory: true
        });
        assertEq(
            MapaeGuardians(collection).resultDigest(r),
            0xb079ab4a54ba1daba3d94f597f3344de1cc079b8009ac86813ac650b15023e9f
        );
    }

    function test_wrongSignerMalformedSignatureAndPendingGrowth() public {
        uint256 id = _ready(ALICE);
        MapaeGuardians.Result memory r = _result(id, 1, 0, 20, true);
        bytes memory signature = _sign(r, 999);
        vm.expectRevert(MapaeGuardians.InvalidResultSignature.selector);
        nft.claimResult(r, signature);
        vm.expectRevert(MapaeGuardians.InvalidResultSignature.selector);
        nft.claimResult(r, hex"01");
        (uint256 pending,) = _mint(BOB);
        r.tokenId = pending;
        vm.expectRevert(MapaeGuardians.PendingDraw.selector);
        nft.claimResult(r, signature);
        assertFalse(nft.claimedPayments(r.paymentTx));
        assertEq(nft.progress(pending).plays, 0);
    }

    /// Regression (audit M-01): requests are keyed by (Entropy, provider, sequence), so after an upgrade to a fresh
    /// Entropy whose sequences restart at 1, minting continues; a birth stranded by the change is re-requested by
    /// its minter and revealed by the new Entropy, and the old Entropy can no longer deliver it.
    function test_entropyChangeKeepsMintingAndRerequestRecoversStrandedBirth() public {
        _ready(ALICE);
        address carol = address(0xCA201);
        vm.deal(carol, 1 ether);
        (uint256 stranded, uint64 oldSequence) = _mint(carol);
        assertEq(oldSequence, 2);
        // The current pair can still deliver it, so a second draw is refused.
        vm.prank(carol);
        vm.expectRevert(MapaeGuardians.PendingDraw.selector);
        nft.rerequestBirth{value: FEE}(stranded, bytes32(0), FEE);

        GuardianEntropyTestDouble entropyB = new GuardianEntropyTestDouble(PROVIDER);
        nft.upgradeToAndCall(address(new MapaeGuardians(address(entropyB), PROVIDER)), "");
        (bool success,) = entropy.deliver(oldSequence, bytes32(uint256(9)));
        assertFalse(success, "old Entropy is no longer accepted");

        for (uint256 i; i < 3; ++i) {
            address who = address(uint160(0xB000 + i));
            vm.deal(who, 1 ether);
            vm.prank(who);
            (, uint64 sequence) = nft.mint{value: FEE}(bytes32(i), FEE);
            assertEq(sequence, i + 1, "fresh Entropy sequences reuse old numbers without colliding");
        }

        vm.prank(BOB);
        vm.expectRevert(MapaeGuardians.InvalidEntropyRequest.selector);
        nft.rerequestBirth{value: FEE}(stranded, bytes32(0), FEE);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(MapaeGuardians.WrongFee.selector, FEE, FEE - 1, FEE));
        nft.rerequestBirth{value: FEE - 1}(stranded, bytes32(0), FEE);
        nft.setMintPaused(true);
        vm.prank(carol);
        vm.expectEmit(address(nft));
        emit MapaeGuardians.BirthRerequested(carol, stranded, 4, bytes32(uint256(5)));
        uint64 sequence = nft.rerequestBirth{value: FEE}(stranded, bytes32(uint256(5)), FEE);
        assertEq(sequence, 4);
        assertEq(nft.mintedBy(carol), 1, "a re-request is not a new mint");
        (, uint64 recorded,) = nft.birth(stranded);
        assertEq(recorded, 4);
        (success,) = entropyB.deliver(sequence, bytes32(uint256(77)));
        assertTrue(success);
        (bytes32 seed,, bool revealed) = nft.birth(stranded);
        assertTrue(revealed);
        assertEq(seed, GuardianTraits.birthSeed(bytes32(uint256(77)), stranded, 91342, address(nft)));
        assertEq(nft.pendingMint(carol), 0);
        assertEq(address(nft).balance, 0);
        vm.prank(carol);
        vm.expectRevert(MapaeGuardians.InvalidEntropyRequest.selector);
        nft.rerequestBirth{value: FEE}(stranded, bytes32(0), FEE);
    }

    /// A provider change on the same Entropy contract: the old provider's requests can still be revealed on Pyth's
    /// side, so the collection must refuse them, or a re-requested birth would have two live draws to pick from.
    function test_providerChangeRefusesOldProviderAndAllowsOneRerequest() public {
        address provider2 = address(0x5678);
        (uint256 id, uint64 oldSequence) = _mint(ALICE);
        entropy.setProvider(provider2);
        nft.upgradeToAndCall(address(new MapaeGuardians(address(entropy), provider2)), "");
        vm.prank(address(entropy));
        vm.expectRevert(MapaeGuardians.InvalidEntropyRequest.selector);
        nft._entropyCallback(oldSequence, PROVIDER, bytes32(uint256(1)));

        vm.prank(ALICE);
        uint64 sequence = nft.rerequestBirth{value: FEE}(id, bytes32(uint256(2)), FEE);
        vm.prank(ALICE);
        vm.expectRevert(MapaeGuardians.PendingDraw.selector);
        nft.rerequestBirth{value: FEE}(id, bytes32(uint256(3)), FEE);
        vm.prank(address(entropy));
        vm.expectRevert(MapaeGuardians.InvalidEntropyRequest.selector);
        nft._entropyCallback(oldSequence, provider2, bytes32(uint256(1)));
        (bool success,) = entropy.deliver(sequence, bytes32(uint256(4)));
        assertTrue(success);
        (,, bool revealed) = nft.birth(id);
        assertTrue(revealed);
    }

    /// Regression (re-audit L-04): sequence numbers restart on a fresh Entropy, so a re-requested birth can carry the
    /// same number as the request it replaced. Reinstating the old Entropy must not let the superseded request
    /// reveal the token: requests are bound to the token's attempt, not to a bare sequence number.
    function test_reinstatedOldPairCannotDeliverSupersededRequestOnSequenceCollision() public {
        _ready(ALICE); // A seq 1
        address carol = address(0xCA201);
        vm.deal(carol, 1 ether);
        (uint256 stranded, uint64 oldSequence) = _mint(carol); // A seq 2
        assertEq(oldSequence, 2);

        GuardianEntropyTestDouble entropyB = new GuardianEntropyTestDouble(PROVIDER);
        address implA = address(new MapaeGuardians(address(entropy), PROVIDER));
        address implB = address(new MapaeGuardians(address(entropyB), PROVIDER));
        nft.upgradeToAndCall(implB, "");
        _mint(BOB); // B seq 1
        vm.prank(carol);
        uint64 newSequence = nft.rerequestBirth{value: FEE}(stranded, bytes32(uint256(5)), FEE); // B seq 2
        assertEq(newSequence, oldSequence, "numeric collision across pairs");

        // Rollback to the original Entropy: the superseded request (A, 2) is refused.
        nft.upgradeToAndCall(implA, "");
        (bool success,) = entropy.deliver(oldSequence, bytes32(uint256(9)));
        assertFalse(success, "superseded request refused");
        (,, bool revealed) = nft.birth(stranded);
        assertFalse(revealed);

        // The live request is on B, which A cannot deliver, so a re-request on A is allowed and is the only live one.
        vm.prank(carol);
        uint64 latest = nft.rerequestBirth{value: FEE}(stranded, bytes32(uint256(6)), FEE);
        vm.prank(carol);
        vm.expectRevert(MapaeGuardians.PendingDraw.selector);
        nft.rerequestBirth{value: FEE}(stranded, bytes32(uint256(7)), FEE);
        (success,) = entropy.deliver(oldSequence, bytes32(uint256(9)));
        assertFalse(success, "still refused after the re-request");

        // Switching to B again: B's request (attempt 2) is superseded by A's (attempt 3) and is refused too.
        nft.upgradeToAndCall(implB, "");
        (success,) = entropyB.deliver(newSequence, bytes32(uint256(10)));
        assertFalse(success, "B request superseded by the later A request");
        nft.upgradeToAndCall(implA, "");
        (success,) = entropy.deliver(latest, bytes32(uint256(11)));
        assertTrue(success);
        (bytes32 seed,, bool done) = nft.birth(stranded);
        assertTrue(done);
        assertEq(seed, GuardianTraits.birthSeed(bytes32(uint256(11)), stranded, 91342, address(nft)));
        assertEq(nft.pendingMint(carol), 0);
    }

    function test_ownedLanesTrackEveryOwnershipChange() public {
        uint256 a1 = _ready(ALICE);
        uint256 a2 = _ready(ALICE);
        uint256 a3 = _ready(ALICE);
        uint256 b1 = _ready(BOB);
        _assertOwned(ALICE);
        _assertOwned(BOB);
        vm.startPrank(ALICE);
        nft.transferFrom(ALICE, BOB, a2);
        nft.transferFrom(ALICE, ALICE, a1);
        vm.stopPrank();
        _assertOwned(ALICE);
        _assertOwned(BOB);
        vm.prank(BOB);
        nft.transferFrom(BOB, ALICE, b1);
        _assertOwned(ALICE);
        _assertOwned(BOB);
        vm.prank(BOB);
        vm.expectRevert(MapaeGuardians.MintLimit.selector);
        nft.transferFrom(BOB, ALICE, a2);
        vm.prank(ALICE);
        nft.safeTransferFrom(ALICE, address(0xD0D), a3);
        _assertOwned(ALICE);
        _assertOwned(address(0xD0D));
        assertEq(nft.totalSupply(), 4);
        assertEq(nft.tokensOfOwner(address(0xE0E)).length, 0);
    }

    function _assertOwned(address who) internal view {
        uint256[] memory ids = nft.tokensOfOwner(who);
        assertEq(ids.length, nft.balanceOf(who));
        for (uint256 i; i < ids.length; ++i) {
            assertEq(nft.ownerOf(ids[i]), who);
            for (uint256 j; j < i; ++j) {
                assertTrue(ids[i] != ids[j]);
            }
        }
    }

    /// Every ID 1..10,000 is drawn exactly once, and draw 10,001 reverts.
    function test_fullDrainIsAPermutation() public {
        uint256[40] memory seen;
        vm.pauseGasMetering();
        for (uint256 i; i < 10_000; ++i) {
            address who = address(uint160(0x100000 + i));
            vm.deal(who, FEE);
            vm.prank(who);
            (uint256 id,) = nft.mint{value: FEE}(bytes32(i), FEE);
            assertTrue(id >= 1 && id <= 10_000);
            uint256 bit = 1 << (id & 255);
            assertEq(seen[id >> 8] & bit, 0, "duplicate id");
            seen[id >> 8] |= bit;
        }
        address last = address(0xFFFFFF);
        vm.deal(last, FEE);
        vm.prank(last);
        vm.expectRevert(MapaeGuardians.MintLimit.selector);
        nft.mint{value: FEE}(bytes32(0), FEE);
        vm.resumeGasMetering();
        assertEq(nft.totalSupply(), 10_000);
        for (uint256 w; w < 39; ++w) {
            assertEq(seen[w] | (w == 0 ? 1 : 0), type(uint256).max, "missing id");
        }
        assertEq(seen[39], (uint256(1) << ((10_000 & 255) + 1)) - 1);
    }

    /// No ETH rests in the collection: the fee is forwarded exactly and plain transfers are rejected.
    function test_noEthRetained() public {
        _mint(ALICE);
        assertEq(address(nft).balance, 0);
        assertEq(address(entropy).balance, FEE);
        vm.prank(ALICE);
        (bool ok,) = address(nft).call{value: 1}("");
        assertFalse(ok);
    }

    /// Accepted (audit I): a contract minter can choose its token ID by rejecting other draws in its receiver
    /// hook. Traits stay out of reach because they come from the later Pyth reveal.
    function test_receiverCanChooseIdButNotTraits() public {
        PickyReceiver picky = new PickyReceiver(nft);
        vm.deal(address(picky), 1 ether);
        uint256 c;
        for (;; ++c) {
            uint256 slot = uint256(
                keccak256(abi.encode(block.prevrandao, address(picky), bytes32(c), uint256(10_000), address(nft)))
            ) % 10_000;
            if (slot == 7776) break;
        }
        picky.setWanted(7777);
        vm.expectRevert(bytes("not the ID I want"));
        picky.draw{value: FEE}(bytes32(c + 1));
        picky.draw{value: FEE}(bytes32(c));
        assertEq(nft.ownerOf(7777), address(picky));
        (,, bool revealed) = nft.birth(7777);
        assertFalse(revealed);
    }

    /// The high-s twin and the EIP-2098 compact form of a valid signature are both rejected.
    function test_signatureMalleabilityRejected() public {
        uint256 id = _ready(ALICE);
        MapaeGuardians.Result memory r = _result(id, 1, 0, 20, true);
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(SIGNER_KEY, nft.resultDigest(r));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory highS = abi.encodePacked(rr, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(MapaeGuardians.InvalidResultSignature.selector);
        nft.claimResult(r, highS);
        bytes32 vs = bytes32(uint256(s) | (uint256(v - 27) << 255));
        vm.expectRevert(MapaeGuardians.InvalidResultSignature.selector);
        nft.claimResult(r, abi.encodePacked(rr, vs));
        nft.claimResult(r, abi.encodePacked(rr, s, v));
        assertEq(nft.progress(id).plays, 1);
    }

    /// The contract checks only that ownershipEpoch is not in the future; actor and the departure epoch are signer
    /// attestations, and anyone may relay a signed result.
    function test_epochIsUpperBoundOnlyAndActorIsAnAttestation() public {
        uint256 id = _ready(ALICE);
        vm.prank(ALICE);
        nft.transferFrom(ALICE, BOB, id);
        vm.prank(BOB);
        nft.transferFrom(BOB, BOB, id);
        assertEq(nft.ownershipEpoch(id), 3);
        MapaeGuardians.Result memory r = _result(id, 1, 0, 20, true);
        r.ownershipEpoch = 1;
        r.actor = address(0xDEAD);
        bytes memory sig = _sign(r, SIGNER_KEY);
        vm.prank(address(0xCAFE));
        nft.claimResult(r, sig);
        assertEq(nft.progress(id).plays, 1);
    }

    /// imageBaseURI is the only free-form string; quotes, backslashes and control characters are escaped.
    function test_imageBaseIsEscapedInMetadata() public {
        string memory hostile = string.concat("https://x.io/a\",\"name\":\"pwn\\", string(hex"01"), "/");
        nft = MapaeGuardians(
            address(
                new ERC1967Proxy(
                    address(new MapaeGuardians(address(entropy), PROVIDER)),
                    abi.encodeCall(MapaeGuardians.initialize, (address(this), vm.addr(SIGNER_KEY), hostile))
                )
            )
        );
        nft.setMintPaused(false);
        uint256 id = _ready(ALICE);
        string memory json = _json(id);
        assertEq(vm.parseJsonString(json, ".name"), string.concat("Mapae Guardian #", vm.toString(id)));
        assertEq(vm.parseJsonString(json, ".image"), string.concat(hostile, vm.toString(id), "/image.svg"));
    }

    function _batch(MapaeGuardians.Result[] memory results)
        internal
        view
        returns (MapaeGuardians.Result[] memory, bytes[] memory signatures)
    {
        signatures = new bytes[](results.length);
        for (uint256 i; i < results.length; ++i) {
            signatures[i] = _sign(results[i], SIGNER_KEY);
        }
        return (results, signatures);
    }

    function _results(uint256 id, uint256 from, uint256 count)
        internal
        view
        returns (MapaeGuardians.Result[] memory r)
    {
        r = new MapaeGuardians.Result[](count);
        for (uint256 i; i < count; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            r[i] = _result(id, from + i, uint8(i % 3), uint32(10 + i), i % 2 == 0);
        }
    }

    function test_claimResultsAppliesEachResultLikeSingleClaims() public {
        uint256 id = _ready(ALICE);
        uint256 other = _ready(BOB);
        MapaeGuardians.Result[] memory r = new MapaeGuardians.Result[](4);
        r[0] = _result(id, 1, 0, 50, true);
        r[1] = _result(id, 2, 0, 40, false);
        r[2] = _result(id, 3, 1, 75, true);
        r[3] = _result(other, 4, 2, 60, false);
        (, bytes[] memory sigs) = _batch(r);
        // Permissionless like claimResult: any relayer may submit, and claims ignore the mint pause.
        nft.setMintPaused(true);
        for (uint256 i; i < r.length; ++i) {
            vm.expectEmit(address(nft));
            emit MapaeGuardians.ResultClaimed(r[i].resultId, r[i].tokenId, r[i].paymentTx, r[i].actor);
            vm.expectEmit(address(nft));
            emit MapaeGuardians.MetadataUpdate(r[i].tokenId);
        }
        vm.prank(address(0xCAFE));
        assertEq(nft.claimResults(r, sigs), 4);
        GuardianMetadata.Progress memory p = nft.progress(id);
        assertEq(p.plays, 3);
        assertEq(p.victories, 2);
        assertEq(p.experience, 40);
        assertEq(p.gamePlays[0], 2);
        assertEq(p.bestScores[0], 50);
        assertEq(p.bestScores[1], 75);
        assertEq(nft.progress(other).plays, 1);
        assertEq(nft.progress(other).bestScores[2], 60);
        for (uint256 i; i < r.length; ++i) {
            assertTrue(nft.claimedPayments(r[i].paymentTx));
        }
    }

    /// A paymentTx claimed elsewhere or earlier in the same batch is skipped rather than failing the batch.
    function test_claimResultsSkipsAlreadyClaimedAndInBatchDuplicates() public {
        uint256 id = _ready(ALICE);
        MapaeGuardians.Result memory claimed = _result(id, 1, 0, 50, true);
        _claim(claimed);
        MapaeGuardians.Result memory fresh = _result(id, 2, 1, 30, false);
        MapaeGuardians.Result memory samePayment = _result(id, 3, 2, 90, true);
        samePayment.paymentTx = fresh.paymentTx;
        MapaeGuardians.Result[] memory r = new MapaeGuardians.Result[](4);
        (r[0], r[1], r[2], r[3]) = (claimed, fresh, fresh, samePayment);
        (, bytes[] memory sigs) = _batch(r);
        vm.recordLogs();
        assertEq(nft.claimResults(r, sigs), 1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2);
        assertEq(logs[0].topics[0], MapaeGuardians.ResultClaimed.selector);
        assertEq(logs[0].topics[1], fresh.resultId);
        GuardianMetadata.Progress memory p = nft.progress(id);
        assertEq(p.plays, 2);
        assertEq(p.bestScores[2], 0);
        // Nothing left to apply: the batch reverts like a repeated single claim.
        vm.expectRevert(MapaeGuardians.AlreadyClaimed.selector);
        nft.claimResults(r, sigs);
    }

    /// Skipping never hides an invalid entry: every entry is fully verified, and one failure reverts them all.
    function test_claimResultsRevertsWholeBatchOnAnyInvalidEntry() public {
        uint256 id = _ready(ALICE);
        MapaeGuardians.Result memory claimed = _result(id, 1, 0, 50, true);
        _claim(claimed);
        MapaeGuardians.Result[] memory r = _results(id, 10, 3);
        (, bytes[] memory sigs) = _batch(r);

        bytes memory good = sigs[1];
        sigs[1] = _sign(r[1], 999);
        vm.expectRevert(MapaeGuardians.InvalidResultSignature.selector);
        nft.claimResults(r, sigs);
        sigs[1] = hex"01";
        vm.expectRevert(MapaeGuardians.InvalidResultSignature.selector);
        nft.claimResults(r, sigs);
        sigs[1] = good;

        // An already-claimed entry with a forged signature is rejected, not skipped.
        MapaeGuardians.Result[] memory withClaimed = new MapaeGuardians.Result[](2);
        (withClaimed[0], withClaimed[1]) = (r[0], claimed);
        bytes[] memory forged = new bytes[](2);
        (forged[0], forged[1]) = (sigs[0], _sign(claimed, 999));
        vm.expectRevert(MapaeGuardians.InvalidResultSignature.selector);
        nft.claimResults(withClaimed, forged);

        // A signed result from a future ownership epoch is invalid in a batch as in a single claim.
        uint64 epoch = r[2].ownershipEpoch;
        r[2].ownershipEpoch = epoch + 1;
        sigs[2] = _sign(r[2], SIGNER_KEY);
        vm.expectRevert(MapaeGuardians.InvalidResult.selector);
        nft.claimResults(r, sigs);
        r[2].ownershipEpoch = epoch;
        sigs[2] = _sign(r[2], SIGNER_KEY);

        (uint256 pending,) = _mint(BOB);
        r[2].tokenId = pending;
        vm.expectRevert(MapaeGuardians.PendingDraw.selector);
        nft.claimResults(r, sigs);
        r[2].tokenId = 9_999_999;
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 9_999_999));
        nft.claimResults(r, sigs);
        r[2].tokenId = id;

        assertEq(nft.progress(id).plays, 1);
        for (uint256 i; i < r.length; ++i) {
            assertFalse(nft.claimedPayments(r[i].paymentTx));
        }
        assertEq(nft.claimResults(r, sigs), 3);
        assertEq(nft.progress(id).plays, 4);
    }

    /// Historical results stay valid after a transfer, and a batch may carry the previous owner's results.
    function test_claimResultsAcceptsHistoricalEpochsAfterTransfer() public {
        uint256 id = _ready(ALICE);
        MapaeGuardians.Result[] memory r = _results(id, 1, 2);
        (, bytes[] memory sigs) = _batch(r);
        vm.prank(ALICE);
        nft.transferFrom(ALICE, BOB, id);
        assertEq(nft.ownershipEpoch(id), 2);
        vm.prank(BOB);
        assertEq(nft.claimResults(r, sigs), 2);
        assertEq(nft.progress(id).plays, 2);
    }

    function test_claimResultsBoundsBatchSize() public {
        uint256 id = _ready(ALICE);
        uint256 cap = nft.MAX_CLAIM_BATCH();
        assertEq(cap, 32);
        MapaeGuardians.Result[] memory empty;
        vm.expectRevert(MapaeGuardians.InvalidBatch.selector);
        nft.claimResults(empty, new bytes[](0));
        (MapaeGuardians.Result[] memory over, bytes[] memory overSigs) = _batch(_results(id, 1, cap + 1));
        vm.expectRevert(MapaeGuardians.InvalidBatch.selector);
        nft.claimResults(over, overSigs);
        bytes[] memory short = new bytes[](cap);
        vm.expectRevert(MapaeGuardians.InvalidBatch.selector);
        nft.claimResults(over, short);
        (MapaeGuardians.Result[] memory full, bytes[] memory fullSigs) = _batch(_results(id, 1, cap));
        uint256 before = gasleft();
        assertEq(nft.claimResults(full, fullSigs), cap);
        assertLt(before - gasleft(), 2_000_000);
        GuardianMetadata.Progress memory p = nft.progress(id);
        assertEq(p.plays, cap);
        assertEq(p.experience, 10 * cap + 5 * (cap / 2));
    }

    /// Calldata gas under EIP-2028 (16 per nonzero byte, 4 per zero byte), for whole-transaction comparisons.
    function _calldataGas(bytes memory data) internal pure returns (uint256 gas) {
        for (uint256 i; i < data.length; ++i) {
            gas += data[i] == 0 ? 4 : 16;
        }
    }

    /// Records whole-transaction gas (21,000 base + calldata + cold execution) of N single claims against one
    /// batch of the same N results, starting from identical state.
    function test_gasClaimResultsVersusSingleClaims() public {
        uint256 id = _ready(ALICE);
        uint256[3] memory sizes = [uint256(1), 8, 32];
        for (uint256 k; k < sizes.length; ++k) {
            uint256 n = sizes[k];
            (MapaeGuardians.Result[] memory r, bytes[] memory sigs) = _batch(_results(id, 1000 * (k + 1), n));
            uint256 snapshot = vm.snapshotState();
            uint256 singles;
            for (uint256 i; i < n; ++i) {
                vm.cool(address(nft));
                bytes memory data = abi.encodeCall(MapaeGuardians.claimResult, (r[i], sigs[i]));
                uint256 start = gasleft();
                (bool ok,) = address(nft).call(data);
                uint256 used = start - gasleft();
                singles += used + 21_000 + _calldataGas(data);
                assertTrue(ok);
            }
            vm.revertToState(snapshot);
            vm.cool(address(nft));
            bytes memory batchData = abi.encodeCall(MapaeGuardians.claimResults, (r, sigs));
            uint256 begin = gasleft();
            (bool success,) = address(nft).call(batchData);
            uint256 batch = begin - gasleft();
            batch += 21_000 + _calldataGas(batchData);
            assertTrue(success);
            assertEq(nft.progress(id).plays, n);
            emit log_named_uint(string.concat("claims ", vm.toString(n), ": singles total gas"), singles);
            emit log_named_uint(string.concat("claims ", vm.toString(n), ": batch total gas"), batch);
            if (n > 1) assertLt(batch, singles);
            vm.revertToState(snapshot);
        }
    }

    /// Upgrading the live proxy to an implementation with claimResults keeps every byte of state, and results
    /// signed before the upgrade can be batched afterwards, skipping those already claimed singly.
    function test_upgradeToBatchClaimImplementationPreservesState() public {
        uint256 id = _ready(ALICE);
        MapaeGuardians.Result[] memory r = _results(id, 1, 3);
        (, bytes[] memory sigs) = _batch(r);
        nft.claimResult(r[0], sigs[0]);
        vm.prank(ALICE);
        nft.transferFrom(ALICE, BOB, id);
        string memory uri = nft.tokenURI(id);
        bytes32 traits = nft.traitsHash(id);

        address next = address(new MapaeGuardians(address(entropy), PROVIDER));
        vm.expectEmit(address(nft));
        emit MapaeGuardians.BatchMetadataUpdate(1, 10_000);
        nft.upgradeToAndCall(next, "");
        assertEq(address(uint160(uint256(vm.load(address(nft), ERC1967Utils.IMPLEMENTATION_SLOT)))), next);
        _assertDomainIsProxy();
        assertEq(nft.owner(), address(this));
        assertEq(nft.resultSigner(), vm.addr(SIGNER_KEY));
        assertFalse(nft.mintPaused());
        assertEq(nft.ownerOf(id), BOB);
        assertEq(nft.ownershipEpoch(id), 2);
        assertEq(nft.traitsHash(id), traits);
        assertEq(keccak256(bytes(nft.tokenURI(id))), keccak256(bytes(uri)));
        assertTrue(nft.claimedPayments(r[0].paymentTx));

        assertEq(nft.claimResults(r, sigs), 2);
        assertEq(nft.progress(id).plays, 3);
    }
}
