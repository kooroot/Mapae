// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployDelegationFramework, IOwnable2StepFramework} from "../script/DeployDelegationFramework.s.sol";
import {DeployOwnerAccount} from "../script/DeployOwnerAccount.s.sol";

contract MockEntryPointV07 {
    function version() external pure returns (string memory) {
        return "0.7";
    }
}

interface INativeTokenPaymentWiring {
    function delegationManager() external view returns (address);
    function argsEqualityCheckEnforcer() external view returns (address);
}

interface IDeleGatorWiring {
    function delegationManager() external view returns (address);
    function entryPoint() external view returns (address);
}

interface IAcceptFrameworkOwnership {
    function acceptOwnership() external;
}

interface IHybridOwnerAccountView {
    function owner() external view returns (address);
    function delegationManager() external view returns (address);
}

contract DeployDelegationFrameworkTest is Test {
    string private constant ARTIFACT_PATH = "./generated/framework-artifacts.json";

    DeployDelegationFramework private deployer;
    MockEntryPointV07 private entryPoint;
    address private frameworkAdmin = makeAddr("framework-admin");

    function setUp() external {
        deployer = new DeployDelegationFramework();
        entryPoint = new MockEntryPointV07();
    }

    function test_deploysExact38UnitCompositionAndStartsTwoStepOwnership() external {
        address[38] memory deployed = deployer.deployForTest(ARTIFACT_PATH, frameworkAdmin, address(entryPoint));

        for (uint256 index; index < deployed.length; ++index) {
            assertGt(deployed[index].code.length, 0, "component has no runtime code");
            for (uint256 earlier; earlier < index; ++earlier) {
                assertNotEq(deployed[index], deployed[earlier], "duplicate component address");
            }
        }

        IOwnable2StepFramework manager = IOwnable2StepFramework(deployed[32]);
        assertEq(manager.owner(), address(deployer));
        assertEq(manager.pendingOwner(), frameworkAdmin);
        assertFalse(manager.paused());

        INativeTokenPaymentWiring nativePayment = INativeTokenPaymentWiring(deployed[33]);
        assertEq(nativePayment.delegationManager(), deployed[32]);
        assertEq(nativePayment.argsEqualityCheckEnforcer(), deployed[5]);

        for (uint256 index = 35; index < 38; ++index) {
            IDeleGatorWiring implementation = IDeleGatorWiring(deployed[index]);
            assertEq(implementation.delegationManager(), deployed[32]);
            assertEq(implementation.entryPoint(), address(entryPoint));
        }

        assertEq(_runtimeAddress(deployed[34], 1), deployed[34], "SCL self link");
        assertEq(_runtimeAddress(deployed[35], 12_757), deployed[34], "Hybrid SCL link");

        vm.prank(frameworkAdmin);
        IAcceptFrameworkOwnership(deployed[32]).acceptOwnership();
        assertEq(manager.owner(), frameworkAdmin);
        assertEq(manager.pendingOwner(), address(0));

        DeployOwnerAccount ownerDeployer = new DeployOwnerAccount();
        address accountOwner = makeAddr("account-owner");
        address ownerAccount = ownerDeployer.deployForTest(
            ARTIFACT_PATH, deployed[0], deployed[35], deployed[32], address(entryPoint), accountOwner
        );
        assertGt(ownerAccount.code.length, 0);
        assertEq(IHybridOwnerAccountView(ownerAccount).owner(), accountOwner);
        assertEq(IHybridOwnerAccountView(ownerAccount).delegationManager(), deployed[32]);
    }

    function test_rejectsZeroOrSameFrameworkAdmin() external {
        vm.expectRevert(DeployDelegationFramework.InvalidFrameworkAdmin.selector);
        deployer.deployForTest(ARTIFACT_PATH, address(0), address(entryPoint));

        vm.expectRevert(DeployDelegationFramework.InvalidFrameworkAdmin.selector);
        deployer.deployForTest(ARTIFACT_PATH, address(deployer), address(entryPoint));
    }

    function test_rejectsEntryPointWithoutCode() external {
        vm.expectRevert(DeployDelegationFramework.InvalidFrameworkAdmin.selector);
        deployer.deployForTest(ARTIFACT_PATH, frameworkAdmin, makeAddr("empty-entry-point"));
    }

    function _runtimeAddress(address target, uint256 start) private view returns (address result) {
        bytes memory value = new bytes(20);
        assembly ("memory-safe") {
            extcodecopy(target, add(value, 0x20), start, 20)
        }
        result = address(bytes20(value));
    }
}
