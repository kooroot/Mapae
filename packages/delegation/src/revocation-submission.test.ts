import {describe, expect, test} from "bun:test";
import {concatHex, getAddress, pad, toHex, type Address, type Hex} from "viem";
import type {SmartAccountsEnvironment} from "@metamask/smart-accounts-kit";
import {encodeDelegations, hashDelegation} from "@metamask/smart-accounts-kit/utils";
import {giwaSepolia} from "@mapae/shared";
import {ENTRY_POINT_V07} from "./config.js";
import {buildD3Policies, preparePeriodDelegation} from "./policy.js";
import {
    buildRevocationUserOperation,
    DEFAULT_REVOCATION_GAS,
    SPONSORED_REVOCATION_GAS,
    finalizeRevocationUserOperation,
} from "./revocation.js";
import {
    buildRevocationSubmissionBody,
    buildSponsoredRevocationApproval,
    judgeSubmissionReadiness,
    validateRevocationSubmission,
    type RevocationSubmissionPolicy,
    judgeCorsRequest,
    parseCorsAllowlist,
} from "./revocation-submission.js";
import {buildSponsoredBootstrapApproval} from "./account-bootstrap.js";

const address = (suffix: number): Address =>
    getAddress(`0x${suffix.toString(16).padStart(40, "0")}`);

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

const PAYER = address(10);
const AGENT = address(11);
const OTHER_PAYER = address(12);

const makeDelegation = (delegator: Address) =>
    preparePeriodDelegation({
        environment,
        delegator,
        delegate: AGENT,
        policy: buildD3Policies(address(20))["open-agent"],
        startDate: 2_000_000_000,
    });

const delegation = makeDelegation(PAYER);
const NONCE = 7n;
const SIGNATURE = `0x${"ab".repeat(65)}` as Hex;

const built = buildRevocationUserOperation({
    delegation,
    entryPoint: ENTRY_POINT_V07,
    chainId: giwaSepolia.id,
    nonce: NONCE,
    gas: DEFAULT_REVOCATION_GAS,
});

const policy: RevocationSubmissionPolicy = {
    payer: PAYER,
    maxCallGasLimit: DEFAULT_REVOCATION_GAS.callGasLimit,
    maxVerificationGasLimit: DEFAULT_REVOCATION_GAS.verificationGasLimit,
    maxPreVerificationGas: DEFAULT_REVOCATION_GAS.preVerificationGas,
    maxFeePerGas: DEFAULT_REVOCATION_GAS.maxFeePerGas,
};

/** The wire shape: bigints as decimal strings, because JSON has no bigint. */
function wire(overrides: Record<string, unknown> = {}, context?: Hex) {
    const {packed} = finalizeRevocationUserOperation(built, SIGNATURE);
    return {
        permissionContext: context ?? encodeDelegations([delegation]),
        userOperation: {
            sender: packed.sender,
            nonce: packed.nonce.toString(),
            initCode: packed.initCode,
            callData: packed.callData,
            accountGasLimits: packed.accountGasLimits,
            preVerificationGas: packed.preVerificationGas.toString(),
            gasFees: packed.gasFees,
            paymasterAndData: packed.paymasterAndData,
            signature: packed.signature,
            ...overrides,
        },
    };
}

const packGas = (verification: bigint, call: bigint): Hex =>
    concatHex([pad(toHex(verification), {size: 16}), pad(toHex(call), {size: 16})]);
const packFees = (priority: bigint, max: bigint): Hex =>
    concatHex([pad(toHex(priority), {size: 16}), pad(toHex(max), {size: 16})]);

