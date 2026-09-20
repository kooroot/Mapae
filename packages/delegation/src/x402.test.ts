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
    FACILITATOR_NOT_READY,
    RATE_LIMITED,
    SETTLEMENT_PENDING,
    decideSettlement,
    decideVerification,
    isVerificationAccepted,
} from "./facilitator-contract.js";
import {
    PaymentIntentSingleFlight,
    PaymentValidationError,
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
 * Every refusal this boundary can form, by the x402 v2 §9 word it puts on the wire.
 *
 * The words are the whole vocabulary a caller gets: the messages asserted above stay in
 * the operator's log, because a caller who learns *why* a delegation was refused learns
 * its caveat boundaries. Pinning the mapping is what keeps a re-worded refusal from
 * silently changing the answer — and what keeps a throw that is not one of these from
 * reaching a route, where it can only be honestly called `unexpected_verify_error`.
 */
describe("x402 §9 refusal vocabulary at the D4 boundary", () => {
    const OPTIONS = {delegationManager: MANAGER, facilitator: FACILITATOR};

    /** The §9 word a refusal carried, or `""` when the validator accepted the request. */
    function reason(
        input: unknown,
        options: Parameters<typeof validateDelegatedPayment>[1] = OPTIONS,
    ): string {
        try {
            validateDelegatedPayment(input, options);
            return "";
        } catch (error) {
            // Re-thrown rather than folded into a word: anything that is not one of these
            // reaches the route as `unexpected_*_error`, which is a bug of ours and the one
            // answer a request the boundary did examine must never get.
            if (!(error instanceof PaymentValidationError)) throw error;
            return error.reason;
        }
    }

    /** The control request with the seller's offer overridden — the echo is left alone. */
    function offer(overrides: Record<string, unknown>): unknown {
        const base = request();
        return {...base, paymentRequirements: {...base.paymentRequirements, ...overrides}};
    }

    /** The control request with the signed payload overridden. */
    function signed(overrides: Record<string, unknown>): unknown {
        const base = request();
        return {
            ...base,
            paymentPayload: {...base.paymentPayload, payload: {...base.paymentPayload.payload, ...overrides}},
        };
    }

    test("the control is accepted, so every word below belongs to its own mutation", () => {
        expect(reason(request())).toBe("");
    });

    test("a version either envelope disagrees on is invalid_x402_version", () => {
        expect(reason({...request(), x402Version: 1})).toBe("invalid_x402_version");
        const base = request();
        expect(reason({...base, paymentPayload: {...base.paymentPayload, x402Version: 1}})).toBe(
            "invalid_x402_version",
        );
    });

    test("another scheme or asset transfer method is unsupported_scheme, not a malformed field", () => {
        // A client picks from `accepts` whatever it supports, so a facilitator that speaks
        // only exact-EVM over ERC-7710 must say which of the two it does not speak — the
        // caller then offers another kind instead of hunting a field it spelled correctly.
        expect(reason(offer({scheme: "upto"}))).toBe("unsupported_scheme");
        expect(
            reason(offer({extra: {assetTransferMethod: "erc3009", facilitatorAddresses: [FACILITATOR]}})),
        ).toBe("unsupported_scheme");
    });

    test("a chain this facilitator does not settle on is invalid_network", () => {
        expect(reason(offer({network: "eip155:8453"}))).toBe("invalid_network");
    });

    test("the offer's own terms are invalid_payment_requirements", () => {
        expect(reason(offer({asset: OTHER_PAYEE}))).toBe("invalid_payment_requirements");
        expect(reason(offer({payTo: "0x1234"}))).toBe("invalid_payment_requirements");
        for (const maxTimeoutSeconds of [0, 301, 1.5, "60"]) {
            expect(reason(offer({maxTimeoutSeconds}))).toBe("invalid_payment_requirements");
        }
        for (const amount of ["1_000", "01", "-1", 1_000_000, "0"]) {
            expect(reason(offer({amount}))).toBe("invalid_payment_requirements");
        }
        expect(reason(request(), {...OPTIONS, maxAmount: 999_999n})).toBe("invalid_payment_requirements");
        // The redeemer list is the seller's. A facilitator absent from it was not asked to
        // settle this offer, which is a fact about the offer, not about the signed payload.
        expect(reason(request(), {...OPTIONS, facilitator: OTHER_FACILITATOR})).toBe(
            "invalid_payment_requirements",
        );
    });

    test("everything the request says about itself is invalid_payload", () => {
        for (const input of [undefined, null, 42, "{}", true]) {
            expect(reason(input)).toBe("invalid_payload");
        }
        const base = request();
        expect(reason({x402Version: 2, paymentRequirements: base.paymentRequirements})).toBe("invalid_payload");
        expect(reason({x402Version: 2, paymentPayload: base.paymentPayload})).toBe("invalid_payload");
        for (const payload of [
            {x402Version: 2, payload: base.paymentPayload.payload},
            {x402Version: 2, accepted: base.paymentPayload.accepted},
        ]) {
            expect(reason({...base, paymentPayload: payload})).toBe("invalid_payload");
        }
        // The echo, the manager allowlist and the payer binding are all claims the payload
        // makes about itself, against an offer and a signature that decide them.
        const tampered = request();
        tampered.paymentPayload.accepted = {...tampered.paymentPayload.accepted, amount: "2"};
        expect(reason(tampered)).toBe("invalid_payload");
        expect(reason(signed({delegationManager: OTHER_PAYEE}))).toBe("invalid_payload");
        expect(reason(signed({delegator: "0x1234"}))).toBe("invalid_payload");
        for (const permissionContext of ["0x", "not-hex", "0x1234", 7]) {
            expect(reason(signed({permissionContext}))).toBe("invalid_payload");
        }
        const forged = request();
        forged.paymentPayload.payload.delegator = OTHER_DELEGATOR;
        expect(reason(forged)).toBe("invalid_payload");
    });

    test("an echo that drops or rewrites the declared flow is not the seller's offer", () => {
        // 흐름 선언은 오퍼의 조건이다. 우리 판매자의 오퍼는 예외 없이 upfront를 싣기
        // 때문에, 그 칸을 빼거나 바꿔 에코한 payload는 판매자가 내건 것과 다른 것을
        // 승낙한 셈이고 기존 에코 불일치 경로에서 떨어진다 — 새 거절 사유는 없다.
        for (const paymentFlow of [undefined, "authorization", "escrow", 1, null]) {
            const base = request();
            const extra = {...base.paymentPayload.accepted.extra} as Record<string, unknown>;
            if (paymentFlow === undefined) delete extra.paymentFlow;
            else extra.paymentFlow = paymentFlow;
            const accepted = {...base.paymentPayload.accepted, extra};
            expect(
                reason({...base, paymentPayload: {...base.paymentPayload, accepted}}),
                JSON.stringify(paymentFlow),
            ).toBe("invalid_payload");
        }
    });

    test("both sides declaring nothing is still one offer", () => {
        // 선언이 전파되지 않은 제3자 오퍼: 퍼실리테이터는 오퍼와 에코가 서로 같은지만
        // 따지며, 흐름 선언을 요구하지는 않는다.
        const base = request();
        const extra = {...base.paymentRequirements.extra} as Record<string, unknown>;
        delete extra.paymentFlow;
        expect(
            reason({
                ...base,
                paymentRequirements: {...base.paymentRequirements, extra},
                paymentPayload: {
                    ...base.paymentPayload,
                    accepted: {...base.paymentPayload.accepted, extra},
                },
            }),
        ).toBe("");
    });

    test("an attacker-shaped echo is a payload defect, never an unexpected error", () => {
        // Every address in `accepted` passes a predicate before `getAddress`, because
        // `accepted` is attacker-controlled JSON and a `getAddress` throw out of the
        // comparison would leave this boundary answering `unexpected_verify_error` for a
        // request it did examine — with a rejected ledger row blaming our code for their
        // JSON. The comparison answers false for garbage instead.
        const base = request();
        // 판매자 오퍼의 extra를 그대로 재현한다 — 흐름 선언까지. 한 칸이라도 빠지면
        // 아래 변형들이 각자 노리는 가비지 주소가 아니라 에코 불일치에서 떨어져,
        // 무엇을 고정한 테스트인지 알 수 없게 된다.
        const erc7710 = {
            assetTransferMethod: "erc7710",
            paymentFlow: "upfront",
            facilitatorAddresses: [FACILITATOR],
        };
        for (const accepted of [
            {...base.paymentPayload.accepted, payTo: "0xzz"},
            {...base.paymentPayload.accepted, asset: 7},
            {...base.paymentPayload.accepted, extra: {...erc7710, facilitatorAddresses: ["nope"]}},
            {...base.paymentPayload.accepted, extra: {...erc7710, facilitatorAddresses: "nope"}},
            {...base.paymentPayload.accepted, extra: {...erc7710, delegationManager: "0xzz"}},
            {...base.paymentPayload.accepted, extra: null},
        ]) {
            expect(reason({...base, paymentPayload: {...base.paymentPayload, accepted}})).toBe("invalid_payload");
        }
    });

    test("the word rides on the error and the message stays behind it", () => {
        // `reason` is what the route copies onto the wire; `message` is what the operator's
        // log line is written from. Two fields, so neither can leak into the other.
        const error = new PaymentValidationError("invalid_payload", "permissionContext is malformed or too large");
        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe("PaymentValidationError");
        expect(error.reason).toBe("invalid_payload");
        expect(error.message).toBe("permissionContext is malformed or too large");
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
            replayed: false,
        });
    });

    test("`replayed` is the facilitator's own word, and only that word makes it true", () => {
        // The facilitator marks a body it answered out of its journal — an earlier
        // attempt's recorded outcome — rather than one it just broadcast. The seller may
        // not infer it: a missing field, or a truthy value that is not `true`, is a
        // facilitator that never said so, and a replay read as a fresh settlement is a
        // sale counted twice.
        expect(decideSettlement({reachable: true, body: {...settled, replayed: true}}, PAYER)).toEqual({
            kind: "settled",
            transaction: TX,
            replayed: true,
        });
        for (const replayed of [undefined, false, "true", 1]) {
            expect(decideSettlement({reachable: true, body: {...settled, replayed}}, PAYER)).toEqual({
                kind: "settled",
                transaction: TX,
                replayed: false,
            });
        }
    });

    test("verify: unreachable is 'unavailable', never a rejection of the delegation", () => {
        // Task #37: an outage on the /verify hop must not be reported as the caller's
        // delegation being refused. Nothing is charged at /verify, so it is safe to
        // separate the operational cause from a real verdict.
        expect(decideVerification({reachable: false}, PAYER)).toEqual({kind: "unavailable"});
        for (const body of [undefined, null, "nope", 3]) {
            expect(decideVerification({reachable: true, body}, PAYER).kind).toBe("unavailable");
        }
    });

    test("verify: a rate-limited answer is 'unavailable' — the delegation was never examined", () => {
        // The limiter refuses before the body is read. Reading that as `rejected` would
        // send the buyer to re-sign a delegation nothing refused, and a flood from one
        // address would turn every honest buyer behind it into a 403.
        expect(
            decideVerification({reachable: true, body: {isValid: false, invalidReason: RATE_LIMITED}}, PAYER),
        ).toEqual({kind: "unavailable"});
    });

    test("verify: a not-ready answer is 'unavailable' whatever status carried it", () => {
        // /verify sends this reason under a 503 the seller never parses. A proxy that
        // rewrites the status, or a facilitator that stops using one, must not turn
        // "nothing was examined" into the refused delegation `decideSettlement` already
        // refuses to read it as.
        expect(
            decideVerification(
                {reachable: true, body: {isValid: false, invalidReason: FACILITATOR_NOT_READY}},
                PAYER,
            ),
        ).toEqual({kind: "unavailable"});
    });

    test("verify: a reachable body that fails the payer cross-check is 'rejected'", () => {
        expect(
            decideVerification({reachable: true, body: {isValid: false}}, PAYER).kind,
        ).toBe("rejected");
        expect(
            decideVerification({reachable: true, body: {isValid: true, payer: IMPOSTOR}}, PAYER).kind,
        ).toBe("rejected");
    });

    test("verify: a valid body naming the derived payer is 'accepted'", () => {
        expect(
            decideVerification({reachable: true, body: {isValid: true, payer: PAYER}}, PAYER),
        ).toEqual({kind: "accepted", payer: PAYER});
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

    test("the pending sentinel is unknown and keeps the hash", () => {
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
                        errorReason: SETTLEMENT_PENDING,
                    },
                },
                PAYER,
            ),
        ).toEqual({kind: "unknown", transaction: TX});
    });

    test("a pending body without a hash breaks the spec, and is still unknown, never failed", () => {
        // x402 v2 binds `settlement_pending` to a non-empty transaction, and every
        // producer in this repository computes the hash before the broadcast. A body
        // that drops it anyway is read for what it still claims — money may have moved
        // — as a 504 with nothing to look up, never a 422 that asserts non-payment.
        expect(
            decideSettlement(
                {
                    reachable: true,
                    body: {
                        success: false,
                        network: GIWA_SEPOLIA_CAIP2,
                        transaction: "",
                        errorReason: SETTLEMENT_PENDING,
                    },
                },
                PAYER,
            ),
        ).toEqual({kind: "unknown", transaction: undefined});
    });

    test("the sentinel is one shared constant, not a literal per process, and is the §9 word", () => {
        // If this ever drifts, the case above silently becomes `failed` — a 422 that
        // asserts a balance nobody checked. Pinning the value is what makes the
        // facilitator and the seller provably agree without running either.
        expect(SETTLEMENT_PENDING).toBe("settlement_pending");
    });

    test("a rate-limited settle is unavailable: nothing was charged and nothing is in doubt", () => {
        // The limiter answers before the body is read, so neither `failed` (a verdict on
        // the transfer) nor `unknown` (money may have moved) is true. The buyer may hand
        // the same payment back later. Pinned like the sentinel above: drifting to
        // `failed` would tell a throttled buyer their payment was refused.
        expect(RATE_LIMITED).toBe("rate_limited");
        expect(
            decideSettlement(
                {
                    reachable: true,
                    body: {success: false, network: GIWA_SEPOLIA_CAIP2, errorReason: RATE_LIMITED},
                },
                PAYER,
            ),
        ).toEqual({kind: "unavailable"});
    });

    test("a settle the facilitator was not ready for is unavailable, never failed", () => {
        // The readiness probe failed for this caller before the body was read. Until
        // this reason existed it reached here as `delegation_rejected` — a verdict on a
        // delegation nobody examined, from a facilitator whose RPC had blinked.
        expect(FACILITATOR_NOT_READY).toBe("facilitator_not_ready");
        expect(
            decideSettlement(
                {
                    reachable: true,
                    body: {success: false, network: GIWA_SEPOLIA_CAIP2, errorReason: FACILITATOR_NOT_READY},
                },
                PAYER,
            ),
        ).toEqual({kind: "unavailable"});
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
                .toEqual({kind: "settled", transaction: undefined, replayed: false});
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
