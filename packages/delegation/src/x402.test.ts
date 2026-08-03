import {describe, expect, test} from "bun:test";
import type {SmartAccountsEnvironment} from "@metamask/smart-accounts-kit";
import {encodeDelegations} from "@metamask/smart-accounts-kit/utils";
import {decodeFunctionData, getAddress, type Address, type Hex} from "viem";
import {
    GIWA_SEPOLIA_CAIP2,
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
    SETTLEMENT_UNCONFIRMED,
    buildDelegatedTransfer,
    decideSettlement,
    isVerificationAccepted,
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

    test("rejects a payload whose accepted advertises a different in-band manager", () => {
        // The 402 offer carries an advisory extra.delegationManager; sameRequirement
        // claims exact match, so an echoed `accepted` that swaps it must not pass as
        // identical to the seller's requirements.
        const permissionContext = rootPermissionContext();
        const requirements = buildErc7710PaymentRequirements({
            payTo: PAYEE,
            amount: 1_000_000n,
            facilitatorAddresses: [FACILITATOR],
            delegationManager: MANAGER,
        });
        const tampered = {
            x402Version: 2 as const,
            paymentRequirements: requirements,
            paymentPayload: buildErc7710PaymentPayload({
                accepted: {
                    ...requirements,
                    extra: {...requirements.extra, delegationManager: OTHER_PAYEE},
                },
                delegationManager: MANAGER,
                permissionContext,
                delegator: DELEGATOR,
            }),
        };
        expect(() =>
            validateDelegatedPayment(tampered, {delegationManager: MANAGER, facilitator: FACILITATOR}),
        ).toThrow("do not exactly match");
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

/**
 * The seller's answer about a payment, pinned.
 *
 * This ladder had no test. It is decided in `apps/delegated-seller`, which had no test
 * file at all, and the two claims it must never confuse — "you were not charged" and "we
 * do not know whether you were charged" — differ by one string literal that used to be
 * written out separately in each of the two processes that share it.
 *
 * The cost of getting it wrong is not hypothetical: GIWA tx `0x533c5cb2…9964c` moved
 * 1.00 mUSDC out of the payer while the caller was told the payment was rejected.
 */
describe("D5 settlement outcome ladder", () => {
    const PAYER = getAddress("0x6000000000000000000000000000000000000001");
    const IMPOSTOR = getAddress("0x6000000000000000000000000000000000000002");
    const TX = `0x${"ab".repeat(32)}` as Hex;
    const settled = {success: true, network: GIWA_SEPOLIA_CAIP2, payer: PAYER, transaction: TX};

    test("the happy path is the control for every case below", () => {
        expect(decideSettlement({reachable: true, body: settled}, PAYER)).toEqual({
            kind: "settled",
            transaction: TX,
        });
    });

    test("an unreachable facilitator is unknown, never failed", () => {
        // Connection refused, non-2xx, timeout — the seller cannot tell them apart, and
        // none of them distinguishes "never landed" from "broadcast, answer lost".
        expect(decideSettlement({reachable: false}, PAYER)).toEqual({kind: "unknown"});
    });

    test("a body that is not an object is unknown, never failed", () => {
        for (const body of [undefined, null, "settled", 7]) {
            expect(decideSettlement({reachable: true, body}, PAYER).kind).toBe("unknown");
        }
    });

    test("the unconfirmed sentinel is unknown and keeps the hash", () => {
        // The hash is the only way the caller can find out whether they were charged,
        // so dropping it would leave them with a 504 and nothing to look up.
        expect(
            decideSettlement(
                {
                    reachable: true,
                    body: {
                        success: false,
                        network: GIWA_SEPOLIA_CAIP2,
                        transaction: TX,
                        errorReason: SETTLEMENT_UNCONFIRMED,
                    },
                },
                PAYER,
            ),
        ).toEqual({kind: "unknown", transaction: TX});
    });

    test("the sentinel is one shared constant, not a literal per process", () => {
        // If this ever drifts, the case above silently becomes `failed` — a 422 that
        // asserts a balance nobody checked. Pinning the value is what makes the
        // facilitator and the seller provably agree without running either.
        expect(SETTLEMENT_UNCONFIRMED).toBe("settlement_unconfirmed");
    });

    test("a clean refusal is failed — money did not move", () => {
        expect(
            decideSettlement(
                {
                    reachable: true,
                    body: {
                        success: false,
                        network: GIWA_SEPOLIA_CAIP2,
                        errorReason: "delegation_rejected",
                    },
                },
                PAYER,
            ),
        ).toEqual({kind: "failed"});
    });

    test("success with a payer we did not derive is unknown, not failed", () => {
        // The facilitator says it broadcast. Only the identity it reports disagrees with
        // the one the seller derived from the signed context, so the balance is exactly
        // what nobody has checked — `failed` would assert it.
        expect(
            decideSettlement({reachable: true, body: {...settled, payer: IMPOSTOR}}, PAYER),
        ).toEqual({kind: "unknown", transaction: TX});
        expect(
            decideSettlement({reachable: true, body: {...settled, payer: undefined}}, PAYER),
        ).toEqual({kind: "unknown", transaction: TX});
    });

    test("a malformed hash is dropped rather than echoed into a receipt", () => {
        for (const transaction of ["0xdeadbeef", "not-a-hash", 42, `0x${"ab".repeat(33)}`]) {
            expect(decideSettlement({reachable: true, body: {...settled, transaction}}, PAYER))
                .toEqual({kind: "settled", transaction: undefined});
        }
    });

    test("verification requires both a valid flag and our own payer", () => {
        expect(isVerificationAccepted({isValid: true, payer: PAYER}, PAYER)).toBe(true);
        // Checksum drift must not read as a different payer.
        expect(isVerificationAccepted({isValid: true, payer: PAYER.toLowerCase()}, PAYER)).toBe(
            true,
        );
        for (const body of [
            {isValid: false, payer: PAYER},
            {isValid: true, payer: IMPOSTOR},
            {isValid: true},
            {isValid: true, payer: "0x1234"},
            {payer: PAYER},
            undefined,
            null,
            "ok",
        ]) {
            expect(isVerificationAccepted(body, PAYER)).toBe(false);
        }
    });
});
