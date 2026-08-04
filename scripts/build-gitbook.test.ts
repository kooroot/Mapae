import {describe, expect, test} from "bun:test";
import {join} from "node:path";
import {
    BANNER,
    BANNER_EN,
    chapterPath,
    diffOutputs,
    expectedOutputs,
    renderChapter,
    renderSummary,
    rewriteRelativeLinks,
    splitTechNotes,
    transformSectionBody,
} from "./build-gitbook";

const REPO = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

/**
 * A miniature tech-notes with the shapes that have to survive the split: a fenced bash
 * block whose `#` lines are comments rather than headings, a fenced text block holding
 * a line shaped exactly like a section boundary, and the `---` separators between
 * sections. Titles are real ones so `chapterPath` resolves.
 */
const FIXTURE = `# 제목

인트로 문단.

---

## 1. 시스템 구성

본문 첫 장. [회수 런북](revocation-runbook.md) 그리고 [스펙](https://example.com/x.md).

### 소제목

\`\`\`bash
# 이 주석은 헤딩이 아니다
bun run check   # [링크](fence-inside.md)
\`\`\`

---

## 2. 결제 흐름

\`\`\`text
## 3. 펜스 안의 가짜 섹션
\`\`\`

#### 깊은 소제목

[앵커](#소제목)와 [메일](mailto:a@b.c).
`;

/** The same two sections as FIXTURE, in the English edition's voice and titles. */
const FIXTURE_EN = `# Mapae — Technical notes

Intro paragraph.

---

## 1. System architecture

First chapter body. [Revocation runbook](revocation-runbook.md).

### A subsection

\`\`\`bash
# this comment is not a heading
bun run check
\`\`\`

---

## 2. Payment flows

Second chapter body. [anchor](#a-subsection).
`;

describe("the English edition", () => {
    const sectionsEn = splitTechNotes(FIXTURE_EN).sections;

    test("English chapters live one directory deeper, under tech/en/, on the same slugs", () => {
        const first = sectionsEn[0];
        expect(first).toBeDefined();
        expect(chapterPath(first!, "en")).toBe("tech/en/01-architecture.md");
        expect(chapterPath(sectionsEn[1]!, "en")).toBe("tech/en/02-payment-flows.md");
    });

    test("an unregistered English title fails loudly, naming the title", () => {
        expect(() => chapterPath({number: 9, title: "Ghost section", body: ""}, "en")).toThrow(
            /Ghost section/,
        );
    });

    test("an English chapter opens with the English banner and climbs two levels for links", () => {
        const chapter = renderChapter(sectionsEn[0]!, "en");
        expect(chapter.startsWith(`${BANNER_EN}\n\n# 1. System architecture\n\n`)).toBe(true);
        expect(chapter).toContain("](../../revocation-runbook.md)");
        // Fences and anchors keep the ko edition's guarantees.
        expect(chapter).toContain("# this comment is not a heading");
        expect(renderChapter(sectionsEn[1]!, "en")).toContain("](#a-subsection)");
    });

    test("the summary puts the English group first and preserves the ko group headings byte-for-byte", () => {
        const summary = renderSummary(splitTechNotes(FIXTURE).sections, sectionsEn);
        // Published Korean URLs derive from these exact headings (d99e67a); a reworded
        // heading silently mints new group slugs and 404s the submitted links.
        expect(summary).toContain("## 기술자료 (Tech)");
        expect(summary).toContain("## 증거와 운영 (Operations)");
        expect(summary).toContain("## Tech (English)");
        expect(summary.indexOf("Tech (English)")).toBeLessThan(summary.indexOf("기술자료 (Tech)"));
        expect(summary).toContain("* [1. System architecture](tech/en/01-architecture.md)");
        expect(summary).toContain("* [1. 시스템 구성](tech/01-architecture.md)");
        expect(summary).toContain("(README.ko.md)");
    });

    test("expectedOutputs derives both editions side by side", () => {
        const outputs = expectedOutputs(FIXTURE, FIXTURE_EN);
        expect(outputs.has("docs/tech/01-architecture.md")).toBe(true);
        expect(outputs.has("docs/tech/en/01-architecture.md")).toBe(true);
        expect(outputs.has("docs/SUMMARY.md")).toBe(true);
    });

    test("editions disagreeing on section count is a build failure, not a quiet skew", () => {
        const missingSecond = `# t\n\n## 1. System architecture\n\nbody\n`;
        expect(() => expectedOutputs(FIXTURE, missingSecond)).toThrow(/section/i);
    });
});

describe("splitTechNotes", () => {
    const split = splitTechNotes(FIXTURE);

    test("splits at numbered section headings and keeps the intro out of them", () => {
        expect(split.sections.map((section) => section.title)).toEqual(["시스템 구성", "결제 흐름"]);
        expect(split.intro).toContain("인트로 문단.");
        expect(split.sections[0]?.body).not.toContain("인트로");
    });

    test("a boundary-shaped line inside a fence does not start a section", () => {
        // Two sections, not three — and the fake heading stays inside chapter 2's fence.
        expect(split.sections).toHaveLength(2);
        expect(split.sections[1]?.body).toContain("## 3. 펜스 안의 가짜 섹션");
    });

    test("the --- separator between sections belongs to neither", () => {
        expect(split.sections[0]?.body.endsWith("---")).toBe(false);
        expect(split.sections[0]?.body).toContain("소제목");
    });
});

