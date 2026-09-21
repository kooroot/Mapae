import {describe, expect, test} from "bun:test";
import {getAddress} from "viem";
import {
    PAYMENT_IDENTIFIER_EXTENSION,
    X402_VERSION,
    buildErc7710PaymentPayload,
    buildErc7710PaymentRequirements,
    buildErc7710SupportedPayload,
    buildPaymentIdentifierEcho,
    buildPaymentIdentifierOffer,
    decodePaymentHeader,
    decodePaymentRequiredHeader,
    decodePaymentResponseHeader,
    encodePaymentHeader,
    encodePaymentRequiredHeader,
    encodePaymentResponseHeader,
    readPaymentIdentifier,
    type PaymentRequired,
    type Erc7710PaymentRequirements,
} from "./x402.js";
import {GIWA_SEPOLIA_CAIP2} from "./chain.js";

const PAYEE = getAddress("0x2000000000000000000000000000000000000001");
const FACILITATOR = getAddress("0x3000000000000000000000000000000000000001");
const MANAGER = getAddress("0x4000000000000000000000000000000000000001");
const DELEGATOR = getAddress("0x5000000000000000000000000000000000000001");

describe("x402 v2 ERC-7710 wire types", () => {
    test("every offer declares the settle-then-serve flow, with or without the optional extras", () => {
        // 스펙 §6.1: 흐름이 authorization이 아니면 반드시 선언해야 한다. 선언이 없으면
        // 클라이언트는 기본값 authorization(선제공·후정산)을 가정하고, Mapae는 /verify와
        // /settle이 모두 성공한 뒤에 자원을 준다 — 다른 레일을 읽는 셈이 된다.
        expect(buildErc7710PaymentRequirements({payTo: PAYEE, amount: 1n}).extra).toEqual({
            assetTransferMethod: "erc7710",
            paymentFlow: "upfront",
        });
        expect(
            buildErc7710PaymentRequirements({
                payTo: PAYEE,
                amount: 1n,
                facilitatorAddresses: [FACILITATOR],
                delegationManager: MANAGER,
            }).extra.paymentFlow,
        ).toBe("upfront");
    });

    test("round-trips the opaque permission context without changing D2 codecs", () => {
        const accepted = buildErc7710PaymentRequirements({
            payTo: PAYEE,
            amount: 1_000_000n,
            facilitatorAddresses: [FACILITATOR],
        });
        const payload = buildErc7710PaymentPayload({
            accepted,
            delegationManager: MANAGER,
            permissionContext: "0x1234",
            delegator: DELEGATOR,
        });
        const decoded = decodePaymentHeader(encodePaymentHeader(payload));

        expect(decoded.x402Version).toBe(X402_VERSION);
        expect(decoded.accepted.extra).toEqual({
            assetTransferMethod: "erc7710",
            paymentFlow: "upfront",
            facilitatorAddresses: [FACILITATOR],
        });
        expect(decoded.payload).toEqual(payload.payload);
    });

    test("the payment header carries an offer with non-Latin-1 text in it", () => {
        // The payload echoes the seller's whole requirements object, fields the agent
        // never reads included. A Korean note in one of them used to make the Latin-1
        // `btoa` codec throw after the leaf was signed; the UTF-8 codec the reference
        // implementation uses carries it, and carries it back byte for byte.
        const payload = buildErc7710PaymentPayload({
            accepted: {
                ...buildErc7710PaymentRequirements({payTo: PAYEE, amount: 1_000_000n}),
                extra: {assetTransferMethod: "erc7710", paymentFlow: "upfront", note: "한글 메모 — 🎉"},
            },
            delegationManager: MANAGER,
            permissionContext: "0x1234",
            delegator: DELEGATOR,
        });
        const header = encodePaymentHeader(payload);
        // The value travels as an HTTP header, so it must itself be plain base64 ASCII.
        expect(/^[A-Za-z0-9+/]+=*$/.test(header)).toBe(true);
        expect(decodePaymentHeader(header)).toEqual(payload);
    });
});