describe("revocation submission validation", () => {
    test("a well-formed submission survives and reproduces the builder's bytes exactly", () => {
        const result = validateRevocationSubmission(wire(), policy);
        // The point of the whole function: what the service submits is byte-identical to
        // what this repo would have built. Not "compatible" — identical.
        expect(result.packed).toEqual(finalizeRevocationUserOperation(built, SIGNATURE).packed);
        expect(result.sender).toBe(PAYER);
        expect(result.requiredPrefund).toBe(built.requiredPrefund);
        expect(result.gas.callGasLimit).toBe(DEFAULT_REVOCATION_GAS.callGasLimit);
        expect(result.gas.verificationGasLimit).toBe(DEFAULT_REVOCATION_GAS.verificationGasLimit);
        expect(result.gas.maxFeePerGas).toBe(DEFAULT_REVOCATION_GAS.maxFeePerGas);
        expect(result.gas.maxPriorityFeePerGas).toBe(DEFAULT_REVOCATION_GAS.maxPriorityFeePerGas);
    });

    test("the unpacked gas values come back out of the packed words, not from a default", () => {
        // Equal-valued defaults would let a reader that ignored the bytes entirely pass.
        const result = validateRevocationSubmission(
            wire({accountGasLimits: packGas(123_000n, 45_000n)}),
            {...policy, maxVerificationGasLimit: 200_000n, maxCallGasLimit: 200_000n},
        );
        expect(result.gas.verificationGasLimit).toBe(123_000n);
        expect(result.gas.callGasLimit).toBe(45_000n);
        expect(result.requiredPrefund).toBe(
            (123_000n + 45_000n + DEFAULT_REVOCATION_GAS.preVerificationGas) *
                DEFAULT_REVOCATION_GAS.maxFeePerGas,
        );
    });

    test("a sender that is not the served account is refused", () => {
        expect(() =>
            validateRevocationSubmission(wire({sender: OTHER_PAYER}), policy),
        ).toThrow(/not the account this submitter serves/);
    });

    test("a permission the sender did not grant is refused", () => {
        // sender passes the allowlist, but the root's delegator is somebody else — the
        // account cannot disable a grant it never made, and DelegationManager would
        // reject it on chain. Refusing here costs no gas.
        const foreign = makeDelegation(OTHER_PAYER);
        const body = {
            permissionContext: encodeDelegations([foreign]),
            userOperation: {...wire().userOperation},
        };
        expect(() => validateRevocationSubmission(body, policy)).toThrow(
            /not granted by the sender account/,
        );
    });

    test("calldata for a different permission is refused", () => {
        // A second grant by the same payer to a different session key. Same account, same
        // caveat shape — `preparePeriodDelegation` is deterministic, so the delegate is
        // what has to differ for this fixture to mean anything.
        const other = buildRevocationUserOperation({
            delegation: preparePeriodDelegation({
                environment,
                delegator: PAYER,
                delegate: address(13),
                policy: buildD3Policies(address(20))["open-agent"],
                startDate: 2_000_000_000,
            }),
            entryPoint: ENTRY_POINT_V07,
            chainId: giwaSepolia.id,
            nonce: NONCE,
            gas: DEFAULT_REVOCATION_GAS,
        });
        // Same shape, same sender, same everything — only the delegation inside the
        // calldata differs. Without the re-encode equality this walks straight through.
        if (other.packed.callData === built.packed.callData) {
            throw new Error("fixture is vacuous: the two permissions encode identically");
        }
        expect(() =>
            validateRevocationSubmission(wire({callData: other.packed.callData}), policy),
        ).toThrow(/not disableDelegation for this permission/);
    });

    test("calldata with trailing bytes is refused — this is why it is not a decode", () => {
        const padded = concatHex([built.packed.callData, "0xdeadbeef"]);
        expect(() => validateRevocationSubmission(wire({callData: padded}), policy)).toThrow(
            /not disableDelegation for this permission/,
        );
    });

    test("a non-empty initCode is refused", () => {
        expect(() =>
            validateRevocationSubmission(wire({initCode: "0xdeadbeef"}), policy),
        ).toThrow(/initCode must be empty/);
    });

    test("a paymaster is refused", () => {
        expect(() =>
            validateRevocationSubmission(
                wire({paymasterAndData: pad(address(99), {size: 52})}),
                policy,
            ),
        ).toThrow(/paymasterAndData must be empty/);
    });

    test("each gas ceiling is enforced separately", () => {
        expect(() =>
            validateRevocationSubmission(
                wire({accountGasLimits: packGas(DEFAULT_REVOCATION_GAS.verificationGasLimit, 300_001n)}),
                policy,
            ),
        ).toThrow(/callGasLimit 300001 exceeds/);
        expect(() =>
            validateRevocationSubmission(
                wire({accountGasLimits: packGas(300_001n, DEFAULT_REVOCATION_GAS.callGasLimit)}),
                policy,
            ),
        ).toThrow(/verificationGasLimit 300001 exceeds/);
        expect(() =>
            validateRevocationSubmission(wire({preVerificationGas: "100001"}), policy),
        ).toThrow(/preVerificationGas 100001 exceeds/);
        expect(() =>
            validateRevocationSubmission(
                wire({gasFees: packFees(1_000_000_000n, 1_000_000_001n)}),
                policy,
            ),
        ).toThrow(/maxFeePerGas 1000000001 exceeds/);
    });

    test("a priority fee above the max fee is refused", () => {
        expect(() =>
            validateRevocationSubmission(
                wire({gasFees: packFees(1_000_000_000n, 500_000_000n)}),
                policy,
            ),
        ).toThrow(/maxPriorityFeePerGas must not exceed/);
    });

    test("a zero-fee operation is refused, because it would make the prefund gate vacuous", () => {
        expect(() =>
            validateRevocationSubmission(wire({gasFees: packFees(0n, 0n)}), policy),
        ).toThrow(/maxFeePerGas must be non-zero/);
    });

    test("the unsigned sentinel is refused without burning a simulation", () => {
        expect(() => validateRevocationSubmission(wire({signature: "0x"}), policy)).toThrow(
            /signature is empty/,
        );
    });

    test("malformed wire values are refused before anything is decoded", () => {
        expect(() => validateRevocationSubmission(null, policy)).toThrow(/must be an object/);
        expect(() => validateRevocationSubmission({}, policy)).toThrow(/permissionContext/);
        expect(() =>
            validateRevocationSubmission(wire({}, "0xabc" as Hex), policy),
        ).toThrow(/permissionContext must be 0x-prefixed hex of whole bytes/);
        expect(() =>
            validateRevocationSubmission(wire({}, "0xdeadbeef"), policy),
        ).toThrow(/not a delegation chain/);
        expect(() => validateRevocationSubmission(wire({nonce: 7}), policy)).toThrow(
            /nonce must be an unsigned integer string/,
        );
        expect(() => validateRevocationSubmission(wire({nonce: "-1"}), policy)).toThrow(
            /nonce must be an unsigned integer string/,
        );
        expect(() =>
            validateRevocationSubmission(wire({accountGasLimits: "0x1234"}), policy),
        ).toThrow(/accountGasLimits must be exactly 32 bytes/);
        expect(() => validateRevocationSubmission(wire({sender: "not-an-address"}), policy)).toThrow(
            /sender must be an address/,
        );
        expect(() =>
            validateRevocationSubmission({permissionContext: encodeDelegations([delegation])}, policy),
        ).toThrow(/userOperation must be an object/);
    });

    test("an oversized hex field is refused before it is parsed", () => {
        const huge = (`0x${"ee".repeat(11_000)}`) as Hex;
        expect(() => validateRevocationSubmission(wire({callData: huge}), policy)).toThrow(
            /callData is too large/,
        );
    });
});

