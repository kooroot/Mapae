import {describe, expect, test} from "bun:test";
import {getAddress, type Address} from "viem";
import type {SmartAccountsEnvironment} from "@metamask/smart-accounts-kit";
import {
    ENTRY_POINT_V07,
    parseD3IdentityConfig,
    parseDeploymentArtifact,
} from "./config.js";
import {buildD3Policies, preparePeriodDelegation} from "./policy.js";

const address = (suffix: number): Address =>
    getAddress(`0x${suffix.toString(16).padStart(40, "0")}`);
const FIXED_VENDOR = address(20);
const D3_POLICIES = buildD3Policies(FIXED_VENDOR);

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

describe("MetaMask Delegation Framework policy construction", () => {
    test("parses role addresses from application configuration and rejects zero", () => {
        expect(
            parseD3IdentityConfig({
                accountOwner: address(20),
                frameworkAdmin: address(21),
                fixedVendor: address(22),
            }),
        ).toEqual({
            accountOwner: address(20),
            frameworkAdmin: address(21),
            fixedVendor: address(22),
        });
        expect(() =>
            parseD3IdentityConfig({
                accountOwner: address(20),
                frameworkAdmin: address(0),
                fixedVendor: address(22),
            }),
        ).toThrow("frameworkAdmin must not be the zero address");
    });

    test("builds open and fixed-vendor parent delegations with on-chain caveats", () => {
        const open = preparePeriodDelegation({
            environment,
            delegator: address(10),
            delegate: address(11),
            policy: D3_POLICIES["open-agent"],
            startDate: 2_000_000_000,
        });
        const vendor = preparePeriodDelegation({
            environment,
            delegator: address(10),
            delegate: address(12),
            policy: D3_POLICIES["vendor-agent"],
            startDate: 2_000_000_000,
        });

        expect(open.caveats.map((item) => getAddress(item.enforcer))).toEqual([
            address(4),
            address(5),
            address(8),
        ]);
        expect(vendor.caveats.map((item) => getAddress(item.enforcer))).toEqual([
            address(4),
            address(5),
            address(8),
            address(7),
        ]);
        expect(vendor.delegate).toBe(address(12));
        expect(D3_POLICIES["vendor-agent"].recipient).toBe(FIXED_VENDOR);
    });

    test("deployment artifact rejects a non-canonical EntryPoint", () => {
        expect(() =>
            parseDeploymentArtifact({
                chainId: 91342,
                frameworkVersion: "1.3.0",
                environment: {...environment, EntryPoint: address(99)},
            }),
        ).toThrow("canonical v0.7");
    });
});