describe("ERC-7710 /supported payload", () => {
    test("advertises the facilitator identically in kinds[].extra and signers", () => {
        const payload = buildErc7710SupportedPayload({facilitatorAddresses: [FACILITATOR]});

        expect(payload.kinds).toHaveLength(1);
        const kind = payload.kinds[0];
        expect(kind?.x402Version).toBe(X402_VERSION);
        expect(kind?.scheme).toBe("exact");
        expect(kind?.network).toBe(GIWA_SEPOLIA_CAIP2);
        expect(kind?.extra.assetTransferMethod).toBe("erc7710");
        // A third-party resource server copies kinds[].extra verbatim into its
        // offers (the supportedKind flow), while this repo's own seller and agent
        // read `signers`. The two channels must never drift, or an offer built
        // from one is refused by a component reading the other.
        expect(kind?.extra.facilitatorAddresses).toEqual([FACILITATOR]);
        // /supported도 레일의 결제 흐름을 선언한다. 참조 구현의 supportedKind 흐름은
        // 이 키를 오퍼로 복사하지 않지만(x402-conformance.test.ts가 고정한 측정값),
        // 통합자가 흐름을 질의할 수 있는 문서는 여기뿐이다.
        expect(kind?.extra.paymentFlow).toBe("upfront");
        expect(payload.signers[GIWA_SEPOLIA_CAIP2]).toEqual([FACILITATOR]);
        expect(payload.extensions).toEqual([]);
    });
});

describe("x402 v2 transport headers", () => {
    const offerBody = (): PaymentRequired<Erc7710PaymentRequirements> => ({
        x402Version: X402_VERSION,
        resource: {
            // Deliberately not Latin-1: the 402 body carries human-facing text, and a
            // Korean description must survive the header codec. This is exactly where
            // the btoa-based payload codec would throw — the reference implementation
            // base64-encodes UTF-8 bytes, and this codec must match it byte for byte.
            description: "결제가 필요합니다 — 로고 시안",
            mimeType: "application/json",
        },
        accepts: [buildErc7710PaymentRequirements({payTo: PAYEE, amount: 1_000_000n})],
    });

    test("Payment-Required codec round-trips a non-Latin-1 offer body", () => {
        const header = encodePaymentRequiredHeader(offerBody());
        // The value travels as an HTTP header, so it must itself be plain base64 ASCII.
        expect(/^[A-Za-z0-9+/]+=*$/.test(header)).toBe(true);
        expect(decodePaymentRequiredHeader(header)).toEqual(offerBody());
    });

    test("decode rejects garbage and non-UTF-8 bytes instead of returning mojibake", () => {
        expect(() => decodePaymentRequiredHeader("!!!not-base64!!!")).toThrow();
        // 0xFF is not a valid UTF-8 start byte; a non-fatal decoder would silently
        // hand back U+FFFD replacement characters inside a "successfully" parsed offer.
        expect(() => decodePaymentRequiredHeader(btoa("ÿþ"))).toThrow();
        // The same codec sits behind every header, so the same refusal holds for the
        // payment and the receipt.
        expect(() => decodePaymentHeader(btoa("ÿþ"))).toThrow();
        expect(() => decodePaymentResponseHeader("!!!not-base64!!!")).toThrow();
    });

    test("Payment-Response codec round-trips a receipt with and without a transaction", () => {
        const settled = {
            success: true,
            network: GIWA_SEPOLIA_CAIP2,
            payer: DELEGATOR,
            transaction: `0x${"cd".repeat(32)}`,
        } as const;
        expect(decodePaymentResponseHeader(encodePaymentResponseHeader(settled))).toEqual(settled);
        // `transaction` is required; "no on-chain transaction" is spelled `""`.
        const unnamed = {
            success: true,
            network: GIWA_SEPOLIA_CAIP2,
            payer: DELEGATOR,
            transaction: "",
        } as const;
        expect(decodePaymentResponseHeader(encodePaymentResponseHeader(unnamed))).toEqual(unnamed);
    });

    test("a failure receipt round-trips without a payer, and names its reason", () => {
        // The failure side of the union: a refusal older than the payer's name — the
        // header that did not parse carried it. `errorReason` is what makes the receipt
        // worth writing at all, so it is required where `payer` is not.
        const unread = {
            success: false,
            network: GIWA_SEPOLIA_CAIP2,
            transaction: "",
            errorReason: "invalid_payload",
        } as const;
        const decoded = decodePaymentResponseHeader(encodePaymentResponseHeader(unread));
        expect(decoded).toEqual(unread);
        // Not merely `payer: undefined`: an absent key is what goes on the wire, because
        // JSON drops an undefined value and a reader must not have to tell the two apart.
        expect(decoded).not.toHaveProperty("payer");
    });
});