describe("open submitter policy (no pinned payer)", () => {
    const openPolicy: RevocationSubmissionPolicy = {
        maxCallGasLimit: DEFAULT_REVOCATION_GAS.callGasLimit,
        maxVerificationGasLimit: DEFAULT_REVOCATION_GAS.verificationGasLimit,
        maxPreVerificationGas: DEFAULT_REVOCATION_GAS.preVerificationGas,
        maxFeePerGas: DEFAULT_REVOCATION_GAS.maxFeePerGas,
    };

    test("any account may revoke its own grant when no payer is pinned", () => {
        // The sponsored public endpoint serves every onboarded account, so the pin has to
        // be optional — but only the pin. Every other check still binds.
        const foreign = makeDelegation(OTHER_PAYER);
        const foreignBuilt = buildRevocationUserOperation({
            delegation: foreign,
            entryPoint: ENTRY_POINT_V07,
            chainId: giwaSepolia.id,
            nonce: NONCE,
            gas: DEFAULT_REVOCATION_GAS,
        });
        const {packed} = finalizeRevocationUserOperation(foreignBuilt, SIGNATURE);
        const body = buildRevocationSubmissionBody({
            permissionContext: encodeDelegations([foreign]),
            packed,
        });
        const result = validateRevocationSubmission(JSON.parse(JSON.stringify(body)), openPolicy);
        expect(result.sender).toBe(OTHER_PAYER);
        expect(result.packed).toEqual(packed);
    });

    test("a sender that did not grant the permission is refused even without a pin", () => {
        // This is the check that carries the whole security argument once the pin is gone:
        // the root's delegator must be the sender, so a caller can only ever disable a
        // grant made by the account it names — and only that account's owner can sign
        // the operation the EntryPoint will accept.
        expect(() =>
            validateRevocationSubmission(wire({sender: OTHER_PAYER}), openPolicy),
        ).toThrow(/not granted by the sender account/);
    });

    test("a pinned payer still refuses every other sender", () => {
        // The loopback single-payer deployment keeps its behaviour byte for byte.
        expect(() =>
            validateRevocationSubmission(wire({sender: OTHER_PAYER}), policy),
        ).toThrow(/not the account this submitter serves/);
    });
});

