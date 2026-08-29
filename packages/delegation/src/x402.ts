import {createx402DelegationProvider} from "@metamask/smart-accounts-kit/experimental";
import {
    ExecutionMode,
    createExecution,
    type PermissionContext,
    type SmartAccountsEnvironment,
} from "@metamask/smart-accounts-kit";
import {decodeDelegations} from "@metamask/smart-accounts-kit/utils";
import type {Account, Address, Hex} from "viem";
import {encodeFunctionData, getAddress, isAddress, isHex} from "viem";
import {
    GIWA_SEPOLIA_CAIP2,
    MOCK_USDC,
    X402_VERSION,
    type Erc7710PaymentPayload,
    type Erc7710PaymentRequirements,
} from "@mapae/shared";
import {MAX_PERMISSION_CONTEXT_HEX_LENGTH} from "./config.js";
import {derivePaymentIntentId, type Erc7710FacilitatorRequest} from "./facilitator-contract.js";

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

    const paymentIntentId = derivePaymentIntentId({
        network: requirements.network,
        asset: getAddress(requirements.asset),
        amount,
        payTo: getAddress(requirements.payTo),
        delegationManager: getAddress(payment.payload.delegationManager),
        permissionContext: payment.payload.permissionContext,
    });

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
