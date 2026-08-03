import {createx402DelegationProvider} from "@metamask/smart-accounts-kit/experimental";
import {
    ExecutionMode,
    createExecution,
    type PermissionContext,
    type SmartAccountsEnvironment,
} from "@metamask/smart-accounts-kit";
import {decodeDelegations} from "@metamask/smart-accounts-kit/utils";
import type {Account, Address, Hex} from "viem";
import {
    encodeAbiParameters,
    encodeFunctionData,
    getAddress,
    isAddress,
    isHex,
    keccak256,
    toBytes,
} from "viem";
import {
    GIWA_SEPOLIA_CAIP2,
    MOCK_USDC,
    X402_VERSION,
    type Erc7710PaymentPayload,
    type Erc7710PaymentRequirements,
    type FacilitatorRequest,
} from "@mapae/shared";
import {MAX_PERMISSION_CONTEXT_HEX_LENGTH} from "./config.js";

export interface MapaeDelegationProviderConfig {
    account: Pick<Account, "address" | "signTypedData">;
    environment: SmartAccountsEnvironment;
    parentPermissionContext: PermissionContext;
    facilitatorAddresses: Address[];
}

/** Payment-specific leaf delegation provider used by the delegated agent. */
export function createMapaeDelegationProvider(config: MapaeDelegationProviderConfig) {
    if (config.facilitatorAddresses.length === 0) {
        throw new Error("at least one facilitator redeemer address is required");
    }
    return createx402DelegationProvider({
        account: config.account as Account,
        environment: config.environment,
        parentPermissionContext: config.parentPermissionContext,
        expirySeconds: (requirements) => requirements.maxTimeoutSeconds,
        redeemers: {
            requireRedeemers: true,
            addresses: config.facilitatorAddresses,
        },
    });
}

export type Erc7710FacilitatorRequest = FacilitatorRequest<
    Erc7710PaymentPayload,
    Erc7710PaymentRequirements
>;

/**
 * The seller→facilitator contract, both halves in one place.
 *
 * The request half has always lived here. The response half did not: the facilitator
 * declared `VerifyResponse`/`SettleResponse` privately, the seller declared its own
 * all-optional `FacilitatorResponse`, and the sentinel below was a bare string literal
 * on each side. Two structurally unrelated types describing one wire is a contract
 * TypeScript cannot check — every field optional on the reading side means a producer
 * change type-checks clean on both sides and only shows up as behaviour.
 *
 * What that behaviour would be is known, because it already happened once. Renaming or
 * dropping this sentinel silently converts the seller's answer for a *broadcast but
 * unconfirmed* payment from 504 to 422 — from "you may have been charged" to "you were
 * not". That is the bug that told a caller `PAYMENT_REJECTED` while GIWA tx
 * `0x533c5cb2…9964c` had already moved 1.00 mUSDC out of the payer.
 */
export const SETTLEMENT_UNCONFIRMED = "settlement_unconfirmed";

export interface Erc7710VerifyResponse {
    isValid: boolean;
    payer?: Address;
    invalidReason?: string;
}

export interface Erc7710SettleResponse {
    success: boolean;
    transaction?: Hex;
    network: typeof GIWA_SEPOLIA_CAIP2;
    payer?: Address;
    /** `SETTLEMENT_UNCONFIRMED` means the redemption was broadcast; the receipt was not seen. */
    errorReason?: string;
}

/**
 * What the seller learned by asking the facilitator to settle.
 *
 * Deliberately three cases, not a boolean. `failed` and `unknown` are opposite claims
 * about the payer's balance, and collapsing them is the whole failure this type exists
 * to prevent — a rejection invites a retry, and retrying an `unknown` can pay twice.
 *
 * Verification refusal is not one of them. It is a boolean answered before settlement is
 * ever attempted, so giving this union a `rejected` variant would add a case no producer
 * can reach and no test can reach either.
 */
export type SettlementOutcome =
    | {kind: "unknown"; transaction?: Hex}
    | {kind: "failed"}
    | {kind: "settled"; transaction?: Hex};

const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;

function readTransaction(value: unknown): Hex | undefined {
    return typeof value === "string" && TRANSACTION_HASH.test(value) ? (value as Hex) : undefined;
}

/**
 * True only when the body claims validity *and* names the payer the seller itself
 * derived from the signed permission context.
 *
 * The payer cross-check is not redundant with the seller's own validation: it is what
 * makes a facilitator that validated a *different* request than the one it was handed
 * fail closed rather than have its answer accepted for our payment.
 */
export function isVerificationAccepted(body: unknown, expectedPayer: Address): boolean {
    if (!body || typeof body !== "object") return false;
    const response = body as Erc7710VerifyResponse;
    if (response.isValid !== true) return false;
    return (
        typeof response.payer === "string" &&
        isAddress(response.payer) &&
        getAddress(response.payer) === expectedPayer
    );
}

/**
 * The verification counterpart of {@link SettlementOutcome}, and the reason it is not a
 * boolean: an outage on the `/verify` hop and a facilitator that examined the delegation
 * and refused it are different claims, and collapsing them blames the caller's delegation
 * for the seller's dependency being down (task #37). Nothing is charged at `/verify` — it
 * is a simulation — so `unavailable` is safe to retry, unlike a settlement `unknown`.
 */
