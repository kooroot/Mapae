// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// @dev Minimal EIP-1271 account: validates against a single EOA owner.
///      Stands in for the ERC-4337 smart account that becomes the payer from D3.
contract MockSmartAccount is IERC1271 {
    address public immutable owner;

    constructor(address _owner) {
        owner = _owner;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == owner) {
            return IERC1271.isValidSignature.selector;
        }
        return 0xffffffff;
    }
}

contract MockUSDCTest is Test {
    MockUSDC internal token;

    uint256 internal payerKey = 0xA11CE;
    uint256 internal attackerKey = 0xBAD;
    address internal payer;
    address internal payee = address(0xBEEF);
    address internal relayer = address(0xFACE);

    uint256 internal constant AMOUNT = 1_000_000; // 1.00 mUSDC (6 decimals)

    function setUp() public {
        token = new MockUSDC();
        payer = vm.addr(payerKey);
        token.mint(payer, 100 * AMOUNT);
        vm.warp(1_800_000_000);
    }

    /*//////////////////////////////////////////////////////////////
                                 HELPERS
    //////////////////////////////////////////////////////////////*/

    function _transferStructHash(address from, address to, uint256 value, uint256 after_, uint256 before_, bytes32 n)
        internal
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), from, to, value, after_, before_, n));
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
    }

    function _sign(uint256 key, bytes32 structHash) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, _digest(structHash));
        return abi.encodePacked(r, s, v);
    }

    /*//////////////////////////////////////////////////////////////
                               HAPPY PATH
    //////////////////////////////////////////////////////////////*/

    /// @notice Relayer submits; payer never touches gas. This is the x402 settlement path.
    function test_transferWithAuthorization_settlesViaRelayer() public {
        bytes32 nonce = keccak256("n1");
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 hours;

        bytes memory sig = _sign(payerKey, _transferStructHash(payer, payee, AMOUNT, validAfter, validBefore, nonce));

        vm.prank(relayer);
        token.transferWithAuthorization(payer, payee, AMOUNT, validAfter, validBefore, nonce, sig);

        assertEq(token.balanceOf(payee), AMOUNT);
        assertTrue(token.authorizationState(payer, nonce));
    }

    /*//////////////////////////////////////////////////////////////
                          CORE TEST 1: SIGNATURE
    //////////////////////////////////////////////////////////////*/

    function test_rejects_signatureFromWrongSigner() public {
        bytes32 nonce = keccak256("n2");
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 hours;

        bytes memory badSig =
            _sign(attackerKey, _transferStructHash(payer, payee, AMOUNT, validAfter, validBefore, nonce));

        vm.expectRevert(abi.encodeWithSelector(MockUSDC.InvalidAuthorizationSignature.selector, payer));
        token.transferWithAuthorization(payer, payee, AMOUNT, validAfter, validBefore, nonce, badSig);
    }

    /// @dev Any tampering with the signed fields must invalidate the signature.
    function test_rejects_tamperedAmount() public {
        bytes32 nonce = keccak256("n3");
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 hours;

        bytes memory sig = _sign(payerKey, _transferStructHash(payer, payee, AMOUNT, validAfter, validBefore, nonce));

        vm.expectRevert(abi.encodeWithSelector(MockUSDC.InvalidAuthorizationSignature.selector, payer));
        token.transferWithAuthorization(payer, payee, AMOUNT * 2, validAfter, validBefore, nonce, sig);
    }

    /*//////////////////////////////////////////////////////////////
                           CORE TEST 2: REPLAY
    //////////////////////////////////////////////////////////////*/

    function test_rejects_replayOfSameNonce() public {
        bytes32 nonce = keccak256("n4");
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 hours;

        bytes memory sig = _sign(payerKey, _transferStructHash(payer, payee, AMOUNT, validAfter, validBefore, nonce));

        token.transferWithAuthorization(payer, payee, AMOUNT, validAfter, validBefore, nonce, sig);

        vm.expectRevert(abi.encodeWithSelector(MockUSDC.AuthorizationAlreadyUsed.selector, payer, nonce));
        token.transferWithAuthorization(payer, payee, AMOUNT, validAfter, validBefore, nonce, sig);
    }

    function test_cancelAuthorization_burnsNonceBeforeUse() public {
        bytes32 nonce = keccak256("n5");
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 hours;

        bytes memory transferSig =
            _sign(payerKey, _transferStructHash(payer, payee, AMOUNT, validAfter, validBefore, nonce));
        bytes memory cancelSig =
            _sign(payerKey, keccak256(abi.encode(token.CANCEL_AUTHORIZATION_TYPEHASH(), payer, nonce)));

        token.cancelAuthorization(payer, nonce, cancelSig);

        vm.expectRevert(abi.encodeWithSelector(MockUSDC.AuthorizationAlreadyUsed.selector, payer, nonce));
        token.transferWithAuthorization(payer, payee, AMOUNT, validAfter, validBefore, nonce, transferSig);
    }

    /*//////////////////////////////////////////////////////////////
                         CORE TEST 3: TIME WINDOW
    //////////////////////////////////////////////////////////////*/

    function test_rejects_beforeValidAfter() public {
        bytes32 nonce = keccak256("n6");
        uint256 validAfter = block.timestamp + 1 hours;
        uint256 validBefore = block.timestamp + 2 hours;

        bytes memory sig = _sign(payerKey, _transferStructHash(payer, payee, AMOUNT, validAfter, validBefore, nonce));

        vm.expectRevert(abi.encodeWithSelector(MockUSDC.AuthorizationNotYetValid.selector, validAfter, block.timestamp));
        token.transferWithAuthorization(payer, payee, AMOUNT, validAfter, validBefore, nonce, sig);
    }

    function test_rejects_afterExpiry() public {
        bytes32 nonce = keccak256("n7");
        uint256 validAfter = block.timestamp - 2 hours;
        uint256 validBefore = block.timestamp + 1 hours;

        bytes memory sig = _sign(payerKey, _transferStructHash(payer, payee, AMOUNT, validAfter, validBefore, nonce));

        vm.warp(validBefore + 1);

        vm.expectRevert(abi.encodeWithSelector(MockUSDC.AuthorizationExpired.selector, validBefore, block.timestamp));
        token.transferWithAuthorization(payer, payee, AMOUNT, validAfter, validBefore, nonce, sig);
    }

    /*//////////////////////////////////////////////////////////////
                    CORE TEST 4: EIP-1271 (D3 BLOCKER)
    //////////////////////////////////////////////////////////////*/

    /// @notice The payer becomes a smart account from D3. If this test fails, D4 fails.
    function test_acceptsSmartAccountSignature_eip1271() public {
        MockSmartAccount account = new MockSmartAccount(payer);
        token.mint(address(account), 10 * AMOUNT);

        bytes32 nonce = keccak256("n8");
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 hours;

        // Signed by the account's owner key; verified through the account's isValidSignature.
        bytes memory sig =
            _sign(payerKey, _transferStructHash(address(account), payee, AMOUNT, validAfter, validBefore, nonce));

        vm.prank(relayer);
        token.transferWithAuthorization(address(account), payee, AMOUNT, validAfter, validBefore, nonce, sig);

        assertEq(token.balanceOf(payee), AMOUNT);
    }

    function test_rejects_smartAccountSignatureFromNonOwner() public {
        MockSmartAccount account = new MockSmartAccount(payer);
        token.mint(address(account), 10 * AMOUNT);

        bytes32 nonce = keccak256("n9");
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 hours;

        bytes memory sig =
            _sign(attackerKey, _transferStructHash(address(account), payee, AMOUNT, validAfter, validBefore, nonce));

        vm.expectRevert(abi.encodeWithSelector(MockUSDC.InvalidAuthorizationSignature.selector, address(account)));
        token.transferWithAuthorization(address(account), payee, AMOUNT, validAfter, validBefore, nonce, sig);
    }

    /*//////////////////////////////////////////////////////////////
                       receiveWithAuthorization GUARD
    //////////////////////////////////////////////////////////////*/

    function test_receiveWithAuthorization_rejectsNonPayeeCaller() public {
        bytes32 nonce = keccak256("n10");
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 hours;

        bytes32 structHash = keccak256(
            abi.encode(
                token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), payer, payee, AMOUNT, validAfter, validBefore, nonce
            )
        );
        bytes memory sig = _sign(payerKey, structHash);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.CallerMustBePayee.selector, relayer, payee));
        token.receiveWithAuthorization(payer, payee, AMOUNT, validAfter, validBefore, nonce, sig);

        vm.prank(payee);
        token.receiveWithAuthorization(payer, payee, AMOUNT, validAfter, validBefore, nonce, sig);
        assertEq(token.balanceOf(payee), AMOUNT);
    }

    /*//////////////////////////////////////////////////////////////
                                 SANITY
    //////////////////////////////////////////////////////////////*/

    function test_decimalsMatchUSDC() public view {
        assertEq(token.decimals(), 6);
    }
}
