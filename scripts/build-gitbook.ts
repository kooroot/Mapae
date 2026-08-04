/**
 * Generate the GitBook rendering of `docs/tech-notes.md` — and refuse drift.
 *
 * GitBook wants one page per chapter, but this repository's rule is that
 * `docs/tech-notes.md` is the single source of truth for the technical narrative.
 * Hand-split chapter copies would be a second truth: the first edit that lands in only
 * one of the two makes the published book quietly disagree with the repository — the
 * same failure shape as the EIP-712 domain living in two files. So the chapters are
 * build artifacts, not documents. `bun run gitbook:build` derives them; `bun run
 * check:gitbook` (inside `bun run check`) re-derives everything in memory and fails on
 * any byte of difference, in either direction — a stale chapter and a hand-edited
 * chapter are the same finding.
 *
 * The transforms are deliberately small and mechanical: promote headings one level
 * (a chapter's `## N. title` becomes its page `# `), prefix relative links with `../`
 * (chapters live one directory deeper than the source), and strip the `---` section
 * separators. Everything else is byte-identical, which is what lets `check-docs.ts`
 * hold the generated files to the same command/link/address standard as the source.
 *
 * Static, instant, offline — the same promise as `check-docs.ts`, and it runs in the
 * same gate chain. The cover page (`docs/README.md`) is authored by hand and is
 * *not* generated: it is a distinct document with its own voice, not a rendering.
 */
import {mkdirSync, readdirSync, rmSync} from "node:fs";
import {join} from "node:path";

const REPO = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

const SOURCE = "docs/tech-notes.md";
const SOURCE_EN = "docs/tech-notes.en.md";

/**
 * Section titles → URL slugs, maintained by hand on purpose. Deriving slugs from the
 * Korean titles automatically would make every URL a transliteration guess, and a
 * renamed section would silently mint a new URL while the old one 404s. A new section
 * with no entry here fails the build with its title in the message.
 */
const SLUGS = new Map<string, string>([
    ["시스템 구성", "architecture"],
    ["결제 흐름", "payment-flows"],
    ["에러 모델", "error-model"],
    ["보안 고려", "security"],
    ["확인된 온체인 환경", "onchain-environment"],
    ["검증 상태와 로드맵", "roadmap"],
]);

/**
 * The English edition reuses the SAME slugs so the two editions stay URL-parallel:
 * `/tech/01-architecture` and `/tech/en/01-architecture` are the same chapter in two
 * languages. A section pair that disagrees on its slug is a registration mistake, not
 * a translation choice.
 */
const SLUGS_EN = new Map<string, string>([
    ["System architecture", "architecture"],
    ["Payment flows", "payment-flows"],
    ["Error model", "error-model"],
    ["Security considerations", "security"],
    ["Verified on-chain environment", "onchain-environment"],
    ["Verification status and roadmap", "roadmap"],
]);

export type Lang = "ko" | "en";

/**
 * Every generated file opens with this. An HTML comment renders as nothing on GitBook
 * and GitHub, but the first thing an editor sees is where the real file lives.
 */
export const BANNER =
    "<!-- 생성된 파일 — 직접 수정하지 말 것. 정본은 `docs/tech-notes.md`, 재생성은 `bun run gitbook:build`. -->";

export const BANNER_EN =
    "<!-- Generated file — do not edit. The source of truth is `docs/tech-notes.en.md`; regenerate with `bun run gitbook:build`. -->";

/**
 * Owned here rather than committed free-standing so that `check:gitbook` also catches
 * the config drifting — a wrong `root:` makes GitBook import the whole repository.
 */
const GITBOOK_YAML = `# GitBook Git Sync — 책의 루트는 docs/, 표지는 원페이저(README.md)다.
# 이 파일은 scripts/build-gitbook.ts 가 소유한다. 바꾸려면 그 스크립트를 바꿀 것.
root: ./docs/
structure:
  readme: README.md
  summary: SUMMARY.md
`;

export interface TechNotesSection {
    number: number;
    title: string;
    /** The body exactly as it sits in tech-notes.md, heading and separators excluded. */
    body: string;
}

export interface TechNotesSplit {
    intro: string;
    sections: TechNotesSection[];
}

const FENCE = /^```/;
const SECTION = /^## (\d+)\. (.+)$/;

/**
 * Split the source into its numbered `## N. title` sections, fence-aware. The fence
 * tracking is not paranoia: the source's bash blocks start lines with `#` and a text
 * block could legitimately contain a line shaped like a heading — splitting there
 * would tear a code block in half and the result would still look plausible.
 */
export function splitTechNotes(text: string): TechNotesSplit {
    const introLines: string[] = [];
    const sections: TechNotesSection[] = [];
    let current: {number: number; title: string; lines: string[]} | null = null;
    let inFence = false;
    for (const line of text.split("\n")) {
        if (FENCE.test(line)) inFence = !inFence;
        const match = inFence ? null : SECTION.exec(line);
        if (match?.[1] !== undefined && match[2] !== undefined) {
            if (current) sections.push(finishSection(current));
            current = {number: Number(match[1]), title: match[2].trim(), lines: []};
            continue;
        }
        (current ? current.lines : introLines).push(line);
    }
    if (current) sections.push(finishSection(current));
    return {intro: introLines.join("\n"), sections};
}

