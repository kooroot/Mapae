// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Deploys the owner's counterfactual HybridDeleGator through SimpleFactory.
contract DeployOwnerAccount is Script {
    using stdJson for string;

    uint256 private constant GIWA_SEPOLIA_CHAIN_ID = 91_342;
    address private constant GIWA_ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    bytes32 private constant GIWA_ENTRY_POINT_CODE_HASH =
        0x8db5ff695839d655407cc8490bb7a5d82337a86a6b39c3f0258aa6c3b582fc58;
    bytes32 private constant PROXY_CREATION_CODE_HASH =
        0xc8fb9314d27cddb08b374dd2bf47cd06c6fb879756ddfbedf522a8c58756a8e0;
    bytes32 private constant PROXY_RUNTIME_CODE_HASH =
        0x8678a7d794f76a790255c0db52d6276dc7259cc7a211426bca106e5ebb4b1ddf;
    bytes32 private constant ERC1967_IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 private constant OWNER_ACCOUNT_SALT = bytes32(0);
    string private constant COMPOSITION_ID = "mapae-sak-1.7.0-d90569fa-df-d0ebab53-e297f795";
    string private constant ACCOUNT_DEPLOYMENT_APPROVAL =
        "reviewed-owner-account-chain-91342-mapae-sak-1.7.0-d90569fa-df-d0ebab53-e297f795";

    error WrongChain(uint256 actual);
    error InvalidEnvironment();
    error FrameworkNotActive();
    error ArtifactIdentityMismatch();
    error ApprovalMismatch();
    error DeployerAddressMismatch(address expected, address actual);
    error OwnerAccountNotDeployed();
    error OwnerAccountAddressMismatch();
    error OwnerAccountVerificationFailed();

    function run() external returns (address account) {
        if (block.chainid != GIWA_SEPOLIA_CHAIN_ID) revert WrongChain(block.chainid);
        string memory deploymentPath =
            vm.envOr("DELEGATION_DEPLOYMENT_PATH", string("../deployments/giwa-sepolia.framework.json"));
        string memory deploymentJson = vm.readFile(deploymentPath);
        if (
            deploymentJson.readUint(".chainId") != GIWA_SEPOLIA_CHAIN_ID
                || keccak256(bytes(deploymentJson.readString(".state"))) != keccak256(bytes("active"))
                || keccak256(bytes(deploymentJson.readString(".compositionId"))) != keccak256(bytes(COMPOSITION_ID))
        ) {
            revert ArtifactIdentityMismatch();
        }
        address factory = deploymentJson.readAddress(".environment.SimpleFactory");
        address implementation = deploymentJson.readAddress(".environment.implementations.HybridDeleGatorImpl");
        address manager = deploymentJson.readAddress(".environment.DelegationManager");
        address entryPoint = deploymentJson.readAddress(".environment.EntryPoint");
        address frameworkAdmin = vm.envAddress("FRAMEWORK_ADMIN_ADDRESS");
        if (deploymentJson.readAddress(".admin.owner") != frameworkAdmin) {
            revert ArtifactIdentityMismatch();
        }
        address accountOwner = vm.envAddress("CASE_1_OWNER_ADDRESS");
        string memory artifactPath = vm.envOr("FRAMEWORK_ARTIFACT_PATH", string("./generated/framework-artifacts.json"));

        _assertActiveEnvironment(manager, entryPoint, frameworkAdmin);
        account = _counterfactualAddress(artifactPath, factory, implementation, accountOwner);
        if (account.code.length == 0) {
            if (vm.envOr("OWNER_ACCOUNT_VERIFY_ONLY", false)) {
                revert OwnerAccountNotDeployed();
            }
            if (
                keccak256(bytes(vm.envString("GIWA_ACCOUNT_DEPLOYMENT_APPROVAL")))
                    != keccak256(bytes(ACCOUNT_DEPLOYMENT_APPROVAL))
            ) {
                revert ApprovalMismatch();
            }
            uint256 deployerPrivateKey = _readDeployerPrivateKey();
            address expectedDeployer = vm.envAddress("DEPLOYER_ADDRESS");
            address actualDeployer = vm.addr(deployerPrivateKey);
            if (actualDeployer != expectedDeployer) {
                revert DeployerAddressMismatch(expectedDeployer, actualDeployer);
            }
            vm.startBroadcast(deployerPrivateKey);
            address actual = _deployOwner(artifactPath, factory, implementation, manager, entryPoint, accountOwner);
            vm.stopBroadcast();
            if (actual != account) revert OwnerAccountAddressMismatch();
        }
        _verifyOwner(account, implementation, manager, entryPoint, accountOwner);

        string memory outputPath =
            vm.envOr("OWNER_ACCOUNT_FORGE_PATH", string("../deployments/giwa-sepolia.owner-account.json"));
        string memory objectKey = "mapae-owner-account";
        vm.serializeUint(objectKey, "schemaVersion", 1);
        vm.serializeUint(objectKey, "chainId", block.chainid);
        vm.serializeAddress(objectKey, "account", account);
        vm.serializeAddress(objectKey, "owner", accountOwner);
        vm.serializeAddress(objectKey, "implementation", implementation);
        vm.serializeAddress(objectKey, "DelegationManager", manager);
        string memory output = vm.serializeAddress(objectKey, "EntryPoint", entryPoint);
        vm.writeJson(output, outputPath);

        console2.log("Owner HybridDeleGator verified");
        console2.log("  account:", account);
        console2.log("  owner:", accountOwner);
        console2.log("  Framework:", deploymentPath);
        console2.log("  artifact:", outputPath);
    }

    /// @dev Exposed for Foundry local tests; production callers should use run().
    function deployForTest(
        string calldata artifactPath,
        address factory,
        address implementation,
        address manager,
        address entryPoint,
        address accountOwner
    ) external returns (address account) {
        account = _deployOwner(artifactPath, factory, implementation, manager, entryPoint, accountOwner);
        _verifyOwner(account, implementation, manager, entryPoint, accountOwner);
    }

    function _deployOwner(
        string memory artifactPath,
        address factory,
        address implementation,
        address manager,
        address entryPoint,
        address accountOwner
    ) internal returns (address account) {
        if (
            factory.code.length == 0 || implementation.code.length == 0 || manager.code.length == 0
                || entryPoint.code.length == 0 || accountOwner == address(0)
        ) {
            revert InvalidEnvironment();
        }
        bytes memory proxyCreationCode = _proxyCreationCode(artifactPath, implementation, accountOwner);
        address expected = _computeCreate2(factory, OWNER_ACCOUNT_SALT, keccak256(proxyCreationCode));
        account = ISimpleFactory(factory).deploy(proxyCreationCode, OWNER_ACCOUNT_SALT);
        if (account != expected) revert OwnerAccountAddressMismatch();
    }

    function _readDeployerPrivateKey() private view returns (uint256) {
        return vm.envUint(vm.envExists("DEPLOYER_PRIVATE_KEY") ? "DEPLOYER_PRIVATE_KEY" : "PRIVATE_KEY");
    }

    function _counterfactualAddress(
        string memory artifactPath,
        address factory,
        address implementation,
        address accountOwner
    ) private view returns (address) {
        bytes memory proxyCreationCode = _proxyCreationCode(artifactPath, implementation, accountOwner);
        return _computeCreate2(factory, OWNER_ACCOUNT_SALT, keccak256(proxyCreationCode));
    }

    function _proxyCreationCode(string memory artifactPath, address implementation, address accountOwner)
        private
        view
        returns (bytes memory)
    {
        string memory json = vm.readFile(artifactPath);
        string memory raw = json.readString(".ownerProxy.ERC1967Proxy");
        bytes memory proxy = vm.parseBytes(raw);
        if (
            keccak256(proxy) != PROXY_CREATION_CODE_HASH
                || json.readBytes32(".ownerProxy.creationCodeHash") != PROXY_CREATION_CODE_HASH
        ) {
            revert ArtifactIdentityMismatch();
        }
        string[] memory keyIds = new string[](0);
        uint256[] memory xValues = new uint256[](0);
        uint256[] memory yValues = new uint256[](0);
        bytes memory initialize =
            abi.encodeCall(IHybridOwnerAccount.initialize, (accountOwner, keyIds, xValues, yValues));
        return bytes.concat(proxy, abi.encode(implementation, initialize));
    }

    function _assertActiveEnvironment(address managerAddress, address entryPoint, address frameworkAdmin) private view {
        if (
            entryPoint != GIWA_ENTRY_POINT || entryPoint.codehash != GIWA_ENTRY_POINT_CODE_HASH
                || frameworkAdmin == address(0)
        ) {
            revert InvalidEnvironment();
        }
        IActiveDelegationManager manager = IActiveDelegationManager(managerAddress);
        if (manager.owner() != frameworkAdmin || manager.pendingOwner() != address(0) || manager.paused()) {
            revert FrameworkNotActive();
        }
    }

    function _verifyOwner(
        address account,
        address implementation,
        address manager,
        address entryPoint,
        address accountOwner
    ) private view {
        if (account.codehash != PROXY_RUNTIME_CODE_HASH) {
            revert OwnerAccountVerificationFailed();
        }
        address slotImplementation = address(uint160(uint256(vm.load(account, ERC1967_IMPLEMENTATION_SLOT))));
        IHybridOwnerAccount ownerAccount = IHybridOwnerAccount(account);
        if (
            slotImplementation != implementation || ownerAccount.getImplementation() != implementation
                || ownerAccount.owner() != accountOwner || ownerAccount.delegationManager() != manager
                || ownerAccount.entryPoint() != entryPoint || ownerAccount.getInitializedVersion() != 1
                || ownerAccount.getKeyIdHashesCount() != 0
        ) {
            revert OwnerAccountVerificationFailed();
        }
    }

    function _computeCreate2(address factory, bytes32 salt, bytes32 initCodeHash) private pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), factory, salt, initCodeHash)))));
    }
}

interface ISimpleFactory {
    function deploy(bytes memory bytecode, bytes32 salt) external returns (address);
}

interface IActiveDelegationManager {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function paused() external view returns (bool);
}

interface IHybridOwnerAccount {
    function initialize(address owner, string[] calldata keyIds, uint256[] calldata xValues, uint256[] calldata yValues)
        external;
    function owner() external view returns (address);
    function delegationManager() external view returns (address);
    function entryPoint() external view returns (address);
    function getImplementation() external view returns (address);
    function getInitializedVersion() external view returns (uint64);
    function getKeyIdHashesCount() external view returns (uint256);
}
