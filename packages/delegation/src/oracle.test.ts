import {describe, expect, test} from "bun:test";
import {getAddress} from "viem";
import {DelegationPolicyOracle, PolicyViolation} from "./oracle.js";
import {buildD3Policies} from "./policy.js";

const START = 2_000_000_000;
const OPEN_AGENT = getAddress("0x1000000000000000000000000000000000000001");
const VENDOR_AGENT = getAddress("0x1000000000000000000000000000000000000002");
const MANAGER = getAddress("0x1000000000000000000000000000000000000003");
const CHILD_A = getAddress("0x1000000000000000000000000000000000000004");
const CHILD_B = getAddress("0x1000000000000000000000000000000000000005");
const OTHER_PAYEE = getAddress("0x2000000000000000000000000000000000000001");
const FIXED_VENDOR = getAddress("0x2000000000000000000000000000000000000002");
const RELAYER = getAddress("0x3000000000000000000000000000000000000001");
const ATTACKER = getAddress("0x3000000000000000000000000000000000000002");
const D3_POLICIES = buildD3Policies(FIXED_VENDOR);

function expectViolation(fn: () => void, code: PolicyViolation["code"]) {
    try {
        fn();
        throw new Error(`expected ${code}`);
    } catch (error) {
        expect(error).toBeInstanceOf(PolicyViolation);
        expect((error as PolicyViolation).code).toBe(code);
    }
}

