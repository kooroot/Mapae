import {describe, expect, test} from "bun:test";
import {getAddress, type Address, type Hex} from "viem";
import {
    GIWA_SEPOLIA_CAIP2,
    buildErc7710PaymentRequirements,
    buildErc7710SupportedPayload,
    encodePaymentRequiredHeader,
    type Erc7710PaymentRequirements,
    type PaymentRequired,
} from "@mapae/shared";
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

function jsonResponse(
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
): Response {
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: new Headers(headers),
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
function scriptedFetch(
    second: Response | (() => Response),
    firstBody: unknown = paymentRequired(),
    firstHeaders: Record<string, string> = {},
) {
    const calls: FetchCall[] = [];
    const impl = (async (url: URL, init?: RequestInit) => {
        calls.push({url, init});
        if (calls.length === 1) return jsonResponse(402, firstBody, firstHeaders);
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

    test("accepts an offer whose extra is copied verbatim from /supported kinds[].extra", async () => {
        // A third-party resource server does not invent `facilitatorAddresses` — it
        // copies the facilitator's advertised kinds[].extra into its offer (the
        // supportedKind flow in @x402/core and @metamask/x402). While /supported
        // advertised only assetTransferMethod there, every such offer died here as
        // FACILITATOR_UNTRUSTED even though the facilitator was fully trusted.
        const supported = buildErc7710SupportedPayload({facilitatorAddresses: [FACILITATOR]});
        const offer = {
            ...buildErc7710PaymentRequirements({payTo: PAYEE, amount: 1_000_000n}),
            extra: supported.kinds[0]!.extra,
        };
        const body = {
            x402Version: 2,
            resource: {url: target.toString(), description: "test", mimeType: "application/json"},
            accepts: [offer],
        };
        const {impl, calls} = scriptedFetch(jsonResponse(200, {invoice: "inv-001"}), body);
        const result = await payForDelegatedResource(target, {
            ...baseConfig(impl),
            trustedFacilitators: supported.signers[GIWA_SEPOLIA_CAIP2] ?? [],
        });

        expect(result.ok).toBe(true);
        expect(calls).toHaveLength(2); // trusted → signed → retried
    });

    test("reads the offer from the Payment-Required header when the 402 body is unusable", async () => {
        // v2 transport: the offer rides in a base64 header and the body may be empty.
        // The body here is `null` — if the client were still reading the body, this
        // would fail as SELLER_OFFER_INVALID ("402 body is not an object").
        const header = encodePaymentRequiredHeader(
            paymentRequired() as PaymentRequired<Erc7710PaymentRequirements>,
        );
        const {impl, calls} = scriptedFetch(
            jsonResponse(200, {invoice: "inv-001"}),
            null,
            {"Payment-Required": header},
        );
        const result = await payForDelegatedResource(target, baseConfig(impl));

        expect(result.ok).toBe(true);
        expect(calls).toHaveLength(2);
    });

    test("a header-transported offer is paid with Payment-Signature alone", async () => {
        // Negotiated, not dual-sent, exactly like the reference client. An ERC-7710
        // payload carries a full permission context, and the same value under two
        // header names crossed the HTTP server's total-header limit — the seller
        // answered 431 before the handler's own size check ever ran (measured on the
        // fork e2e). The 402's own transport is the negotiation signal.
        const header = encodePaymentRequiredHeader(
            paymentRequired() as PaymentRequired<Erc7710PaymentRequirements>,
        );
        const {impl, calls} = scriptedFetch(
            jsonResponse(200, {invoice: "inv-001"}),
            null,
            {"Payment-Required": header},
        );
        const result = await payForDelegatedResource(target, baseConfig(impl));

        expect(result.ok).toBe(true);
        const headers = calls[1]?.init?.headers as Record<string, string>;
        expect(headers["Payment-Signature"]).toBeTypeOf("string");
        expect(headers["X-PAYMENT"]).toBeUndefined();
    });

    test("a body-transported offer is paid with X-PAYMENT alone", async () => {
        // The already-deployed v1-transport seller answers with a body-only 402 and
        // reads only X-PAYMENT; sending it the v2 name would waste the same header
        // budget the test above protects.
        const {impl, calls} = scriptedFetch(jsonResponse(200, {invoice: "inv-001"}));
        const result = await payForDelegatedResource(target, baseConfig(impl));

        expect(result.ok).toBe(true);
        const headers = calls[1]?.init?.headers as Record<string, string>;
        expect(headers["X-PAYMENT"]).toBeTypeOf("string");
        expect(headers["Payment-Signature"]).toBeUndefined();
    });

    test("falls back to the 402 JSON body when the Payment-Required header is malformed", async () => {
        // Mirrors the reference client: a present-but-unusable v2 header downgrades to
        // the v1-transport body instead of failing a payment the body can still carry.
        const {impl, calls} = scriptedFetch(
            jsonResponse(200, {invoice: "inv-001"}),
            paymentRequired(),
            {"Payment-Required": "!!!not-base64!!!"},
        );
        const result = await payForDelegatedResource(target, baseConfig(impl));

        expect(result.ok).toBe(true);
        expect(calls).toHaveLength(2);
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

/**
 * D5's second completion criterion, taken literally: "실패 시 조용히 죽지 말고 이유 반환".
 *
 * Every case below threw an unstructured exception out of `payForDelegatedResource`
 * before these guards existed — verified by running the real function against these exact
 * responses. A thrown DOMException or TypeError is not a reason: it names no field, no
 * seller, and nothing the caller can act on, and for one of them it arrives *after* the
 * leaf delegation has been signed.
 */
describe("D5 every failure returns a reason, never a throw", () => {
    async function codeFor(firstBody: unknown, provider = okProvider): Promise<string> {
        const {impl} = scriptedFetch(jsonResponse(200, {ok: true}), firstBody);
        const result = await payForDelegatedResource(target, baseConfig(impl, provider));
        if (result.ok) return "ok";
        return result.code;
    }

    test("a 402 body of literal null is answered, not raised", async () => {
        // `null` is valid JSON so the parse succeeds, and `typeof null === "object"` so a
        // plain typeof guard would pass it through to `body.x402Version` — which threw
        // TypeError out of a function whose entire contract is to return a reason.
        expect(await codeFor(null)).toBe("SELLER_OFFER_INVALID");
    });

    test("a non-object 402 body is answered", async () => {
        for (const body of [7, "text", true]) {
            expect(await codeFor(body)).toBe("SELLER_OFFER_INVALID");
        }
    });

    test("an array 402 body is answered", async () => {
        // Arrays are objects, so this one reaches the version check and is caught there.
        expect(await codeFor([])).toBe("UNSUPPORTED_X402_VERSION");
    });

    test("a wrong x402 version is answered — the code exists and is reachable", async () => {
        // v1 is the version most guides describe, so this is the likeliest real mismatch.
        expect(await codeFor({...paymentRequired(), x402Version: 1})).toBe(
            "UNSUPPORTED_X402_VERSION",
        );
    });

    /**
     * The sharpest of the group.
     *
     * `X-PAYMENT` is base64 via `btoa`, which is Latin-1 only, and the header echoes the
     * seller's whole requirements object — including fields the agent never reads. One
     * character above U+00FF and the encode throws. That encode happens *after* the leaf
     * is signed, so the failure used to leave a bearer authorization in existence and hand
     * the caller a DOMException naming no field at all.
     *
     * It is one refactor away from firing in this very repo: the seller's own descriptions
     * contain an em dash and today sit at the 402 top level. Moving them into `accepts[0]`
     * — the v1-shaped layout CLAUDE.md flags as the most common trap — would kill every
     * payment.
     */
    describe("an offer that cannot be header-encoded is refused before signing", () => {
        for (const [label, note] of [
            ["Hangul", "한글 메모"],
            ["em dash", "invoice — one"],
            ["emoji (astral, surrogate pair)", "paid 🎉"],
            ["a single U+0100", "Ā"],
        ] as const) {
            test(label, async () => {
                const offer = paymentRequired();
                // A field the agent never reads: the point is that *any* byte in the
                // object reaches btoa, not just the ones that are validated.
                (offer.accepts[0] as unknown as {extra: Record<string, unknown>}).extra.note = note;
                expect(await codeFor(offer)).toBe("SELLER_OFFER_INVALID");
            });
        }

        test("U+00FF itself is still accepted — the boundary is not off by one", async () => {
            const offer = paymentRequired();
            (offer.accepts[0] as unknown as {extra: Record<string, unknown>}).extra.note = "ÿ";
            expect(await codeFor(offer)).toBe("ok");
        });

        test("the refusal happens before the provider is ever asked to sign", async () => {
            // This is the property that matters. A guard at the encoder would also stop
            // the throw, but only a guard here stops a bearer authorization from existing
            // for a payment that can never be sent.
            let signed = 0;
            const counting: DelegatedLeafProvider = async () => {
                signed += 1;
                return {
                    delegationManager: MANAGER,
                    permissionContext: PERMISSION_CONTEXT,
                    delegator: DELEGATOR,
                };
            };
            const offer = paymentRequired();
            (offer.accepts[0] as unknown as {extra: Record<string, unknown>}).extra.note = "한";
            expect(await codeFor(offer, counting)).toBe("SELLER_OFFER_INVALID");
            expect(signed).toBe(0);
        });
    });

    test("a provider returning a malformed address is reported, not raised", async () => {
        // `getAddress` throws on anything that is not an address, so it fired before the
        // MANAGER_MISMATCH check could describe the problem.
        const malformed: DelegatedLeafProvider = async () =>
            ({
                delegationManager: "not-an-address",
                permissionContext: PERMISSION_CONTEXT,
                delegator: DELEGATOR,
            }) as never;
        expect(await codeFor(paymentRequired(), malformed)).toBe("MANAGER_MISMATCH");
    });

    test("a provider returning a malformed delegator is reported too", async () => {
        const malformed: DelegatedLeafProvider = async () =>
            ({
                delegationManager: MANAGER,
                permissionContext: PERMISSION_CONTEXT,
                delegator: "0xnope",
            }) as never;
        expect(await codeFor(paymentRequired(), malformed)).toBe("MANAGER_MISMATCH");
    });

    test("MALFORMED_RESOURCE is reachable — a paid resource that is not JSON", async () => {
        // The payment succeeded here, so this is the one failure that arrives after money
        // moved. It must still be a code rather than a throw.
        const {impl} = scriptedFetch({
            status: 200,
            ok: true,
            json: async () => {
                throw new Error("not JSON");
            },
        } as unknown as Response);
        const result = await payForDelegatedResource(target, baseConfig(impl));
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.code).toBe("MALFORMED_RESOURCE");
    });
});

/**
 * "Rejected" and "not known to have succeeded" are different claims.
 *
 * This distinction was missing and it cost a real payment's answer. On GIWA the transfer
 * settled (`0x533c5cb2…9964c`, block 31634935, payer −1.00 mUSDC) while the caller was
 * told `PAYMENT_REJECTED`. The seller had reported the ambiguity correctly — 504
 * `settlement_unknown`, with a comment saying exactly why — and this function flattened
 * every non-2xx into one code on the way back.
 *
 * The two demand opposite responses: a rejection invites a retry, and retrying this one
 * can pay twice.
 */
describe("D5 settlement-unknown is not a rejection", () => {
    async function resultFor(second: Response) {
        const {impl} = scriptedFetch(second);
        return payForDelegatedResource(target, baseConfig(impl));
    }

    test("504 from the seller is SETTLEMENT_UNKNOWN, not PAYMENT_REJECTED", async () => {
        // 504 is exactly what apps/delegated-seller returns when its facilitator call
        // does not answer — the case where the money may already have moved.
        const result = await resultFor(poisonedResponse(504));
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.code).toBe("SETTLEMENT_UNKNOWN");
        expect(result.status).toBe(504);
        // The caller has to be told the payer may be charged, not just given a code.
        expect(result.detail).toContain("may already be charged");
    });

    test("gateway timeouts and origin-death codes are treated the same way", async () => {
        // 502/520/521/522/523/524 are what a reverse proxy (the deployed seller sits
        // behind a Cloudflare Tunnel) answers when the origin dies mid-exchange. This
        // status is only reached on the retry — the payment header is already on the
        // wire — so the money may have moved and a retry could pay twice.
        for (const status of [408, 425, 502, 520, 521, 522, 523, 524]) {
            const result = await resultFor(poisonedResponse(status));
            expect(result.ok === false && result.code).toBe("SETTLEMENT_UNKNOWN");
        }
    });

    test("a genuine refusal is still PAYMENT_REJECTED", async () => {
        // 403 delegation_rejected and 422 settlement_failed both mean the payment did not
        // go through. Widening the unknown set to cover these would make every refusal
        // look like a possible charge, which is its own way of being useless. 503 is the
        // seller's verify-unavailable rung: nothing is charged at /verify, so a retry is
        // safe and this stays a rejection, not an unknown.
        for (const status of [402, 403, 422, 400, 500, 503]) {
            const result = await resultFor(poisonedResponse(status));
            expect(result.ok === false && result.code).toBe("PAYMENT_REJECTED");
        }
    });

    test("the seller's body is still never read on an unknown outcome", async () => {
        // `poisonedResponse` throws if the body is touched. The bearer-reflection rule
        // does not relax just because the status changed class.
        const result = await resultFor(poisonedResponse(504));
        expect(result.ok).toBe(false);
    });

    test("a dead connection after the header is sent is SETTLEMENT_UNKNOWN", async () => {
        // Measured: Bun's fetch does not retry, so this surfaces as a thrown socket
        // error. Reporting TRANSPORT_ERROR would read as "the request never landed" —
        // the belief that makes a caller re-send a payment that already settled.
        let call = 0;
        const impl = (async (url: URL, init?: RequestInit) => {
            call += 1;
            if (call === 1) return jsonResponse(402, paymentRequired());
            throw new Error("The socket connection was closed unexpectedly");
        }) as unknown as typeof fetch;

        const result = await payForDelegatedResource(target, baseConfig(impl));
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.code).toBe("SETTLEMENT_UNKNOWN");
        expect(result.detail).toContain("after the payment was sent");
    });

    test("the same failure before the header is sent is still TRANSPORT_ERROR", async () => {
        // The header is the whole difference. Collapsing both into SETTLEMENT_UNKNOWN
        // would make an unreachable seller look like a possible charge.
        const impl = (async () => {
            throw new Error("connection refused");
        }) as unknown as typeof fetch;

        const result = await payForDelegatedResource(target, baseConfig(impl));
        expect(result.ok === false && result.code).toBe("TRANSPORT_ERROR");
    });
});

describe("offer-advertised DelegationManager", () => {
    const offerWith = (manager: string) => ({
        x402Version: 2,
        resource: {url: target.toString(), description: "test", mimeType: "application/json"},
        accepts: [
            {
                ...buildErc7710PaymentRequirements({
                    payTo: PAYEE,
                    amount: 1_000_000n,
                    facilitatorAddresses: [FACILITATOR],
                }),
                extra: {
                    assetTransferMethod: "erc7710",
                    facilitatorAddresses: [FACILITATOR],
                    delegationManager: manager,
                },
            },
        ],
    });

    test("an offer advertising the verified manager is paid", async () => {
        const {impl, calls} = scriptedFetch(jsonResponse(200, {invoice: "inv-001"}), offerWith(MANAGER));
        const result = await payForDelegatedResource(target, baseConfig(impl));

        expect(result.ok).toBe(true);
        expect(calls).toHaveLength(2);
    });

    test("an offer advertising a different manager is refused before signing", async () => {
        // The advertised manager is advisory for third parties, but when it is present
        // and disagrees with the deployment this agent verified, signing a leaf would
        // mint a bearer authorization the facilitator must reject anyway. Refuse first,
        // and with the code that names the actual fault line.
        const {impl, calls} = scriptedFetch(jsonResponse(200, {}), offerWith(OTHER_MANAGER));
        const result = await payForDelegatedResource(target, baseConfig(impl));

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.code).toBe("MANAGER_MISMATCH");
        expect(calls).toHaveLength(1); // never signed, never retried
    });

    test("a malformed advertised manager is a seller offer fault", async () => {
        const {impl, calls} = scriptedFetch(jsonResponse(200, {}), offerWith("not-an-address"));
        const result = await payForDelegatedResource(target, baseConfig(impl));

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.code).toBe("SELLER_OFFER_INVALID");
        expect(calls).toHaveLength(1);
    });
});
