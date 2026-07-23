import type {Address, Hex} from "viem";

/**
 * Settlement error model.
 *
 * Every failure mode on the payment path gets its own tag so callers can branch on
 * cause rather than parsing message strings. Blockchain code has an unusually wide
 * error surface — RPC timeouts, rate limits, reverts, nonce races, signature
 * failures, an out-of-gas relayer — and collapsing them into one `catch` loses the
 * only information that matters for recovery.
 *
 * The `_tag` discriminant is deliberate: these map one-to-one onto
 * `Data.TaggedError` when the settlement path moves to Effect (see docs/tech-notes.md).
 * Keeping the shape now makes that migration mechanical rather than a rewrite.
 */
export type SettlementError =
    | {_tag: "InvalidSignature"; expectedSigner: Address}
    | {_tag: "AuthorizationExpired"; validBefore: bigint; now: bigint}
    | {_tag: "AuthorizationNotYetValid"; validAfter: bigint; now: bigint}
    | {_tag: "NonceAlreadyUsed"; authorizer: Address; nonce: Hex}
    | {_tag: "InsufficientBalance"; available: bigint; required: bigint}
    | {_tag: "LimitExceeded"; available: bigint; requested: bigint; periodEndsAt?: bigint}
    | {_tag: "DelegationRevoked"; delegationHash: Hex}
    | {_tag: "RelayerOutOfGas"; signer: Address; balance: bigint}
    | {_tag: "RpcUnavailable"; url: string; cause: unknown}
    | {_tag: "RpcRateLimited"; url: string; retryAfterMs?: number}
    | {_tag: "TxReverted"; hash?: Hex; reason?: string}
    | {_tag: "DomainMismatch"; expected: string; received: string}
    | {_tag: "MalformedPayload"; field: string; detail?: string};

export type SettlementErrorTag = SettlementError["_tag"];

/** Errors worth retrying. Everything else is terminal — surface it, don't loop. */
const RETRYABLE: ReadonlySet<SettlementErrorTag> = new Set([
    "RpcUnavailable",
    "RpcRateLimited",
]);

export function isRetryable(error: SettlementError): boolean {
    return RETRYABLE.has(error._tag);
}

/**
 * Operator-facing errors. These mean the service is misconfigured or starved,
 * not that the caller did something wrong — they should page, not 400.
 */
const OPERATIONAL: ReadonlySet<SettlementErrorTag> = new Set([
    "RelayerOutOfGas",
    "RpcUnavailable",
    "RpcRateLimited",
]);

export function isOperational(error: SettlementError): boolean {
    return OPERATIONAL.has(error._tag);
}

export function httpStatusFor(error: SettlementError): number {
    if (isOperational(error)) return 503;
    switch (error._tag) {
        case "MalformedPayload":
        case "DomainMismatch":
            return 400;
        case "InvalidSignature":
            return 401;
        case "DelegationRevoked":
        case "LimitExceeded":
            return 403;
        case "NonceAlreadyUsed":
            return 409;
        default:
            return 422;
    }
}

/** Never let a failure leave as a bare 500 with no cause — that's undebuggable in a demo. */
export function describe(error: SettlementError): string {
    switch (error._tag) {
        case "InvalidSignature":
            return `signature does not recover to ${error.expectedSigner}`;
        case "AuthorizationExpired":
            return `authorization expired at ${error.validBefore} (now ${error.now})`;
        case "AuthorizationNotYetValid":
            return `authorization not valid until ${error.validAfter} (now ${error.now})`;
        case "NonceAlreadyUsed":
            return `nonce ${error.nonce} already consumed by ${error.authorizer}`;
        case "InsufficientBalance":
            return `balance ${error.available} < required ${error.required}`;
        case "LimitExceeded":
            return `period allowance ${error.available} < requested ${error.requested}`;
        case "DelegationRevoked":
            return `delegation ${error.delegationHash} was revoked`;
        case "RelayerOutOfGas":
            return `relayer ${error.signer} has ${error.balance} wei — top up`;
        case "RpcUnavailable":
            return `RPC ${error.url} unreachable`;
        case "RpcRateLimited":
            return `RPC ${error.url} rate limited`;
        case "TxReverted":
            return `tx reverted${error.reason ? `: ${error.reason}` : ""}`;
        case "DomainMismatch":
            return `EIP-712 domain mismatch: expected ${error.expected}, got ${error.received}`;
        case "MalformedPayload":
            return `malformed field "${error.field}"${error.detail ? `: ${error.detail}` : ""}`;
    }
}
