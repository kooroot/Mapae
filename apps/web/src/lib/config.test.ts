import {afterEach, describe, expect, test} from "bun:test";
import {
    bootstrapAvailability,
    publicSubmitterAvailability,
    submitterAvailability,
} from "./config";

/**
 * These pins moved here from the retired console's `config.test.ts` — the guards they
 * cover now live in this app, and a guard nobody pins gets deleted as "redundant" the
 * next time someone tidies. Two properties matter and both are secrets properties, not
 * connectivity ones: a refusal names the *host* and never echoes the rest of the URL
 * (a keyed RPC URL carries its secret in the path, and this text reaches the DOM), and
 * a value that parses but points somewhere unexpected is refused rather than used.
 *
 * The path-refusal cases are new, not ported: every endpoint variable here is a
 * *path-less origin* — the client appends `/revoke` or `/bootstrap` itself — and a
 * pathed value used to pass the hostname-only check and 404 at runtime as
 * `/revoke/revoke`. That was a documented trap; refusing it here makes it a visible
 * configuration error instead of a silent dead button.
 */

const VARS = [
    "VITE_REVOCATION_SUBMITTER_URL",
    "VITE_REVOCATION_SUBMITTER_PUBLIC_URL",
    "VITE_BOOTSTRAP_URL",
] as const;

afterEach(() => {
    for (const name of VARS) delete process.env[name];
});

describe("submitterAvailability (loopback pinned submitter)", () => {
    test("unset means the revoke pill has nothing to report", () => {
        expect(submitterAvailability()).toEqual({kind: "absent"});
    });

    test("loopback is accepted and reduced to an origin", () => {
        process.env["VITE_REVOCATION_SUBMITTER_URL"] = "http://127.0.0.1:8082/";
        expect(submitterAvailability()).toEqual({
            kind: "configured",
            url: "http://127.0.0.1:8082",
        });
    });

    test("a remote submitter is refused — it holds a funded relayer key and has no auth", () => {
        process.env["VITE_REVOCATION_SUBMITTER_URL"] = "https://submitter.example.io:8082";
        const result = submitterAvailability();
        expect(result.kind).toBe("refused");
    });

    test("the refusal names the host, never the rest of the URL", () => {
        process.env["VITE_REVOCATION_SUBMITTER_URL"] =
            "https://private.example.io/super-secret-key";
        const result = submitterAvailability();
        if (result.kind !== "refused") throw new Error("expected a refusal");
        expect(result.reason).toContain("private.example.io");
        expect(result.reason).not.toContain("super-secret-key");
    });

    test("a malformed value fails loudly rather than silently disabling the pill", () => {
        process.env["VITE_REVOCATION_SUBMITTER_URL"] = "not a url";
        expect(submitterAvailability().kind).toBe("refused");
    });
});

describe("publicSubmitterAvailability (sponsored /revoke)", () => {
    test("the tunnel origin is accepted", () => {
        process.env["VITE_REVOCATION_SUBMITTER_PUBLIC_URL"] = "https://facilitator.mapae.io";
        expect(publicSubmitterAvailability()).toEqual({
            kind: "configured",
            url: "https://facilitator.mapae.io",
        });
    });

    test("any other public host is refused, naming the host only", () => {
        process.env["VITE_REVOCATION_SUBMITTER_PUBLIC_URL"] =
            "https://evil.example/with-a-path-segment";
        const result = publicSubmitterAvailability();
        if (result.kind !== "refused") throw new Error("expected a refusal");
        expect(result.reason).toContain("evil.example");
        expect(result.reason).not.toContain("with-a-path-segment");
    });

    test("plaintext HTTP to a remote host is refused", () => {
        process.env["VITE_REVOCATION_SUBMITTER_PUBLIC_URL"] = "http://facilitator.mapae.io";
        expect(publicSubmitterAvailability().kind).toBe("refused");
    });

    test("a pathed value is refused — the client appends /revoke itself", () => {
        // The exact misconfiguration the first wiring runbook shipped: the right host
        // with "/revoke" already attached passes a hostname-only check and every later
        // request lands on /revoke/revoke as a 404. Refusing it turns a silent dead
        // button into a named configuration error.
        process.env["VITE_REVOCATION_SUBMITTER_PUBLIC_URL"] =
            "https://facilitator.mapae.io/revoke";
        const result = publicSubmitterAvailability();
        expect(result.kind).toBe("refused");
    });
});

describe("bootstrapAvailability (sponsored onboarding)", () => {
    test("the tunnel origin is accepted", () => {
        process.env["VITE_BOOTSTRAP_URL"] = "https://facilitator.mapae.io";
        expect(bootstrapAvailability()).toEqual({
            kind: "configured",
            url: "https://facilitator.mapae.io",
        });
    });

    test("a pathed value is refused — the client appends /bootstrap itself", () => {
        process.env["VITE_BOOTSTRAP_URL"] = "https://facilitator.mapae.io/bootstrap";
        expect(bootstrapAvailability().kind).toBe("refused");
    });

    test("loopback keeps working for a local service", () => {
        process.env["VITE_BOOTSTRAP_URL"] = "http://127.0.0.1:8083";
        expect(bootstrapAvailability()).toEqual({
            kind: "configured",
            url: "http://127.0.0.1:8083",
        });
    });
});