describe("transformSectionBody", () => {
    const body = splitTechNotes(FIXTURE).sections[0]?.body ?? "";
    const transformed = transformSectionBody(body);

    test("promotes headings one level outside fences", () => {
        expect(transformed).toContain("\n## 소제목");
        expect(transformed).not.toContain("### 소제목");
    });

    test("leaves fenced content byte-identical — bash comments are not headings", () => {
        expect(transformed).toContain("# 이 주석은 헤딩이 아니다");
        expect(transformed).toContain("[링크](fence-inside.md)");
        expect(transformed).not.toContain("../fence-inside.md");
    });

    test("relative links climb one level, absolute and anchor links stay", () => {
        expect(transformed).toContain("](../revocation-runbook.md)");
        expect(transformed).toContain("](https://example.com/x.md)");
        const second = transformSectionBody(splitTechNotes(FIXTURE).sections[1]?.body ?? "");
        expect(second).toContain("](#소제목)");
        expect(second).toContain("](mailto:a@b.c)");
    });

    test("rewriting is idempotent — an already-climbing link does not climb twice", () => {
        expect(rewriteRelativeLinks("[a](../revocation-runbook.md)")).toBe("[a](../revocation-runbook.md)");
    });
});

describe("chapter and summary rendering", () => {
    const sections = splitTechNotes(FIXTURE).sections;

    test("a chapter is banner, page title, transformed body", () => {
        const first = sections[0];
        expect(first).toBeDefined();
        const chapter = renderChapter(first!);
        expect(chapter.startsWith(`${BANNER}\n\n# 1. 시스템 구성\n\n`)).toBe(true);
        expect(chapter.endsWith("\n")).toBe(true);
    });

    test("an unregistered section title fails loudly with the title in the message", () => {
        expect(() => chapterPath({number: 9, title: "없는 섹션", body: ""})).toThrow(/없는 섹션/);
    });

    test("the summary lists every chapter once, in order, plus the standing documents", () => {
        const summary = renderSummary(sections, splitTechNotes(FIXTURE_EN).sections);
        expect(summary).toContain("* [1. 시스템 구성](tech/01-architecture.md)");
        expect(summary).toContain("* [2. 결제 흐름](tech/02-payment-flows.md)");
        expect(summary.indexOf("01-architecture")).toBeLessThan(summary.indexOf("02-payment-flows"));
        expect(summary).toContain("(deployed-contracts.md)");
        expect(summary).toContain("(giwa-demo-runbook.md)");
        expect(summary).toContain("(revocation-runbook.md)");
    });
});

describe("diffOutputs", () => {
    const expected = new Map([["docs/tech/01-architecture.md", "정본 내용\n"]]);

    test("a missing file and a stale file are both findings, and both name the fix", () => {
        const missing = diffOutputs(expected, new Map([["docs/tech/01-architecture.md", null]]), []);
        const stale = diffOutputs(expected, new Map([["docs/tech/01-architecture.md", "손으로 고친 내용\n"]]), []);
        expect(missing).toHaveLength(1);
        expect(missing[0]).toContain("missing");
        expect(stale).toHaveLength(1);
        expect(stale[0]).toContain("gitbook:build");
    });

    test("a byte-identical rendering has no findings", () => {
        expect(diffOutputs(expected, new Map([["docs/tech/01-architecture.md", "정본 내용\n"]]), [])).toEqual([]);
    });

    test("an orphan chapter is a finding — a deleted section must take its page along", () => {
        const failures = diffOutputs(expected, new Map([["docs/tech/01-architecture.md", "정본 내용\n"]]), [
            "docs/tech/07-ghost.md",
        ]);
        expect(failures.some((failure) => failure.includes("07-ghost"))).toBe(true);
    });
});

describe("against the real docs/tech-notes.md", () => {
    const load = async (): Promise<[string, string]> =>
        Promise.all([
            Bun.file(join(REPO, "docs/tech-notes.md")).text(),
            Bun.file(join(REPO, "docs/tech-notes.en.md")).text(),
        ]);

    test("every section has a registered slug and derives a chapter in both editions", async () => {
        const outputs = expectedOutputs(...(await load()));
        const chapters = [...outputs.keys()].filter((path) => path.startsWith("docs/tech/"));
        expect(chapters.length).toBeGreaterThanOrEqual(12);
        for (const path of chapters) {
            expect(path).toMatch(/^docs\/tech\/(en\/)?\d{2}-[a-z-]+\.md$/);
        }
        expect(outputs.has(".gitbook.yaml")).toBe(true);
        expect(outputs.has("docs/SUMMARY.md")).toBe(true);
    });

    test("no chapter still contains a section-boundary heading — the split consumed them all", async () => {
        const outputs = expectedOutputs(...(await load()));
        for (const [path, content] of outputs) {
            if (!path.startsWith("docs/tech/")) continue;
            const banner = path.startsWith("docs/tech/en/") ? BANNER_EN : BANNER;
            expect(content.startsWith(banner)).toBe(true);
            let inFence = false;
            for (const line of content.split("\n")) {
                if (/^```/.test(line)) inFence = !inFence;
                if (!inFence) expect(line).not.toMatch(/^## \d+\. /);
            }
        }
    });

    test("the payment-flows chapter carries the mermaid diagram through intact, in both editions", async () => {
        const outputs = expectedOutputs(...(await load()));
        for (const path of ["docs/tech/02-payment-flows.md", "docs/tech/en/02-payment-flows.md"]) {
            const chapter = outputs.get(path) ?? "";
            expect(chapter).toContain("```mermaid");
            expect(chapter).toContain("sequenceDiagram");
        }
    });
});
