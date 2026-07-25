import {
    DeleGatorCore,
    DelegationManager,
    EntryPoint as EntryPointContract,
} from "@metamask/smart-accounts-kit/contracts";
import {hashDelegation, SIGNABLE_USER_OP_TYPED_DATA} from "@metamask/smart-accounts-kit/utils";
import type {Delegation} from "@metamask/smart-accounts-kit";
import {EntryPoint as EntryPointAbi} from "@metamask/delegation-abis";
import {getAddress, type Address, type Hex, type PublicClient} from "viem";
import {
    toPackedUserOperation,
    type PackedUserOperation,
    type UserOperation,
} from "viem/account-abstraction";

export interface RevocationCall {
    to: Address;
    value: 0n;
    data: Hex;
}

/**
 * Build the owner smart-account call used to revoke a delegation.
 *
 * `DeleGatorCore.disableDelegation` is only callable through the account itself or
 * EntryPoint, so this call must be wrapped in an owner-authorized UserOperation.
 * It must never be sent directly from the relayer to DelegationManager.
 */
export function buildRevocationCall(delegation: Delegation): RevocationCall {
    return {
        to: getAddress(delegation.delegator),
        value: 0n,
        data: DeleGatorCore.encode.disableDelegation({delegation}),
    };
}

export async function isDelegationRevoked(params: {
    publicClient: PublicClient;
    delegationManager: Address;
    delegation: Delegation;
}): Promise<boolean> {
    return DelegationManager.read.disabledDelegations({
        client: params.publicClient,
        contractAddress: params.delegationManager,
        delegationHash: hashDelegation(params.delegation),
    });
}

/**
 * A local `as const` copy of the kit's `SIGNABLE_USER_OP_TYPED_DATA`.
 *
 * The kit declares its export as the widened `TypedData`, which strict viem/wagmi
 * `signTypedData` generics refuse to narrow to `primaryType: "PackedUserOperation"`.
 * `revocation.test.ts` asserts this copy deep-equals the kit's export, so a kit-side
 * field reorder fails a unit test instead of producing a silent `AA24` on chain.
 */
export const REVOCATION_USER_OP_TYPES = {
    PackedUserOperation: [
        {name: "sender", type: "address"},
        {name: "nonce", type: "uint256"},
        {name: "initCode", type: "bytes"},
        {name: "callData", type: "bytes"},
        {name: "accountGasLimits", type: "bytes32"},
        {name: "preVerificationGas", type: "uint256"},
        {name: "gasFees", type: "bytes32"},
        {name: "paymasterAndData", type: "bytes"},
        {name: "entryPoint", type: "address"},
    ],
} as const;

export interface RevocationGas {
    callGasLimit: bigint;
    verificationGasLimit: bigint;
    preVerificationGas: bigint;
    maxFeePerGas: bigint;
    /** Kept equal to `maxFeePerGas` so the prefund is independent of `block.basefee`. */
    maxPriorityFeePerGas: bigint;
}

/** ~3.5M gas-units at 1 gwei. Sized for a single `disableDelegation`, with headroom. */
export const DEFAULT_REVOCATION_GAS: RevocationGas = {
    callGasLimit: 300_000n,
    verificationGasLimit: 300_000n,
    preVerificationGas: 100_000n,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
};

/**
 * The nine signed fields, typed exactly.
 *
 * Not `Record<string, unknown>`: viem and wagmi `signTypedData` will not narrow a widened
 * message, so a loose type here is a cast at every call site — including the console's.
 */
export interface RevocationUserOpMessage {
    sender: Address;
    nonce: bigint;
    initCode: Hex;
    callData: Hex;
    accountGasLimits: Hex;
    preVerificationGas: bigint;
    gasFees: Hex;
    paymasterAndData: Hex;
    entryPoint: Address;
}

/**
 * `EntryPoint.sol` `_getRequiredPrefund`, with no paymaster terms because this account
 * pays for itself. Exported so a readiness display can size the deposit without
 * building (and therefore without fetching a nonce for) an operation nobody will sign.
 */
