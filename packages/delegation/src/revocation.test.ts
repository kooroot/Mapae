import {describe, expect, test} from "bun:test";
import {
    ContractFunctionRevertedError,
    HttpRequestError,
    LimitExceededRpcError,
    concatHex,
    encodeAbiParameters,
    encodeFunctionData,
    getAddress,
    hashTypedData,
    keccak256,
    pad,
    toHex,
    type Address,
    type PublicClient,
} from "viem";
import type {SmartAccountsEnvironment} from "@metamask/smart-accounts-kit";
import {DeleGatorCore} from "@metamask/smart-accounts-kit/contracts";
import {
    EntryPoint as EntryPointAbi,
    HybridDeleGator as HybridDeleGatorAbi,
} from "@metamask/delegation-abis";
import {giwaSepolia} from "@mapae/shared";
import {ENTRY_POINT_V07} from "./config.js";
import {buildD3Policies, preparePeriodDelegation} from "./policy.js";
import {
    buildPrefundDepositCall,
    buildRevocationCall,
    buildRevocationUserOperation,
    DEFAULT_REVOCATION_GAS,
    finalizeRevocationUserOperation,
    KIT_SIGNABLE_USER_OP_TYPED_DATA,
    REVOCATION_USER_OP_TYPES,
    revocationPrefund,
    SPONSORED_REVOCATION_GAS,
    verifyRevocationSignature,
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

describe("sponsored revocation gas profile", () => {
    test("same limits as the default profile — only the fee changes", () => {
        expect(SPONSORED_REVOCATION_GAS.callGasLimit).toBe(DEFAULT_REVOCATION_GAS.callGasLimit);
        expect(SPONSORED_REVOCATION_GAS.verificationGasLimit).toBe(
            DEFAULT_REVOCATION_GAS.verificationGasLimit,
        );
        expect(SPONSORED_REVOCATION_GAS.preVerificationGas).toBe(
            DEFAULT_REVOCATION_GAS.preVerificationGas,
        );
    });

    test("prefund is 0.000007 ETH — the sponsor's per-request exposure, exactly", () => {
        expect(SPONSORED_REVOCATION_GAS.maxFeePerGas).toBe(10_000_000n);
        expect(revocationPrefund(SPONSORED_REVOCATION_GAS)).toBe(7_000_000_000_000n);
    });

    test("the tip equals the fee, so the prefund is independent of block.basefee", () => {
        expect(SPONSORED_REVOCATION_GAS.maxPriorityFeePerGas).toBe(
            SPONSORED_REVOCATION_GAS.maxFeePerGas,
        );
    });

    test("caps the leftover gift at 1% of the self-funded profile", () => {
        // The EntryPoint refunds the unused prefund into the *sender's* deposit, where the
        // account owner can withdraw it. At the default 1 gwei profile that makes a public
        // sponsor a 0.0007 ETH-per-request faucet; this profile is what bounds the gift.
        expect(revocationPrefund(SPONSORED_REVOCATION_GAS) * 100n).toBeLessThanOrEqual(
            revocationPrefund(DEFAULT_REVOCATION_GAS),
        );
    });
});

describe("buildPrefundDepositCall", () => {
    const ENTRY = address(30);
    const SENDER = address(31);

    test("encodes EntryPoint.depositTo(sender) with the amount as value", () => {
        const call = buildPrefundDepositCall({entryPoint: ENTRY, sender: SENDER, amount: 7n});
        expect(call.to).toBe(ENTRY);
        expect(call.value).toBe(7n);
        expect(call.data).toBe(
            encodeFunctionData({
                abi: EntryPointAbi,
                functionName: "depositTo",
                args: [SENDER],
            }),
        );
    });

    test("refuses a zero amount — a zero deposit is a bug, not a no-op", () => {
        expect(() =>
            buildPrefundDepositCall({entryPoint: ENTRY, sender: SENDER, amount: 0n}),
        ).toThrow(/amount must be positive/);
    });
});

describe("verifyRevocationSignature", () => {
    const built = build();
    const packed = finalizeRevocationUserOperation(built, `0x${"ab".repeat(65)}`).packed;
    const HASH = `0x${"11".repeat(32)}` as const;

    /** A stub is unavoidable here: the helper's whole job is two eth_calls. */
    function stubClient(
        onIsValid: (hash: unknown, signature: unknown) => Promise<unknown>,
    ): Pick<PublicClient, "readContract"> {
        return {
            readContract: (async (args: {functionName: string; args: readonly unknown[]}) => {
                if (args.functionName === "getPackedUserOperationTypedDataHash") return HASH;
                if (args.functionName === "isValidSignature") {
                    return onIsValid(args.args[0], args.args[1]);
                }
                throw new Error(`unexpected read: ${args.functionName}`);
            }) as PublicClient["readContract"],
        };
    }

    test("returns true only for the ERC-1271 magic value, fed the account's own hash", async () => {
        let seenHash: unknown;
        let seenSignature: unknown;
        const client = stubClient(async (hash, signature) => {
            seenHash = hash;
            seenSignature = signature;
            return "0x1626ba7e";
        });
        await expect(
            verifyRevocationSignature({publicClient: client as PublicClient, packed}),
        ).resolves.toBe(true);
        // The hash the account computes is the hash the signature is checked against —
        // never a hash we derived ourselves.
        expect(seenHash).toBe(HASH);
        expect(seenSignature).toBe(packed.signature);
    });

    test("a non-magic answer is a refusal, not an error", async () => {
        const client = stubClient(async () => "0xffffffff");
        await expect(
            verifyRevocationSignature({publicClient: client as PublicClient, packed}),
        ).resolves.toBe(false);
    });

    test("a contract revert reads as invalid — OZ ECDSA reverts on malformed signatures", async () => {
        const client = stubClient(async () => {
            throw new ContractFunctionRevertedError({
                abi: HybridDeleGatorAbi,
                functionName: "isValidSignature",
                message: "execution reverted",
            });
        });
        await expect(
            verifyRevocationSignature({publicClient: client as PublicClient, packed}),
        ).resolves.toBe(false);
    });

    test("a transport failure is rethrown — 'unreachable' must not read as 'invalid'", async () => {
        const client = stubClient(async () => {
            throw new HttpRequestError({url: "http://127.0.0.1:1", details: "connection refused"});
        });
        await expect(
            verifyRevocationSignature({publicClient: client as PublicClient, packed}),
        ).rejects.toThrow(/HTTP request failed|connection refused/);
    });

    test("an RPC throttle is rethrown, not reported as a bad signature", async () => {
        // A `-32005` is a viem `BaseError` like everything else. Classifying by base class
        // would tell an owner their signature is invalid *and* consume their rate-limit
        // token, for a condition that has nothing to do with the signature.
        const client = stubClient(async () => {
            throw new LimitExceededRpcError(new Error("too many requests"));
        });
        await expect(
            verifyRevocationSignature({publicClient: client as PublicClient, packed}),
        ).rejects.toThrow(/limit|too many requests/i);
    });
});
