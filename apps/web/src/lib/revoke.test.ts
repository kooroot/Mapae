import {describe, expect, test} from "bun:test";
import {getAddress, type Address} from "viem";
import {
    awaitRevocationVisible,
    judgeStudioRevokeGate,
    revokeRefusalMessage,
    studioRevokeButtonLabel,
} from "./revoke";

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
    test("each gate has its own sentence — English is the default", () => {
        expect(studioRevokeButtonLabel({kind: "no-endpoint"})).toBe(
            "Revocation endpoint not configured",
        );
        expect(studioRevokeButtonLabel({kind: "already-revoked"})).toBe("Already revoked");
        expect(studioRevokeButtonLabel({kind: "disconnected"})).toBe(
            "Connect the owner wallet",
        );
        expect(
            studioRevokeButtonLabel({kind: "wrong-chain", connected: 1, expected: 91_342}),
        ).toBe("Wallet on a different network");
        expect(
            studioRevokeButtonLabel({kind: "wrong-wallet", connected: OTHER, owner: OWNER}),
        ).toBe("A different wallet is connected");
        expect(studioRevokeButtonLabel({kind: "owner-unknown"})).toBe("Confirming owner…");
        expect(studioRevokeButtonLabel({kind: "ready", owner: OWNER})).toBe(
            "Sign to revoke this permission",
        );
    });

    test("the Korean toggle keeps each gate's original sentence", () => {
        expect(studioRevokeButtonLabel({kind: "no-endpoint"}, "ko")).toBe(
            "회수 엔드포인트 미설정",
        );
        expect(studioRevokeButtonLabel({kind: "already-revoked"}, "ko")).toBe("이미 회수됨");
        expect(studioRevokeButtonLabel({kind: "disconnected"}, "ko")).toBe("소유자 지갑 연결");
        expect(
            studioRevokeButtonLabel({kind: "wrong-chain", connected: 1, expected: 91_342}, "ko"),
        ).toBe("지갑 네트워크가 다름");
        expect(
            studioRevokeButtonLabel({kind: "wrong-wallet", connected: OTHER, owner: OWNER}, "ko"),
        ).toBe("다른 지갑이 연결됨");
        expect(studioRevokeButtonLabel({kind: "owner-unknown"}, "ko")).toBe("소유자 확인 중…");
        expect(studioRevokeButtonLabel({kind: "ready", owner: OWNER}, "ko")).toBe(
            "권한 회수 서명",
        );
    });
});

describe("revokeRefusalMessage", () => {
    test("maps every server refusal to a sentence nobody has to debug", () => {
        expect(revokeRefusalMessage("already_revoked")).toContain("already revoked");
        expect(revokeRefusalMessage("rate_limited")).toContain("Try again");
        expect(revokeRefusalMessage("invalid_account_signature")).toContain("owner");
        expect(revokeRefusalMessage("budget_exhausted")).toContain("Try again");
        expect(revokeRefusalMessage("sponsor_unfunded")).toContain("Try again");
        expect(revokeRefusalMessage("sender_busy")).toContain("in progress");
        expect(revokeRefusalMessage("fee_below_basefee")).toContain("fees");
        expect(revokeRefusalMessage("base_fee_unreadable")).toContain("Try again");
        expect(revokeRefusalMessage("invalid_submission")).toContain("permission");
    });

    test("an unknown or missing reason maps to the generic sentence, never to raw server text", () => {
        // The body is a closed enum by design; mapping (rather than rendering) it means a
        // new server-side reason can never become UI text nobody wrote.
        expect(revokeRefusalMessage("brand_new_reason")).toBe(
            "The revocation could not be completed.",
        );
        expect(revokeRefusalMessage(undefined)).toBe("The revocation could not be completed.");
    });

    test("the Korean toggle maps the same refusals", () => {
        expect(revokeRefusalMessage("already_revoked", "ko")).toContain("이미 회수");
        expect(revokeRefusalMessage("rate_limited", "ko")).toContain("잠시 후");
        expect(revokeRefusalMessage("invalid_account_signature", "ko")).toContain("소유자");
        expect(revokeRefusalMessage("budget_exhausted", "ko")).toContain("잠시 후");
        expect(revokeRefusalMessage("sponsor_unfunded", "ko")).toContain("잠시 후");
        expect(revokeRefusalMessage("sender_busy", "ko")).toContain("처리 중");
        expect(revokeRefusalMessage("fee_below_basefee", "ko")).toContain("수수료");
        expect(revokeRefusalMessage("base_fee_unreadable", "ko")).toContain("잠시 후");
        expect(revokeRefusalMessage("invalid_submission", "ko")).toContain("권한");
        expect(revokeRefusalMessage("brand_new_reason", "ko")).toBe("회수를 완료하지 못했습니다.");
        expect(revokeRefusalMessage(undefined, "ko")).toBe("회수를 완료하지 못했습니다.");
    });
});

describe("awaitRevocationVisible", () => {
    test("a flip on the first read returns immediately, without sleeping", async () => {
        const sleeps: number[] = [];
        const result = await awaitRevocationVisible({
            read: async () => true,
            sleep: async (ms) => void sleeps.push(ms),
        });
        expect(result).toBe(true);
        expect(sleeps).toEqual([]);
    });

    test("polls until the chain shows the flip, sleeping the interval between reads", async () => {
        const sleeps: number[] = [];
        let reads = 0;
        const result = await awaitRevocationVisible({
            read: async () => ++reads >= 3,
            intervalMs: 250,
            sleep: async (ms) => void sleeps.push(ms),
        });
        expect(result).toBe(true);
        expect(reads).toBe(3);
        expect(sleeps).toEqual([250, 250]);
    });

    test("gives up after the attempt budget and says so", async () => {
        let reads = 0;
        const result = await awaitRevocationVisible({
            read: async () => (reads++, false),
            attempts: 4,
            sleep: async () => {},
        });
        expect(result).toBe(false);
        expect(reads).toBe(4);
    });

    test("a read that throws counts as not-yet-visible instead of ending the wait", async () => {
        // The whole point is to outlast a lagging or flaky replica — a transient RPC
        // error is exactly the situation the poll exists for.
        let reads = 0;
        const result = await awaitRevocationVisible({
            read: async () => {
                reads += 1;
                if (reads < 3) throw new Error("replica not caught up");
                return true;
            },
            sleep: async () => {},
        });
        expect(result).toBe(true);
        expect(reads).toBe(3);
    });
});
