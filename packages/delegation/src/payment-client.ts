import {
    GIWA_SEPOLIA_CAIP2,
    MOCK_USDC,
    X402_VERSION,
    buildErc7710PaymentPayload,
    encodePaymentHeader,
    redactForLog,
    type Erc7710PaymentRequirements,
    type PaymentRequired,
} from "@mapae/shared";
import {getAddress, isAddress, type Address, type Hex} from "viem";

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Reason an autonomous delegated payment did not complete. Returned instead of
 * thrown so the MCP server (D5) surfaces a cause rather than dying silently.
 */
export type DelegatedPaymentFailureCode =
    | "NOT_PAYMENT_REQUIRED"
    | "UNSUPPORTED_X402_VERSION"
    | "SELLER_OFFER_INVALID"
    | "FACILITATOR_UNTRUSTED"
    | "MANAGER_MISMATCH"
    /** The on-chain period cap cannot cover this payment. */
    | "LIMIT_EXCEEDED"
    /** The permission is revoked, expired, or not yet active. */
    | "PERMISSION_INACTIVE"
    /** The leaf delegation could not be signed — e.g. the parent was revoked. */
    | "SIGNING_FAILED"
    | "PAYMENT_REJECTED"
    | "MALFORMED_RESOURCE"
    | "TRANSPORT_ERROR";

/** Signs a payment-specific leaf delegation for a seller's ERC-7710 offer. */
export type DelegatedLeafProvider = (
    requirements: Erc7710PaymentRequirements,
) => Promise<{delegationManager: Address; permissionContext: Hex; delegator: Address}>;

/** Verdict from an optional on-chain check made before any payment is attempted. */
export type PreflightVerdict =
    | {ok: true}
    | {ok: false; code: "LIMIT_EXCEEDED" | "PERMISSION_INACTIVE"; detail: string};

export interface DelegatedPaymentConfig {
    provider: DelegatedLeafProvider;
    /** Expected DelegationManager from the verified deployment. */
    delegationManager: Address;
    /** Facilitator redeemer addresses this agent already trusts. */
    trustedFacilitators: Address[];
    /**
     * Optional check against the enforcer's own accounting, run before signing.
     *
     * The cap is enforced on-chain either way; this exists so an agent that cannot
     * afford the payment says so — `LIMIT_EXCEEDED` — instead of walking into a
     * seller's generic rejection and reporting a status code. Kept as a callback so
     * the payment core itself stays chain-independent and unit-testable.
     */
    preflight?: (amount: bigint) => Promise<PreflightVerdict>;
    /** Injectable for tests; defaults to the global fetch. */
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
}

export type DelegatedPaymentResult =
    | {ok: true; amount: string; payTo: Address; transaction?: Hex; resource: unknown}
    | {ok: false; code: DelegatedPaymentFailureCode; status?: number; detail: string};

/**
 * Assert a seller's ERC-7710 offer is exactly what this agent is willing to pay.
 * Anything off — wrong scheme, network, asset, malformed amount, unsafe timeout —
 * throws, and the caller maps it to `SELLER_OFFER_INVALID`.
 */
export function assertErc7710Offer(value: unknown): Erc7710PaymentRequirements {
    const req = value as Erc7710PaymentRequirements;
    if (
        !req ||
        req.scheme !== "exact" ||
        req.network !== GIWA_SEPOLIA_CAIP2 ||
        req.extra?.assetTransferMethod !== "erc7710"
    ) {
        throw new Error("seller did not offer exact ERC-7710 on GIWA");
    }
    if (!isAddress(req.asset) || getAddress(req.asset) !== MOCK_USDC.address) {
        throw new Error(`unexpected asset ${req.asset}`);
    }
    if (!isAddress(req.payTo)) throw new Error("seller payTo is malformed");
    if (!/^[1-9]\d*$/.test(req.amount)) throw new Error("seller amount is malformed");
    if (
        !Number.isInteger(req.maxTimeoutSeconds) ||
        req.maxTimeoutSeconds < 1 ||
        req.maxTimeoutSeconds > 300
    ) {
        throw new Error("seller timeout is unsafe");
    }
    // Validated here rather than at the comparison below: the field is attacker-
    // controlled JSON, and a bare string would make `.some` throw straight out of
    // a function whose whole contract is to return a reason instead of throwing.
    const facilitators = req.extra.facilitatorAddresses;
    if (facilitators != null && !Array.isArray(facilitators)) {
        throw new Error("seller facilitatorAddresses is not a list");
    }
    return req;
}

