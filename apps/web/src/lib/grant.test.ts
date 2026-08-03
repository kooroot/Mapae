import {describe, expect, test} from "bun:test";
import {judgeSpendable, signedSessionGrant, validateGrantDraft, type GrantDraft} from "./grant";

/**
 * `DelegationManager.ANY_DELEGATE` — the framework sentinel that makes a delegation
 * redeemable by anyone. Legitimate in a *leaf*, where a single `RedeemerEnforcer` binds
 * it; catastrophic in a *root*, where it would hand the whole period cap to any caller.
 */
const ANY_DELEGATE = "0x0000000000000000000000000000000000000a11";

const ADDRESS = "0x0229346e91a07EA24A54704F094D293E43E9d302";
const base: GrantDraft = {
    agentName: "Invoice agent",
    delegate: ADDRESS,
    amount: "25.5",
    periodSeconds: "86400",
    expirySeconds: "2592000",
    recipientMode: "any",
    recipient: "",
};

describe("grant draft", () => {
    test("turns human limits into a period policy input", () => {
        const result = validateGrantDraft(base);
        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") return;
        expect(result.value.periodAmount).toBe(25_500_000n);
        expect(result.value.delegate).toBe(ADDRESS);
        expect(result.value.recipient).toBeUndefined();
    });

    test("requires a fixed recipient when that boundary is selected", () => {
        const result = validateGrantDraft({...base, recipientMode: "fixed"});
        expect(result).toEqual({
            kind: "invalid",
            field: "recipient",
            reason: "허용할 수취인의 0x 주소를 확인해 주세요.",
        });
    });

    test("rejects a permission that expires before its first period completes", () => {
        const result = validateGrantDraft({
            ...base,
            periodSeconds: "604800",
            expirySeconds: "86400",
        });
        expect(result.kind).toBe("invalid");
        if (result.kind === "invalid") expect(result.field).toBe("expirySeconds");
    });

    test("rejects zero and excess token precision", () => {
        expect(validateGrantDraft({...base, amount: "0"}).kind).toBe("invalid");
        expect(validateGrantDraft({...base, amount: "1.0000001"}).kind).toBe("invalid");
    });

    test("rejects zero addresses at both authority boundaries", () => {
        const zero = "0x0000000000000000000000000000000000000000";
        expect(validateGrantDraft({...base, delegate: zero}).kind).toBe("invalid");
        expect(
            validateGrantDraft({
                ...base,
                recipientMode: "fixed",
                recipient: zero,
            }).kind,
        ).toBe("invalid");
    });
});

describe("ANY_DELEGATE in the root form", () => {
    test("is refused as a delegate", () => {
        const result = validateGrantDraft({...base, delegate: ANY_DELEGATE});
        expect(result.kind).toBe("invalid");
        if (result.kind !== "invalid") return;
        expect(result.field).toBe("delegate");
    });

    test("is refused in mixed case too — the check is not a string compare", () => {
        const result = validateGrantDraft({
            ...base,
            delegate: "0x0000000000000000000000000000000000000A11",
        });
        expect(result.kind).toBe("invalid");
    });

    test("is refused as a recipient", () => {
        const result = validateGrantDraft({
            ...base,
            recipientMode: "fixed",
            recipient: ANY_DELEGATE,
        });
        expect(result.kind).toBe("invalid");
        if (result.kind !== "invalid") return;
        expect(result.field).toBe("recipient");
    });
});

describe("judgeSpendable", () => {
    test("the cap is the limit when the account holds more than it", () => {
        const result = judgeSpendable({available: 3_000_000n, balance: 10_000_000n});
        expect(result).toEqual({spendable: 3_000_000n, limitedBy: "cap"});
    });

    test("the balance is the limit when it sits below the cap", () => {
        const result = judgeSpendable({available: 3_000_000n, balance: 1_000_000n});
        expect(result).toEqual({spendable: 1_000_000n, limitedBy: "balance"});
    });

    test("an empty account can spend nothing, whatever the cap says", () => {
        // The bug this exists to stop: a freshly bootstrapped account shows the full
        // period cap as "available" while holding zero tokens, so the first payment
        // fails in the token transfer rather than at the enforcer, and the user is told
        // "settlement failed" instead of "you have no balance".
        const result = judgeSpendable({available: 3_000_000n, balance: 0n});
        expect(result).toEqual({spendable: 0n, limitedBy: "balance"});
    });

    test("equal cap and balance is reported as cap-limited", () => {
        const result = judgeSpendable({available: 5n, balance: 5n});
        expect(result.limitedBy).toBe("cap");
    });

    test("an unread balance is not treated as zero", () => {
        // A read we could not make is a question we cannot answer, not an answer of zero.
        const result = judgeSpendable({available: 3_000_000n, balance: undefined});
        expect(result).toEqual({spendable: 3_000_000n, limitedBy: "unknown"});
    });
});

describe("signedSessionGrant", () => {
    const artifact = {
        frameworkVersion: "1.3.0",
        chainId: 91342,
        role: "open-agent",
        delegator: "0x15286FE9A48d52504607bEaaa021B29194353301",
        delegate: "0xA350522aE469DFA53a117aFD268a60C0e322a321",
        permissionContext: ("0x" + "cd".repeat(80)) as `0x${string}`,
        createdAt: 1_700_000_000,
    } as Parameters<typeof signedSessionGrant>[0];
    const value = {
        agentName: "invoice agent",
        delegate: "0xA350522aE469DFA53a117aFD268a60C0e322a321",
        periodAmount: 3_000_000n,
        periodDurationSeconds: 86_400,
        expiresAfterSeconds: 2_592_000,
    } as Parameters<typeof signedSessionGrant>[1];

    test("carries a browser-generated agent key through to the session grant", () => {
        const agentKey = {
            address: "0xA350522aE469DFA53a117aFD268a60C0e322a321",
            privateKey: ("0x" + "11".repeat(32)) as `0x${string}`,
        } as const;
        const grant = signedSessionGrant(artifact, value, agentKey);
        expect(grant.agentKey).toEqual(agentKey);
    });

    test("a grant for a user-supplied address has no agent key", () => {
        const grant = signedSessionGrant(artifact, value);
        expect(grant.agentKey).toBeUndefined();
    });
});
