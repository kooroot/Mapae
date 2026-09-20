import {describe, expect, test} from "bun:test";
import {getAddress, type Address, type Hex} from "viem";
import {
    GIWA_SEPOLIA_CAIP2,
    buildErc7710PaymentRequirements,
    buildErc7710SupportedPayload,
    buildPaymentRequirements,
    decodePaymentHeader,
    encodePaymentRequiredHeader,
    encodePaymentResponseHeader,
    type Erc7710PaymentRequirements,
    type PaymentRequired,
    type SettleResponse,
} from "@mapae/shared";
import {
    BEARER_REDACTION,
    payForDelegatedResource,
    type DelegatedLeafProvider,
} from "./payment-client.js";

const MANAGER = getAddress("0x4000000000000000000000000000000000000001");
const OTHER_MANAGER = getAddress("0x4000000000000000000000000000000000000002");
const FACILITATOR = getAddress("0x3000000000000000000000000000000000000001");
const UNTRUSTED = getAddress("0x3000000000000000000000000000000000000009");
const PAYEE = getAddress("0x2000000000000000000000000000000000000001");
const DELEGATOR = getAddress("0x5000000000000000000000000000000000000001");
const PERMISSION_CONTEXT = `0x${"ab".repeat(64)}` as Hex;
const TX = `0x${"cd".repeat(32)}` as Hex;

const target = new URL("http://127.0.0.1:3001/s/demo-cafe/americano");

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
        headers: new Headers({"content-type": "application/json", ...headers}),
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

/** A 2xx whose body is not JSON — what a seller of text, markdown or HTML serves. */
function textResponse(body: string, contentType: string, headers: Record<string, string> = {}): Response {
    return {
        status: 200,
        ok: true,
        headers: new Headers({"content-type": contentType, ...headers}),
        json: async () => {
            throw new Error("json() must not be called on a non-JSON resource");
        },
        text: async () => body,
    } as unknown as Response;
}

