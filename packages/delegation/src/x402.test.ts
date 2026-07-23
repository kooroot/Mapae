import {describe, expect, test} from "bun:test";
import type {SmartAccountsEnvironment} from "@metamask/smart-accounts-kit";
import {encodeDelegations} from "@metamask/smart-accounts-kit/utils";
import {decodeFunctionData, getAddress, type Address, type Hex} from "viem";
import {
    MOCK_USDC,
    buildErc7710PaymentPayload,
    buildErc7710PaymentRequirements,
} from "@mapae/shared";
import {ENTRY_POINT_V07} from "./config.js";
import {
    buildD3Policies,
    preparePeriodDelegation,
    withDelegationSignature,
} from "./policy.js";
import {
    PaymentIntentSingleFlight,
    buildDelegatedTransfer,
    validateDelegatedPayment,
} from "./x402.js";

const address = (suffix: number): Address =>
    getAddress(`0x${suffix.toString(16).padStart(40, "0")}`);
const PAYEE = getAddress("0x2000000000000000000000000000000000000001");
const OTHER_PAYEE = getAddress("0x2000000000000000000000000000000000000002");
const FACILITATOR = getAddress("0x3000000000000000000000000000000000000001");
const OTHER_FACILITATOR = getAddress("0x3000000000000000000000000000000000000002");
const MANAGER = getAddress("0x4000000000000000000000000000000000000001");
const DELEGATOR = getAddress("0x5000000000000000000000000000000000000001");
const OTHER_DELEGATOR = getAddress("0x5000000000000000000000000000000000000002");
const TEAM_MANAGER = getAddress("0x6000000000000000000000000000000000000001");
const SIGNATURE = `0x${"11".repeat(65)}` as Hex;
const D3_POLICIES = buildD3Policies(OTHER_PAYEE);