describe("fee floor (sponsored mode)", () => {
    /**
     * The ceiling alone does not protect the relayer, and the base fee is not a floor.
     *
     * The EntryPoint reimburses the relayer at `min(maxFeePerGas, tip + baseFee)` per gas,
     * while the relayer's own transaction is priced at `baseFee + suggested tip`. On GIWA
     * the measured base fee is ~267 wei and the suggested tip is 1,000,000 wei — so an
     * operation signed just above the base fee is *accepted* by `fee_below_basefee` and
     * reimburses the relayer at ~1/3700 of what it paid. The deposit for such an
     * operation is proportionally tiny, so the daily budget barely moves: the cheaper the
     * attack, the less it is bounded by the one bound that exists.
     */
    const floored: RevocationSubmissionPolicy = {
        maxCallGasLimit: SPONSORED_REVOCATION_GAS.callGasLimit,
        maxVerificationGasLimit: SPONSORED_REVOCATION_GAS.verificationGasLimit,
        maxPreVerificationGas: SPONSORED_REVOCATION_GAS.preVerificationGas,
        maxFeePerGas: SPONSORED_REVOCATION_GAS.maxFeePerGas,
        minFeePerGas: SPONSORED_REVOCATION_GAS.maxFeePerGas,
    };

    const sponsoredBuilt = buildRevocationUserOperation({
        delegation,
        entryPoint: ENTRY_POINT_V07,
        chainId: giwaSepolia.id,
        nonce: NONCE,
        gas: SPONSORED_REVOCATION_GAS,
    });

    function sponsoredWire(overrides: Record<string, unknown> = {}) {
        const {packed} = finalizeRevocationUserOperation(sponsoredBuilt, SIGNATURE);
        return {
            permissionContext: encodeDelegations([delegation]),
            userOperation: {
                sender: packed.sender,
                nonce: packed.nonce.toString(),
                initCode: packed.initCode,
                callData: packed.callData,
                accountGasLimits: packed.accountGasLimits,
                preVerificationGas: packed.preVerificationGas.toString(),
                gasFees: packed.gasFees,
                paymasterAndData: packed.paymasterAndData,
                signature: packed.signature,
                ...overrides,
            },
        };
    }

    test("the profile's own fee passes", () => {
        const result = validateRevocationSubmission(sponsoredWire(), floored);
        expect(result.gas.maxFeePerGas).toBe(SPONSORED_REVOCATION_GAS.maxFeePerGas);
    });

    test("a fee just above the base fee is refused, not merely under-reimbursed", () => {
        // 300 wei: above GIWA's measured 267-wei base fee, so `fee_below_basefee` would
        // have waved it through, and 1/33,000th of the profile's fee.
        expect(() =>
            validateRevocationSubmission(
                sponsoredWire({gasFees: packFees(300n, 300n)}),
                floored,
            ),
        ).toThrow(/maxFeePerGas 300 is below the required 10000000/);
    });

    test("one wei under the floor is still under it", () => {
        const under = SPONSORED_REVOCATION_GAS.maxFeePerGas - 1n;
        expect(() =>
            validateRevocationSubmission(sponsoredWire({gasFees: packFees(under, under)}), floored),
        ).toThrow(/is below the required/);
    });

    test("a policy with no floor accepts what the ceiling allows — the pinned mode is unchanged", () => {
        expect(() =>
            validateRevocationSubmission(wire({gasFees: packFees(300n, 300n)}), policy),
        ).not.toThrow();
    });
});

