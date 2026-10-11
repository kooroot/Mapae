// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {MapaeGuardians} from "../src/MapaeGuardians.sol";
import {IEntropyV2} from "@pythnetwork/entropy-sdk-solidity/IEntropyV2.sol";
import {EntropyStructsV2} from "@pythnetwork/entropy-sdk-solidity/EntropyStructsV2.sol";

/// @notice Deploy paused. A separately verified GIWA request/reveal canary precedes public mint enablement.
/// @dev Deploys the implementation, then an ERC1967Proxy that runs initialize() in its constructor, so the
/// proxy can never be observed uninitialized. The PROXY is the collection address every app uses.
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
        MapaeGuardians implementation = new MapaeGuardians(ENTROPY, PROVIDER);
        guardians = MapaeGuardians(
            address(
                new ERC1967Proxy(
                    address(implementation), abi.encodeCall(MapaeGuardians.initialize, (admin, signer, imageBase))
                )
            )
        );
        vm.stopBroadcast();
        require(guardians.owner() == admin && guardians.resultSigner() == signer, "Initialization mismatch");
        require(guardians.mintPaused() && guardians.pendingOwner() == address(0), "Must start paused");
        require(address(guardians.entropy()) == ENTROPY && guardians.entropyProvider() == PROVIDER, "Oracle mismatch");
        require(
            address(uint160(uint256(vm.load(address(guardians), ERC1967Utils.IMPLEMENTATION_SLOT))))
                == address(implementation),
            "Implementation slot mismatch"
        );
        console2.log("Mapae Guardians (proxy, ARCADE_GUARDIAN_ADDRESS):", address(guardians));
        console2.log("implementation:", address(implementation));
        console2.log("chainId:", block.chainid);
        console2.log("result signer:", signer);
        console2.log("mint paused:", guardians.mintPaused());
        console2.log("current Entropy fee:", guardians.mintFee());
    }
}
