/**
 * The checker's own proof.
 *
 * Every rule is shown to fire on a violating line and to stay silent on each form the
 * roadmap allows. The silent cases matter more: a false positive on `MOCK_USDC` or on
 * the roadmap's own "테스트넷 USDC(tUSDC)" would get the check switched off, which is
 * worse than not having it.
 */
import {describe, expect, test} from "bun:test";
import {
    findCopyViolations,
    formatFinding,
    isScopedSource,
    RULES,
    SCOPE_FILES,
    scopedFiles,
} from "./check-copy-rules";

const rulesHit = (line: string) => findCopyViolations(line).map((finding) => finding.rule);

describe("bare USDC", () => {
    test.each([
        "정산 자산은 USDC다.",
        "Agents pay in USDC on GIWA.",
        "an x402-USDC rail",
        "USDC (tUSDC) — the space breaks the allowed spelling",
        "USDC(testnet) is not the allowed spelling either",
    ])("fires on %j", (line) => {
        expect(rulesHit(line)).toEqual(["bare USDC"]);
    });

    test.each([
        "결제 자산은 GIWA Sepolia의 tUSDC다.",
        "MockUSDC deployed and verified",
        "import {MOCK_USDC} from \"@mapae/shared\";",
        "개인 거래소 계정으로 USDC(거래소)를 판다.",
        "테스트넷 USDC(tUSDC)로 쓴다.",
        "1,000원 ≈ 1.00 tUSDC (시험용 고정 환산)",
    ])("stays silent on %j", (line) => {
        expect(rulesHit(line)).toEqual([]);
    });
});

describe("mUSDC", () => {
    test.each(["Cap 3 mUSDC", "한도 ${cap} mUSDC", "<span>mUSDC</span>"])(
        "fires on %j",
        (line) => {
            expect(rulesHit(line)).toEqual(["mUSDC outside a symbol line"]);
        },
    );

    test("the on-chain symbol may be named where a symbol is shown", () => {
        expect(rulesHit('    symbol: "mUSDC",')).toEqual([]);
        expect(rulesHit("토큰 심볼은 mUSDC다.")).toEqual([]);
    });

    test("a symbol line does not license the bare ticker", () => {
        // The two rules are independent: naming the symbol excuses `mUSDC`, not `USDC`.
        expect(rulesHit("symbol mUSDC, i.e. USDC")).toEqual(["bare USDC"]);
    });
});

describe("매출·수익·구독", () => {
    test.each(["매출이 들어옵니다.", "수익률을 높입니다.", "월 구독 결제"])(
        "fires on %j",
        (line) => {
            expect(rulesHit(line)).toEqual(["매출·수익·구독 in the affirmative"]);
        },
    );

    test("silent inside the negation the roadmap prescribes", () => {
        expect(rulesHit("원화 환전·매출·수익·구독을 약속하지 않습니다.")).toEqual([]);
    });

    test("any other negation still fires — the rule is the literal '하지 않'", () => {
        expect(rulesHit("구독은 없습니다.")).toEqual(["매출·수익·구독 in the affirmative"]);
    });
});

describe("mainnet or real money", () => {
    test.each(["메인넷에서 받습니다", "실제 돈을 받는 날", "mainnet-ready today"])(
        "fires on %j",
        (line) => {
            expect(rulesHit(line)).toEqual(["mainnet or real money implied"]);
        },
    );

    test("saying that the mainnet does not exist yet is allowed", () => {
        expect(rulesHit("GIWA 메인넷은 미출시다. 실제 돈이 아니다.")).toEqual([]);
    });
});

describe("findCopyViolations", () => {
    test("reports the line number through multi-byte text", () => {
        const source = "첫 줄 😀 한글\n둘째 줄\n셋째: Cap 3 mUSDC\n";
        expect(findCopyViolations(source)).toEqual([
            {line: 3, rule: "mUSDC outside a symbol line", text: "셋째: Cap 3 mUSDC"},
        ]);
    });

    test("CRLF input keeps its line numbers and loses the carriage return", () => {
        const [finding] = findCopyViolations("safe\r\nUSDC\r\n");
        expect(finding).toEqual({line: 2, rule: "bare USDC", text: "USDC"});
    });

    test("a long line is capped by code point, never through an emoji", () => {
        const [finding] = findCopyViolations(`${"😀".repeat(130)} USDC`);
        expect(finding?.text.endsWith("…")).toBe(true);
        expect(Array.from(finding?.text ?? "")).toHaveLength(121);
        expect(finding?.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    });

    test("one line can break two rules", () => {
        expect(rulesHit("매출 1 USDC")).toEqual([
            "bare USDC",
            "매출·수익·구독 in the affirmative",
        ]);
    });

    test("every rule is exercised above", () => {
        expect(RULES.map((rule) => rule.name).sort()).toEqual(
            [
                "bare USDC",
                "mUSDC outside a symbol line",
                "매출·수익·구독 in the affirmative",
                "mainnet or real money implied",
            ].sort(),
        );
    });
});

describe("formatFinding", () => {
    test("prints file:line: rule — text", () => {
        expect(
            formatFinding("docs/mcp-guide.md", {line: 7, rule: "bare USDC", text: "USDC를 받는다"}),
        ).toBe("docs/mcp-guide.md:7: bare USDC — USDC를 받는다");
    });
});

describe("scope", () => {
    test("the prose files are the roadmap's four", () => {
        expect([...SCOPE_FILES]).toEqual([
            "README.md",
            "README.ko.md",
            "docs/mcp-guide.md",
            "docs/seller-guide.md",
        ]);
    });

    test("source files count, test files and stylesheets do not", () => {
        expect(isScopedSource("index.tsx")).toBe(true);
        expect(isScopedSource("config.ts")).toBe(true);
        expect(isScopedSource("faucet.test.ts")).toBe(false);
        expect(isScopedSource("app.css")).toBe(false);
    });

    test("the walk finds the landing and stays inside the scope", () => {
        const files = scopedFiles();
        expect(files).toContain("apps/web/src/routes/index.tsx");
        expect(files).toContain("docs/seller-guide.md");
        expect(files.some((file) => /\.test\.tsx?$/.test(file))).toBe(false);
        expect(
            files.every(
                (file) =>
                    file.startsWith("apps/web/src/") || (SCOPE_FILES as readonly string[]).includes(file),
            ),
        ).toBe(true);
    });
});