export function revocationPrefund(gas: RevocationGas): bigint {
    return (gas.verificationGasLimit + gas.callGasLimit + gas.preVerificationGas) * gas.maxFeePerGas;
}

export interface RevocationUserOperation {
    entryPoint: Address;
    /** Always `delegation.delegator` — the payer smart account revokes its own grant. */
    sender: Address;
    /** The nine frozen fields. Every one of them is inside the signed digest. */
    userOperation: Omit<UserOperation<"0.7">, "signature">;
    /** `signature: "0x"` — replaced only by {@link finalizeRevocationUserOperation}. */
    packed: PackedUserOperation;
    typedData: {
        domain: {
            name: string;
            version: "1";
            chainId: number;
            verifyingContract: Address;
        };
        types: typeof REVOCATION_USER_OP_TYPES;
        primaryType: "PackedUserOperation";
        message: RevocationUserOpMessage;
    };
    /** `(verification + call + preVerification) * maxFeePerGas` — EntryPoint.sol `_getRequiredPrefund`. */
    requiredPrefund: bigint;
}

/**
 * Build the EIP-712 payload the payer's wallet signs to revoke a delegation.
 *
 * Pure: no network, no estimation, no nonce fetch. Everything the digest covers is an
 * input, because a value re-read between build and sign silently produces a stale
 * digest that fails as `AA24 signature error` — a message that reads like a nonce or
 * gas problem and is not.
 *
 * `callData` is `buildRevocationCall(delegation).data` verbatim, deliberately *not*
 * wrapped in `execute(...)`. The EntryPoint calls the account directly, so `msg.sender`
 * is the EntryPoint and `onlyEntryPointOrSelf` passes through its EntryPoint disjunct.
 * Wrapping would route EntryPoint -> execute -> self-call and re-enter through the self
 * branch, which is the branch that was already covered.
 */
export function buildRevocationUserOperation(params: {
    delegation: Delegation;
    entryPoint: Address;
    chainId: number;
    nonce: bigint;
    gas: RevocationGas;
    accountDomainName?: "HybridDeleGator" | "MultiSigDeleGator";
}): RevocationUserOperation {
    const {gas} = params;
    if (gas.maxFeePerGas === 0n) {
        throw new Error(
            "maxFeePerGas must be non-zero: a zero-fee UserOperation has requiredPrefund 0, " +
                "which makes the EntryPoint prefund check dead code and lets handleOps succeed " +
                "on a completely unfunded account",
        );
    }
    if (gas.maxPriorityFeePerGas > gas.maxFeePerGas) {
        throw new Error("maxPriorityFeePerGas must not exceed maxFeePerGas");
    }

    const sender = getAddress(params.delegation.delegator);
    const entryPoint = getAddress(params.entryPoint);

    const userOperation: Omit<UserOperation<"0.7">, "signature"> = {
        sender,
        nonce: params.nonce,
        callData: buildRevocationCall(params.delegation).data,
        callGasLimit: gas.callGasLimit,
        verificationGasLimit: gas.verificationGasLimit,
        preVerificationGas: gas.preVerificationGas,
        maxFeePerGas: gas.maxFeePerGas,
        maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
    };
    const packed = toPackedUserOperation({...userOperation, signature: "0x"});

    return {
        entryPoint,
        sender,
        userOperation,
        packed,
        typedData: {
            domain: {
                name: params.accountDomainName ?? "HybridDeleGator",
                version: "1",
                chainId: params.chainId,
                // The account proxy, never the implementation: OZ rebuilds the domain
                // separator over `address(this)`, so the proxy is the verifying contract.
                verifyingContract: sender,
            },
            types: REVOCATION_USER_OP_TYPES,
            primaryType: "PackedUserOperation",
            message: {
                sender: packed.sender,
                nonce: packed.nonce,
                initCode: packed.initCode,
                callData: packed.callData,
                accountGasLimits: packed.accountGasLimits,
                preVerificationGas: packed.preVerificationGas,
                gasFees: packed.gasFees,
                paymasterAndData: packed.paymasterAndData,
                entryPoint,
            },
        },
        requiredPrefund: revocationPrefund(gas),
    };
}

