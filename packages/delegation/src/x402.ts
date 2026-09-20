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

/**
 * The x402 v2 §9 words a facilitator may refuse a request with, as this profile uses
 * them. They are the whole vocabulary the wire carries for a refused verification — the
 * message stays in the operator's log, because a caller who learns *why* a delegation
 * was refused learns its caveat boundaries.
 *
 * `invalid_transaction_state` is the one that is not about the request's text: the
 * intent it names already ended on chain as a failure (a mined revert, a receipt with
 * no `Transfer` to the seller), so re-verifying it cannot make it valid.
 */
export type PaymentValidationReason =
    | "invalid_x402_version"
    | "invalid_payload"
    | "invalid_payment_requirements"
    | "unsupported_scheme"
    | "invalid_network"
    | "invalid_transaction_state";

/** A refusal formed before the chain was touched, carrying its §9 word and a log-only message. */
export class PaymentValidationError extends Error {
    constructor(readonly reason: PaymentValidationReason, message: string) {
        super(message);
        this.name = "PaymentValidationError";
    }
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

/**
 * Exact equality between the client's echoed `accepted` and the seller's offer.
 *
 * `a` is attacker-controlled JSON, so nothing in here may throw: every address goes
 * through {@link sameAddress}, which answers false for garbage instead of letting
 * `getAddress` raise a viem error out of a function whose whole job is to return
 * true/false — and whose caller would otherwise classify that error as a verdict.
 */
function sameRequirement(a: Erc7710PaymentRequirements, b: Erc7710PaymentRequirements): boolean {
    return (
        a.scheme === b.scheme &&
        a.network === b.network &&
        a.amount === b.amount &&
        a.maxTimeoutSeconds === b.maxTimeoutSeconds &&
        sameAddress(a.payTo, b.payTo) &&
        sameAddress(a.asset, b.asset) &&
        a.extra?.assetTransferMethod === b.extra.assetTransferMethod &&
        // 결제 흐름 선언도 오퍼의 조건이다. 우리 판매자의 오퍼는 예외 없이
        // `paymentFlow: "upfront"`를 싣기 때문에, 그 칸을 빼거나 바꿔 에코한 payload는
        // 판매자가 내건 조건과 다른 것을 승낙한 셈이고 여기서 떨어진다. 둘 다 없는
        // 경우(선언이 전파되지 않은 제3자 오퍼)는 일치다.
        a.extra?.paymentFlow === b.extra.paymentFlow &&
        sameOptionalManager(a.extra?.delegationManager, b.extra.delegationManager) &&
        sameAddressList(a.extra?.facilitatorAddresses, b.extra.facilitatorAddresses)
    );
}

function sameAddress(a: unknown, b: unknown): boolean {
    if (typeof a !== "string" || typeof b !== "string" || !isAddress(a) || !isAddress(b)) {
        return false;
    }
    return getAddress(a) === getAddress(b);
}

/**
 * Compare the advisory in-band DelegationManager on both offers. Both-absent is a match;
 * present-vs-absent or a value mismatch is not, because this function's contract is
 * exact equality and its failure message tells the caller the offer did not match.
 */
function sameOptionalManager(a: unknown, b: unknown): boolean {
    if (a === undefined && b === undefined) return true;
    return sameAddress(a, b);
}

/** An absent list and an empty one are the same offer: no redeemer was named. */
function sameAddressList(a: unknown, b: unknown): boolean {
    const left = a ?? [];
    const right = b ?? [];
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((address, index) => sameAddress(address, right[index]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/**
 * Strict D4 trust-boundary validator. No chain call happens until this succeeds, and
 * every refusal is a {@link PaymentValidationError} whose reason is the §9 word the
 * wire will carry: the request's own shape is `invalid_payload`, the offer's terms are
 * `invalid_payment_requirements`, and the version, scheme and network each have theirs.
 */
export function validateDelegatedPayment(
    input: unknown,
    options: {
        delegationManager: Address;
        facilitator: Address;
        maxAmount?: bigint;
    },
): ValidatedDelegatedPayment {
    const refuse = (reason: PaymentValidationReason, message: string) =>
        new PaymentValidationError(reason, message);

    if (input === null || typeof input !== "object") {
        throw refuse("invalid_payload", "request must be an object");
    }
    const request = input as Erc7710FacilitatorRequest;
    if (request.x402Version !== X402_VERSION) {
        throw refuse("invalid_x402_version", "unsupported x402Version");
    }

    const requirements = request.paymentRequirements;
    const payment = request.paymentPayload;
    if (!isRecord(requirements) || !isRecord(payment)) {
        throw refuse("invalid_payload", "paymentPayload and paymentRequirements are required");
    }
    if (payment.x402Version !== X402_VERSION) {
        throw refuse("invalid_x402_version", "paymentPayload.x402Version is unsupported");
    }
    if (!isRecord(payment.accepted) || !isRecord(payment.payload)) {
        throw refuse("invalid_payload", "paymentPayload.accepted and paymentPayload.payload are required");
    }
    if (requirements.scheme !== "exact" || requirements.extra?.assetTransferMethod !== "erc7710") {
        throw refuse("unsupported_scheme", "unsupported scheme or asset transfer method");
    }
    if (requirements.network !== GIWA_SEPOLIA_CAIP2) throw refuse("invalid_network", "unsupported network");
    if (!isAddress(requirements.asset) || getAddress(requirements.asset) !== MOCK_USDC.address) {
        throw refuse("invalid_payment_requirements", "unsupported asset");
    }
    if (!isAddress(requirements.payTo)) {
        throw refuse("invalid_payment_requirements", "payTo must be an address");
    }
    if (
        !Number.isInteger(requirements.maxTimeoutSeconds) ||
        requirements.maxTimeoutSeconds < 1 ||
        requirements.maxTimeoutSeconds > 300
    ) {
        throw refuse("invalid_payment_requirements", "maxTimeoutSeconds must be between 1 and 300");
    }
    if (typeof requirements.amount !== "string" || !UINT_STRING.test(requirements.amount)) {
        throw refuse("invalid_payment_requirements", "amount must be an integer string");
    }
    // 이 레일은 즉시 정산한다: `/verify` 다음에 `/settle`이 붙고 그 자리에서 redeem한다.
    // 그래서 수행할 수 있는 흐름은 `upfront`와 스펙 기본값 `authorization`(부재·null이
    // 뜻하는 값)뿐이고, `escrow`처럼 나중 청구를 약속한 오퍼는 여기서 떨어뜨린다 —
    // 그 약속을 지킬 코드가 없는데 redeem하면 페이어는 자기가 읽은 선언과 다른 시점에
    // 돈을 낸다. 클라이언트(`assertErc7710Offer`)와 같은 규칙이라 보호가 한쪽 경계에만
    // 있지 않다. 타입은 좁지만 값은 호출자가 준 JSON이므로 `unknown`으로 읽는다.
    const declaredFlow: unknown = requirements.extra.paymentFlow;
    if (declaredFlow != null && declaredFlow !== "upfront" && declaredFlow !== "authorization") {
        throw refuse("invalid_payment_requirements", "unsupported payment flow");
    }
    const amount = BigInt(requirements.amount);
    if (amount <= 0n) throw refuse("invalid_payment_requirements", "amount must be positive");
    if (options.maxAmount !== undefined && amount > options.maxAmount) {
        throw refuse("invalid_payment_requirements", "amount exceeds facilitator safety cap");
    }

    if (!sameRequirement(payment.accepted, requirements)) {
        throw refuse("invalid_payload", "accepted requirements do not exactly match the seller offer");
    }
    if (
        !isAddress(payment.payload.delegationManager) ||
        getAddress(payment.payload.delegationManager) !==
            getAddress(options.delegationManager)
    ) {
        throw refuse("invalid_payload", "delegationManager is not allowlisted");
    }
    if (!isAddress(payment.payload.delegator)) {
        throw refuse("invalid_payload", "delegator must be an address");
    }
    if (
        !isHex(payment.payload.permissionContext) ||
        payment.payload.permissionContext.length <= 2 ||
        payment.payload.permissionContext.length > MAX_PERMISSION_CONTEXT_HEX_LENGTH
    ) {
        throw refuse("invalid_payload", "permissionContext is malformed or too large");
    }

    let delegationChain;
    try {
        delegationChain = decodeDelegations(payment.payload.permissionContext);
    } catch {
        throw refuse("invalid_payload", "permissionContext is not a valid delegation chain");
    }
    const rootDelegation = delegationChain.at(-1);
    if (!rootDelegation || !isAddress(rootDelegation.delegator)) {
        throw refuse("invalid_payload", "permissionContext must contain a root delegator");
    }
    const payer = getAddress(rootDelegation.delegator);
    if (payer !== getAddress(payment.payload.delegator)) {
        throw refuse("invalid_payload", "claimed delegator does not match the signed root payer");
    }

    const facilitators = requirements.extra.facilitatorAddresses;
    if (
        facilitators &&
        !facilitators.some(
            (address) => isAddress(address) && getAddress(address) === getAddress(options.facilitator),
        )
    ) {
        throw refuse("invalid_payment_requirements", "this facilitator is not advertised as a redeemer");
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
