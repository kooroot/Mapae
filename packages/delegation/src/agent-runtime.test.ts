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
    tightestRemaining,
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
describe("tightestRemaining", () => {
    test("takes the smallest allowance across the chain, not the root's", () => {
        // A re-delegated child's smaller cap binds even when the root has room.
        expect(
            tightestRemaining([
                link({remaining: toTokenAmount("1")}),
                link({remaining: toTokenAmount("5")}),
            ]),
        ).toEqual({amount: toTokenAmount("1"), source: "period"});
    });

    test("a chain with no spending caveat anywhere is undefined, not zero and not Infinity", () => {
        // `undefined` is the whole point: it means "there is no cap to compare against".
        // Collapsing it to a number here would force every caller into one interpretation,
        // and the two callers want opposite ones.
        expect(tightestRemaining([link({remaining: undefined})])).toBeUndefined();
        expect(tightestRemaining([])).toBeUndefined();
    });

    test("links without a cap do not mask the ones that have it", () => {
        expect(tightestRemaining([link({remaining: undefined}), link({remaining: 7n})])).toEqual({
            amount: 7n,
            source: "period",
        });
    });

    /**
     * 총액이 후보에 들어가야 하는 이유가 여기 있다.
     *
     * 기간이 갱신되면 기간 잔량은 가득 찬 숫자로 되살아나지만 `spentMap`은 되돌아가지
     * 않는다. 기간만 세면 그 순간 이 함수는 체인이
     * `ERC20TransferAmountEnforcer:allowance-exceeded`로 되돌릴 결제를 통과시킨다.
     */
    test("총액 잔량이 더 좁으면 그쪽이 답이고, 출처도 그렇게 적힌다", () => {
        expect(
            tightestRemaining([
                link({remaining: toTokenAmount("3"), lifetimeRemaining: 0n}),
            ]),
        ).toEqual({amount: 0n, source: "lifetime"});
    });

    test("기간 잔량이 더 좁으면 총액이 있어도 기간이 답이다", () => {
        expect(
            tightestRemaining([
                link({remaining: toTokenAmount("1"), lifetimeRemaining: toTokenAmount("8")}),
            ]),
        ).toEqual({amount: toTokenAmount("1"), source: "period"});
    });

    test("두 잔량이 같으면 총액으로 적는다 — 기다림이 해결하지 못하는 쪽이다", () => {
        expect(
            tightestRemaining([
                link({remaining: toTokenAmount("2"), lifetimeRemaining: toTokenAmount("2")}),
            ]),
        ).toEqual({amount: toTokenAmount("2"), source: "lifetime"});
    });

    test("한 링크의 총액이 다른 링크의 기간 잔량보다 좁을 수 있다", () => {
        expect(
            tightestRemaining([
                link({remaining: toTokenAmount("5")}),
                link({remaining: toTokenAmount("6"), lifetimeRemaining: toTokenAmount("2")}),
            ]),
        ).toEqual({amount: toTokenAmount("2"), source: "lifetime"});
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

    /**
     * 같은 `LIMIT_EXCEEDED` 안에서 처방이 갈린다.
     *
     * 기간 잔량이 원인이면 기다리면 열린다. 총액이 원인이면 기다려도 열리지 않고 새 grant를
     * 서명해야 한다. 두 경우에 같은 문장을 적으면, 총액이 소진된 운영자는 영원히 오지 않는
     * 다음 기간을 기다린다.
     */
    test("총액이 소진된 체인은 기간이 열려 있어도 거절하고, 사유를 총액으로 적는다", () => {
        const verdict = judgePreflight(
            [link({remaining: toTokenAmount("3"), lifetimeRemaining: 0n})],
            toTokenAmount("1"),
        );
        expect(verdict).toMatchObject({code: "LIMIT_EXCEEDED"});
        expect(verdict.ok === false && verdict.detail).toContain("lifetime total");
        expect(verdict.ok === false && verdict.detail).not.toContain("left in this period");
    });

    test("기간이 원인인 거절은 기간 문구를 그대로 유지한다", () => {
        const verdict = judgePreflight(
            [link({remaining: 1_000_000n, lifetimeRemaining: toTokenAmount("8")})],
            1_000_001n,
        );
        expect(verdict.ok === false && verdict.detail).toBe(
            "payment of 1000001 exceeds 1000000 left in this period",
        );
    });

    test("총액이 남아 있으면 통과한다 — 총액의 존재 자체가 거절 사유는 아니다", () => {
        expect(
            judgePreflight(
                [link({remaining: toTokenAmount("3"), lifetimeRemaining: toTokenAmount("8")})],
                toTokenAmount("3"),
            ),
        ).toEqual({ok: true});
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

    test("선판정은 상태를 바꾸지 않는다 — 같은 오퍼를 다섯 번 물어도 같은 답이다", () => {
        // 선판정이 예약까지 해 버리면, 판정 뒤 서명까지 가지 않는 호출자의 예산이 한
        // 조각씩 영구히 사라진다 — `apps/payment-scheduler`가 자기 스케줄 조건으로
        // 거절하는 경로가 정확히 그것이다. 예약은 서명 직전(`wrap`)에만 선다.
        const gate = createAgentSpendGate({maxSessionTotalBase: toTokenAmount("3")});
        for (let i = 0; i < 5; i++) {
            expect(gate.judge(fullOffer(toTokenAmount("3")))).toEqual({ok: true});
        }
    });

    test("선판정을 거치지 않고 서명해도 한도가 걸린다", async () => {
        // `preflight`를 넘기지 않는 호출자에게도 한도가 걸려야 한다. 강제가 선판정에만
        // 있으면 그 경로는 무제한이고, 무제한인 경로가 하나 있는 한도는 한도가 아니다.
        const gate = createAgentSpendGate({maxPerPaymentBase: toTokenAmount("1")});
        let signatures = 0;
        const sign = gate.wrap(async () => {
            signatures += 1;
            return signedLeaf;
        });

        await expect(sign(fullOffer(toTokenAmount("2")))).rejects.toThrow(
            "AGENT_MAX_PAYMENT_MUSDC",
        );
        expect(signatures).toBe(0);
    });

    test("동시 호출은 세션 예산을 나눠 쓴다 — 두 번째는 서명되지 않는다", async () => {
        // 판정과 예약이 두 호출로 나뉘어 있으면 이 테스트가 실패한다: 둘 다 선판정을
        // 통과한 뒤 둘 다 서명되고, 세션 총액은 동시 호출 수에 비례해 넘친다(측정값:
        // 예산 1.0에 5개 동시 호출 → 5.0 서명). 강제 지점이 서명 직전 한 곳이고 그
        // 블록에 `await`가 없다는 것이 이 단정의 근거다.
        const gate = createAgentSpendGate({maxSessionTotalBase: toTokenAmount("3")});
        let signatures = 0;
        const sign = gate.wrap(async () => {
            signatures += 1;
            return signedLeaf;
        });

        // 선판정으로는 둘 다 통과한다 — 아직 아무것도 서명되지 않았기 때문이다.
        expect(gate.judge(fullOffer(toTokenAmount("2")))).toEqual({ok: true});

        const settled = await Promise.allSettled([
            sign(fullOffer(toTokenAmount("2"))),
            sign(fullOffer(toTokenAmount("2"))),
        ]);

        expect(settled.map((outcome) => outcome.status)).toEqual(["fulfilled", "rejected"]);
        expect(signatures).toBe(1);
        const refused = settled[1];
        expect(refused.status === "rejected" && String(refused.reason)).toContain(
            "AGENT_SESSION_BUDGET_MUSDC",
        );
        // 예약이 정확히 한 번만 섰다: 2가 들어갔고 4가 들어가지 않았다.
        expect(gate.judge(fullOffer(toTokenAmount("1")))).toEqual({ok: true});
        expect(gate.judge(fullOffer(toTokenAmount("2")))).toMatchObject({ok: false});
    });

    test("서명이 실패하면 예약이 되돌아간다", async () => {
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

    test("동시 결제 두 건 중 예산에 맞는 하나만 서명된다", async () => {
        // 리뷰에서 재현된 회귀다: MCP 서버는 tool 호출을 직렬화하지 않으므로 두 결제가
        // 같은 게이트 위에서 겹친다. 예산 2.0에 2.0짜리 두 건을 동시에 넣으면 서명은
        // 정확히 한 번이어야 한다.
        const gate = createAgentSpendGate({maxSessionTotalBase: toTokenAmount("2")});
        const first = run(fullOffer(toTokenAmount("2")), gate);
        const second = run(fullOffer(toTokenAmount("2")), gate);

        const [a, b] = await Promise.all([first.result, second.result]);

        expect(a.ok).toBe(true);
        // 선판정을 통과한 뒤 서명 직전에 걸린 거절은 `SIGNING_FAILED`로 보고된다 —
        // 서명이 일어나지 않았다는 사실은 그 코드로도 정확하고, `detail`이 어느 한도에
        // 걸렸는지 변수 이름으로 말한다. 강제가 늦은 것이 아니라 보고가 한 단계 거친
        // 것이다(docs/mcp-guide.md §3.1에 같은 문장이 있다).
        expect(b).toMatchObject({ok: false, code: "SIGNING_FAILED"});
        expect(b.ok === false && b.detail).toContain("AGENT_SESSION_BUDGET_MUSDC");
        expect(first.signatures() + second.signatures()).toBe(1);
        // 거절된 쪽은 402를 받은 한 번뿐 — 결제 헤더를 실은 재요청이 나가지 않았다.
        expect(second.calls).toHaveLength(1);
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
