import {describe, expect, test} from "bun:test";
import {getAddress, type Address, type Hex} from "viem";
import {buildErc7710PaymentRequirements} from "@mapae/shared";
import {payForDelegatedResource, type DelegatedLeafProvider} from "./payment-client.js";

const MANAGER = getAddress("0x4000000000000000000000000000000000000001");
const OTHER_MANAGER = getAddress("0x4000000000000000000000000000000000000002");
const FACILITATOR = getAddress("0x3000000000000000000000000000000000000001");
const UNTRUSTED = getAddress("0x3000000000000000000000000000000000000009");
const PAYEE = getAddress("0x2000000000000000000000000000000000000001");
const DELEGATOR = getAddress("0x5000000000000000000000000000000000000001");
const PERMISSION_CONTEXT = `0x${"ab".repeat(64)}` as Hex;
const TX = `0x${"cd".repeat(32)}` as Hex;

const target = new URL("http://127.0.0.1:3001/delegated/deliverable/inv-001");

function paymentRequired(facilitators: Address[] = [FACILITATOR]) {
    return {
        x402Version: 2,
        resource: {url: target.toString(), description: "test", mimeType: "application/json"},
        accepts: [
            buildErc7710PaymentRequirements({
                payTo: PAYEE,
                amount: 1_000_000n,
                facilitatorAddresses: facilitators,
            }),
        ],
    };
}

const okProvider: DelegatedLeafProvider = async () => ({
    delegationManager: MANAGER,
    permissionContext: PERMISSION_CONTEXT,
    delegator: DELEGATOR,
});

function jsonResponse(status: number, body: unknown): Response {
    return {
        status,
        ok: status >= 200 && status < 300,
        json: async () => body,
    } as unknown as Response;
}

/** A non-2xx response whose body throws if read — proves the caller never reads it. */
function poisonedResponse(status: number): Response {
    return {
        status,
        ok: false,
        json: async () => {
            throw new Error("body must not be read after a rejected payment");
        },
    } as unknown as Response;
}

interface FetchCall {
    url: URL;
    init?: RequestInit;
}

/** First call returns the 402 offer; the second (retry) returns `second`. */
function scriptedFetch(second: Response | (() => Response), firstBody: unknown = paymentRequired()) {
    const calls: FetchCall[] = [];
    const impl = (async (url: URL, init?: RequestInit) => {
        calls.push({url, init});
        if (calls.length === 1) return jsonResponse(402, firstBody);
        return typeof second === "function" ? second() : second;
    }) as unknown as typeof fetch;
    return {impl, calls};
}

function baseConfig(fetchImpl: typeof fetch, provider: DelegatedLeafProvider = okProvider) {
    return {
        provider,
        delegationManager: MANAGER,
        trustedFacilitators: [FACILITATOR],
        fetchImpl,
        timeoutMs: 2_000,
    };
}