function finishSection(partial: {number: number; title: string; lines: string[]}): TechNotesSection {
    // The `---` before the next section is a separator between chapters, not content
    // of either; on its own page it would render as a stray horizontal rule.
    const body = partial.lines
        .join("\n")
        .replace(/\n+---\s*$/, "")
        .replace(/^\n+/, "")
        .replace(/\n+$/, "");
    return {number: partial.number, title: partial.title, body};
}

/** Apply `transform` to every line that sits outside a fenced code block. */
function mapOutsideFences(text: string, transform: (line: string) => string): string {
    let inFence = false;
    return text
        .split("\n")
        .map((line) => {
            if (FENCE.test(line)) {
                inFence = !inFence;
                return line;
            }
            return inFence ? line : transform(line);
        })
        .join("\n");
}

/**
 * Chapters live in `docs/tech/`, one directory below the source, so a link that
 * `check-docs.ts` verified against `docs/` must climb one level to keep resolving.
 * Absolute URLs, mailto and in-page anchors are position-independent and stay put.
 */
export function rewriteRelativeLinks(line: string, depth = 1): string {
    const climb = "../".repeat(depth);
    return line.replace(/\]\(([^)\s]+)(\s[^)]*)?\)/g, (whole, target: string, title: string | undefined) => {
        if (/^(https?:|mailto:|#|\.\.\/)/.test(target)) return whole;
        return `](${climb}${target}${title ?? ""})`;
    });
}

/**
 * The section heading becomes the page's `# ` title, so every heading below it moves
 * up one level to keep the hierarchy contiguous.
 */
export function transformSectionBody(body: string, depth = 1): string {
    return mapOutsideFences(body, (line) => {
        const promoted = /^#{2,6} /.test(line) ? line.slice(1) : line;
        return rewriteRelativeLinks(promoted, depth);
    });
}

export function chapterPath(section: TechNotesSection, lang: Lang = "ko"): string {
    const slugs = lang === "en" ? SLUGS_EN : SLUGS;
    const slug = slugs.get(section.title);
    if (slug === undefined) {
        throw new Error(
            `no slug registered for section "${section.title}" — ` +
                `add it to ${lang === "en" ? "SLUGS_EN" : "SLUGS"} in scripts/build-gitbook.ts ` +
                "so its URL is chosen, not guessed",
        );
    }
    const prefix = lang === "en" ? "tech/en/" : "tech/";
    return `${prefix}${String(section.number).padStart(2, "0")}-${slug}.md`;
}

export function renderChapter(section: TechNotesSection, lang: Lang = "ko"): string {
    const banner = lang === "en" ? BANNER_EN : BANNER;
    // English chapters sit at docs/tech/en/ — two levels below docs/ — so their
    // relative links climb twice where the Korean chapters climb once.
    const depth = lang === "en" ? 2 : 1;
    return `${banner}\n\n# ${section.number}. ${section.title}\n\n${transformSectionBody(section.body, depth)}\n`;
}

export function renderSummary(
    sectionsKo: TechNotesSection[],
    sectionsEn: TechNotesSection[],
): string {
    const chaptersKo = sectionsKo
        .map((section) => `* [${section.number}. ${section.title}](${chapterPath(section)})`)
        .join("\n");
    const chaptersEn = sectionsEn
        .map((section) => `* [${section.number}. ${section.title}](${chapterPath(section, "en")})`)
        .join("\n");
    // No banner here, unlike the chapters: GitBook's summary parser is documented for
    // headings and list items only, and what it does with an HTML comment ahead of the
    // required top-level heading is documented nowhere. The drift gate pins these bytes
    // anyway, so the ownership marker is not load-bearing in this one file.
    // The English parentheticals are load-bearing, not decoration: GitBook derives each
    // group's URL segment from the ASCII left after slugifying the heading, so a
    // Korean-only title slugs to an empty string and the site falls back to
    // /undefined/, /undefined-1/. "(Tech)" and "(Operations)" make the URLs
    // /tech/… and /operations/….
    //
    // The English group comes first because English is the base language of the public
    // site — but the TWO EXISTING group headings are byte-frozen: published Korean URLs
    // derive from them (d99e67a measured the failure), and the submitted GASOK links
    // must keep resolving.
    return `# Summary

* [Mapae one-pager](README.md)
* [마패 원페이저 (한국어)](README.ko.md)

## Tech (English)

${chaptersEn}

## 기술자료 (Tech)

${chaptersKo}

## 증거와 운영 (Operations)

* [배포 컨트랙트](deployed-contracts.md)
* [MCP 연결 가이드](mcp-guide.md)
* [GIWA 데모 런북](giwa-demo-runbook.md)
* [회수 런북](revocation-runbook.md)
`;
}