const environment: SmartAccountsEnvironment = {
    DelegationManager: MANAGER,
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

function rootPermissionContext(): Hex {
    const root = preparePeriodDelegation({
        environment,
        delegator: DELEGATOR,
        delegate: FACILITATOR,
        policy: D3_POLICIES["open-agent"],
        startDate: 2_000_000_000,
    });
    return encodeDelegations([withDelegationSignature(root, SIGNATURE)]);
}

function nestedPermissionContext(): Hex {
    const root = withDelegationSignature(
        preparePeriodDelegation({
            environment,
            delegator: DELEGATOR,
            delegate: TEAM_MANAGER,
            policy: D3_POLICIES["team-manager"],
            startDate: 2_000_000_000,
        }),
        SIGNATURE,
    );
    const parentPermissionContext = encodeDelegations([root]);
    const leaf = withDelegationSignature(
        preparePeriodDelegation({
            environment,
            delegator: TEAM_MANAGER,
            delegate: FACILITATOR,
            policy: D3_POLICIES["child-a"],
            startDate: 2_000_000_000,
            parentPermissionContext,
        }),
        SIGNATURE,
    );
    return encodeDelegations([leaf, root]);
}

function request(permissionContext = rootPermissionContext()) {
    const accepted = buildErc7710PaymentRequirements({
        payTo: PAYEE,
        amount: 1_000_000n,
        facilitatorAddresses: [FACILITATOR],
    });
    return {
        x402Version: 2,
        paymentRequirements: accepted,
        paymentPayload: buildErc7710PaymentPayload({
            accepted,
            delegationManager: MANAGER,
            permissionContext,
            delegator: DELEGATOR,
        }),
    };
}

describe("D4 ERC-7710 facilitator boundary", () => {
    test("builds the exact token transfer the facilitator simulates and settles", () => {
        const payment = validateDelegatedPayment(request(), {
            delegationManager: MANAGER,
            facilitator: FACILITATOR,
        });
        const transfer = buildDelegatedTransfer(payment);
        const execution = transfer.executions[0]?.[0];
        expect(execution?.target).toBe(MOCK_USDC.address);
        expect(execution?.value).toBe(0n);

        const decoded = decodeFunctionData({
            abi: [
                {
                    type: "function",
                    name: "transfer",
                    stateMutability: "nonpayable",
                    inputs: [
                        {name: "to", type: "address"},
                        {name: "amount", type: "uint256"},
                    ],
                    outputs: [{name: "", type: "bool"}],
                },
            ],
            data: execution?.callData ?? "0x",
        });
        expect(decoded.functionName).toBe("transfer");
        expect(decoded.args).toEqual([PAYEE, 1_000_000n]);
    });

    test("derives the canonical payer from the last/root delegation", () => {
        const payment = validateDelegatedPayment(request(nestedPermissionContext()), {
            delegationManager: MANAGER,
            facilitator: FACILITATOR,
        });
        expect(payment.payer).toBe(DELEGATOR);
    });

    test("rejects a claimed delegator that differs from the signed root payer", () => {
        const tampered = request();
        tampered.paymentPayload.payload.delegator = OTHER_DELEGATOR;
        expect(() =>
            validateDelegatedPayment(tampered, {
                delegationManager: MANAGER,
                facilitator: FACILITATOR,
            }),
        ).toThrow("does not match the signed root payer");
    });

    test("uses a byte-stable payment intent ID instead of hashing JSON text", () => {
        const lower = request();
        const upper = request();
        upper.paymentPayload.payload.permissionContext =
            `0x${upper.paymentPayload.payload.permissionContext.slice(2).toUpperCase()}` as Hex;

        const lowerId = validateDelegatedPayment(lower, {
            delegationManager: MANAGER,
            facilitator: FACILITATOR,
        }).paymentIntentId;
        const upperId = validateDelegatedPayment(upper, {
            delegationManager: MANAGER,
            facilitator: FACILITATOR,
        }).paymentIntentId;

        expect(upperId).toBe(lowerId);

        const differentTerms = request();
        const differentRequirements = buildErc7710PaymentRequirements({
            payTo: OTHER_PAYEE,
            amount: 1_000_000n,
            facilitatorAddresses: [FACILITATOR],
        });
        differentTerms.paymentRequirements = differentRequirements;
        differentTerms.paymentPayload.accepted = differentRequirements;
        const differentId = validateDelegatedPayment(differentTerms, {
            delegationManager: MANAGER,
            facilitator: FACILITATOR,
        }).paymentIntentId;
        expect(differentId).not.toBe(lowerId);
    });

    test("coalesces concurrent settlement work for the same payment intent", async () => {
        const payment = validateDelegatedPayment(request(), {
            delegationManager: MANAGER,
            facilitator: FACILITATOR,
        });
        const singleFlight = new PaymentIntentSingleFlight<string>();
        let executions = 0;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const execute = async () => {
            executions += 1;
            await gate;
            return "settled";
        };

        const first = singleFlight.run(payment.paymentIntentId, execute);
        const second = singleFlight.run(payment.paymentIntentId, execute);
        await Promise.resolve();
        expect(executions).toBe(1);

        release();
        expect(await Promise.all([first, second])).toEqual(["settled", "settled"]);
        expect(executions).toBe(1);
    });

    test("rejects a manager swap, facilitator mismatch, and accepted-offer tampering", () => {
        expect(() =>
            validateDelegatedPayment(request(), {
                delegationManager: getAddress(
                    "0x4000000000000000000000000000000000000002",
                ),
                facilitator: FACILITATOR,
            }),
        ).toThrow("allowlisted");

        expect(() =>
            validateDelegatedPayment(request(), {
                delegationManager: MANAGER,
                facilitator: OTHER_FACILITATOR,
            }),
        ).toThrow("not advertised");

        const tampered = request();
        tampered.paymentPayload.accepted = {
            ...tampered.paymentPayload.accepted,
            amount: "2",
        };
        expect(() =>
            validateDelegatedPayment(tampered, {
                delegationManager: MANAGER,
                facilitator: FACILITATOR,
            }),
        ).toThrow("do not exactly match");

        const malformed = request("0x1234");
        expect(() =>
            validateDelegatedPayment(malformed, {
                delegationManager: MANAGER,
                facilitator: FACILITATOR,
            }),
        ).toThrow("not a valid delegation chain");
    });
});