function receiptHeader(receipt: unknown): Record<string, string> {
    return {"Payment-Response": encodePaymentResponseHeader(receipt as SettleResponse)};
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
    test("happy path: 402 → sign → retry with Payment-Signature → resource + tx", async () => {
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

        // The retry — and only the retry — carries the bearer Payment-Signature header.
        expect(calls).toHaveLength(2);
        expect((calls[0]?.init?.headers as Record<string, string> | undefined)?.["Payment-Signature"]).toBeUndefined();
        expect((calls[1]?.init?.headers as Record<string, string>)["Payment-Signature"]).toBeTypeOf("string");
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

    test("Payment-Signature is the one submission header, whichever way the offer arrived", async () => {
        // Never a second name beside it: an ERC-7710 payload carries a full permission
        // context, and the same value under two header names crossed the HTTP server's
        // total-header limit — the seller answered 431 before the handler's own size
        // check ever ran (measured on the fork e2e). And no v1 alias: the v1 transport
        // cannot carry an ERC-7710 offer, so a seller reading only `X-PAYMENT` has
        // nothing this agent could pay for.
        const header = encodePaymentRequiredHeader(
            paymentRequired() as PaymentRequired<Erc7710PaymentRequirements>,
        );
        for (const [firstBody, firstHeaders] of [
            [null, {"Payment-Required": header}],
            [paymentRequired(), {}],
        ] as const) {
            const {impl, calls} = scriptedFetch(
                jsonResponse(200, {invoice: "inv-001"}),
                firstBody,
                firstHeaders,
            );
            const result = await payForDelegatedResource(target, baseConfig(impl));

            expect(result.ok).toBe(true);
            const headers = calls[1]?.init?.headers as Record<string, string>;
            expect(Object.keys(headers)).toEqual(["Payment-Signature"]);
            expect(decodePaymentHeader(headers["Payment-Signature"]!).payload).toEqual({
                delegationManager: MANAGER,
                permissionContext: PERMISSION_CONTEXT,
                delegator: DELEGATOR,
            });
        }
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

    test("a case-flipped or 0x-stripped echo of the permission context is still redacted", async () => {
        // EVM hex has no canonical case, so a seller re-emitting the same bytes uppercased
        // or without the 0x prefix is echoing the identical bearer authorization. An exact
        // substring match would miss it; the redaction must be case-insensitive.
        const upper = `0x${"AB".repeat(64)}`;
        const stripped = "ab".repeat(64);
        const {impl} = scriptedFetch(
            jsonResponse(200, {invoice: "inv-001", a: upper, b: stripped}),
        );
        const result = await payForDelegatedResource(target, baseConfig(impl));
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("unreachable");
        const serialized = JSON.stringify(result.resource).toLowerCase();
        expect(serialized).not.toContain("ab".repeat(64));
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
 * responses. A thrown TypeError is not a reason: it names no field, no seller, and
 * nothing the caller can act on.
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

    test("an offer paying the zero address is refused before signing", async () => {
        // A leaf for transfer(0x0, amount) is an unsettleable bearer authorization no
        // enforcer refuses; the ERC-7710 path must reject it like the v1 agent does.
        let signed = 0;
        const counting: DelegatedLeafProvider = async () => {
            signed += 1;
            return {delegationManager: MANAGER, permissionContext: PERMISSION_CONTEXT, delegator: DELEGATOR};
        };
        const offer = paymentRequired();
        (offer.accepts[0] as {payTo: string}).payTo =
            "0x0000000000000000000000000000000000000000";
        expect(await codeFor(offer, counting)).toBe("SELLER_OFFER_INVALID");
        expect(signed).toBe(0);
    });

    test("a bad-asset refusal does not echo the raw seller value into the reason", async () => {
        const {impl} = scriptedFetch(jsonResponse(200, {ok: true}), (() => {
            const offer = paymentRequired();
            (offer.accepts[0] as {asset: string}).asset = "0xdeadBEEFdeadbeefdeadbeefdeadbeefdeadbeef";
            return offer;
        })());
        const result = await payForDelegatedResource(target, baseConfig(impl));
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        // Either a checksummed form or a generic phrase — never the raw lowercase input.
        expect(result.detail).not.toContain("0xdeadBEEFdeadbeef");
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

    test("an offer carrying non-Latin-1 text is paid, and the header echoes it back intact", async () => {
        // The header echoes the seller's whole requirements object, fields the agent
        // never reads included. Under the Latin-1 `btoa` codec a Korean note here threw
        // *after* the leaf was signed, so the agent refused such offers up front; the
        // UTF-8 codec the reference implementation uses carries them, and the echoed
        // `accepted` block the facilitator compares against the seller's offer must
        // come back byte for byte — a corrupted note is a mismatched offer.
        for (const note of ["한글 메모", "invoice — one", "paid 🎉", "Ā"]) {
            const offer = paymentRequired();
            (offer.accepts[0] as unknown as {extra: Record<string, unknown>}).extra.note = note;
            const {impl, calls} = scriptedFetch(jsonResponse(200, {ok: true}), offer);
            const result = await payForDelegatedResource(target, baseConfig(impl));

            expect(result.ok, note).toBe(true);
            const header = (calls[1]?.init?.headers as Record<string, string>)["Payment-Signature"]!;
            expect(decodePaymentHeader(header).accepted.extra, note).toEqual(offer.accepts[0]!.extra);
        }
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

    test("MALFORMED_RESOURCE is reachable — a resource labelled JSON that is not JSON", async () => {
        // The payment succeeded here, so this is the one failure that arrives after money
        // moved. It must still be a code rather than a throw.
        const {impl} = scriptedFetch({
            status: 200,
            ok: true,
            headers: new Headers({"content-type": "application/json"}),
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
 * The spec's selection rule: the client picks, from `accepts`, the requirements it
 * supports. A seller that lists EIP-3009 first for wallets and ERC-7710 second for
 * delegated agents must lose neither payer, and a list with several ERC-7710 entries
 * must be walked past the ones this agent cannot use.
 */
describe("D5 the whole accepts list is considered", () => {
    const eip3009 = () => buildPaymentRequirements({payTo: PAYEE, amount: 1_000_000n});
    const erc7710 = (facilitators: Address[] = [FACILITATOR]) =>
        buildErc7710PaymentRequirements({payTo: PAYEE, amount: 2_000_000n, facilitatorAddresses: facilitators});
    const offerOf = (...accepts: unknown[]) => ({
        x402Version: 2,
        resource: {url: target.toString(), description: "test", mimeType: "application/json"},
        accepts,
    });

    test("an ERC-7710 entry behind an EIP-3009 one is the one paid", async () => {
        const {impl, calls} = scriptedFetch(jsonResponse(200, {invoice: "inv-001"}), offerOf(eip3009(), erc7710()));
        const result = await payForDelegatedResource(target, baseConfig(impl));

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("unreachable");
        expect(result.amount).toBe("2000000"); // the ERC-7710 entry's price, not accepts[0]'s
        const header = (calls[1]?.init?.headers as Record<string, string>)["Payment-Signature"]!;
        expect(decodePaymentHeader(header).accepted).toEqual(erc7710());
    });

    test("no ERC-7710 entry at all is SELLER_OFFER_INVALID, counted", async () => {
        const {impl, calls} = scriptedFetch(jsonResponse(200, {}), offerOf(eip3009(), eip3009()));
        const result = await payForDelegatedResource(target, baseConfig(impl));

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.code).toBe("SELLER_OFFER_INVALID");
        expect(result.detail).toBe("no exact ERC-7710 offer on GIWA among 2 accepts");
        expect(calls).toHaveLength(1);
    });

    test("an empty or missing accepts list is SELLER_OFFER_INVALID", async () => {
        for (const accepts of [[], undefined, "accepts"]) {
            const {impl} = scriptedFetch(jsonResponse(200, {}), {...offerOf(), accepts});
            const result = await payForDelegatedResource(target, baseConfig(impl));
            expect(result.ok).toBe(false);
            if (result.ok) throw new Error("unreachable");
            expect(result.code).toBe("SELLER_OFFER_INVALID");
            expect(result.detail).toBe("402 body has no accepts");
        }
    });

    test("an ERC-7710 entry through an untrusted facilitator is passed over for a trusted one", async () => {
        const {impl, calls} = scriptedFetch(
            jsonResponse(200, {invoice: "inv-001"}),
            offerOf(erc7710([UNTRUSTED]), erc7710([FACILITATOR])),
        );
        const result = await payForDelegatedResource(target, baseConfig(impl));

        expect(result.ok).toBe(true);
        expect(calls).toHaveLength(2);
        const header = (calls[1]?.init?.headers as Record<string, string>)["Payment-Signature"]!;
        expect(decodePaymentHeader(header).accepted).toEqual(erc7710([FACILITATOR]));
    });

    test("only untrusted ERC-7710 entries is FACILITATOR_UNTRUSTED — the rail's fault, not a missing rail", async () => {
        // The first candidate on the ERC-7710 rail names the actionable reason. Reporting
        // SELLER_OFFER_INVALID here would send an operator to look for a missing offer
        // when the offer is there and its facilitator is the problem.
        const {impl, calls} = scriptedFetch(
            jsonResponse(200, {}),
            offerOf(eip3009(), erc7710([UNTRUSTED]), erc7710([UNTRUSTED])),
        );
        const result = await payForDelegatedResource(target, baseConfig(impl));

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.code).toBe("FACILITATOR_UNTRUSTED");
        expect(calls).toHaveLength(1);
    });
});

/**
 * The 2xx receipt. The spec's `Payment-Response` header is the interoperable place a
 * settlement hash lives; the body's `receipt.transaction` is what this repo's hosted
 * shop and payment scheduler have relied on. The header wins when it is a receipt of
 * this payment, and the body stays as the fallback — never a failure, because a 2xx
 * means the resource was paid for and delivered.
 */
describe("D5 Payment-Response receipt", () => {
    const OTHER_TX = `0x${"ef".repeat(32)}` as Hex;
    const settled = (patch: Record<string, unknown> = {}) => ({
        success: true,
        network: GIWA_SEPOLIA_CAIP2,
        payer: DELEGATOR,
        transaction: TX,
        ...patch,
    });

    test("a valid header names the transaction, ahead of the body", async () => {
        const {impl} = scriptedFetch(
            jsonResponse(200, {receipt: {transaction: OTHER_TX}}, receiptHeader(settled())),
        );
        const result = await payForDelegatedResource(target, baseConfig(impl));

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("unreachable");
        expect(result.transaction).toBe(TX);
    });

    test("a header naming another payer is ignored and the body fallback is used", async () => {
        // A 2xx with a receipt that is not this payment's is the seller contradicting
        // itself. The resource was still delivered and paid for, so it is returned, and
        // the diagnostic header is simply not believed.
        const {impl} = scriptedFetch(
            jsonResponse(200, {receipt: {transaction: OTHER_TX}}, receiptHeader(settled({payer: PAYEE}))),
        );
        const result = await payForDelegatedResource(target, baseConfig(impl));

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("unreachable");
        expect(result.transaction).toBe(OTHER_TX);
    });

    test("success false, another network, garbage, and a non-hash transaction are all ignored", async () => {
        for (const header of [
            receiptHeader(settled({success: false, errorReason: "settlement_pending"})),
            receiptHeader(settled({network: "eip155:8453"})),
            receiptHeader(settled({transaction: "not-a-hash"})),
            {"Payment-Response": "!!!not-base64!!!"},
            {"Payment-Response": btoa("null")},
        ]) {
            const {impl} = scriptedFetch(jsonResponse(200, {receipt: {transaction: OTHER_TX}}, header));
            const result = await payForDelegatedResource(target, baseConfig(impl));
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error("unreachable");
            expect(result.transaction).toBe(OTHER_TX);
            // Whatever the seller wrote in the header stays there.
            expect(JSON.stringify(result)).not.toContain("settlement_pending");
        }
    });

    test("a valid header with transaction \"\" means no hash — not the body's", async () => {
        // The spec makes `transaction` required and writes "" for "none". A receipt that
        // says so explicitly is believed over a body claiming otherwise.
        for (const transaction of ["", undefined]) {
            const {impl} = scriptedFetch(
                jsonResponse(200, {receipt: {transaction: OTHER_TX}}, receiptHeader(settled({transaction}))),
            );
            const result = await payForDelegatedResource(target, baseConfig(impl));
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error("unreachable");
            expect(result.transaction).toBeUndefined();
        }
    });

    test("a header carrying UTF-8 text still decodes", async () => {
        // The reference codec is base64 over UTF-8 bytes; a receipt with a non-ASCII
        // field must not be dropped by a Latin-1 decoder.
        const {impl} = scriptedFetch(
            jsonResponse(200, {}, receiptHeader(settled({note: "정산 완료 — 🎉"}))),
        );
        const result = await payForDelegatedResource(target, baseConfig(impl));

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("unreachable");
        expect(result.transaction).toBe(TX);
    });
});

describe("D5 non-JSON resources", () => {
    test("a text/plain resource is returned as text, with its media type and no parameters", async () => {
        const {impl} = scriptedFetch(textResponse("Your report.\n", "text/plain; charset=utf-8"));
        const result = await payForDelegatedResource(target, baseConfig(impl));

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("unreachable");
        expect(result.resource).toBe("Your report.\n");
        expect(result.contentType).toBe("text/plain");
    });

    test("a bearer value echoed inside a text resource is redacted", async () => {
        const {impl} = scriptedFetch(
            textResponse(`thanks, your context was ${PERMISSION_CONTEXT}`, "text/markdown"),
        );
        const result = await payForDelegatedResource(target, baseConfig(impl));

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("unreachable");
        expect(typeof result.resource).toBe("string");
        expect(result.resource as string).not.toContain(PERMISSION_CONTEXT);
        expect(result.resource as string).toContain("thanks, your context was ");
    });

    test("a bearer value echoed in the content type never reaches the result", async () => {
        // The content type lands in MCP tool output like the body does, so it is held to
        // the same invariant: neither the permission context nor the signature comes back
        // from this function. A secret parked in a parameter goes with the parameters…
        const {impl} = scriptedFetch(
            jsonResponse(
                200,
                {invoice: "inv-001"},
                {"content-type": `application/json; note=${PERMISSION_CONTEXT}`},
            ),
        );
        const result = await payForDelegatedResource(target, baseConfig(impl));

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("unreachable");
        expect(result.contentType).toBe("application/json");
        expect(result.resource).toEqual({invoice: "inv-001"});
        expect(JSON.stringify(result)).not.toContain(PERMISSION_CONTEXT.slice(2));

        // …and a seller that makes the media type itself the signature it was just sent,
        // where there is no parameter to strip, meets the body's redaction.
        let attempts = 0;
        const reflecting = (async (_url: URL, init?: RequestInit) => {
            attempts += 1;
            if (attempts === 1) return jsonResponse(402, paymentRequired());
            const submitted = (init?.headers as Record<string, string>)["Payment-Signature"]!;
            return textResponse("Your report.\n", submitted);
        }) as unknown as typeof fetch;
        const reflected = await payForDelegatedResource(target, baseConfig(reflecting));

        expect(reflected.ok).toBe(true);
        if (!reflected.ok) throw new Error("unreachable");
        expect(reflected.contentType).toBe(BEARER_REDACTION);
        expect(reflected.resource).toBe("Your report.\n");
    });

    test("a +json media type is parsed like application/json; a JSON body without a JSON label is text", async () => {
        const parsed = await payForDelegatedResource(
            target,
            baseConfig(scriptedFetch(jsonResponse(200, {ticket: "T-1"}, {"content-type": "application/ticket+json"})).impl),
        );
        expect(parsed.ok && parsed.resource).toEqual({ticket: "T-1"});

        const unlabelled = await payForDelegatedResource(
            target,
            baseConfig(scriptedFetch(textResponse('{"ticket":"T-1"}', "text/html")).impl),
        );
        expect(unlabelled.ok && unlabelled.resource).toBe('{"ticket":"T-1"}');
    });

    test("a JSON resource still reports its content type", async () => {
        const {impl} = scriptedFetch(jsonResponse(200, {invoice: "inv-001"}));
        const result = await payForDelegatedResource(target, baseConfig(impl));

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("unreachable");
        expect(result.contentType).toBe("application/json");
        expect(result.resource).toEqual({invoice: "inv-001"});
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
        // look like a possible charge, which is its own way of being useless.
        for (const status of [402, 403, 422, 400, 500]) {
            const result = await resultFor(poisonedResponse(status));
            expect(result.ok === false && result.code).toBe("PAYMENT_REJECTED");
        }
    });

    test("a seller that could not take the payment is SELLER_UNAVAILABLE, not a refusal", async () => {
        // 503 is @mapae/seller's facilitator_unavailable rung — /supported or /verify out
        // of reach, or the facilitator refusing to look (rate limit, not ready) on either
        // call; 429 is the seller throttling. Nothing reached a verdict or a chain, so
        // the same offer is safe to retry, and PAYMENT_REJECTED would send the caller to
        // inspect a delegation nothing refused.
        for (const status of [503, 429]) {
            const result = await resultFor(poisonedResponse(status));
            expect(result.ok).toBe(false);
            if (result.ok) throw new Error("unreachable");
            expect(result.code).toBe("SELLER_UNAVAILABLE");
            expect(result.status).toBe(status);
            expect(result.detail).toContain("nothing charged");
            expect(result.detail).toContain("retry later");
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
