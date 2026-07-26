/**
 * The checker's own proof.
 *
 * `scripts/check-docs.ts` reported 25 problems on its first run and 24 of them were its
 * own bugs — an address regex that matched the first 40 hex digits of a transaction
 * hash, a command regex that read `bun run index.ts` as a script named `index`. A
 * checker that sits in `bun run check` and has never been shown to *fail* proves nothing
 * when it passes.
 *
 * The negative cases matter more than the positive ones here. A false positive gets the
 * check switched off, which is worse than not having it.
 */
import {describe, expect, test} from "bun:test";
import {findLogLeaks, stripNonCode} from "./check-logging.js";

const leaks = (source: string) => findLogLeaks(source).map((finding) => finding.label);

describe("stripNonCode", () => {
    test("keeps offsets and newlines so reported lines stay right", () => {
        const source = 'const a = "hello";\nconst b = 1;\n';
        const stripped = stripNonCode(source);
        expect(stripped.length).toBe(source.length);
        expect(stripped.split("\n").length).toBe(source.split("\n").length);
        expect(stripped).not.toContain("hello");
        expect(stripped).toContain("const a =");
    });

    test("blanks line and block comments", () => {
        expect(stripNonCode("// error.message\ncode()")).not.toContain("error.message");
        expect(stripNonCode("/* error.message */ code()")).not.toContain("error.message");
    });

    test("survives a regex literal holding both quote characters", () => {
        // This is not a hypothetical: it is `redactUrls` in packages/shared/src/errors.ts.
        // A stripper that does not know regex literals reads the `"` inside the character
        // class as a string opening and desynchronises for the rest of the file — every
        // later console call would then be invisible to the check.
        const source = String.raw`
const RE = /\bhttps?:\/\/[^\s"'<>)\]}]+/gi;
console.error(error.message);
`;
        expect(leaks(source)).toContain("error.message");
    });

    test("division is not mistaken for a regex", () => {
        const source = "const half = total / 2;\nconsole.error(error.message);";
        expect(leaks(source)).toContain("error.message");
    });

    test("template interpolations stay code, literal text does not", () => {
        expect(leaks("console.error(`x ${error.message} y`)")).toEqual(["error.message"]);
        expect(leaks("console.error(`not error.message here`)")).toEqual([]);
    });

    test("nested templates inside interpolations resynchronise", () => {
        const source = "console.error(`a ${cond ? `b ${error.message}` : ''} c`)";
        expect(leaks(source)).toContain("error.message");
    });
});

describe("findLogLeaks", () => {
    test("catches every documented escape shape", () => {
        expect(leaks("console.error(error.message)")).toEqual(["error.message"]);
        expect(leaks("console.error(err.message)")).toEqual(["error.message"]);
        expect(leaks("console.error(String(error))")).toEqual(["String(error)"]);
        expect(leaks("console.error(e.stack)")).toEqual([".stack"]);
        expect(leaks("console.log(JSON.stringify(error, null, 2))")).toEqual([
            "JSON.stringify(error)",
        ]);
        // The exact expression that survived the manual sweep in apps/agent/index.ts.
        expect(
            leaks("console.error(`\\n${err instanceof Error ? err.message : String(err)}`)"),
        ).toEqual(["error.message", "String(error)"]);
    });

    test("optional chaining does not launder the leak", () => {
        // The form a person writes while tidying a catch block, and the one the first
        // draft of this check missed. Found by probing shapes the tests did not cover.
        expect(leaks("console.error(error?.message)")).toEqual(["error.message"]);
        expect(leaks("console.error(err?.stack)")).toEqual([".stack"]);
        expect(leaks("console.error(String(error?.cause))")).toEqual(["String(error)"]);
        expect(leaks("console.error(JSON.stringify(err?.cause?.message))")).toEqual([
            "error.message",
            "JSON.stringify(error)",
        ]);
    });

    test("`.stack` is refused without a name guard", () => {
        // On a viem BaseError the stack begins with the composed message including
        // `URL:` — it leaks more than `.message`, and past redactForLog's 300-char cap.
        expect(leaks("console.error(somethingElse.stack)")).toEqual([".stack"]);
    });

    test("a redacted error is allowed", () => {
        expect(leaks("console.error(redactForLog(error))")).toEqual([]);
        expect(leaks("console.error(redactUrls(error.stack ?? ''))")).toEqual([]);
        expect(leaks("console.error(`x ${redactForLog(error, 200)} y`)")).toEqual([]);
    });

    test("only console sinks are inspected", () => {
        // Stated scope, pinned so a later reader does not assume wider coverage.
        expect(leaks("return {detail: error.message};")).toEqual([]);
        expect(leaks("throw new Error(error.message)")).toEqual([]);
    });

    test("unrelated identifiers named like fields are left alone", () => {
        expect(leaks("console.log(response.message)")).toEqual([]);
        expect(leaks("console.log(body.reason)")).toEqual([]);
        expect(leaks("console.log(String(count))")).toEqual([]);
    });

    test("a second console call after a stripped one is still scanned", () => {
        const source = 'console.log("safe");\nconsole.error(error.message);';
        expect(leaks(source)).toEqual(["error.message"]);
    });

    test("reports the line the leak is on, not the line the call starts on", () => {
        const source = ["console.error(", "    'prefix',", "    error.message,", ");"].join("\n");
        const [finding] = findLogLeaks(source);
        expect(finding?.line).toBe(3);
    });
});
