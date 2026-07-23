// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// @notice Deploys MockUSDC and prints every value the facilitator needs.
/// @dev  forge script script/DeployMockUSDC.s.sol \
///         --rpc-url giwa_sepolia --broadcast --verify -vvvv
contract DeployMockUSDC is Script {
    uint256 private constant GIWA_SEPOLIA_CHAIN_ID = 91342;

    function run() external {
        require(block.chainid == GIWA_SEPOLIA_CHAIN_ID, "GIWA Sepolia only");

        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address testUser = vm.envAddress("TEST_USER");
        require(testUser != vm.addr(deployerKey), "TEST_USER must differ from deployer");

        vm.startBroadcast(deployerKey);

        MockUSDC token = new MockUSDC();

        // 1,000 mUSDC to the test payer so D2 has something to move.
        token.mint(testUser, 1_000 * 10 ** 6);

        vm.stopBroadcast();

        console.log("=== MockUSDC deployed ===");
        console.log("address        :", address(token));
        console.log("chainId        :", block.chainid);
        console.log("decimals       :", token.decimals());
        console.log("minted to      :", testUser);
        console.log("");
        console.log("=== facilitator token config (must match exactly) ===");
        console.log("eip712 name    : Mock USDC");
        console.log("eip712 version : 2");
        console.logBytes32(token.DOMAIN_SEPARATOR());
        console.log("^ DOMAIN_SEPARATOR - compare against the client's computed value when signatures fail");
    }
}