describe("sponsored revocation approval phrase", () => {
    test("is pinned to the chain and the composition", () => {
        expect(buildSponsoredRevocationApproval("abc123")).toBe(
            `sponsored-revocation-chain-${giwaSepolia.id}-abc123`,
        );
    });

    test("differs from the bootstrap approval for the same composition", () => {
        // One phrase must never authorise the other service: they spend differently and
        // an operator approves each shape separately.
        expect(buildSponsoredRevocationApproval("abc123")).not.toBe(
            buildSponsoredBootstrapApproval("abc123"),
        );
    });
});

describe("wire body round trip", () => {
    test("what the builder encodes is what the validator decodes, byte for byte", () => {
        // The encoder and decoder of a wire format drifting apart is the failure this repo
        // already paid for once with the EIP-712 domain. A field renamed on one side has to
        // fail here, not as an AA24 on chain.
        const {packed} = finalizeRevocationUserOperation(built, SIGNATURE);
        const body = buildRevocationSubmissionBody({
            permissionContext: encodeDelegations([delegation]),
            packed,
        });
        // Through real JSON, because that is what crosses the wire — a leaked bigint would
        // throw here and nowhere else.
        const validated = validateRevocationSubmission(JSON.parse(JSON.stringify(body)), policy);
        expect(validated.packed).toEqual(packed);
        // Compared by hash, not by struct. An ABI round trip legitimately re-normalises the
        // representation — `decodeDelegations` returns lowercase addresses and a minimal
        // `0x0` salt where the builder held `0x00` — while the delegation is the same one.
        // The hash is the identity the DelegationManager itself uses, so it is the identity
        // that has to survive; asserting on the struct would fail on cosmetics.
        expect(hashDelegation(validated.delegation)).toBe(hashDelegation(delegation));
    });

    test("integers are serialised as strings, not numbers", () => {
        const {packed} = finalizeRevocationUserOperation(built, SIGNATURE);
        const body = buildRevocationSubmissionBody({
            permissionContext: encodeDelegations([delegation]),
            packed,
        });
        expect(typeof body.userOperation.nonce).toBe("string");
        expect(typeof body.userOperation.preVerificationGas).toBe("string");
        // JSON.stringify on a bigint throws; this is the assertion that the body is
        // actually serialisable rather than merely shaped right.
        expect(() => JSON.stringify(body)).not.toThrow();
    });
});

