// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MapaeGuardians} from "../src/MapaeGuardians.sol";
import {IEntropyV2} from "@pythnetwork/entropy-sdk-solidity/IEntropyV2.sol";
import {EntropyStructsV2} from "@pythnetwork/entropy-sdk-solidity/EntropyStructsV2.sol";

/// @notice Deploy paused. A separately verified GIWA request/reveal canary precedes public mint enablement.
contract DeployGuardians is Script {
    address public constant ENTROPY = 0x0708325268dF9F66270F1401206434524814508b;
    address public constant PROVIDER = 0x6CC14824Ea2918f5De5C2f75A9Da968ad4BD6344;

    function run() external returns (MapaeGuardians guardians) {
        require(block.chainid == 91342, "GIWA Sepolia only");
        require(ENTROPY.code.length != 0, "Entropy missing");
        IEntropyV2 service = IEntropyV2(ENTROPY);
        require(service.getDefaultProvider() == PROVIDER, "Provider changed");
        EntropyStructsV2.ProviderInfo memory provider = service.getProviderInfoV2(PROVIDER);
        require(
            provider.originalCommitment != bytes32(0) && provider.sequenceNumber < provider.endSequenceNumber,
            "Provider exhausted or unregistered"
        );
        require(provider.defaultGasLimit >= 500_000, "Callback gas changed");
        uint256 deployerKey = vm.envUint("GUARDIAN_DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        require(deployer == vm.envAddress("GUARDIAN_DEPLOYER_ADDRESS"), "Deployer mismatch");
        address admin = vm.envAddress("GUARDIAN_ADMIN_ADDRESS");
        address signer = vm.envAddress("GUARDIAN_RESULT_SIGNER_ADDRESS");
        address paymentSigner = vm.envAddress("SESSION_ACCOUNT");
        require(
            admin != address(0) && signer != address(0) && signer != admin && signer != deployer
                && signer != paymentSigner,
            "Separate result signer required"
        );
        string memory imageBase = vm.envString("GUARDIAN_IMAGE_BASE_URI");
        vm.startBroadcast(deployerKey);
        guardians = new MapaeGuardians(admin, signer, ENTROPY, PROVIDER, imageBase);
        vm.stopBroadcast();
        console2.log("Mapae Guardians:", address(guardians));
        console2.log("chainId:", block.chainid);
        console2.log("result signer:", signer);
        console2.log("mint paused:", guardians.mintPaused());
        console2.log("current Entropy fee:", guardians.mintFee());
    }
}