export type VerificationOutcome =
    | {kind: "unavailable"}
    | {kind: "rejected"}
    | {kind: "accepted"; payer: Address};

/**
 * Map a `/verify` call onto the three outcomes. `reachable: false` — connection refused,
 * non-2xx, unparseable JSON, timeout — is `unavailable`, never `rejected`: the seller
 * could not obtain a verdict, which is not the same as obtaining a "no".
 */
export function decideVerification(
    response: {reachable: boolean; body?: unknown},
    expectedPayer: Address,
): VerificationOutcome {
    if (!response.reachable || !response.body || typeof response.body !== "object") {
        return {kind: "unavailable"};
    }
    if (!isVerificationAccepted(response.body, expectedPayer)) {
        return {kind: "rejected"};
    }
    return {kind: "accepted", payer: expectedPayer};
}

/**
 * Map a `/settle` call onto the four outcomes.
 *
 * `reachable: false` covers every way the call did not produce a body we can read —
 * connection refused, non-2xx, unparseable JSON. All of them are `unknown` rather than
 * `failed`, because none of them distinguishes "the request never landed" from "it
 * landed, broadcast, and the answer was lost on the way back".
 */
export function decideSettlement(
    response: {reachable: boolean; body?: unknown},
    expectedPayer: Address,
): SettlementOutcome {
    if (!response.reachable || !response.body || typeof response.body !== "object") {
        return {kind: "unknown"};
    }
    const body = response.body as Erc7710SettleResponse;
    if (body.errorReason === SETTLEMENT_UNCONFIRMED) {
        return {kind: "unknown", transaction: readTransaction(body.transaction)};
    }
    if (body.success !== true) return {kind: "failed"};
    // Success with a payer we did not derive is not a clean failure. The facilitator
    // said it broadcast, so money may well have moved; only the identity it reports is
    // inconsistent. Answering `failed` here would assert a balance nobody has checked.
    if (
        typeof body.payer !== "string" ||
        !isAddress(body.payer) ||
        getAddress(body.payer) !== expectedPayer
    ) {
        return {kind: "unknown", transaction: readTransaction(body.transaction)};
    }
    return {kind: "settled", transaction: readTransaction(body.transaction)};
}

export interface ValidatedDelegatedPayment {
    paymentPayload: Erc7710PaymentPayload;
    paymentRequirements: Erc7710PaymentRequirements;
    amount: bigint;
    /** Root payer derived from the signed permission context, never from an unsigned claim. */
    payer: Address;
    /** Canonical, off-chain idempotency key for this exact payment intent. */
    paymentIntentId: Hex;
}

const UINT_STRING = /^(0|[1-9]\d*)$/;
const PAYMENT_INTENT_DOMAIN = keccak256(toBytes("mapae.erc7710.payment-intent.v1"));

/** Coalesces concurrent requests for one payment intent into one operation. */
export class PaymentIntentSingleFlight<T> {
    readonly #inflightPayments = new Map<Hex, Promise<T>>();

    async run(paymentIntentId: Hex, execute: () => Promise<T>): Promise<T> {
        const existing = this.#inflightPayments.get(paymentIntentId);
        if (existing) return existing;

        // Defer execution until after the promise is registered so re-entrant calls coalesce too.
        const operation = Promise.resolve().then(execute);
        this.#inflightPayments.set(paymentIntentId, operation);
        try {
            return await operation;
        } finally {
            if (this.#inflightPayments.get(paymentIntentId) === operation) {
                this.#inflightPayments.delete(paymentIntentId);
            }
        }
    }
}

function sameRequirement(
    a: Erc7710PaymentRequirements,
    b: Erc7710PaymentRequirements,
): boolean {
    const aFacilitators = a.extra.facilitatorAddresses?.map(getAddress) ?? [];
    const bFacilitators = b.extra.facilitatorAddresses?.map(getAddress) ?? [];
    return (
        a.scheme === b.scheme &&
        a.network === b.network &&
        a.amount === b.amount &&
        a.maxTimeoutSeconds === b.maxTimeoutSeconds &&
        getAddress(a.payTo) === getAddress(b.payTo) &&
        getAddress(a.asset) === getAddress(b.asset) &&
        a.extra.assetTransferMethod === b.extra.assetTransferMethod &&
        sameOptionalManager(a.extra.delegationManager, b.extra.delegationManager) &&
        aFacilitators.length === bFacilitators.length &&
        aFacilitators.every((address, index) => address === bFacilitators[index])
    );
}

/**
 * Compare the advisory in-band DelegationManager on both offers. `a` is the client's
 * echoed `accepted`, i.e. attacker-controlled JSON, so `getAddress` is only reached
 * after `isAddress` — a bare `getAddress` throws on garbage out of a function whose
 * whole job is to return true/false. Both-absent is a match; present-vs-absent or a
 * value mismatch is not, because this function's contract is exact equality and its
 * failure message tells the caller the offer did not match.
 */