describe("submission readiness", () => {
    const armed = {
        deposit: 700_000_000_000_000n,
        requiredPrefund: 700_000_000_000_000n,
        baseFeePerGas: 8n,
        maxFeePerGas: 1_000_000_000n,
        relayerBalance: 10n ** 18n,
    };

    test("an exactly-funded deposit is armed — the boundary, not headroom", () => {
        expect(judgeSubmissionReadiness(armed)).toEqual({ok: true});
    });

    test("an unreadable base fee refuses instead of passing as zero", () => {
        // The caller used to substitute `0n` for a block with no base fee. That makes the
        // fee check below `maxFeePerGas < 0n` — false for every input — so the guard that
        // stops the relayer fronting unrecoverable gas silently stopped existing. viem
        // types a block's base fee as `bigint | null`, so this is a reachable state and not
        // a hypothetical.
        expect(judgeSubmissionReadiness({...armed, baseFeePerGas: undefined})).toEqual({
            ok: false,
            refusal: {reason: "base_fee_unreadable", maxFeePerGas: armed.maxFeePerGas},
        });
    });

    test("an unreadable base fee is not reported as a fee that is too low", () => {
        // Distinct reasons on purpose: `fee_below_basefee` tells the owner to re-sign with
        // a higher fee, which is the wrong instruction when the truth is that we could not
        // read the chain. One is about their signature, the other about our read.
        const unreadable = judgeSubmissionReadiness({...armed, baseFeePerGas: undefined});
        expect(unreadable).toMatchObject({refusal: {reason: "base_fee_unreadable"}});
        const tooLow = judgeSubmissionReadiness({...armed, baseFeePerGas: armed.maxFeePerGas + 1n});
        expect(tooLow).toMatchObject({refusal: {reason: "fee_below_basefee"}});
    });

    test("one wei short is not armed, and the shortfall is reported", () => {
        const result = judgeSubmissionReadiness({...armed, deposit: armed.deposit - 1n});
        expect(result).toEqual({
            ok: false,
            refusal: {
                reason: "prefund_short",
                deposit: armed.deposit - 1n,
                requiredPrefund: armed.requiredPrefund,
                shortfall: 1n,
            },
        });
    });

    test("a fee below the base fee is refused — the relayer cannot recover it", () => {
        const result = judgeSubmissionReadiness({
            ...armed,
            baseFeePerGas: 2_000_000_000n,
        });
        expect(result).toEqual({
            ok: false,
            refusal: {
                reason: "fee_below_basefee",
                maxFeePerGas: 1_000_000_000n,
                baseFeePerGas: 2_000_000_000n,
            },
        });
    });

    test("a fee exactly at the base fee is accepted", () => {
        expect(
            judgeSubmissionReadiness({...armed, baseFeePerGas: armed.maxFeePerGas}),
        ).toEqual({ok: true});
    });

    test("a relayer that cannot front the transaction is refused", () => {
        const result = judgeSubmissionReadiness({...armed, relayerBalance: 1n});
        expect(result).toEqual({
            ok: false,
            refusal: {reason: "relayer_unfunded", relayerBalance: 1n, needed: armed.requiredPrefund},
        });
    });

    test("the deposit is checked before the relayer, because it is the usual failure", () => {
        // Both are broken. The payer's unarmed kill switch is what they can act on.
        const result = judgeSubmissionReadiness({...armed, deposit: 0n, relayerBalance: 0n});
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.refusal.reason).toBe("prefund_short");
    });
});

/**
 * Whether the revoke button can reach the submitter from a browser at all.
 *
 * The console is served from :5173 and the submitter listens on :8082, so every revoke is
 * cross-origin, and `content-type: application/json` is not CORS-safelisted — the browser
 * sends a preflight first and drops the POST if it fails. This went unnoticed because the
 * e2e runner uses Bun's server-side fetch, which does not enforce CORS at all: the service
 * was green from a script and dead from a page.
 */