/** Everything the generator owns, keyed by repository-relative path. */
export function expectedOutputs(sourceKo: string, sourceEn: string): Map<string, string> {
    const {sections: sectionsKo} = splitTechNotes(sourceKo);
    const {sections: sectionsEn} = splitTechNotes(sourceEn);
    // The editions are the same document in two languages. A section present in one and
    // not the other is a half-translated book; failing here keeps that out of the gate
    // instead of publishing a skewed summary.
    if (sectionsKo.length !== sectionsEn.length) {
        throw new Error(
            `edition skew: ${SOURCE} has ${sectionsKo.length} sections, ` +
                `${SOURCE_EN} has ${sectionsEn.length} — every section needs both languages`,
        );
    }
    for (const [index, ko] of sectionsKo.entries()) {
        const en = sectionsEn[index];
        if (en && (en.number !== ko.number || chapterPath(en, "en").slice(8) !== chapterPath(ko).slice(5))) {
            throw new Error(
                `edition skew at section ${ko.number}: "${ko.title}" pairs with "${en.title}" ` +
                    "but they derive different slugs — the editions must stay URL-parallel",
            );
        }
    }
    const outputs = new Map<string, string>();
    outputs.set(".gitbook.yaml", GITBOOK_YAML);
    outputs.set("docs/SUMMARY.md", renderSummary(sectionsKo, sectionsEn));
    for (const section of sectionsKo) {
        outputs.set(`docs/${chapterPath(section)}`, renderChapter(section));
    }
    for (const section of sectionsEn) {
        outputs.set(`docs/${chapterPath(section, "en")}`, renderChapter(section, "en"));
    }
    return outputs;
}

/**
 * Compare what the source derives against what is on disk. Pure so the failure modes
 * are testable without a filesystem: `null` in `actual` means the file is missing, and
 * `orphans` are files in the generated directory that nothing derives any more — a
 * deleted section must take its page with it, or the book keeps publishing it.
 */
export function diffOutputs(
    expected: Map<string, string>,
    actual: Map<string, string | null>,
    orphans: string[],
): string[] {
    const failures: string[] = [];
    for (const [path, content] of expected) {
        const found = actual.get(path);
        if (found === null || found === undefined) {
            failures.push(`${path}: missing — run \`bun run gitbook:build\` and commit the result`);
        } else if (found !== content) {
            failures.push(`${path}: differs from what docs/tech-notes.md derives — run \`bun run gitbook:build\``);
        }
    }
    for (const orphan of orphans) {
        failures.push(`${orphan}: exists but nothing in docs/tech-notes.md derives it — remove it or restore its section`);
    }
    return failures;
}

function listChapterFiles(): string[] {
    const list = (dir: string): string[] => {
        try {
            return readdirSync(join(REPO, dir))
                .filter((entry) => entry.endsWith(".md"))
                .map((entry) => `${dir}/${entry}`);
        } catch {
            return []; // the missing directory surfaces as every chapter reported missing
        }
    };
    return [...list("docs/tech"), ...list("docs/tech/en")];
}

async function readActual(paths: Iterable<string>): Promise<Map<string, string | null>> {
    const actual = new Map<string, string | null>();
    for (const path of paths) {
        const file = Bun.file(join(REPO, path));
        actual.set(path, (await file.exists()) ? await file.text() : null);
    }
    return actual;
}

async function main(): Promise<void> {
    const check = process.argv.includes("--check");
    const source = await Bun.file(join(REPO, SOURCE)).text();
    const sourceEn = await Bun.file(join(REPO, SOURCE_EN)).text();
    const expected = expectedOutputs(source, sourceEn);
    const orphans = listChapterFiles().filter((path) => !expected.has(path));

    if (check) {
        const failures = diffOutputs(expected, await readActual(expected.keys()), orphans);
        if (failures.length > 0) {
            console.error(`[gitbook] ${failures.length} problem(s):`);
            for (const failure of failures) console.error(`  ✗ ${failure}`);
            process.exit(1);
        }
        const chapters = expected.size - 2; // minus SUMMARY and .gitbook.yaml
        console.log(
            `[gitbook] ${chapters} chapters + SUMMARY + .gitbook.yaml are exactly what ${SOURCE} derives`,
        );
        return;
    }

    mkdirSync(join(REPO, "docs/tech/en"), {recursive: true});
    // Orphans go first. On a case-insensitive filesystem a case-only rename makes the
    // stray file and an expected chapter the same inode: reading first counts the
    // chapter "unchanged", and the orphan removal then deletes it — leaving a build
    // that needs a second run to converge. Measured, not hypothesized.
    for (const orphan of orphans) {
        rmSync(join(REPO, orphan));
        console.log(`[gitbook] removed orphan ${orphan}`);
    }
    let written = 0;
    let unchanged = 0;
    const actual = await readActual(expected.keys());
    for (const [path, content] of expected) {
        if (actual.get(path) === content) {
            unchanged += 1;
            continue;
        }
        await Bun.write(join(REPO, path), content);
        written += 1;
    }
    console.log(`[gitbook] ${written} file(s) written, ${unchanged} unchanged, ${orphans.length} orphan(s) removed`);
}

if (import.meta.main) await main();
