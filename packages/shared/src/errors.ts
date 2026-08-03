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
    /**
     * The settle call did not return a verdict we can trust — a transport failure, a
     * non-2xx, or a lost response after the facilitator may have broadcast. Distinct
     * from TxReverted (an observed non-payment) and from RpcUnavailable (retryable):
     * the money may have moved, so re-signing can pay twice. Maps to 504.
     */
    | {_tag: "SettlementUnknown"; transaction?: Hex}
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
        // The client's SETTLEMENT_UNKNOWN_STATUSES treats 504 as "may be charged, do not
        // re-sign"; the delegated seller already answers 504 for the same condition.
        case "SettlementUnknown":
            return 504;
        default:
            return 422;
    }
}

/**
 * A one-line log message that keeps the cause and drops the bearer material.
 *
 * viem embeds the whole request in its errors, and on the settlement path that
 * request carries a signed permission context — a bearer authorization that must
 * never reach a log. What an operator actually needs is short: revert reasons like
 * `ERC20PeriodTransferEnforcer:transfer-amount-exceeded`, addresses, tx hashes.
 * The dangerous material is long hex, so the split is by length: anything longer
 * than a 32-byte hash is replaced by its size. Logging only `error.name` avoids the
 * leak too, but leaves the operator with "Error: request rejected" and no cause.
 */
/**
 * Reduce every URL in a string to `scheme://host`, dropping path, query and fragment.
 *
 * Private RPC providers authenticate with an API key in the URL *path*, so a full URL is
 * a credential even though nothing about it looks like one. viem embeds its transport URL
 * in error messages, anvil prints the fork URL when a fork fails, and both of those reach
 * logs and — through `redactForLog` — HTTP response bodies.
 *
 * The host is kept deliberately: "which endpoint failed" is the entire diagnostic value,
 * and the host is not the secret.
 */
export function redactUrls(text: string): string {
    return text.replace(/\bhttps?:\/\/[^\s"'<>)\]}]+/gi, (match) => {
        try {
            const url = new URL(match);
            const tail = match.slice(url.origin.length);
            return tail && tail !== "/" ? `${url.origin}/<redacted>` : url.origin;
        } catch {
            return match;
        }
    });
}

export function redactForLog(value: unknown, maxLength = 300): string {
    const raw = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
    const scrubbed = redactUrls(raw)
        .replace(/0x[0-9a-fA-F]{65,}/g, (match) => `0x<${(match.length - 2) / 2} bytes redacted>`)
        .replace(/\s+/g, " ")
        .trim();
    return scrubbed.length > maxLength ? `${scrubbed.slice(0, maxLength)}…` : scrubbed;
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
        // Host only. The path carries the provider API key, and this string is a
        // user-facing description, not an operator-only log line.
        case "RpcUnavailable":
            return `RPC ${redactUrls(error.url)} unreachable`;
        case "RpcRateLimited":
            return `RPC ${redactUrls(error.url)} rate limited`;
        case "TxReverted":
            return `tx reverted${error.reason ? `: ${error.reason}` : ""}`;
        case "SettlementUnknown":
            return (
                "settlement outcome unknown — the payment may have settled; do not re-sign" +
                (error.transaction ? ` (tx ${error.transaction})` : "")
            );
        case "DomainMismatch":
            return `EIP-712 domain mismatch: expected ${error.expected}, got ${error.received}`;
        case "MalformedPayload":
            return `malformed field "${error.field}"${error.detail ? `: ${error.detail}` : ""}`;
    }
}