function failure(
    code: DelegatedPaymentFailureCode,
    detail: string,
    status?: number,
): DelegatedPaymentResult {
    return {ok: false, code, detail, status};
}

/**
 * Every failure `detail` this module produces passes through here, so this is the one
 * place the RPC credential has to be stopped.
 *
 * `detail` is not internal: it is re-thrown to stderr by `apps/delegated-agent`, returned
 * as MCP tool output by `apps/agent-mcp` (i.e. to whatever agent is driving), and printed
 * by the e2e runner. The preflight closure reads over `throttledHttp(rpcUrl)`, and viem
 * embeds the full transport URL in its error messages — `getUrl` strips only userinfo, so
 * a provider key in the path survives untouched.
 *
 * This file already scrubs the *other* secret class carefully (`redactBearerSecrets`);
 * the RPC endpoint was the gap.
 */
function errorMessage(error: unknown): string {
    return redactForLog(error);
}

export const BEARER_REDACTION = "[redacted: bearer payment authorization]";

/**
 * Replace the bearer values we sent wherever they appear in a seller's response.
 *
 * Serialising and splitting on the literal reaches any nesting depth, which a
 * hand-written walker would not, and both secrets are long opaque hex/base64
 * strings so a substring match cannot collide with real content.
 */
function redactBearerSecrets(resource: unknown, secrets: string[]): unknown {
    const serialized = JSON.stringify(resource);
    if (serialized === undefined) return resource;
    let cleaned = serialized;
    for (const secret of secrets) {
        if (secret.length >= 32) cleaned = cleaned.split(secret).join(BEARER_REDACTION);
    }
    return cleaned === serialized ? resource : JSON.parse(cleaned);
}

function extractTransaction(resource: unknown): Hex | undefined {
    if (resource && typeof resource === "object" && "receipt" in resource) {
        const tx = (resource as {receipt?: {transaction?: unknown}}).receipt?.transaction;
        if (typeof tx === "string" && /^0x[0-9a-fA-F]{64}$/.test(tx)) return tx as Hex;
    }
    return undefined;
}

/**
 * Autonomous ERC-7710 payment: GET → 402 → sign a payment-specific leaf → retry
 * with `X-PAYMENT` → resource. This is the reusable core shared by the CLI agent
 * and the D5 MCP server; the caller owns env/file loading, deployment verification,
 * and provider construction.
 *
 * Security invariants (preserved from the CLI agent):
 * - On a failed retry the seller's body is neither read nor returned. A malicious
 *   seller can reflect `X-PAYMENT` back after we send a bearer permission context.
 * - The signed permission context and signature are never put into the result by
 *   this function, and are stripped from the seller's 2xx body if it echoes them.
 * - Only a 2xx retry yields the resource body.
 */