describe("payment-identifier 확장", () => {
    const ID = "pay_7d5d747be160e280504c099d984bcfe0";
    /** 사양 문서에 적힌 스키마 그대로. 우리 상수를 다시 읽는 대신 여기에 옮겨 고정한다. */
    const SCHEMA = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
            required: {type: "boolean"},
            id: {type: "string", minLength: 16, maxLength: 128},
        },
        required: ["required"],
    };

    test("서버 광고와 클라이언트 제시가 사양의 두 예시와 같은 봉투다", () => {
        expect(PAYMENT_IDENTIFIER_EXTENSION).toBe("payment-identifier");
        // 사양 "PaymentRequired": info.required + 위 스키마.
        expect(buildPaymentIdentifierOffer()).toEqual({info: {required: false}, schema: SCHEMA});
        // 사양 "PaymentPayload": 같은 스키마를 에코하고 info에 id를 더한다.
        expect(buildPaymentIdentifierEcho(ID)).toEqual({
            info: {required: false, id: ID},
            schema: SCHEMA,
        });
    });

    test("봉투는 페이로드 헤더를 왕복하고, 확장을 쓰지 않은 결제에는 칸이 없다", () => {
        const accepted = buildErc7710PaymentRequirements({payTo: PAYEE, amount: 1_000_000n});
        const withId = buildErc7710PaymentPayload({
            accepted,
            delegationManager: MANAGER,
            permissionContext: "0x1234",
            delegator: DELEGATOR,
            extensions: {[PAYMENT_IDENTIFIER_EXTENSION]: buildPaymentIdentifierEcho(ID)},
        });
        const decoded = decodePaymentHeader(encodePaymentHeader(withId));
        expect(decoded).toEqual(withId);
        expect(readPaymentIdentifier(decoded)).toEqual({kind: "present", id: ID});

        const without = buildErc7710PaymentPayload({
            accepted,
            delegationManager: MANAGER,
            permissionContext: "0x1234",
            delegator: DELEGATOR,
        });
        expect("extensions" in without).toBe(false);
        expect(readPaymentIdentifier(without)).toEqual({kind: "absent"});
    });

    test("형식을 어긴 id는 '없음'이 아니라 '잘못됨'으로 읽힌다", () => {
        const read = (id: unknown) =>
            readPaymentIdentifier({
                extensions: {[PAYMENT_IDENTIFIER_EXTENSION]: {info: {required: false, id}}},
            }).kind;
        // 사양 "id Format": 16–128자, 영숫자·하이픈·밑줄.
        expect(read("pay_shorty")).toBe("malformed"); // 10자
        expect(read("pay_shorty12345")).toBe("malformed"); // 15자 — 한 자 짧다
        expect(read(`pay_${"a".repeat(125)}`)).toBe("malformed"); // 129자 — 한 자 길다
        expect(read(`pay_${"a".repeat(124)}`)).toBe("present"); // 128자 — 경계는 안이다
        expect(read("pay_7d5d747be160e28!")).toBe("malformed");
        expect(read("pay_7d5d747be160 e28")).toBe("malformed");
        expect(read("pay.7d5d747be160e280")).toBe("malformed");
        expect(read(42)).toBe("malformed");
        // 하이픈·밑줄은 허용 문자다.
        expect(read("pay-7d5d747b_e160e280")).toBe("present");
    });

    test("봉투가 깨진 항목은 malformed, id 없는 항목은 absent", () => {
        // 확장을 쓴다고 이름을 올려 두고 모양을 틀린 것 — 조용히 무시하면 안 된다.
        expect(readPaymentIdentifier({extensions: {[PAYMENT_IDENTIFIER_EXTENSION]: "x"}}).kind).toBe(
            "malformed",
        );
        expect(
            readPaymentIdentifier({extensions: {[PAYMENT_IDENTIFIER_EXTENSION]: {info: "x"}}}).kind,
        ).toBe("malformed");
        // 사양의 스키마에서 id는 선택이다: required:false를 광고한 서버에 "id는 없다"고
        // 답하는 것은 합법이고, 그 결제는 멱등성 약속이 없는 결제일 뿐이다.
        expect(
            readPaymentIdentifier({
                extensions: {[PAYMENT_IDENTIFIER_EXTENSION]: {info: {required: false}}},
            }).kind,
        ).toBe("absent");
        // 남의 확장만 실은 봉투, 봉투가 없는 문서, 문서가 아닌 값 — 모두 없음이다.
        expect(readPaymentIdentifier({extensions: {mapae: {info: {}}}}).kind).toBe("absent");
        expect(readPaymentIdentifier({extensions: 7}).kind).toBe("absent");
        expect(readPaymentIdentifier({}).kind).toBe("absent");
        expect(readPaymentIdentifier(null).kind).toBe("absent");
        expect(readPaymentIdentifier("payload").kind).toBe("absent");
    });

    test("402 광고도 같은 봉투로 헤더를 왕복한다", () => {
        const body: PaymentRequired<Erc7710PaymentRequirements> = {
            x402Version: X402_VERSION,
            accepts: [buildErc7710PaymentRequirements({payTo: PAYEE, amount: 1_000_000n})],
            extensions: {[PAYMENT_IDENTIFIER_EXTENSION]: buildPaymentIdentifierOffer()},
        };
        expect(decodePaymentRequiredHeader(encodePaymentRequiredHeader(body))).toEqual(body);
    });
});

