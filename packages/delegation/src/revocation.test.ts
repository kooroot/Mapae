import {describe, expect, test} from "bun:test";
import {
    concatHex,
    encodeAbiParameters,
    getAddress,
    hashTypedData,
    keccak256,
    pad,
    toHex,
    type Address,
} from "viem";
import type {SmartAccountsEnvironment} from "@metamask/smart-accounts-kit";
import {DeleGatorCore} from "@metamask/smart-accounts-kit/contracts";
import {giwaSepolia} from "@mapae/shared";
import {ENTRY_POINT_V07} from "./config.js";
import {buildD3Policies, preparePeriodDelegation} from "./policy.js";
import {
    buildRevocationCall,
    buildRevocationUserOperation,
    DEFAULT_REVOCATION_GAS,
    finalizeRevocationUserOperation,
    KIT_SIGNABLE_USER_OP_TYPED_DATA,
    REVOCATION_USER_OP_TYPES,
    revocationPrefund,
} from "./revocation.js";

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

const delegation = preparePeriodDelegation({
    environment,
    delegator: PAYER,
    delegate: AGENT,
    policy: buildD3Policies(address(20))["open-agent"],
    startDate: 2_000_000_000,
});

const NONCE = 7n;

const build = (overrides: Partial<typeof DEFAULT_REVOCATION_GAS> = {}) =>
    buildRevocationUserOperation({
        delegation,
        entryPoint: ENTRY_POINT_V07,
        chainId: giwaSepolia.id,
        nonce: NONCE,
        gas: {...DEFAULT_REVOCATION_GAS, ...overrides},
    });