/** Splice the wallet's signature into the exact operation that was hashed. */
export function finalizeRevocationUserOperation(
    built: RevocationUserOperation,
    signature: Hex,
): {entryPoint: Address; packed: PackedUserOperation} {
    return {
        entryPoint: built.entryPoint,
        packed: {...built.packed, signature},
    };
}

/**
 * Read the account's 2D nonce for `key`.
 *
 * The key is explicit because viem's default nonce-key manager derives a 192-bit key
 * from the wall clock, so an implicit call lands in a different key space every time.
 */
export async function readRevocationNonce(params: {
    publicClient: PublicClient;
    entryPoint: Address;
    sender: Address;
    key?: bigint;
}): Promise<bigint> {
    return EntryPointContract.read.entryPointGetNonce({
        client: params.publicClient,
        entryPoint: getAddress(params.entryPoint),
        contractAddress: getAddress(params.sender),
        key: params.key ?? 0n,
    });
}

export interface RevocationPrefundState {
    /** `StakeManager.deposits[sender].deposit` — what the EntryPoint actually charges. */
    deposit: bigint;
    /** The account's own ETH. Expected to stay `0` — the payer never holds gas. */
    nativeBalance: bigint;
    shortfall: bigint;
    ready: boolean;
}

/**
 * Report whether the kill switch is armed.
 *
 * Revocation is the one operation that cannot avoid the EntryPoint, and the EntryPoint
 * charges the account's *deposit*, not its balance. With neither, the operation fails as
 * `AA21 didn't pay prefund` — `DeleGatorCore._payPrefund` swallows the failed transfer,
 * so the refusal comes from the EntryPoint, not the account. A kill switch whose
 * readiness is invisible is worse than none, so this is a first-class read.
 */
export async function readRevocationPrefundState(params: {
    publicClient: PublicClient;
    entryPoint: Address;
    sender: Address;
    requiredPrefund: bigint;
}): Promise<RevocationPrefundState> {
    const sender = getAddress(params.sender);
    const [deposit, nativeBalance] = await Promise.all([
        params.publicClient.readContract({
            address: getAddress(params.entryPoint),
            abi: EntryPointAbi,
            functionName: "balanceOf",
            args: [sender],
        }) as Promise<bigint>,
        params.publicClient.getBalance({address: sender}),
    ]);
    const shortfall =
        deposit >= params.requiredPrefund ? 0n : params.requiredPrefund - deposit;
    return {deposit, nativeBalance, shortfall, ready: shortfall === 0n};
}

/**
 * Read the EOA that controls the payer smart account.
 *
 * `HybridDeleGator` implements `IERC173` (`HybridDeleGator.sol:233`), and its `owner()` is
 * the only key whose signature `_isValidSignature` accepts. A UI that collects a signature
 * from some other connected wallet gets `AA24 signature error` back from the EntryPoint —
 * a message that reads like a nonce or gas problem and sends people to the wrong place.
 * Comparing against this first turns that into "this wallet is not the owner".
 */
export async function readAccountOwner(params: {
    publicClient: PublicClient;
    account: Address;
}): Promise<Address> {
    const owner = await params.publicClient.readContract({
        address: getAddress(params.account),
        abi: [
            {
                type: "function",
                name: "owner",
                stateMutability: "view",
                inputs: [],
                outputs: [{type: "address"}],
            },
        ] as const,
        functionName: "owner",
    });
    return getAddress(owner);
}

/** Kept only to fail a unit test if the kit reorders the signed struct. */
export const KIT_SIGNABLE_USER_OP_TYPED_DATA = SIGNABLE_USER_OP_TYPED_DATA;