describe("in-band DelegationManager advertisement", () => {
    test("the offer carries extra.delegationManager when the seller provides one", () => {
        // GIWA's manager is not in @metamask/delegation-deployments, and the merged
        // ERC-7710 scheme is registry-free — the offer itself is the only in-band place
        // a third-party agent's delegationProvider can learn which manager to build its
        // leaf against (it receives these requirements verbatim, extra included).
        const withManager = buildErc7710PaymentRequirements({
            payTo: PAYEE,
            amount: 1_000_000n,
            delegationManager: MANAGER,
        });
        expect(withManager.extra.delegationManager).toBe(MANAGER);

        // Omission stays omission — existing offers and fixtures must not change shape.
        const without = buildErc7710PaymentRequirements({payTo: PAYEE, amount: 1_000_000n});
        expect("delegationManager" in without.extra).toBe(false);
    });

    test("/supported kinds[].extra can carry the manager as a discovery document", () => {
        // Measured against @metamask/x402 0.2.0: its supportedKind flow copies only
        // facilitatorAddresses into offers, so this field does NOT propagate through a
        // third-party seller automatically. It is still the one queryable place an
        // integrator can read the rail's manager from, which is why it rides here too.
        const payload = buildErc7710SupportedPayload({
            facilitatorAddresses: [FACILITATOR],
            delegationManager: MANAGER,
        });
        expect(payload.kinds[0]?.extra.delegationManager).toBe(MANAGER);
        expect(payload.signers[GIWA_SEPOLIA_CAIP2]).toEqual([FACILITATOR]);
    });
});
