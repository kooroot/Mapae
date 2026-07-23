import {describe, expect, test} from "bun:test";
import {privateKeyToAccount} from "viem/accounts";
import {getAddress, type Address, type Hex} from "viem";
import type {SmartAccountsEnvironment} from "@metamask/smart-accounts-kit";
import {decodeDelegations, encodeDelegations} from "@metamask/smart-accounts-kit/utils";
import {ENTRY_POINT_V07} from "./config.js";
import {buildFrameworkOwnershipAcceptance} from "./admin.js";
import {
    buildD3Policies,
    preparePeriodDelegation,
    withDelegationSignature,
} from "./policy.js";
import {buildRevocationCall} from "./revocation.js";
import {signChildPeriodPermission} from "./signing.js";

const address = (suffix: number): Address =>
    getAddress(`0x${suffix.toString(16).padStart(40, "0")}`);
const MANAGER_KEY =
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const D3_POLICIES = buildD3Policies(address(20));

const environment: SmartAccountsEnvironment = {
    DelegationManager: address(1),
    EntryPoint: ENTRY_POINT_V07,
    SimpleFactory: address(2),
    implementations: {HybridDeleGatorImpl: address(3)},
    caveatEnforcers: {
        ValueLteEnforcer: address(4),
        ERC20PeriodTransferEnforcer: address(5),
        ERC20TransferAmountEnforcer: address(6),
        AllowedCalldataEnforcer: address(7),
        TimestampEnforcer: address(8),
        RedeemerEnforcer: address(9),
    },
};

describe("D3 signing and revocation preparation", () => {
    test("manager signs a child permission while preserving the parent chain", async () => {
        const manager = privateKeyToAccount(MANAGER_KEY);
        const parent = preparePeriodDelegation({
            environment,
            delegator: address(10),
            delegate: manager.address,
            policy: D3_POLICIES["team-manager"],
            startDate: 2_000_000_000,
        });
        const parentContext = encodeDelegations([
            withDelegationSignature(parent, `0x${"11".repeat(65)}`),
        ]);
        const artifact = await signChildPeriodPermission({
            managerPrivateKey: MANAGER_KEY,
            managerAddress: manager.address,
            childAddress: address(12),
            parentPermissionContext: parentContext,
            environment,
            policy: D3_POLICIES["child-a"],
            startDate: 2_000_000_000,
        });
        const chain = decodeDelegations(artifact.permissionContext);

        expect(chain).toHaveLength(2);
        expect(getAddress(chain[0]!.delegate)).toBe(address(12));
        expect(getAddress(chain[1]!.delegate)).toBe(manager.address);
        expect(chain[0]!.signature).not.toBe("0x");
    });

    test("revocation is targeted at the delegator smart account, not the manager", () => {
        const delegation = preparePeriodDelegation({
            environment,
            delegator: address(10),
            delegate: address(11),
            policy: D3_POLICIES["open-agent"],
            startDate: 2_000_000_000,
        });
        const call = buildRevocationCall(delegation);
        expect(call.to).toBe(address(10));
        expect(call.to).not.toBe(environment.DelegationManager);
        expect(call.data.startsWith("0x")).toBe(true);
    });

    test("Framework ownership acceptance is a zero-value admin-wallet call", () => {
        const call = buildFrameworkOwnershipAcceptance(address(1));
        expect(call.to).toBe(address(1));
        expect(call.value).toBe(0n);
        expect(call.data).toHaveLength(10);
    });
});
