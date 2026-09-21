import {describe, expect, test} from "bun:test";
import {getAddress, type Address, type Hex} from "viem";
import {
    buildErc7710PaymentRequirements,
    toTokenAmount,
    type Erc7710PaymentRequirements,
} from "@mapae/shared";
import {
    createAgentSpendGate,
    judgePreflight,
    parseAgentSpendPolicy,
    resolveResourceTarget,
    tightestPeriodRemaining,
} from "./agent-runtime.js";
import {payForDelegatedResource, type DelegatedLeafProvider} from "./payment-client.js";
import type {DelegationStatus} from "./delegation-status.js";

const seller = new URL("http://127.0.0.1:3101");

const ADDR = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`);

/** A link that permits everything, so each test varies exactly one thing. */
function link(overrides: Partial<DelegationStatus> = {}): DelegationStatus {
    return {
        delegationHash: `0x${"11".repeat(32)}`,
        delegator: ADDR(1),
        delegate: ADDR(2),
        remaining: toTokenAmount("3"),
        revoked: false,
        expired: false,
        notYetActive: false,
        ...overrides,
    };
}

/**
 * The check that stands between an agent and a signature.
 *
 * This is the product's central claim in one function: the agent asks the enforcer what
 * is left *before* signing, so a payment the cap cannot cover never becomes a signed
 * bearer authorization. It is deliberately pure so it can be tested without a chain — the
 * closure it was extracted from was reachable only through a bootstrap wanting env vars,
 * files and an RPC, which is why it had no test.
 */
describe("tightestPeriodRemaining", () => {
    test("takes the smallest allowance across the chain, not the root's", () => {
        // A re-delegated child's smaller cap binds even when the root has room.
        expect(
            tightestPeriodRemaining([
                link({remaining: toTokenAmount("1")}),
                link({remaining: toTokenAmount("5")}),
            ]),
        ).toBe(toTokenAmount("1"));
    });

    test("a chain with no period caveat anywhere is undefined, not zero and not Infinity", () => {
        // `undefined` is the whole point: it means "there is no cap to compare against".
        // Collapsing it to a number here would force every caller into one interpretation,
        // and the two callers want opposite ones.
        expect(tightestPeriodRemaining([link({remaining: undefined})])).toBeUndefined();
        expect(tightestPeriodRemaining([])).toBeUndefined();
    });

    test("links without a cap do not mask the ones that have it", () => {
        expect(
            tightestPeriodRemaining([link({remaining: undefined}), link({remaining: 7n})]),
        ).toBe(7n);
    });
});

describe("judgePreflight", () => {

    test("clears a payment inside the cap", () => {
        expect(judgePreflight([link()], toTokenAmount("1"))).toEqual({ok: true});
    });

    test("an empty chain is refused, not cleared", () => {
        // Every other rule here is a loop, so with no statuses each one fell through and
        // the function cleared the payment — measured at 999 mUSDC against a chain it had
        // read nothing from. The state is reachable: `isPermissionContext` guards shape
        // and length, and a well-formed ABI encoding of an empty `Delegation[]` is 130
        // characters that passes it and decodes to `[]`.
        const verdict = judgePreflight([], 999_000_000n);
        expect(verdict.ok).toBe(false);
        expect(verdict).toMatchObject({code: "PERMISSION_EMPTY"});
    });

    test("empty and inactive are told apart, not merged", () => {
        // Separate codes on purpose: `PERMISSION_INACTIVE` sends an operator to check
        // revocation and expiry on chain, where a broken permission artifact leaves
        // nothing to find. Asserting both sides — a `not.toMatchObject` here would pass
        // for a verdict of `{ok: true}` too, which is the bug this pins.
        expect(judgePreflight([], 1n)).toMatchObject({code: "PERMISSION_EMPTY"});
        expect(judgePreflight([link({revoked: true})], 1n)).toMatchObject({
            code: "PERMISSION_INACTIVE",
        });
    });

    test("clears a payment exactly at the cap — the enforcer allows equality", () => {
        // `>` not `>=`: refusing the exact remaining balance would make the last
        // spendable unit unspendable, and the chain would have allowed it.
        expect(judgePreflight([link({remaining: toTokenAmount("1")})], toTokenAmount("1"))).toEqual({
            ok: true,
        });
    });

    test("refuses one wei over the cap", () => {
        const verdict = judgePreflight([link({remaining: 1_000_000n})], 1_000_001n);
        expect(verdict.ok).toBe(false);
        expect(verdict).toMatchObject({code: "LIMIT_EXCEEDED"});
        // The number the operator needs is the remaining balance, not just a refusal.
        expect(verdict.ok === false && verdict.detail).toContain("1000000");
    });

    test("binds to the tightest link, not the root", () => {
        // A re-delegated child with a smaller cap. The DelegationManager enforces every
        // link, so clearing against the root would sign a payment the chain then reverts.
        const verdict = judgePreflight(
            [link({remaining: toTokenAmount("1")}), link({remaining: toTokenAmount("6")})],
            toTokenAmount("2"),
        );
        expect(verdict).toMatchObject({code: "LIMIT_EXCEEDED"});
        expect(verdict.ok === false && verdict.detail).toContain(String(toTokenAmount("1")));
    });

    test("order of the links does not change the verdict", () => {
        const tight = link({remaining: toTokenAmount("1")});
        const loose = link({remaining: toTokenAmount("6")});
        const amount = toTokenAmount("2");
        expect(judgePreflight([tight, loose], amount)).toEqual(judgePreflight([loose, tight], amount));
    });

    for (const [field, detail] of [
        ["revoked", "permission was revoked"],
        ["expired", "permission has expired"],
        ["notYetActive", "permission is not active yet"],
    ] as const) {
        test(`refuses a ${field} link with its own reason`, () => {
            const verdict = judgePreflight([link({[field]: true})], toTokenAmount("1"));
            expect(verdict).toEqual({ok: false, code: "PERMISSION_INACTIVE", detail});
        });

        test(`${field} outranks an over-cap amount on the same link`, () => {
            // Both refusals apply here, which is the only arrangement that pins the
            // order. An earlier version of this test used an amount that fit, so the cap
            // branch never fired and reordering the two checks broke nothing — the test
            // named the property without testing it, and a mutation run caught that.
            //
            // The order matters because the two send the operator to different places: a
            // permission that is unusable at *any* amount reported as `LIMIT_EXCEEDED`
            // has them raising a cap that was never the cause.
            const verdict = judgePreflight([link({[field]: true, remaining: 0n})], 1n);
            expect(verdict).toEqual({ok: false, code: "PERMISSION_INACTIVE", detail});
        });
    }

    test("an inactive link anywhere in the chain refuses the whole chain", () => {
        const verdict = judgePreflight([link(), link({revoked: true})], toTokenAmount("1"));
        expect(verdict).toMatchObject({code: "PERMISSION_INACTIVE"});
    });

    test("a link with no period cap does not become the tightest", () => {
        // `remaining: undefined` means that link carries no ERC-20 period caveat. Treating
        // an absent cap as zero would refuse every payment on a policy that has no cap.
        expect(
            judgePreflight([link({remaining: undefined}), link({remaining: toTokenAmount("3")})], toTokenAmount("2")),
        ).toEqual({ok: true});
    });

    test("no link carries a cap at all — nothing to exceed", () => {
        // Deliberate, and deliberately *not* what the broadcast gate does with the same
        // input. `apps/delegation-lab/giwa-preflight.ts` records a missing period cap as a
        // FAILED condition, because its last line reads `GO — every condition met` to a
        // human about to send an irreversible settlement, and a cap that is absent must not
        // be shown as one that was checked. This function answers a narrower question —
        // "will the chain refuse this payment?" — and with no period cap the answer is no.
        //
        // If you came here to make the two agree, read the comment above `tightest` in
        // agent-runtime.ts first. This assertion is what breaks when you change it.
        expect(judgePreflight([link({remaining: undefined})], toTokenAmount("999"))).toEqual({
            ok: true,
        });
    });

    test("a zero remaining balance refuses any positive amount", () => {
        expect(judgePreflight([link({remaining: 0n})], 1n)).toMatchObject({
            code: "LIMIT_EXCEEDED",
        });
    });
});

/**
 * The MCP tool takes a resource path from whatever is driving the agent, which in
 * D5 is a model. A path that resolves to another origin would send `Payment-Signature` —
 * a bearer authorization — somewhere the operator never configured, so this is a
 * security boundary rather than input tidying.
 */
describe("resolveResourceTarget", () => {
    test("keeps an ordinary absolute path on the seller origin", () => {
        const target = resolveResourceTarget(seller, "/s/demo-cafe/americano");
        expect(target.toString()).toBe("http://127.0.0.1:3101/s/demo-cafe/americano");
    });

    test("preserves a query string", () => {
        expect(resolveResourceTarget(seller, "/a?b=c").toString()).toBe(
            "http://127.0.0.1:3101/a?b=c",
        );
    });

    test("refuses a protocol-relative path that would change host", () => {
        // new URL("//evil.example", seller) silently yields http://evil.example.
        expect(() => resolveResourceTarget(seller, "//evil.example/x")).toThrow(
            "absolute path on the seller origin",
        );
    });

    test("refuses an absolute URL to another origin", () => {
        expect(() => resolveResourceTarget(seller, "http://evil.example/x")).toThrow(
            "absolute path on the seller origin",
        );
        expect(() => resolveResourceTarget(seller, "https://127.0.0.1:3101/x")).toThrow(
            "absolute path on the seller origin",
        );
    });

    test("refuses a backslash, which some parsers fold into a slash", () => {
        expect(() => resolveResourceTarget(seller, "/\\evil.example/x")).toThrow(
            "absolute path on the seller origin",
        );
        expect(() => resolveResourceTarget(seller, "\\\\evil.example/x")).toThrow(
            "absolute path on the seller origin",
        );
    });

    test("refuses a relative path that has no anchor on the origin", () => {
        expect(() => resolveResourceTarget(seller, "deliverable/inv-001")).toThrow(
            "absolute path on the seller origin",
        );
        expect(() => resolveResourceTarget(seller, "")).toThrow(
            "absolute path on the seller origin",
        );
    });

    test("traversal cannot climb out of the origin", () => {
        // Path traversal normalises within the origin, so it stays safe — asserted
        // so a future change that swaps the origin check for a prefix check fails.
        expect(resolveResourceTarget(seller, "/../../etc/passwd").origin).toBe(seller.origin);
    });

    test("a port change is a different origin", () => {
        expect(() => resolveResourceTarget(seller, "//127.0.0.1:9999/x")).toThrow(
            "absolute path on the seller origin",
        );
    });
});

/* ------------------------------------------------------------------ *
 * 런타임 지출 정책
 * ------------------------------------------------------------------ */

/**
 * 온체인 caveat 위에 얹는 운영자 쪽 한도.
 *
 * 체인의 기간 한도는 며칠치 예산을 한 칸에 담고 있고, 그 안의 개별 결제는 전부 합법이다.
 * 잘못 든 자원 경로 하나가 한 세션에 그 예산을 다 쓰는 것을 체인은 막지 않는다 — 막을
 * 근거가 없기 때문이다. 아래 세 한도가 그 폭을 좁히고, 판정은 전부 서명 전에 일어난다.
 */
describe("parseAgentSpendPolicy", () => {
    test("세 변수가 모두 없으면 한도가 하나도 없다 — 체인이 유일한 한도다", () => {
        // 임의의 기본 숫자를 넣지 않는다. 운영자가 정한 적 없는 예산에 걸린 거절은
        // 그 원인이 운영자가 읽을 수 있는 어디에도 적혀 있지 않다.
        expect(parseAgentSpendPolicy({})).toEqual({
            maxPerPaymentBase: undefined,
            maxSessionTotalBase: undefined,
            allowedPayTo: undefined,
        });
    });

    test("금액은 십진 문자열로 읽고 base unit으로 옮긴다", () => {
        expect(
            parseAgentSpendPolicy({
                AGENT_MAX_PAYMENT_MUSDC: "2.50",
                AGENT_SESSION_BUDGET_MUSDC: "10",
            }),
        ).toMatchObject({
            maxPerPaymentBase: toTokenAmount("2.5"),
            maxSessionTotalBase: toTokenAmount("10"),
        });
    });

    test("허용목록은 쉼표로 끊고 체크섬으로 정규화한다", () => {
        // 운영자는 주소를 소문자로 붙여넣는다. 비교 시점에 정규화하면 목록 쪽과 오퍼 쪽
        // 두 군데에서 각자 정규화해야 하고, 한쪽을 잊으면 목록이 조용히 비어 있게 된다.
        const policy = parseAgentSpendPolicy({
            AGENT_ALLOWED_PAY_TO: ` ${ADDR(7).toLowerCase()} , ${ADDR(8)} `,
        });
        expect(policy.allowedPayTo).toEqual([ADDR(7), ADDR(8)]);
    });

    test("빈 문자열은 미설정과 같다 — 셸에서 둘은 구분되지 않는다", () => {
        expect(
            parseAgentSpendPolicy({AGENT_MAX_PAYMENT_MUSDC: "  ", AGENT_ALLOWED_PAY_TO: ""}),
        ).toEqual({
            maxPerPaymentBase: undefined,
            maxSessionTotalBase: undefined,
            allowedPayTo: undefined,
        });
    });

    for (const [name, value, reason] of [
        ["AGENT_MAX_PAYMENT_MUSDC", "-1", "음수"],
        ["AGENT_MAX_PAYMENT_MUSDC", "0", "0은 모든 결제를 거절하는 한도다"],
        ["AGENT_MAX_PAYMENT_MUSDC", "1.0000001", "소수 7자리 — 토큰은 6자리다"],
        ["AGENT_MAX_PAYMENT_MUSDC", "2.5 tUSDC", "단위를 붙인 값"],
        ["AGENT_SESSION_BUDGET_MUSDC", "0", "0은 모든 결제를 거절하는 한도다"],
        ["AGENT_SESSION_BUDGET_MUSDC", "abc", "숫자가 아님"],
        ["AGENT_ALLOWED_PAY_TO", "0x1234", "주소가 아님"],
        ["AGENT_ALLOWED_PAY_TO", ",", "목록을 적으려다 아무것도 남지 않았다"],
        ["AGENT_ALLOWED_PAY_TO", `0x${"0".repeat(40)}`, "0 주소는 어떤 오퍼와도 맞지 않는다"],
    ] as const) {
        test(`잘못된 ${name}=${JSON.stringify(value)}는 부팅에서 실패한다 (${reason})`, () => {
            // 조용히 무제한으로 도는 것보다 낫다. 한도가 걸리지 않는 것과 한도가 없는
            // 것은 밖에서 똑같이 보이므로, 오타를 무시하면 그 상태는 관측되지 않는다.
            expect(() => parseAgentSpendPolicy({[name]: value})).toThrow(name);
        });
    }
});

const PAYEE = ADDR(7);
const OTHER_PAYEE = ADDR(9);
const MANAGER = ADDR(0x41);
const FACILITATOR = ADDR(0x31);

/** `assertErc7710Offer`를 통과하는 온전한 오퍼 — provider와 결제 루프가 받는 모양이다. */
function fullOffer(amount: bigint, payTo: Address = PAYEE): Erc7710PaymentRequirements {
    return buildErc7710PaymentRequirements({
        payTo,
        amount,
        facilitatorAddresses: [FACILITATOR],
    });
}

const signedLeaf = {
    delegationManager: MANAGER,
    permissionContext: `0x${"ab".repeat(64)}` as Hex,
    delegator: ADDR(0x51),
};

describe("createAgentSpendGate", () => {
    test("한도가 하나도 없으면 아무리 큰 결제도 통과한다", () => {
        const gate = createAgentSpendGate({});
        expect(gate.judge(fullOffer(toTokenAmount("999999")))).toEqual({ok: true});
    });

    test("호출당 상한을 넘으면 거절한다", () => {
        const gate = createAgentSpendGate({maxPerPaymentBase: toTokenAmount("1")});
        const verdict = gate.judge(fullOffer(toTokenAmount("1") + 1n));
        expect(verdict).toMatchObject({ok: false, code: "SPEND_POLICY_REFUSED"});
        // 운영자가 고칠 변수의 이름과 설정한 숫자가 사유에 들어 있어야 한다.
        expect(verdict.ok === false && verdict.detail).toContain("AGENT_MAX_PAYMENT_MUSDC");
        expect(verdict.ok === false && verdict.detail).toContain("1000000");
    });

    test("상한과 정확히 같은 금액은 통과한다 — 설정한 숫자가 실제 한도여야 한다", () => {
        // `>=`로 잘못 쓰면 마지막 한 단위를 쓸 수 없고, 운영자가 적은 값과 실제 한도가
        // 달라진다. 온체인 판정(`judgePreflight`)도 같은 경계 규칙을 쓴다.
        const gate = createAgentSpendGate({maxPerPaymentBase: toTokenAmount("1")});
        expect(gate.judge(fullOffer(toTokenAmount("1")))).toEqual({ok: true});
    });

    test("세션 누적은 두 번째 호출에서 초과된다", async () => {
        const gate = createAgentSpendGate({maxSessionTotalBase: toTokenAmount("3")});
        const sign = gate.wrap(async () => signedLeaf);

        expect(gate.judge(fullOffer(toTokenAmount("2")))).toEqual({ok: true});
        await sign(fullOffer(toTokenAmount("2")));
        const verdict = gate.judge(fullOffer(toTokenAmount("2")));

        expect(verdict).toMatchObject({ok: false, code: "SPEND_POLICY_REFUSED"});
        expect(verdict.ok === false && verdict.detail).toContain("AGENT_SESSION_BUDGET_MUSDC");
        // 남은 예산이 아니라 이 결제가 도달할 총액을 말한다 — 예산을 얼마로 올려야
        // 하는지 운영자가 바로 읽을 수 있는 숫자다.
        expect(verdict.ok === false && verdict.detail).toContain("4000000");
    });

    test("누적과 정확히 같은 총액까지는 통과한다", async () => {
        const gate = createAgentSpendGate({maxSessionTotalBase: toTokenAmount("3")});
        const sign = gate.wrap(async () => signedLeaf);
        await sign(fullOffer(toTokenAmount("2")));
        expect(gate.judge(fullOffer(toTokenAmount("1")))).toEqual({ok: true});
    });

    test("판정은 상태를 바꾸지 않는다 — 같은 오퍼를 다섯 번 물어도 같은 답이다", () => {
        // 판정이 누적을 더해 버리면 체인이 거절한 결제(`LIMIT_EXCEEDED`)가 세션 예산을
        // 먹고, 기간이 돌아온 뒤에도 프로세스를 다시 띄워야 하는 상태가 생긴다. 서명만
        // 세는 것은 그래서다 — `wrap`이 유일한 누적 지점이다.
        const gate = createAgentSpendGate({maxSessionTotalBase: toTokenAmount("3")});
        for (let i = 0; i < 5; i++) {
            expect(gate.judge(fullOffer(toTokenAmount("3")))).toEqual({ok: true});
        }
    });

    test("서명이 실패한 금액은 누적에 들어가지 않는다", async () => {
        const gate = createAgentSpendGate({maxSessionTotalBase: toTokenAmount("3")});
        const sign = gate.wrap(async () => {
            throw new Error("delegation is disabled");
        });

        await expect(sign(fullOffer(toTokenAmount("3")))).rejects.toThrow("disabled");
        // 존재하지 않는 leaf는 청구될 수 없다. 예산은 그대로다.
        expect(gate.judge(fullOffer(toTokenAmount("3")))).toEqual({ok: true});
    });

    test("허용목록 밖의 수취처는 금액과 무관하게 거절된다", () => {
        const gate = createAgentSpendGate({
            maxPerPaymentBase: 1n,
            allowedPayTo: [PAYEE],
        });
        // 금액 상한도 동시에 걸리는 금액을 골랐다. 두 거절이 모두 성립하는 입력만이
        // 순서를 고정한다 — 낯선 수취처를 금액 초과로 보고하면 운영자는 한도를 올리러
        // 가고, 정작 봐야 할 것(에이전트가 왜 그 판매자를 골랐는가)을 보지 않는다.
        const verdict = gate.judge(fullOffer(toTokenAmount("500"), OTHER_PAYEE));
        expect(verdict).toMatchObject({ok: false, code: "SPEND_POLICY_REFUSED"});
        expect(verdict.ok === false && verdict.detail).toContain("AGENT_ALLOWED_PAY_TO");
        expect(verdict.ok === false && verdict.detail).toContain(OTHER_PAYEE);
    });

    test("허용목록 안의 수취처는 통과한다", () => {
        const gate = createAgentSpendGate({allowedPayTo: [OTHER_PAYEE, PAYEE]});
        expect(gate.judge(fullOffer(1n, PAYEE))).toEqual({ok: true});
    });

    test("허용목록이 미설정이면 어떤 수취처도 제한하지 않는다", () => {
        // 미설정은 "제한 없음"이지 "아무것도 허용 안 함"이 아니다. 빈 목록으로 접으면
        // 변수를 적지 않은 운영자의 에이전트가 아무 결제도 못 한다.
        const gate = createAgentSpendGate({maxPerPaymentBase: toTokenAmount("5")});
        expect(gate.judge(fullOffer(1n, OTHER_PAYEE))).toEqual({ok: true});
    });
});

/**
 * 정책 거절이 **서명 전에** 도달한다는 것이 이 기능의 전부다.
 *
 * 서명된 leaf는 bearer 권한이다. 사후에 거절해도 그 권한은 이미 존재하고, facilitator가
 * 청구할 수 있다. 그래서 위의 단위 테스트만으로는 부족하다 — 게이트의 판정이 실제 결제
 * 루프에서 provider보다 먼저 불리는지가 확인되어야 한다.
 */
describe("지출 정책과 결제 루프의 합성", () => {
    const target = new URL("http://127.0.0.1:3001/s/demo-cafe/americano");

    /** 첫 호출은 402 오퍼, 두 번째(재요청)는 자원. */
    function scriptedFetch(offer: Erc7710PaymentRequirements) {
        const calls: URL[] = [];
        const impl = (async (url: URL) => {
            calls.push(url);
            const body =
                calls.length === 1 ? {x402Version: 2, accepts: [offer]} : {served: true};
            return {
                status: calls.length === 1 ? 402 : 200,
                ok: calls.length !== 1,
                headers: new Headers({"content-type": "application/json"}),
                json: async () => body,
                text: async () => JSON.stringify(body),
            } as unknown as Response;
        }) as unknown as typeof fetch;
        return {impl, calls};
    }

    function run(offer: Erc7710PaymentRequirements, gate: ReturnType<typeof createAgentSpendGate>) {
        let signatures = 0;
        const counting: DelegatedLeafProvider = async () => {
            signatures += 1;
            return signedLeaf;
        };
        const {impl, calls} = scriptedFetch(offer);
        // 런타임이 엮는 것과 같은 배선: 판정은 preflight로, 누적은 provider를 감싸서.
        const result = payForDelegatedResource(target, {
            provider: gate.wrap(counting),
            preflight: async (requirements) => gate.judge(requirements),
            delegationManager: MANAGER,
            trustedFacilitators: [FACILITATOR],
            fetchImpl: impl,
            timeoutMs: 2_000,
        });
        return {result, calls, signatures: () => signatures};
    }

    test("호출당 상한을 넘는 오퍼는 leaf가 만들어지기 전에 거절된다", async () => {
        const gate = createAgentSpendGate({maxPerPaymentBase: toTokenAmount("1")});
        const {result, calls, signatures} = run(fullOffer(toTokenAmount("2")), gate);

        const verdict = await result;
        expect(verdict.ok).toBe(false);
        if (verdict.ok) throw new Error("unreachable");
        expect(verdict.code).toBe("SPEND_POLICY_REFUSED");
        // 서명이 일어나지 않았다는 것이 이 테스트의 주장이다.
        expect(signatures()).toBe(0);
        // 402를 받은 한 번뿐 — 결제 헤더를 실은 재요청은 나가지 않았다.
        expect(calls).toHaveLength(1);
    });

    test("허용목록 밖의 수취처도 같은 지점에서 멈춘다", async () => {
        const gate = createAgentSpendGate({allowedPayTo: [PAYEE]});
        const {result, calls, signatures} = run(
            fullOffer(toTokenAmount("1"), OTHER_PAYEE),
            gate,
        );

        const verdict = await result;
        expect(verdict).toMatchObject({ok: false, code: "SPEND_POLICY_REFUSED"});
        expect(signatures()).toBe(0);
        expect(calls).toHaveLength(1);
    });

    test("세션 예산을 다 쓰면 다음 호출의 서명이 일어나지 않는다", async () => {
        const gate = createAgentSpendGate({maxSessionTotalBase: toTokenAmount("2")});
        const first = run(fullOffer(toTokenAmount("2")), gate);
        expect((await first.result).ok).toBe(true);
        expect(first.signatures()).toBe(1);

        const second = run(fullOffer(toTokenAmount("1")), gate);
        const verdict = await second.result;
        expect(verdict).toMatchObject({ok: false, code: "SPEND_POLICY_REFUSED"});
        expect(second.signatures()).toBe(0);
        expect(second.calls).toHaveLength(1);
    });
});