export async function payForDelegatedResource(
    target: URL,
    config: DelegatedPaymentConfig,
): Promise<DelegatedPaymentResult> {
    const doFetch = config.fetchImpl ?? fetch;
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let first: Response;
    try {
        first = await doFetch(target, {
            redirect: "error",
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        return failure("TRANSPORT_ERROR", errorMessage(error));
    }
    if (first.status !== 402) {
        return failure(
            "NOT_PAYMENT_REQUIRED",
            `expected 402, received ${first.status}`,
            first.status,
        );
    }

    let body: PaymentRequired<Erc7710PaymentRequirements>;
    try {
        body = (await first.json()) as PaymentRequired<Erc7710PaymentRequirements>;
    } catch (error) {
        return failure("SELLER_OFFER_INVALID", `402 body is not JSON: ${errorMessage(error)}`);
    }
    if (body.x402Version !== X402_VERSION) {
        return failure("UNSUPPORTED_X402_VERSION", `unsupported x402 version ${body.x402Version}`);
    }

    let accepted: Erc7710PaymentRequirements;
    try {
        accepted = assertErc7710Offer(body.accepts?.[0]);
    } catch (error) {
        return failure("SELLER_OFFER_INVALID", errorMessage(error));
    }

    const advertised = accepted.extra.facilitatorAddresses ?? [];
    const overlaps = config.trustedFacilitators.some((trusted) =>
        advertised.some(
            (candidate) =>
                typeof candidate === "string" &&
                isAddress(candidate) &&
                getAddress(candidate) === trusted,
        ),
    );
    if (!overlaps) {
        return failure(
            "FACILITATOR_UNTRUSTED",
            "seller and trusted facilitator signer lists do not overlap",
        );
    }

    if (config.preflight) {
        let verdict: PreflightVerdict;
        try {
            verdict = await config.preflight(BigInt(accepted.amount));
        } catch (error) {
            return failure("TRANSPORT_ERROR", `preflight read failed: ${errorMessage(error)}`);
        }
        // Stop before signing: a leaf that cannot settle is still a bearer
        // authorization, and there is no reason to mint one.
        if (!verdict.ok) return failure(verdict.code, verdict.detail);
    }

    let leaf: Awaited<ReturnType<DelegatedLeafProvider>>;
    try {
        leaf = await config.provider(accepted);
    } catch (error) {
        // Not a transport problem: the agent reached everything it needed and the
        // delegation itself could not be produced. Collapsing this into
        // TRANSPORT_ERROR sends whoever reads the reason looking at the network.
        return failure("SIGNING_FAILED", `leaf signing failed: ${errorMessage(error)}`);
    }
    if (getAddress(leaf.delegationManager) !== getAddress(config.delegationManager)) {
        return failure("MANAGER_MISMATCH", "provider returned an unexpected DelegationManager");
    }

    const payload = buildErc7710PaymentPayload({
        accepted,
        delegationManager: getAddress(leaf.delegationManager),
        permissionContext: leaf.permissionContext,
        delegator: getAddress(leaf.delegator),
    });

    const paymentHeader = encodePaymentHeader(payload);

    let second: Response;
    try {
        second = await doFetch(target, {
            redirect: "error",
            signal: AbortSignal.timeout(timeoutMs),
            headers: {"X-PAYMENT": paymentHeader},
        });
    } catch (error) {
        return failure("TRANSPORT_ERROR", errorMessage(error));
    }
    if (!second.ok) {
        // Do not read the body: a malicious seller can reflect X-PAYMENT after we
        // have sent a bearer permission context. Report the status class only.
        return failure(
            "PAYMENT_REJECTED",
            `seller rejected the payment (${second.status})`,
            second.status,
        );
    }

    let resource: unknown;
    try {
        resource = await second.json();
    } catch (error) {
        return failure("MALFORMED_RESOURCE", `resource is not JSON: ${errorMessage(error)}`);
    }
    // The payment succeeded, so this body is what the caller paid for and has to
    // come back. It is still seller-controlled text that lands in MCP tool output
    // and agent transcripts, and a seller that echoes `X-PAYMENT` — or the raw
    // permission context — would park a bearer authorization there. We know the
    // exact values, so strip them instead of trusting the seller not to send them.
    resource = redactBearerSecrets(resource, [leaf.permissionContext, paymentHeader]);
    return {
        ok: true,
        amount: accepted.amount,
        payTo: getAddress(accepted.payTo),
        transaction: extractTransaction(resource),
        resource,
    };
}