describe("judgeCorsRequest", () => {
    const policy = {allowedOrigins: ["http://127.0.0.1:5173", "http://localhost:5173"]};

    test("allows a configured console origin and echoes it back exactly", () => {
        const decision = judgeCorsRequest("http://127.0.0.1:5173", policy);
        expect(decision.allowed).toBe(true);
        if (!decision.allowed) return;
        expect(decision.headers["Access-Control-Allow-Origin"]).toBe("http://127.0.0.1:5173");
    });

    test("marks the response as varying by origin", () => {
        // Without this a cache in front of the submitter can hand one origin's allow
        // header to another, which is the allowlist leaking through a shared cache.
        const decision = judgeCorsRequest("http://localhost:5173", policy);
        expect(decision.allowed && decision.headers.Vary).toBe("Origin");
    });

    test("a preflight additionally answers method, headers and max-age", () => {
        const decision = judgeCorsRequest("http://127.0.0.1:5173", policy, true);
        expect(decision.allowed).toBe(true);
        if (!decision.allowed) return;
        expect(decision.headers["Access-Control-Allow-Methods"]).toContain("POST");
        // The console sends content-type: application/json. Omitting it here fails the
        // preflight just as completely as having no CORS at all.
        expect(decision.headers["Access-Control-Allow-Headers"]).toContain("content-type");
        expect(Number(decision.headers["Access-Control-Max-Age"])).toBeGreaterThan(0);
    });

    test("refuses an origin that is not on the list", () => {
        for (const origin of [
            "http://evil.example",
            "https://127.0.0.1:5173", // different scheme is a different origin
            "http://127.0.0.1:5174", // different port is a different origin
            "http://127.0.0.1:5173.evil.example", // suffix, not a match
        ]) {
            expect(judgeCorsRequest(origin, policy).allowed).toBe(false);
        }
    });

    test("never answers with a wildcard", () => {
        // The submitter has no application authentication and fronts a funded relayer
        // key, so `*` would let any page the operator has open spend its gas.
        const decision = judgeCorsRequest("http://127.0.0.1:5173", policy);
        expect(decision.allowed && decision.headers["Access-Control-Allow-Origin"]).not.toBe("*");
    });

    test("never allows credentials", () => {
        // Authority travels in the signature inside the body, not in a cookie. Setting
        // this would make the wildcard ban the only thing standing between an arbitrary
        // page and an authenticated request.
        const decision = judgeCorsRequest("http://127.0.0.1:5173", policy, true);
        expect(decision.allowed && decision.headers["Access-Control-Allow-Credentials"]).toBeUndefined();
    });

    test("a request with no Origin passes through unchanged", () => {
        // curl and the e2e runner send no Origin. They were working before CORS existed
        // and must keep working — the browser is the only thing this policy governs.
        const decision = judgeCorsRequest(undefined, policy);
        expect(decision.allowed).toBe(true);
        if (!decision.allowed) return;
        expect(Object.keys(decision.headers)).toHaveLength(0);
    });
});

describe("parseCorsAllowlist", () => {
    const loopback = (host: string) => ["127.0.0.1", "localhost", "[::1]"].includes(host);
    const fallback = ["http://127.0.0.1:5173"];

    test("falls back when unset or blank", () => {
        expect(parseCorsAllowlist(undefined, loopback, fallback)).toEqual(fallback);
        expect(parseCorsAllowlist("   ", loopback, fallback)).toEqual(fallback);
        expect(parseCorsAllowlist(",, ,", loopback, fallback)).toEqual(fallback);
    });

    test("splits, trims, and reduces each entry to a bare origin", () => {
        // A trailing slash or path would never match `Origin`, which is scheme+host+port
        // only — so normalising here is what stops one stray character from silently
        // disabling the whole allowlist.
        expect(
            parseCorsAllowlist(
                " http://127.0.0.1:5173/ , http://localhost:4173/console ",
                loopback,
                fallback,
            ),
        ).toEqual(["http://127.0.0.1:5173", "http://localhost:4173"]);
    });

    test("refuses a wildcard outright", () => {
        expect(() => parseCorsAllowlist("*", loopback, fallback)).toThrow("must not be '*'");
    });

    test("refuses a non-loopback origin", () => {
        expect(() => parseCorsAllowlist("https://console.example.com", loopback, fallback)).toThrow(
            "must be loopback",
        );
    });

    test("refuses a non-URL and a non-HTTP scheme", () => {
        expect(() => parseCorsAllowlist("not a url", loopback, fallback)).toThrow("not a URL");
        expect(() => parseCorsAllowlist("file:///etc/passwd", loopback, fallback)).toThrow(
            "must be HTTP(S)",
        );
    });

    test("one bad entry rejects the whole list rather than silently dropping it", () => {
        // Skipping the bad one would leave a submitter running with an allowlist the
        // operator did not write.
        expect(() =>
            parseCorsAllowlist("http://127.0.0.1:5173,https://evil.example", loopback, fallback),
        ).toThrow("must be loopback");
    });
});
