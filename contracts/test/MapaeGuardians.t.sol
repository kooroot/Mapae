// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {MapaeGuardians} from "../src/MapaeGuardians.sol";
import {GuardianTraits} from "../src/GuardianTraits.sol";
import {IEntropyConsumer} from "@pythnetwork/entropy-sdk-solidity/IEntropyConsumer.sol";
import {DeployGuardians} from "../script/DeployGuardians.s.sol";

/// @dev Deliberately adversarial transport. No test treats this as proof of oracle randomness/liveness.
contract GuardianEntropyTestDouble {
    address public immutable provider;
    uint128 public fee = 15_000_000_000_001;
    uint64 public next = 1;
    bool public failRequest;
    mapping(uint64 => address) public requester;
    mapping(uint64 => bytes32) public contribution;
    mapping(uint64 => uint32) public callbackGas;

    constructor(address provider_) {
        provider = provider_;
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

contract DrainedGuardianCollection is MapaeGuardians {
    constructor(address admin, address signer, address e, address p)
        MapaeGuardians(admin, signer, e, p, "https://mapae.io/api/arcade/guardians/")
    {}

    function setDrawn(uint256 value) external {
        _drawn = value;
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

    function setUp() public {
        vm.chainId(91342);
        entropy = new GuardianEntropyTestDouble(PROVIDER);
        nft = new MapaeGuardians(
            address(this), vm.addr(SIGNER_KEY), address(entropy), PROVIDER, "https://mapae.io/api/arcade/guardians/"
        );
        nft.setMintPaused(false);
        vm.deal(ALICE, 1 ether);
        vm.deal(BOB, 1 ether);
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
        assertEq(nft.tokenOfOwnerByIndex(ALICE, 0), id);
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
        DrainedGuardianCollection full =
            new DrainedGuardianCollection(address(this), vm.addr(SIGNER_KEY), address(entropy), PROVIDER);
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
        DrainedGuardianCollection small =
            new DrainedGuardianCollection(address(this), vm.addr(SIGNER_KEY), address(entropy), PROVIDER);
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

    function test_growthAtomicCountersBestScoresAndGlobalReplay() public {
        uint256 id = _ready(ALICE);
        MapaeGuardians.Result memory first = _result(id, 1, 0, 50, true);
        _claim(first);
        _claim(_result(id, 2, 0, 40, false));
        _claim(_result(id, 3, 1, 75, true));
        _claim(_result(id, 4, 2, 60, false));
        MapaeGuardians.Progress memory p = nft.progress(id);
        assertEq(p.plays, 4);
        assertEq(p.victories, 2);
        assertEq(p.experience, 50);
        assertEq(p.gamePlays[0], 2);
        assertEq(p.gameVictories[0], 1);
        assertEq(p.bestScores[0], 50);
        assertEq(p.bestScores[1], 75);
        assertEq(p.bestScores[2], 60);
        assertTrue(nft.claimedResults(first.resultId));
        assertTrue(nft.claimedPayments(first.paymentTx));
        bytes memory duplicateSignature = _sign(first, SIGNER_KEY);
        vm.expectRevert(MapaeGuardians.AlreadyClaimed.selector);
        nft.claimResult(first, duplicateSignature);
        MapaeGuardians.Result memory duplicatePayment = _result(_ready(BOB), 5, 1, 60, true);
        duplicatePayment.paymentTx = first.paymentTx;
        duplicateSignature = _sign(duplicatePayment, SIGNER_KEY);
        vm.expectRevert(MapaeGuardians.AlreadyClaimed.selector);
        nft.claimResult(duplicatePayment, duplicateSignature);
        assertFalse(nft.claimedResults(duplicatePayment.resultId));
        assertEq(nft.progress(duplicatePayment.tokenId).plays, 0);
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
            assertFalse(nft.claimedResults(r.resultId));
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
        vm.etch(other, address(nft).code);
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
        assertTrue(nft.supportsInterface(0x780e9d63));
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
        assertLt(address(nft).code.length, 24_576);
        emit log_named_uint("runtime bytes", address(nft).code.length);
        DeployGuardians script = new DeployGuardians();
        vm.chainId(1);
        vm.expectRevert("GIWA Sepolia only");
        script.run();
    }

    function test_constructorRejectsInvalidOracleSignerAndImageConfig() public {
        vm.expectRevert(MapaeGuardians.InvalidConfiguration.selector);
        new MapaeGuardians(address(this), address(this), address(entropy), PROVIDER, "https://mapae.io/");
        vm.expectRevert(MapaeGuardians.InvalidConfiguration.selector);
        new MapaeGuardians(address(this), vm.addr(SIGNER_KEY), ALICE, PROVIDER, "https://mapae.io/");
        vm.expectRevert(MapaeGuardians.InvalidConfiguration.selector);
        new MapaeGuardians(address(this), vm.addr(SIGNER_KEY), address(entropy), address(0), "https://mapae.io/");
        vm.expectRevert(MapaeGuardians.InvalidConfiguration.selector);
        new MapaeGuardians(address(this), vm.addr(SIGNER_KEY), address(entropy), PROVIDER, "http://mapae.io/");
        vm.expectRevert(MapaeGuardians.InvalidConfiguration.selector);
        new MapaeGuardians(address(this), vm.addr(SIGNER_KEY), address(entropy), PROVIDER, "https://mapae.io");
        MapaeGuardians paused =
            new MapaeGuardians(address(this), vm.addr(SIGNER_KEY), address(entropy), PROVIDER, "https://mapae.io/");
        assertTrue(paused.mintPaused());
    }

    function test_fixedTypeScriptEIP712Vector() public {
        address collection = 0x1111111111111111111111111111111111111111;
        vm.etch(collection, address(nft).code);
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
}
