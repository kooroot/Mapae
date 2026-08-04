import {describe, expect, test} from "bun:test";
import {getAddress, type Address} from "viem";
import {judgeStudioRevokeGate, revokeRefusalMessage, studioRevokeButtonLabel} from "./revoke";

const address = (suffix: number): Address =>
    getAddress(`0x${suffix.toString(16).padStart(40, "0")}`);

const OWNER = address(1);
const OTHER = address(2);

const ready = {
    endpoint: "https://facilitator.mapae.io",
    revoked: false,
    connected: OWNER,
    connectedChainId: 91_342,
    expectedChainId: 91_342,
    owner: OWNER,
};

describe("judgeStudioRevokeGate", () => {
    test("everything in place is ready", () => {
        expect(judgeStudioRevokeGate(ready)).toEqual({kind: "ready", owner: OWNER});
    });

    test("a missing endpoint outranks everything — nothing else is actionable without it", () => {
        expect(
            judgeStudioRevokeGate({...ready, endpoint: undefined, revoked: true}),
        ).toEqual({kind: "no-endpoint"});
    });

    test("already revoked outranks the wallet — there is nothing left to fix", () => {
        expect(
            judgeStudioRevokeGate({...ready, revoked: true, connected: undefined}),
        ).toEqual({kind: "already-revoked"});
    });

    test("disconnected before any wallet comparison", () => {
        expect(judgeStudioRevokeGate({...ready, connected: undefined})).toEqual({
            kind: "disconnected",
        });
    });

    test("wrong chain before wrong wallet — nothing means what it says until the chain matches", () => {
        expect(
            judgeStudioRevokeGate({...ready, connectedChainId: 1, connected: OTHER}),
        ).toEqual({kind: "wrong-chain", connected: 1, expected: 91_342});
    });

    test("a non-owner wallet is named, case-insensitively", () => {
        expect(judgeStudioRevokeGate({...ready, connected: OTHER})).toEqual({
            kind: "wrong-wallet",
            connected: OTHER,
            owner: OWNER,
        });
        expect(
            judgeStudioRevokeGate({
                ...ready,
                connected: OWNER.toLowerCase() as Address,
            }),
        ).toEqual({kind: "ready", owner: OWNER});
    });

    test("an unknown owner while connected stays gated rather than guessing", () => {
        expect(judgeStudioRevokeGate({...ready, owner: undefined})).toEqual({
            kind: "owner-unknown",
        });
    });

    test("there is no deposit gate — the sponsor covers the shortfall", () => {
        // The console's local gate refuses on `shortfall > 0n`. Here that state is the
        // normal one: the payer holds no ETH by design and the endpoint deposits at
        // revoke time. A gate keyed on the deposit would block the exact flow this
        // feature exists to provide, so the judge does not even accept the field.
        const input = {...ready, shortfall: 1n} as Record<string, unknown>;
        expect(judgeStudioRevokeGate(input as Parameters<typeof judgeStudioRevokeGate>[0])).toEqual(
            {kind: "ready", owner: OWNER},
        );
    });
});

describe("studioRevokeButtonLabel", () => {
    test("each gate has its own sentence", () => {
        expect(studioRevokeButtonLabel({kind: "no-endpoint"})).toBe("회수 엔드포인트 미설정");
        expect(studioRevokeButtonLabel({kind: "already-revoked"})).toBe("이미 회수됨");
        expect(studioRevokeButtonLabel({kind: "disconnected"})).toBe("소유자 지갑 연결");
        expect(
            studioRevokeButtonLabel({kind: "wrong-chain", connected: 1, expected: 91_342}),
        ).toBe("지갑 네트워크가 다름");
        expect(
            studioRevokeButtonLabel({kind: "wrong-wallet", connected: OTHER, owner: OWNER}),
        ).toBe("다른 지갑이 연결됨");
        expect(studioRevokeButtonLabel({kind: "owner-unknown"})).toBe("소유자 확인 중…");
        expect(studioRevokeButtonLabel({kind: "ready", owner: OWNER})).toBe("권한 회수 서명");
    });
});

describe("revokeRefusalMessage", () => {
    test("maps every server refusal to a sentence nobody has to debug", () => {
        expect(revokeRefusalMessage("already_revoked")).toContain("이미 회수");
        expect(revokeRefusalMessage("rate_limited")).toContain("잠시 후");
        expect(revokeRefusalMessage("invalid_account_signature")).toContain("소유자");
        expect(revokeRefusalMessage("budget_exhausted")).toContain("잠시 후");
        expect(revokeRefusalMessage("sponsor_unfunded")).toContain("잠시 후");
        expect(revokeRefusalMessage("sender_busy")).toContain("처리 중");
        expect(revokeRefusalMessage("fee_below_basefee")).toContain("수수료");
        expect(revokeRefusalMessage("base_fee_unreadable")).toContain("잠시 후");
        expect(revokeRefusalMessage("invalid_submission")).toContain("권한");
    });

    test("an unknown or missing reason maps to the generic sentence, never to raw server text", () => {
        // The body is a closed enum by design; mapping (rather than rendering) it means a
        // new server-side reason can never become UI text nobody wrote.
        expect(revokeRefusalMessage("brand_new_reason")).toBe("회수를 완료하지 못했습니다.");
        expect(revokeRefusalMessage(undefined)).toBe("회수를 완료하지 못했습니다.");
    });
});
