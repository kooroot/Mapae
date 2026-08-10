import {describe, expect, test} from "bun:test";
import {isRelativeDocLink, resolveDocLink} from "./links";

/** Every markdown file under `docs/`, published or not — what the build passes in. */
const REPO_DOCS = new Set([
    "README.md",
    "README.ko.md",
    "deployed-contracts.md",
    "mcp-guide.md",
    "giwa-demo-runbook.md",
    "revocation-runbook.md",
    "infra-map.md",
    "tech-notes.md",
    "tech-notes.en.md",
    "tech/01-architecture.md",
    "tech/02-payment-flows.md",
    "tech/en/01-architecture.md",
    "tech/en/02-payment-flows.md",
    "tech/en/03-error-model.md",
]);

describe("isRelativeDocLink", () => {
    test("repository-relative markdown links are rewritten", () => {
        expect(isRelativeDocLink("deployed-contracts.md")).toBe(true);
        expect(isRelativeDocLink("../mcp-guide.md")).toBe(true);
        expect(isRelativeDocLink("tech/en/01-architecture.md")).toBe(true);
    });

    test("absolute destinations are left alone", () => {
        // The docs link out to GitHub and the explorer, and those must survive untouched.
        expect(isRelativeDocLink("https://github.com/kooroot/Mapae/blob/main/docs/tech-notes.md"))
            .toBe(false);
        expect(isRelativeDocLink("mailto:hi@mapae.io")).toBe(false);
        expect(isRelativeDocLink("//cdn.example/x.md")).toBe(false);
        expect(isRelativeDocLink("/operations/mcp-guide")).toBe(false);
    });

    test("a bare fragment or a non-markdown target is not a doc link", () => {
        expect(isRelativeDocLink("#section")).toBe(false);
        expect(isRelativeDocLink("../images/flow.png")).toBe(false);
    });
});

describe("resolveDocLink", () => {
    test("resolves from the linking file's own directory", () => {
        // A chapter reaching back up to a top-level operations document.
        expect(resolveDocLink("tech/02-payment-flows.md", "../mcp-guide.md", REPO_DOCS)).toBe(
            "/operations/mcp-guide",
        );
        // The English chapters sit one level deeper, so the same target needs `../../`.
        expect(resolveDocLink("tech/en/02-payment-flows.md", "../../mcp-guide.md", REPO_DOCS)).toBe(
            "/operations/mcp-guide",
        );
    });

    test("resolves downward from a cover page", () => {
        expect(resolveDocLink("README.md", "tech/en/01-architecture.md", REPO_DOCS)).toBe(
            "/tech-english/01-architecture",
        );
        expect(resolveDocLink("README.ko.md", "tech/01-architecture.md", REPO_DOCS)).toBe(
            "/tech/01-architecture",
        );
        expect(resolveDocLink("mcp-guide.md", "deployed-contracts.md", REPO_DOCS)).toBe(
            "/operations/deployed-contracts",
        );
    });

    test("the book root is a bare slash, not an empty href", () => {
        // `README.md` publishes at `""`; emitting `` would make the link inert.
        expect(resolveDocLink("README.ko.md", "README.md", REPO_DOCS)).toBe("/");
    });

    test("keeps a fragment", () => {
        expect(resolveDocLink("README.md", "tech/en/03-error-model.md#tags", REPO_DOCS)).toBe(
            "/tech-english/03-error-model#tags",
        );
    });

    test("an unpublished but real document falls back to its GitHub source", () => {
        // `docs/tech-notes.md` is deliberately absent from SUMMARY.md, and
        // `revocation-runbook.md` links to it. GitBook resolved that to GitHub, so this
        // does too — the alternative is a 404 where a reader currently gets the document.
        expect(resolveDocLink("revocation-runbook.md", "tech-notes.md", REPO_DOCS)).toBe(
            "https://github.com/kooroot/Mapae/blob/main/docs/tech-notes.md",
        );
        expect(resolveDocLink("README.md", "infra-map.md", REPO_DOCS)).toBe(
            "https://github.com/kooroot/Mapae/blob/main/docs/infra-map.md",
        );
    });

    test("throws when the target is not a file in the repository at all", () => {
        // A typo, not a publishing decision — and the only case worth stopping a build for.
        expect(() => resolveDocLink("README.md", "does-not-exist.md", REPO_DOCS)).toThrow(
            /does not exist/,
        );
    });
});