function sameOptionalManager(a: unknown, b: unknown): boolean {
    if (a === undefined && b === undefined) return true;
    if (typeof a !== "string" || typeof b !== "string" || !isAddress(a) || !isAddress(b)) {
        return false;
    }
    return getAddress(a) === getAddress(b);
}

/**
 * Strict D4 trust-boundary validator. No chain call happens until this succeeds.
 */
export function validateDelegatedPayment(
    input: unknown,
    options: {
        delegationManager: Address;
        facilitator: Address;
        maxAmount?: bigint;
    },
): ValidatedDelegatedPayment {
    if (!input || typeof input !== "object") throw new Error("request must be an object");
    const request = input as Erc7710FacilitatorRequest;
    if (request.x402Version !== X402_VERSION) throw new Error("unsupported x402Version");

    const requirements = request.paymentRequirements;
    const payment = request.paymentPayload;
    if (!requirements || !payment || payment.x402Version !== X402_VERSION) {
        throw new Error("paymentPayload and paymentRequirements are required");
    }
    if (
        requirements.scheme !== "exact" ||
        requirements.network !== GIWA_SEPOLIA_CAIP2 ||
        requirements.extra?.assetTransferMethod !== "erc7710"
    ) {
        throw new Error("unsupported payment method or network");
    }
    if (!isAddress(requirements.asset) || getAddress(requirements.asset) !== MOCK_USDC.address) {
        throw new Error("unsupported asset");
    }
    if (!isAddress(requirements.payTo)) throw new Error("payTo must be an address");
    if (
        !Number.isInteger(requirements.maxTimeoutSeconds) ||
        requirements.maxTimeoutSeconds < 1 ||
        requirements.maxTimeoutSeconds > 300
    ) {
        throw new Error("maxTimeoutSeconds must be between 1 and 300");
    }
    if (!UINT_STRING.test(requirements.amount)) throw new Error("amount must be an integer string");
    const amount = BigInt(requirements.amount);
    if (amount <= 0n) throw new Error("amount must be positive");
    if (options.maxAmount !== undefined && amount > options.maxAmount) {
        throw new Error("amount exceeds facilitator safety cap");
    }

    if (!sameRequirement(payment.accepted, requirements)) {
        throw new Error("accepted requirements do not exactly match the seller offer");
    }
    if (
        !isAddress(payment.payload.delegationManager) ||
        getAddress(payment.payload.delegationManager) !==
            getAddress(options.delegationManager)
    ) {
        throw new Error("delegationManager is not allowlisted");
    }
    if (!isAddress(payment.payload.delegator)) throw new Error("delegator must be an address");
    if (
        !isHex(payment.payload.permissionContext) ||
        payment.payload.permissionContext.length <= 2 ||
        payment.payload.permissionContext.length > MAX_PERMISSION_CONTEXT_HEX_LENGTH
    ) {
        throw new Error("permissionContext is malformed or too large");
    }

    let delegationChain;
    try {
        delegationChain = decodeDelegations(payment.payload.permissionContext);
    } catch {
        throw new Error("permissionContext is not a valid delegation chain");
    }
    const rootDelegation = delegationChain.at(-1);
    if (!rootDelegation || !isAddress(rootDelegation.delegator)) {
        throw new Error("permissionContext must contain a root delegator");
    }
    const payer = getAddress(rootDelegation.delegator);
    if (payer !== getAddress(payment.payload.delegator)) {
        throw new Error("claimed delegator does not match the signed root payer");
    }

    const facilitators = requirements.extra.facilitatorAddresses;
    if (
        facilitators &&
        !facilitators.some(
            (address) => isAddress(address) && getAddress(address) === getAddress(options.facilitator),
        )
    ) {
        throw new Error("this facilitator is not advertised as a redeemer");
    }

    const paymentIntentId = keccak256(
        encodeAbiParameters(
            [
                {name: "domain", type: "bytes32"},
                {name: "network", type: "string"},
                {name: "asset", type: "address"},
                {name: "amount", type: "uint256"},
                {name: "payTo", type: "address"},
                {name: "delegationManager", type: "address"},
                {name: "permissionContextHash", type: "bytes32"},
            ],
            [
                PAYMENT_INTENT_DOMAIN,
                requirements.network,
                getAddress(requirements.asset),
                amount,
                getAddress(requirements.payTo),
                getAddress(payment.payload.delegationManager),
                keccak256(payment.payload.permissionContext),
            ],
        ),
    );

    return {
        paymentPayload: payment,
        paymentRequirements: requirements,
        amount,
        payer,
        paymentIntentId,
    };
}

export function buildDelegatedTransfer(payment: ValidatedDelegatedPayment) {
    return {
        delegations: [payment.paymentPayload.payload.permissionContext],
        modes: [ExecutionMode.SingleDefault],
        executions: [
            [
                createExecution({
                    target: getAddress(payment.paymentRequirements.asset),
                    value: 0n,
                    callData: encodeFunctionData({
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
                        functionName: "transfer",
                        args: [getAddress(payment.paymentRequirements.payTo), payment.amount],
                    }),
                }),
            ],
        ],
    } as const;
}