describe("revocation UserOperation", () => {
    test("the domain is the payer account proxy, not the manager or the implementation", () => {
        const built = build();
        expect(built.typedData.domain.name).toBe("HybridDeleGator");
        expect(built.typedData.domain.version).toBe("1");
        expect(built.typedData.domain.chainId).toBe(giwaSepolia.id);
        expect(built.typedData.domain.verifyingContract).toBe(PAYER);
        expect(built.typedData.domain.verifyingContract).not.toBe(
            environment.DelegationManager,
        );
        expect(built.typedData.domain.verifyingContract).not.toBe(
            environment.implementations.HybridDeleGatorImpl,
        );
        expect(built.sender).toBe(PAYER);
    });

    test("entryPoint is carried as the ninth signed field, not just as a submit target", () => {
        const built = build();
        expect(built.typedData.message["entryPoint"]).toBe(getAddress(ENTRY_POINT_V07));
        expect(built.entryPoint).toBe(getAddress(ENTRY_POINT_V07));
        expect(REVOCATION_USER_OP_TYPES.PackedUserOperation[8]).toEqual({
            name: "entryPoint",
            type: "address",
        });
    });

    test("the local type copy still matches the kit's export", () => {
        expect(REVOCATION_USER_OP_TYPES).toEqual(
            KIT_SIGNABLE_USER_OP_TYPED_DATA as typeof REVOCATION_USER_OP_TYPES,
        );
    });

    test("callData is the raw disableDelegation call, never wrapped in execute()", () => {
        const built = build();
        expect(built.packed.callData).toBe(buildRevocationCall(delegation).data);
        expect(built.packed.callData.slice(0, 10)).toBe(
            DeleGatorCore.encode.disableDelegation({delegation}).slice(0, 10),
        );
        // `execute` would re-enter through the self branch — the branch already covered.
        expect(built.packed.callData.slice(0, 10)).not.toBe("0xb61d27f6");
    });

    test("accountGasLimits packs verification high, call low", () => {
        // The two limits must differ, or a swapped packing order produces identical
        // bytes and this assertion proves nothing.
        const built = build({verificationGasLimit: 111_000n, callGasLimit: 222_000n});
        const expected = concatHex([
            pad(toHex(111_000n), {size: 16}),
            pad(toHex(222_000n), {size: 16}),
        ]);
        expect(built.packed.accountGasLimits).toBe(expected);
        expect(built.packed.accountGasLimits).not.toBe(
            concatHex([pad(toHex(222_000n), {size: 16}), pad(toHex(111_000n), {size: 16})]),
        );
    });

    test("gasFees packs priority high, max low", () => {
        const built = build({maxPriorityFeePerGas: 500_000_000n});
        const expected = concatHex([
            pad(toHex(500_000_000n), {size: 16}),
            pad(toHex(DEFAULT_REVOCATION_GAS.maxFeePerGas), {size: 16}),
        ]);
        expect(built.packed.gasFees).toBe(expected);
    });

    test("no factory and no paymaster — this account is deployed and pays for itself", () => {
        const built = build();
        expect(built.packed.initCode).toBe("0x");
        expect(built.packed.paymasterAndData).toBe("0x");
        expect(built.packed.signature).toBe("0x");
    });

    test("requiredPrefund is the sum of the three gas limits times maxFeePerGas", () => {
        const built = build();
        expect(built.requiredPrefund).toBe(
            (DEFAULT_REVOCATION_GAS.verificationGasLimit +
                DEFAULT_REVOCATION_GAS.callGasLimit +
                DEFAULT_REVOCATION_GAS.preVerificationGas) *
                DEFAULT_REVOCATION_GAS.maxFeePerGas,
        );
        expect(built.requiredPrefund).toBeGreaterThan(0n);
        // The console sizes the deposit from the same helper without building an
        // operation. If these ever diverge, the readiness display lies.
        expect(revocationPrefund(DEFAULT_REVOCATION_GAS)).toBe(built.requiredPrefund);
    });

    test("a zero-fee operation is refused, because it would make the prefund gate vacuous", () => {
        expect(() => build({maxFeePerGas: 0n, maxPriorityFeePerGas: 0n})).toThrow(
            /requiredPrefund 0/,
        );
    });

    test("a priority fee above the max fee is refused", () => {
        expect(() => build({maxPriorityFeePerGas: 2_000_000_000n})).toThrow(
            /maxPriorityFeePerGas/,
        );
    });

    test("the digest matches an independently hand-encoded EIP-712 hash", () => {
        const built = build();
        const typeHash = keccak256(
            toHex(
                "PackedUserOperation(address sender,uint256 nonce,bytes initCode,bytes callData," +
                    "bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees," +
                    "bytes paymasterAndData,address entryPoint)",
            ),
        );
        const structHash = keccak256(
            encodeAbiParameters(
                [
                    {type: "bytes32"},
                    {type: "address"},
                    {type: "uint256"},
                    {type: "bytes32"},
                    {type: "bytes32"},
                    {type: "bytes32"},
                    {type: "uint256"},
                    {type: "bytes32"},
                    {type: "bytes32"},
                    {type: "address"},
                ],
                [
                    typeHash,
                    built.packed.sender,
                    built.packed.nonce,
                    keccak256(built.packed.initCode),
                    keccak256(built.packed.callData),
                    built.packed.accountGasLimits,
                    built.packed.preVerificationGas,
                    built.packed.gasFees,
                    keccak256(built.packed.paymasterAndData),
                    built.entryPoint,
                ],
            ),
        );
        const domainSeparator = keccak256(
            encodeAbiParameters(
                [
                    {type: "bytes32"},
                    {type: "bytes32"},
                    {type: "bytes32"},
                    {type: "uint256"},
                    {type: "address"},
                ],
                [
                    keccak256(
                        toHex(
                            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
                        ),
                    ),
                    keccak256(toHex("HybridDeleGator")),
                    keccak256(toHex("1")),
                    BigInt(giwaSepolia.id),
                    PAYER,
                ],
            ),
        );
        const expected = keccak256(concatHex(["0x1901", domainSeparator, structHash]));
        expect(hashTypedData(built.typedData)).toBe(expected);
    });

    test("the digest is stable — any drift in domain, field order, or packing moves it", () => {
        expect(hashTypedData(build().typedData)).toBe(
            "0xd2b79a5c85515b753ab5a2239ac94848d86624baab7dd41040eaef280fb18db4",
        );
    });

    test("finalize swaps in the signature and touches nothing else", () => {
        const built = build();
        const signature = `0x${"ab".repeat(65)}` as const;
        const final = finalizeRevocationUserOperation(built, signature);
        expect(final.entryPoint).toBe(built.entryPoint);
        expect(final.packed.signature).toBe(signature);
        const {signature: _dropped, ...rest} = final.packed;
        const {signature: _also, ...original} = built.packed;
        expect(rest).toEqual(original);
    });
});