describe("D3 role and failure scenario oracle", () => {
    test("open agent can vary recipient but cannot cross its 3 mUSDC period cap", () => {
        const oracle = new DelegationPolicyOracle();
        oracle.register({
            id: "open",
            delegate: OPEN_AGENT,
            policy: D3_POLICIES["open-agent"],
            startDate: START,
            redeemers: [RELAYER],
        });

        oracle.settle({
            settlementId: "open-1",
            delegationId: "open",
            amount: 1_000_000n,
            payTo: OTHER_PAYEE,
            redeemer: RELAYER,
            at: START + 1,
        });
        oracle.settle({
            settlementId: "open-2",
            delegationId: "open",
            amount: 2_000_000n,
            payTo: FIXED_VENDOR,
            redeemer: RELAYER,
            at: START + 2,
        });
        expect(oracle.remaining("open", START + 2)).toBe(0n);
        expectViolation(
            () =>
                oracle.settle({
                    settlementId: "open-3",
                    delegationId: "open",
                    amount: 1n,
                    payTo: OTHER_PAYEE,
                    redeemer: RELAYER,
                    at: START + 3,
                }),
            "LIMIT_EXCEEDED",
        );
    });

    test("vendor agent accepts only the fixed vendor", () => {
        const oracle = new DelegationPolicyOracle();
        oracle.register({
            id: "vendor",
            delegate: VENDOR_AGENT,
            policy: D3_POLICIES["vendor-agent"],
            startDate: START,
            redeemers: [RELAYER],
        });
        expectViolation(
            () =>
                oracle.settle({
                    settlementId: "wrong-vendor",
                    delegationId: "vendor",
                    amount: 1_000_000n,
                    payTo: OTHER_PAYEE,
                    redeemer: RELAYER,
                    at: START + 1,
                }),
            "RECIPIENT_DENIED",
        );
        oracle.settle({
            settlementId: "right-vendor",
            delegationId: "vendor",
            amount: 5_000_000n,
            payTo: FIXED_VENDOR,
            redeemer: RELAYER,
            at: START + 1,
        });
    });

    test("manager 6 cap aggregates child A/B even though each child has a 4 cap", () => {
        const oracle = new DelegationPolicyOracle();
        oracle.register({
            id: "manager",
            delegate: MANAGER,
            policy: D3_POLICIES["team-manager"],
            startDate: START,
        });
        oracle.register({
            id: "child-a",
            parentId: "manager",
            delegate: CHILD_A,
            policy: D3_POLICIES["child-a"],
            startDate: START,
            redeemers: [RELAYER],
        });
        oracle.register({
            id: "child-b",
            parentId: "manager",
            delegate: CHILD_B,
            policy: D3_POLICIES["child-b"],
            startDate: START,
            redeemers: [RELAYER],
        });

        oracle.settle({
            settlementId: "a-4",
            delegationId: "child-a",
            amount: 4_000_000n,
            payTo: OTHER_PAYEE,
            redeemer: RELAYER,
            at: START + 1,
        });
        oracle.settle({
            settlementId: "b-2",
            delegationId: "child-b",
            amount: 2_000_000n,
            payTo: OTHER_PAYEE,
            redeemer: RELAYER,
            at: START + 2,
        });
        expect(oracle.remaining("child-b", START + 2)).toBe(2_000_000n);
        expect(oracle.remaining("manager", START + 2)).toBe(0n);
        expectViolation(
            () =>
                oracle.settle({
                    settlementId: "b-over-aggregate",
                    delegationId: "child-b",
                    amount: 1n,
                    payTo: OTHER_PAYEE,
                    redeemer: RELAYER,
                    at: START + 3,
                }),
            "LIMIT_EXCEEDED",
        );
    });

    test("period reset restores allowance after 60 seconds", () => {
        const oracle = new DelegationPolicyOracle();
        oracle.register({
            id: "open",
            delegate: OPEN_AGENT,
            policy: D3_POLICIES["open-agent"],
            startDate: START,
        });
        oracle.settle({
            settlementId: "period-0",
            delegationId: "open",
            amount: 3_000_000n,
            payTo: OTHER_PAYEE,
            redeemer: RELAYER,
            at: START + 59,
        });
        expect(oracle.remaining("open", START + 60)).toBe(3_000_000n);
    });

    test("expiry, unauthorized redeemer, and replay all fail closed", () => {
        const oracle = new DelegationPolicyOracle();
        oracle.register({
            id: "open",
            delegate: OPEN_AGENT,
            policy: D3_POLICIES["open-agent"],
            startDate: START,
            redeemers: [RELAYER],
        });
        expectViolation(
            () =>
                oracle.settle({
                    settlementId: "attacker",
                    delegationId: "open",
                    amount: 1n,
                    payTo: OTHER_PAYEE,
                    redeemer: ATTACKER,
                    at: START + 1,
                }),
            "REDEEMER_DENIED",
        );
        oracle.settle({
            settlementId: "once",
            delegationId: "open",
            amount: 1n,
            payTo: OTHER_PAYEE,
            redeemer: RELAYER,
            at: START + 1,
        });
        expectViolation(
            () =>
                oracle.settle({
                    settlementId: "once",
                    delegationId: "open",
                    amount: 1n,
                    payTo: OTHER_PAYEE,
                    redeemer: RELAYER,
                    at: START + 2,
                }),
            "REPLAY",
        );
        expectViolation(
            () =>
                oracle.settle({
                    settlementId: "expired",
                    delegationId: "open",
                    amount: 1n,
                    payTo: OTHER_PAYEE,
                    redeemer: RELAYER,
                    at: START + 1_800,
                }),
            "EXPIRED",
        );
    });

    test("revoking a manager invalidates descendants; rotation isolates the old key", () => {
        const oracle = new DelegationPolicyOracle();
        oracle.register({
            id: "manager",
            delegate: MANAGER,
            policy: D3_POLICIES["team-manager"],
            startDate: START,
        });
        oracle.register({
            id: "child-a",
            parentId: "manager",
            delegate: CHILD_A,
            policy: D3_POLICIES["child-a"],
            startDate: START,
        });
        oracle.revoke("manager");
        expectViolation(
            () =>
                oracle.settle({
                    settlementId: "revoked-child",
                    delegationId: "child-a",
                    amount: 1n,
                    payTo: OTHER_PAYEE,
                    redeemer: RELAYER,
                    at: START + 1,
                }),
            "REVOKED",
        );

        oracle.rotate("child-a", {
            id: "child-a-rotated",
            parentId: "manager",
            delegate: CHILD_B,
            policy: D3_POLICIES["child-a"],
            startDate: START,
        });
        expectViolation(
            () =>
                oracle.settle({
                    settlementId: "rotated-but-parent-revoked",
                    delegationId: "child-a-rotated",
                    amount: 1n,
                    payTo: OTHER_PAYEE,
                    redeemer: RELAYER,
                    at: START + 1,
                }),
            "REVOKED",
        );
    });
});
