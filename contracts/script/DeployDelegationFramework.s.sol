// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Deploys the exact 38-unit Smart Accounts Kit 1.7.0 composition pinned by Mapae.
/// @dev The generated artifact bundle contains the audited npm creation bytecodes. Compiling the
///      upstream source under Mapae's 0.8.28 project would produce a different composition.
contract DeployDelegationFramework is Script {
    using stdJson for string;

    uint256 internal constant DEPLOYMENT_COUNT = 38;
    uint256 internal constant DELEGATION_MANAGER_INDEX = 32;
    uint256 internal constant ARGS_EQUALITY_INDEX = 5;
    uint256 internal constant SCL_INDEX = 34;
    uint256 internal constant HYBRID_INDEX = 35;
    uint256 internal constant HYBRID_LINK_START = 14_415;
    uint256 internal constant HYBRID_LINK_LENGTH = 20;

    uint256 internal constant GIWA_SEPOLIA_CHAIN_ID = 91_342;
    address internal constant GIWA_ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    bytes32 internal constant GIWA_ENTRY_POINT_CODE_HASH =
        0x8db5ff695839d655407cc8490bb7a5d82337a86a6b39c3f0258aa6c3b582fc58;
    bytes32 internal constant COMPOSITION_SPEC_HASH =
        0xe297f795868c4f18206506c93ae5984df86e73d8d05c388b32404f866fa49782;
    bytes32 internal constant HYBRID_TEMPLATE_TEXT_HASH =
        0x67f580878a56b3a534d59fe6fa5e5d6ef29da37749cbb163006a8e4b4468e7f5;
    string internal constant COMPOSITION_ID = "mapae-sak-1.7.0-d90569fa-df-d0ebab53-e297f795";
    string internal constant DEPLOYMENT_APPROVAL = "reviewed-chain-91342-mapae-sak-1.7.0-d90569fa-df-d0ebab53-e297f795";

    error WrongChain(uint256 actual);
    error WrongEntryPoint(address entryPoint, bytes32 codeHash);
    error DeployerAddressMismatch(address expected, address actual);
    error InvalidFrameworkAdmin();
    error DeploymentApprovalMismatch();
    error ArtifactIdentityMismatch();
    error CreationCodeMismatch(uint256 index);
    error ContractCreationFailed(uint256 index);
    error OwnershipStateMismatch();

    function run() external returns (address[DEPLOYMENT_COUNT] memory deployed) {
        if (block.chainid != GIWA_SEPOLIA_CHAIN_ID) revert WrongChain(block.chainid);
        if (GIWA_ENTRY_POINT.code.length == 0 || GIWA_ENTRY_POINT.codehash != GIWA_ENTRY_POINT_CODE_HASH) {
            revert WrongEntryPoint(GIWA_ENTRY_POINT, GIWA_ENTRY_POINT.codehash);
        }

        uint256 deployerPrivateKey = _readDeployerPrivateKey();
        address deployer = vm.addr(deployerPrivateKey);
        address expectedDeployer = vm.envAddress("DEPLOYER_ADDRESS");
        if (deployer != expectedDeployer) {
            revert DeployerAddressMismatch(expectedDeployer, deployer);
        }
        address frameworkAdmin = vm.envAddress("FRAMEWORK_ADMIN_ADDRESS");
        if (frameworkAdmin == address(0) || frameworkAdmin == deployer) {
            revert InvalidFrameworkAdmin();
        }
        if (keccak256(bytes(vm.envString("GIWA_DEPLOYMENT_APPROVAL"))) != keccak256(bytes(DEPLOYMENT_APPROVAL))) {
            revert DeploymentApprovalMismatch();
        }
        string memory artifactPath = vm.envOr("FRAMEWORK_ARTIFACT_PATH", string("./generated/framework-artifacts.json"));

        console2.log("Mapae Delegation Framework deployment");
        console2.log("  deployer:", deployer);
        console2.log("  Framework admin:", frameworkAdmin);
        console2.log("  EntryPoint:", GIWA_ENTRY_POINT);
        console2.log("  composition:", COMPOSITION_ID);

        vm.startBroadcast(deployerPrivateKey);
        deployed = _deployFramework(artifactPath, deployer, frameworkAdmin, GIWA_ENTRY_POINT);
        vm.stopBroadcast();

        string memory outputPath = vm.envOr(
            "FRAMEWORK_FORGE_ADDRESS_PATH", string("../deployments/giwa-sepolia.framework-forge-addresses.json")
        );
        _writeAddressArtifact(outputPath, deployed, deployer, frameworkAdmin, GIWA_ENTRY_POINT);
        console2.log("  addresses:", outputPath);
        console2.log("  state: ownership-pending");
    }

    /// @dev Exposed for the Foundry local test. Production callers should use run().
    function deployForTest(string calldata artifactPath, address frameworkAdmin, address entryPoint)
        external
        returns (address[DEPLOYMENT_COUNT] memory)
    {
        return _deployFramework(artifactPath, address(this), frameworkAdmin, entryPoint);
    }

    function _deployFramework(
        string memory artifactPath,
        address initialOwner,
        address frameworkAdmin,
        address entryPoint
    ) internal returns (address[DEPLOYMENT_COUNT] memory deployed) {
        if (
            initialOwner == address(0) || frameworkAdmin == address(0) || frameworkAdmin == initialOwner
                || entryPoint.code.length == 0
        ) {
            revert InvalidFrameworkAdmin();
        }
        string memory json = vm.readFile(artifactPath);
        _assertArtifactIdentity(json);

        for (uint256 index; index < DEPLOYMENT_COUNT; ++index) {
            string memory raw = json.readString(string.concat(".bytecodes.", _deploymentName(index)));
            bytes memory creationCode =
                index == HYBRID_INDEX ? _linkHybrid(raw, deployed[SCL_INDEX]) : vm.parseBytes(raw);
            _assertCreationCode(index, creationCode);

            bytes memory constructorArguments;
            if (index == DELEGATION_MANAGER_INDEX) {
                constructorArguments = abi.encode(initialOwner);
            } else if (index == 33) {
                constructorArguments = abi.encode(deployed[DELEGATION_MANAGER_INDEX], deployed[ARGS_EQUALITY_INDEX]);
            } else if (index >= HYBRID_INDEX) {
                constructorArguments = abi.encode(deployed[DELEGATION_MANAGER_INDEX], entryPoint);
            }
            deployed[index] = _create(index, creationCode, constructorArguments);
            console2.log(index, _deploymentName(index), deployed[index]);
        }

        IOwnable2StepFramework manager = IOwnable2StepFramework(deployed[DELEGATION_MANAGER_INDEX]);
        if (manager.owner() != initialOwner || manager.pendingOwner() != address(0) || manager.paused()) {
            revert OwnershipStateMismatch();
        }
        manager.transferOwnership(frameworkAdmin);
        if (manager.owner() != initialOwner || manager.pendingOwner() != frameworkAdmin || manager.paused()) {
            revert OwnershipStateMismatch();
        }
    }

    function _create(uint256 index, bytes memory creationCode, bytes memory constructorArguments)
        private
        returns (address deployed)
    {
        bytes memory initCode = bytes.concat(creationCode, constructorArguments);
        assembly ("memory-safe") {
            deployed := create(0, add(initCode, 0x20), mload(initCode))
        }
        if (deployed == address(0) || deployed.code.length == 0) {
            revert ContractCreationFailed(index);
        }
    }

    function _readDeployerPrivateKey() private view returns (uint256) {
        return vm.envUint(vm.envExists("DEPLOYER_PRIVATE_KEY") ? "DEPLOYER_PRIVATE_KEY" : "PRIVATE_KEY");
    }

    function _assertArtifactIdentity(string memory json) private pure {
        if (
            json.readUint(".schemaVersion") != 1 || json.readUint(".deploymentCount") != DEPLOYMENT_COUNT
                || keccak256(bytes(json.readString(".compositionId"))) != keccak256(bytes(COMPOSITION_ID))
                || json.readBytes32(".compositionSpecHash") != COMPOSITION_SPEC_HASH
        ) {
            revert ArtifactIdentityMismatch();
        }
    }

    function _assertCreationCode(uint256 index, bytes memory creationCode) private pure {
        bytes32 actual;
        if (index == HYBRID_INDEX) {
            bytes20 link;
            for (uint256 offset; offset < HYBRID_LINK_LENGTH; ++offset) {
                link |= bytes20(creationCode[HYBRID_LINK_START + offset]) >> (offset * 8);
                creationCode[HYBRID_LINK_START + offset] = 0;
            }
            actual = keccak256(creationCode);
            for (uint256 offset; offset < HYBRID_LINK_LENGTH; ++offset) {
                creationCode[HYBRID_LINK_START + offset] = link[offset];
            }
        } else {
            actual = keccak256(creationCode);
        }
        if (actual != _expectedCreationCodeHash(index)) {
            revert CreationCodeMismatch(index);
        }
    }

    function _linkHybrid(string memory raw, address scl) private pure returns (bytes memory) {
        if (scl == address(0) || keccak256(bytes(raw)) != HYBRID_TEMPLATE_TEXT_HASH) {
            revert CreationCodeMismatch(HYBRID_INDEX);
        }
        bytes memory text = bytes(raw);
        uint256 textStart = 2 + HYBRID_LINK_START * 2;
        bytes memory encodedAddress = bytes(_toLowerHex(scl));
        for (uint256 index; index < 40; ++index) {
            text[textStart + index] = encodedAddress[index + 2];
        }
        return vm.parseBytes(string(text));
    }

    function _toLowerHex(address value) private pure returns (string memory) {
        bytes16 symbols = "0123456789abcdef";
        bytes20 data = bytes20(value);
        bytes memory output = new bytes(42);
        output[0] = "0";
        output[1] = "x";
        for (uint256 index; index < 20; ++index) {
            output[2 + index * 2] = symbols[uint8(data[index] >> 4)];
            output[3 + index * 2] = symbols[uint8(data[index] & 0x0f)];
        }
        return string(output);
    }

    function _writeAddressArtifact(
        string memory path,
        address[DEPLOYMENT_COUNT] memory deployed,
        address deployer,
        address frameworkAdmin,
        address entryPoint
    ) private {
        string memory objectKey = "mapae-framework";
        vm.serializeUint(objectKey, "schemaVersion", 1);
        vm.serializeUint(objectKey, "chainId", block.chainid);
        vm.serializeString(objectKey, "compositionId", COMPOSITION_ID);
        vm.serializeAddress(objectKey, "deployer", deployer);
        vm.serializeAddress(objectKey, "frameworkAdmin", frameworkAdmin);
        vm.serializeAddress(objectKey, "EntryPoint", entryPoint);
        string memory json;
        for (uint256 index; index < DEPLOYMENT_COUNT; ++index) {
            json = vm.serializeAddress(objectKey, _deploymentName(index), deployed[index]);
        }
        vm.writeJson(json, path);
    }

    function _deploymentName(uint256 index) internal pure returns (string memory) {
        string[DEPLOYMENT_COUNT] memory names = [
            "SimpleFactory",
            "AllowedCalldataEnforcer",
            "AllowedTargetsEnforcer",
            "AllowedMethodsEnforcer",
            "ApprovalRevocationEnforcer",
            "ArgsEqualityCheckEnforcer",
            "DeployedEnforcer",
            "TimestampEnforcer",
            "BlockNumberEnforcer",
            "LimitedCallsEnforcer",
            "ERC20BalanceChangeEnforcer",
            "ERC20TransferAmountEnforcer",
            "ERC20StreamingEnforcer",
            "ERC721BalanceChangeEnforcer",
            "ERC721TransferEnforcer",
            "ERC1155BalanceChangeEnforcer",
            "IdEnforcer",
            "NonceEnforcer",
            "ValueLteEnforcer",
            "NativeTokenTransferAmountEnforcer",
            "NativeBalanceChangeEnforcer",
            "NativeTokenStreamingEnforcer",
            "OwnershipTransferEnforcer",
            "RedeemerEnforcer",
            "SpecificActionERC20TransferBatchEnforcer",
            "ERC20PeriodTransferEnforcer",
            "NativeTokenPeriodTransferEnforcer",
            "ExactCalldataBatchEnforcer",
            "ExactCalldataEnforcer",
            "ExactExecutionEnforcer",
            "ExactExecutionBatchEnforcer",
            "MultiTokenPeriodEnforcer",
            "DelegationManager",
            "NativeTokenPaymentEnforcer",
            "SCL_RIP7212",
            "HybridDeleGatorImpl",
            "MultiSigDeleGatorImpl",
            "EIP7702StatelessDeleGatorImpl"
        ];
        return names[index];
    }

    function _expectedCreationCodeHash(uint256 index) internal pure returns (bytes32) {
        bytes32[DEPLOYMENT_COUNT] memory hashes = [
            bytes32(0xb9edc85c313403190645581f931075fcd7be32d7683937198454e1b8e0bc47df),
            bytes32(0x38dbfba3662883b326a2feed3cead4fe93a490e6f25492bbc991ec5ec8bc1b79),
            bytes32(0xfc2787b7250255c6d274a502e1d8b36ecc7d6743351096366eba1a34372f1804),
            bytes32(0x162fb6a13b7cc41c0443abd633ef77832109bab1a3dadd4e1aadc6b6e0f6061c),
            bytes32(0x03ed0d65d94b328d4a9ec7e722bdf9ec92b07ef5ef6ad7cb3466e26397c3f606),
            bytes32(0xe961316a1fe08be9205973874bcb0a9b24b4622f4023541bf20bc514e3107865),
            bytes32(0x1c6d891d8c83a5ce299332252ebef3e8a552cafe431105fd8f03de5bea3b2c75),
            bytes32(0x574b9de67818caf7103c54d4020381bedf2fb490ef66fdf465f8cafd73d8363b),
            bytes32(0x5a4449c8a7f5f6bd8570bc58fb72aa59442e11978f68674e35b6ed48752e3bb4),
            bytes32(0x139615de6fa6ee219746b61feb8f07db4a8aae5f06ee19f716d17c8a7e4db852),
            bytes32(0xb5804c6afe6abbbcc6c76ef0ff7d743d619fd92e163b615f2201ec8f48892e04),
            bytes32(0xaf7ac4f88b5f6e442971e88190e7536ab9d5df02681037a3e4aa7bca5bd572fd),
            bytes32(0x4a6ee2f6904845383ef13592981926e73493e19ea8408420d0eeac7a193feee9),
            bytes32(0xad41aeb122b97416210ffeeadccbfe238ea6707fe49870cf2236970e66a66e05),
            bytes32(0xb454f9ba4aa3f19c56461656c33aed39c2c367f66c96a5a895cee7801f99ae48),
            bytes32(0x5fe2d4ce84cd7f571f0854db48f491ce0f9d10508a31b0357223e55d3425d894),
            bytes32(0x98c1388ebdde6fc235d9ec81077734b952a44ea19f144e7fb9f5450daf4c6d47),
            bytes32(0xb01009dfc230ad870d1a8e0397ed51af04d8c1144882f62ee5f9c7ee2572c17d),
            bytes32(0x9d542e67659a86201de903f52adf3db803ca47bc6a15715ef27eb72c386e4c43),
            bytes32(0x834cb8b7afc04b9d9ec50e7e52d606d4b6d2ecdda0893a4e49618d9469829f38),
            bytes32(0x34aed3d041a172e6b5606cf5f7c82ce6e096abee7dc0e66c14bcd4bfafffc705),
            bytes32(0x1cfb00f254013ff2e88bffc6e72f2646268b6513c0ad0f8012d57766b7f29766),
            bytes32(0x732cffbb8de612505cee311b245ff91f0fdf2625883bb543ff5537995b74b0e5),
            bytes32(0xbc4d0d01bac5457181585b52dea16c2b17d5701adf52625de734123ba64f67c2),
            bytes32(0x21ff03355ad2485e64b24666bc87a9e057cfaf33367766c28e52f2f3e422e895),
            bytes32(0x31255a95baf79864773e06b7fab02d7f86e15720ab15d2b0c6b808a4de53b760),
            bytes32(0x09107e0791be2fe69c840de6148b1bf80860f1bff560b13c568bba529af62a77),
            bytes32(0x845125a01adfb36ec6ffc20864c6583941930447d9c3a606224a11010ebfd31e),
            bytes32(0x57770e05d904cd4207bbd636b8b41480f8c066cd7362ce6cc218f6d8e6c73a9f),
            bytes32(0x2e950ac7c53af08498582fbe2006c7c8cc7b4872f13c07bb52adc978081c24cc),
            bytes32(0x8c4a0370ede9217a4f01ccd63680e77760b56e33aa2d804c906a53da80b1c607),
            bytes32(0x758ea2bcf12def92d7e0cac5232ed8e1abd527f17754dc1801722c2c9bf2d1f0),
            bytes32(0x16c6f93163626c1293bfe2341b3501ca059db8cd184abeae10bad6f26e992653),
            bytes32(0x88d05d26117419969ad5c7033170feb2d956ecba005a1bc99fa61571d3968d1e),
            bytes32(0x3184ebff326e016f18a2f16ab863add3e384dc4558b2733bf5689dc67e4dcdf7),
            bytes32(0x619beb9d31212130a79c99009105cd0ade46c69cc243445715674fa626522b40),
            bytes32(0x6b5e983dfaef1fa2faacab260f66228c93270aef9c83d443d7a7bc45e9041cd1),
            bytes32(0x7af2e1a25716422aadfc9dd563a5134290a122488491e3d265066703d801391d)
        ];
        return hashes[index];
    }
}

interface IOwnable2StepFramework {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function paused() external view returns (bool);
    function transferOwnership(address newOwner) external;
}
