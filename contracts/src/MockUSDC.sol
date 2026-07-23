// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title MockUSDC
/// @notice EIP-3009 test stablecoin for Mapae on GIWA Sepolia.
/// @dev Design notes:
///      - Signature verification goes through OpenZeppelin `SignatureChecker`, so BOTH plain EOAs and
///        ERC-4337 smart accounts (EIP-1271) can authorize. This is required from D3 onward, when the
///        payer becomes a smart account. An `ecrecover`-only implementation silently breaks there.
///      - `decimals()` is 6 to match real USDC. Mismatched decimals cause 10^12 errors in x402 amounts.
///      - The EIP-712 domain (`name`, `version`) MUST match the facilitator's token config, otherwise
///        every signature fails verification. See `eip712Domain()` (ERC-5267) and `DOMAIN_SEPARATOR()`.
///      - `mint` is intentionally permissionless. TESTNET ONLY.
contract MockUSDC is ERC20, EIP712 {
    /*//////////////////////////////////////////////////////////////
                              EIP-712 DOMAIN
    //////////////////////////////////////////////////////////////*/

    /// @dev Keep these in sync with the facilitator's token registration.
    string private constant _EIP712_NAME = "Mock USDC";
    string private constant _EIP712_VERSION = "2";

    /*//////////////////////////////////////////////////////////////
                                TYPEHASHES
    //////////////////////////////////////////////////////////////*/

    /// @dev 0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    /// @dev 0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");

    /*//////////////////////////////////////////////////////////////
                                  STATE
    //////////////////////////////////////////////////////////////*/

    /// @dev EIP-3009 nonces are random bytes32, not sequential.
    mapping(address authorizer => mapping(bytes32 nonce => bool used)) private _authorizationStates;

    /*//////////////////////////////////////////////////////////////
                              EVENTS / ERRORS
    //////////////////////////////////////////////////////////////*/

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    error AuthorizationNotYetValid(uint256 validAfter, uint256 nowTs);
    error AuthorizationExpired(uint256 validBefore, uint256 nowTs);
    error AuthorizationAlreadyUsed(address authorizer, bytes32 nonce);
    error InvalidAuthorizationSignature(address expectedSigner);
    error CallerMustBePayee(address caller, address payee);

    constructor() ERC20("Mock USDC", "mUSDC") EIP712(_EIP712_NAME, _EIP712_VERSION) {}

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice EIP-3009 authorization state.
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    /// @notice Exposed for facilitator/client debugging — most "invalid signature" bugs are domain mismatches.
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /*//////////////////////////////////////////////////////////////
                                 FAUCET
    //////////////////////////////////////////////////////////////*/

    /// @notice Permissionless mint. TESTNET ONLY — never ship this shape to a real network.
    function mint(address to, uint256 value) external {
        _mint(to, value);
    }

    /*//////////////////////////////////////////////////////////////
                                EIP-3009
    //////////////////////////////////////////////////////////////*/

    /// @notice Transfer via off-chain authorization. The relayer/facilitator pays gas.
    /// @dev Front-running note: an observer can extract this authorization from the mempool and submit it
    ///      first. Funds still land at `to`, so this is an ordering/griefing concern rather than theft.
    ///      Contracts that gate on receipt should use `receiveWithAuthorization` instead.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) public {
        _requireValidWindow(validAfter, validBefore);
        _requireUnusedAuthorization(from, nonce);

        bytes32 structHash = keccak256(
            abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
        );
        _requireValidSignature(from, structHash, signature);

        _consumeAuthorization(from, nonce);
        _transfer(from, to, value);
    }

    /// @notice Same as `transferWithAuthorization`, but only the payee may submit it.
    /// @dev Removes the front-running vector above by binding the caller to `to`.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) public {
        if (msg.sender != to) revert CallerMustBePayee(msg.sender, to);

        _requireValidWindow(validAfter, validBefore);
        _requireUnusedAuthorization(from, nonce);

        bytes32 structHash =
            keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce));
        _requireValidSignature(from, structHash, signature);

        _consumeAuthorization(from, nonce);
        _transfer(from, to, value);
    }

    /// @notice Burn an unused nonce so a leaked authorization can never settle.
    function cancelAuthorization(address authorizer, bytes32 nonce, bytes memory signature) public {
        _requireUnusedAuthorization(authorizer, nonce);

        bytes32 structHash = keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce));
        _requireValidSignature(authorizer, structHash, signature);

        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    /*//////////////////////////////////////////////////////////////
                        v/r/s OVERLOADS (COMPAT)
    //////////////////////////////////////////////////////////////*/

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, abi.encodePacked(r, s, v));
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        receiveWithAuthorization(from, to, value, validAfter, validBefore, nonce, abi.encodePacked(r, s, v));
    }

    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        cancelAuthorization(authorizer, nonce, abi.encodePacked(r, s, v));
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNALS
    //////////////////////////////////////////////////////////////*/

    function _requireValidWindow(uint256 validAfter, uint256 validBefore) private view {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid(validAfter, block.timestamp);
        if (block.timestamp >= validBefore) revert AuthorizationExpired(validBefore, block.timestamp);
    }

    function _requireUnusedAuthorization(address authorizer, bytes32 nonce) private view {
        if (_authorizationStates[authorizer][nonce]) revert AuthorizationAlreadyUsed(authorizer, nonce);
    }

    /// @dev Accepts EOA (ECDSA) and smart-account (EIP-1271) signatures.
    function _requireValidSignature(address signer, bytes32 structHash, bytes memory signature) private view {
        bytes32 digest = _hashTypedDataV4(structHash);
        if (!SignatureChecker.isValidSignatureNow(signer, digest, signature)) {
            revert InvalidAuthorizationSignature(signer);
        }
    }

    function _consumeAuthorization(address authorizer, bytes32 nonce) private {
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationUsed(authorizer, nonce);
    }
}
