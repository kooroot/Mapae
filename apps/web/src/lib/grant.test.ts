import {describe, expect, test} from "bun:test";
import {validateGrantDraft, type GrantDraft} from "./grant";

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
