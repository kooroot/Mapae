import {describe, expect, test} from "bun:test";
import {parseNodeRpcUrl} from "@mapae/shared";
import {assertPublishableRpc, configuredSubmitterUrl} from "./config";

/**
 * These guard a secrets property, not a connectivity one.
 *
 * Vite inlines `import.meta.env.VITE_*` into the built bundle, so `VITE_RPC_URL` is
 * published to every visitor. Private RPC providers authenticate with an API key in the
 * URL path, which `parseNodeRpcUrl` cannot see — its check is for userinfo.
 *
 * This module-level guard is NOT what stops the leak, and must not be mistaken for it.
 * Vite bundles modules rather than executing them, so this code first runs in a visitor's
 * browser — after the value is already in `dist/`. Measured: with the check only here,
 * `bun run build` succeeded and the key was greppable in `dist/assets/index-*.js`. The
 * build-time refusal lives in `vite.config.ts`; this one covers `bun run dev` and any
 * importer that does not go through that config. Both are needed.
 */
describe("VITE_RPC_URL is publishable", () => {
    test("the public GIWA endpoint is allowed", () => {
        expect(assertPublishableRpc("https://sepolia-rpc.giwa.io/")).toBe(
            "https://sepolia-rpc.giwa.io/",
        );
    });

    test("loopback is allowed, so a local fork still works", () => {
        for (const value of ["http://127.0.0.1:8545", "http://localhost:8545", "http://[::1]:8545"]) {
            expect(assertPublishableRpc(value)).toBe(value);
        }
    });

    test("a keyed private endpoint is refused — the key would ship in the bundle", () => {
        // The realistic shape: the credential is a path segment, not userinfo, so every
        // check that only looks at `url.username` waves it through.
        expect(() =>
            assertPublishableRpc("https://giwa-sepolia.example.io/some-opaque-api-key"),
        ).toThrow(/inlines this value into the shipped bundle/);
    });

    test("the refusal names the host but never echoes the path", () => {
        // The error message is itself a leak surface: it reaches a build log and a
        // browser console. It must identify the mistake without reprinting the secret.
        let message = "";
        try {
            assertPublishableRpc("https://private.example.io/super-secret-key");
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toContain("private.example.io");
        expect(message).not.toContain("super-secret-key");
    });

    test("the existing validator does NOT catch this — the guard is not redundant", () => {
        // parseNodeRpcUrl rejects credentials in *userinfo* (user:pass@host). A provider
        // key sitting in the path is invisible to it. If this assertion ever flips, the
        // shared validator has grown a path check and this guard can be reconsidered —
        // until then, removing it silently reopens the bundle leak.
        const keyed = "https://giwa-sepolia.example.io/some-opaque-api-key";
        expect(() => parseNodeRpcUrl(keyed)).not.toThrow();
        expect(() => assertPublishableRpc(keyed)).toThrow();
    });

    test("any other public host is refused too — this is an allowlist, not a keyword filter", () => {
        expect(() => assertPublishableRpc("https://rpc.ankr.com/giwa")).toThrow(/publ|loopback/i);
        // Not loopback despite the substring; hostname matching is on the whole label.
        expect(() => assertPublishableRpc("https://localhost.evil.example.com")).toThrow();
    });
});

describe("VITE_REVOCATION_SUBMITTER_URL is loopback", () => {
    // `configuredSubmitterUrl` reads the env at call time, and Bun maps `import.meta.env`
    // onto `process.env`, so each case sets the variable and calls it.
    const set = (value: string | undefined) => {
        if (value === undefined) delete process.env["VITE_REVOCATION_SUBMITTER_URL"];
        else process.env["VITE_REVOCATION_SUBMITTER_URL"] = value;
    };

    test("unset means the revoke button has nowhere to send a signature", () => {
        set(undefined);
        expect(configuredSubmitterUrl()).toBeUndefined();
    });

    test("loopback is accepted and reduced to an origin", () => {
        set("http://127.0.0.1:8082/revoke");
        expect(configuredSubmitterUrl()).toBe("http://127.0.0.1:8082");
        set("http://localhost:8082");
        expect(configuredSubmitterUrl()).toBe("http://localhost:8082");
    });

    test("a remote submitter is refused — it holds a funded relayer key and has no auth", () => {
        // Not a secrets guard like VITE_RPC_URL: this one is about where an owner's
        // bearer-grade signature is allowed to travel.
        set("https://submitter.example.com");
        expect(() => configuredSubmitterUrl()).toThrow(/must be loopback/);
        set("https://localhost.evil.example.com");
        expect(() => configuredSubmitterUrl()).toThrow(/must be loopback/);
    });

    test("a malformed value fails loudly rather than silently disabling the button", () => {
        set("not-a-url");
        expect(() => configuredSubmitterUrl()).toThrow(/not a valid URL/);
        set(undefined);
    });
});
