// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Optional Forge route for the Framework-admin acceptance transaction.
/// @dev A reviewed Rabby or multisig submission of acceptOwnership() is equally valid.
contract AcceptFrameworkOwnership is Script {
    using stdJson for string;

    uint256 private constant GIWA_SEPOLIA_CHAIN_ID = 91_342;
    string private constant COMPOSITION_ID = "mapae-sak-1.7.0-d90569fa-df-d0ebab53-e297f795";
    string private constant ACCEPTANCE_APPROVAL =
        "reviewed-ownership-acceptance-chain-91342-mapae-sak-1.7.0-d90569fa-df-d0ebab53-e297f795";

    error WrongChain(uint256 actual);
    error ApprovalMismatch();
    error ArtifactIdentityMismatch();
    error OwnershipStateMismatch();

    function run() external {
        if (block.chainid != GIWA_SEPOLIA_CHAIN_ID) revert WrongChain(block.chainid);
        string memory bootstrapPath =
            vm.envOr("DELEGATION_BOOTSTRAP_PATH", string("../deployments/giwa-sepolia.framework.bootstrap.json"));
        string memory bootstrapJson = vm.readFile(bootstrapPath);
        if (
            bootstrapJson.readUint(".chainId") != GIWA_SEPOLIA_CHAIN_ID
                || keccak256(bytes(bootstrapJson.readString(".state"))) != keccak256(bytes("ownership-pending"))
                || keccak256(bytes(bootstrapJson.readString(".compositionId"))) != keccak256(bytes(COMPOSITION_ID))
        ) {
            revert ArtifactIdentityMismatch();
        }
        address managerAddress = bootstrapJson.readAddress(".environment.DelegationManager");
        uint256 adminPrivateKey = vm.envUint("FRAMEWORK_ADMIN_PRIVATE_KEY");
        address frameworkAdmin = vm.addr(adminPrivateKey);
        if (bootstrapJson.readAddress(".admin.pendingOwner") != frameworkAdmin) {
            revert ArtifactIdentityMismatch();
        }
        if (
            keccak256(bytes(vm.envString("GIWA_OWNERSHIP_ACCEPTANCE_APPROVAL")))
                != keccak256(bytes(ACCEPTANCE_APPROVAL))
        ) {
            revert ApprovalMismatch();
        }

        IFrameworkOwnershipAcceptance manager = IFrameworkOwnershipAcceptance(managerAddress);
        if (manager.pendingOwner() != frameworkAdmin || manager.owner() == frameworkAdmin || manager.paused()) {
            revert OwnershipStateMismatch();
        }

        console2.log("Accepting DelegationManager ownership");
        console2.log("  manager:", managerAddress);
        console2.log("  Framework admin:", frameworkAdmin);
        console2.log("  bootstrap:", bootstrapPath);
        vm.startBroadcast(adminPrivateKey);
        manager.acceptOwnership();
        vm.stopBroadcast();

        if (manager.owner() != frameworkAdmin || manager.pendingOwner() != address(0) || manager.paused()) {
            revert OwnershipStateMismatch();
        }
        console2.log("  state: active on-chain; run the independent finalizer next");
    }
}

interface IFrameworkOwnershipAcceptance {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function paused() external view returns (bool);
    function acceptOwnership() external;
}