describe("D5 payForDelegatedResource", () => {
    test("happy path: 402 → sign → retry with X-PAYMENT → resource + tx", async () => {
        const {impl, calls} = scriptedFetch(
            jsonResponse(200, {
                invoice: "inv-001",
                deliverable: "logo-final.svg",
                receipt: {transaction: TX, payer: DELEGATOR},
            }),
        );
        const result = await payForDelegatedResource(target, baseConfig(impl));

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("unreachable");
        expect(result.transaction).toBe(TX);
        expect(result.amount).toBe("1000000");
        expect(getAddress(result.payTo)).toBe(PAYEE);

        // The retry — and only the retry — carries the bearer X-PAYMENT header.
        expect(calls).toHaveLength(2);
        expect((calls[0]?.init?.headers as Record<string, string> | undefined)?.["X-PAYMENT"]).toBeUndefined();
        expect((calls[1]?.init?.headers as Record<string, string>)["X-PAYMENT"]).toBeTypeOf("string");
    });

    test("no retry when the seller advertises no trusted facilitator", async () => {
        const {impl, calls} = scriptedFetch(jsonResponse(200, {}), paymentRequired([UNTRUSTED]));
        const result = await payForDelegatedResource(target, baseConfig(impl));

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.code).toBe("FACILITATOR_UNTRUSTED");
        expect(calls).toHaveLength(1); // never signed, never retried
    });

    test("a seller echoing the permission context cannot get it into the result", async () => {
        const {impl} = scriptedFetch(
            jsonResponse(200, {invoice: "inv-001", nested: {echo: PERMISSION_CONTEXT}}),
        );
        const result = await payForDelegatedResource(target, baseConfig(impl));

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("unreachable");
        // The resource still comes back — the caller paid for it — but the bearer
        // authorization must not ride along into tool output or a transcript.
        const serialized = JSON.stringify(result.resource);
        expect(serialized).toContain("inv-001");
        expect(serialized).not.toContain(PERMISSION_CONTEXT);
    });

    test("a malformed facilitator list is a reason, not a thrown TypeError", async () => {
        const body = paymentRequired();
        // A hostile seller sends a bare string where the list belongs. Before this
        // was validated, `.some` threw straight out of a function whose contract is
        // to return a cause rather than die.
        (body.accepts[0] as unknown as {extra: Record<string, unknown>}).extra.facilitatorAddresses =
            FACILITATOR;
        const {impl, calls} = scriptedFetch(jsonResponse(200, {}), body);
        const result = await payForDelegatedResource(target, baseConfig(impl));

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.code).toBe("SELLER_OFFER_INVALID");
        expect(calls).toHaveLength(1); // never signed, never retried
    });

    test("rejected payment reports status without reading the reflected body", async () => {
        const {impl} = scriptedFetch(poisonedResponse(403));
        const result = await payForDelegatedResource(target, baseConfig(impl));

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.code).toBe("PAYMENT_REJECTED");
        expect(result.status).toBe(403);
    });

    test("a non-402 first response is not a payment flow", async () => {
        const impl = (async () => jsonResponse(200, {open: true})) as unknown as typeof fetch;
        const result = await payForDelegatedResource(target, baseConfig(impl));

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.code).toBe("NOT_PAYMENT_REQUIRED");
        expect(result.status).toBe(200);
    });

    test("a provider that returns the wrong DelegationManager is rejected before retry", async () => {
        const wrongProvider: DelegatedLeafProvider = async () => ({
            delegationManager: OTHER_MANAGER,
            permissionContext: PERMISSION_CONTEXT,
            delegator: DELEGATOR,
        });
        const {impl, calls} = scriptedFetch(jsonResponse(200, {}));
        const result = await payForDelegatedResource(target, baseConfig(impl, wrongProvider));

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.code).toBe("MANAGER_MISMATCH");
        expect(calls).toHaveLength(1); // rejected after signing, before paying
    });

    test("an over-cap payment is refused before a leaf is ever signed", async () => {
        let signed = 0;
        const countingProvider: DelegatedLeafProvider = async (...args) => {
            signed += 1;
            return okProvider(...args);
        };
        const {impl, calls} = scriptedFetch(jsonResponse(200, {}));
        const result = await payForDelegatedResource(target, {
            ...baseConfig(impl, countingProvider),
            preflight: async (amount) => ({
                ok: false,
                code: "LIMIT_EXCEEDED",
                detail: `payment of ${amount} exceeds 500000 left in this period`,
            }),
        });

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.code).toBe("LIMIT_EXCEEDED");
        expect(result.detail).toContain("exceeds");
        // No bearer authorization is minted for a payment that cannot settle.
        expect(signed).toBe(0);
        expect(calls).toHaveLength(1);
    });

    test("a revoked permission is named as inactive, not as a seller rejection", async () => {
        const {impl, calls} = scriptedFetch(jsonResponse(200, {}));
        const result = await payForDelegatedResource(target, {
            ...baseConfig(impl),
            preflight: async () => ({
                ok: false,
                code: "PERMISSION_INACTIVE",
                detail: "permission was revoked",
            }),
        });

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.code).toBe("PERMISSION_INACTIVE");
        expect(calls).toHaveLength(1);
    });

    test("a passing preflight leaves the happy path untouched", async () => {
        const {impl, calls} = scriptedFetch(
            jsonResponse(200, {receipt: {transaction: TX}}),
        );
        const seen: bigint[] = [];
        const result = await payForDelegatedResource(target, {
            ...baseConfig(impl),
            preflight: async (amount) => {
                seen.push(amount);
                return {ok: true};
            },
        });

        expect(result.ok).toBe(true);
        expect(seen).toEqual([1_000_000n]); // the amount actually being paid
        expect(calls).toHaveLength(2);
    });

    test("a preflight that cannot read the chain is a transport fault, not a limit", async () => {
        const {impl} = scriptedFetch(jsonResponse(200, {}));
        const result = await payForDelegatedResource(target, {
            ...baseConfig(impl),
            preflight: async () => {
                throw new Error("rpc unreachable");
            },
        });

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.code).toBe("TRANSPORT_ERROR");
        expect(result.detail).toContain("preflight");
    });

    test("a provider that cannot sign is reported as signing, not transport", async () => {
        // What a revoked or expired parent permission looks like to the agent.
        const revokedParent: DelegatedLeafProvider = async () => {
            throw new Error("delegation is disabled");
        };
        const {impl, calls} = scriptedFetch(jsonResponse(200, {}));
        const result = await payForDelegatedResource(target, baseConfig(impl, revokedParent));

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.code).toBe("SIGNING_FAILED");
        expect(result.detail).toContain("disabled");
        expect(calls).toHaveLength(1); // never paid
    });

    test("a transport failure surfaces as a reason, not a throw", async () => {
        const impl = (async () => {
            throw new Error("connection refused");
        }) as unknown as typeof fetch;
        const result = await payForDelegatedResource(target, baseConfig(impl));

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.code).toBe("TRANSPORT_ERROR");
        expect(result.detail).toContain("connection refused");
    });
});
