/**
 * The first thing that has ever run these guards.
 *
 * They are build-time refusals for values Vite inlines into a bundle Cloudflare serves to
 * every visitor, and until this file existed nothing exercised them: each returns early on
 * an empty value, and the only source of `VITE_` values is the gitignored
 * `apps/web/.env.production`, so on a CI checkout `loadEnv` returns `{}` and all five return
 * immediately. `bun run check` stayed green with a guard call deleted.
 *
 * So the tests are chosen by what a wrong edit would do, not by branch coverage:
 *
 * - a keyed private endpoint must be refused (the failure the guards exist for);
 * - the refusal message must never echo the path, because the path *is* the credential and
 *   the message goes to build logs and CI output;
 * - the config must actually apply the guards — that call being deleted is the mutation
 *   nothing could previously catch, so it is asserted against the real exported config.
 */
import {describe, expect, test} from "bun:test";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
    assertBootstrapEndpoint,
    assertBuildEnv,
    assertLoopbackSubmitter,
    assertPublicSubmitterEndpoint,
    assertPublishableRpc,
    assertSiteSurface,
    BUILD_GUARDS,
    PUBLIC_BOOTSTRAP_HOST,
    PUBLIC_GIWA_HOST,
} from "./build-guards";

/**
 * A private endpoint of the shape this repository actually uses: the API key is a path
 * segment, not userinfo and not a query parameter. That is why a URL parser cannot help —
 * `parseNodeRpcUrl` rejects `url.username`/`url.password` and waves a path key straight
 * through — and why the host allowlist is the only thing standing between this value and
 * every visitor's browser.
 */
const KEYED_PATH_SECRET = "kEyThAtMuStNeVeRbEpRiNtEd";
const KEYED_PRIVATE_RPC = `https://giwa-sepolia.private-provider.example/v2/${KEYED_PATH_SECRET}`;

describe("assertPublishableRpc", () => {
    test("refuses a private endpoint whose API key is a path segment", () => {
        expect(() => assertPublishableRpc(KEYED_PRIVATE_RPC)).toThrow(/must be the public GIWA/);
    });

    test("refusal names the host and never the path", () => {
        // The message reaches build logs and CI output. Naming the path would move the
        // credential from the bundle into the log — the same leak by a shorter route.
        let message = "";
        try {
            assertPublishableRpc(KEYED_PRIVATE_RPC);
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toContain("giwa-sepolia.private-provider.example");
        expect(message).not.toContain(KEYED_PATH_SECRET);
        expect(message).not.toContain("/v2/");
    });

    test("accepts the public GIWA endpoint", () => {
        expect(() => assertPublishableRpc(`https://${PUBLIC_GIWA_HOST}`)).not.toThrow();
    });

    test.each(["http://127.0.0.1:8545", "http://localhost:8545", "http://[::1]:8545"])(
        "accepts loopback %s",
        (url) => {
            expect(() => assertPublishableRpc(url)).not.toThrow();
        },
    );

    test("refuses a value that is not a URL", () => {
        expect(() => assertPublishableRpc("sepolia-rpc.giwa.io")).toThrow(/not a valid URL/);
    });

    // The comparison has to be exact, and each of these fails under a different way of
    // relaxing it: `endsWith` admits the first, `startsWith` the second, `includes` all
    // three. Written as three cases rather than one because a single probe silently stops
    // testing the moment someone picks the other loose comparison — measured: the earlier
    // one-value version of this test passed with `===` swapped for `endsWith`.
    test.each([
        [`x${PUBLIC_GIWA_HOST}`, "endsWith"],
        [`${PUBLIC_GIWA_HOST}.attacker.test`, "startsWith"],
        [`a.${PUBLIC_GIWA_HOST}.b`, "includes"],
    ])("refuses %s, which a %s allowlist would admit", (hostname) => {
        expect(() => assertPublishableRpc(`https://${hostname}`)).toThrow(
            /must be the public GIWA/,
        );
    });

    test.each([undefined, "", "   "])("an unset value (%p) is not a failure", (value) => {
        // Deliberate: absence means the variable is unset, which is a legitimate
        // development state. What was wrong was never this branch — it was that no
        // configured value was checked anywhere.
        expect(() => assertPublishableRpc(value)).not.toThrow();
    });
});

describe("assertLoopbackSubmitter", () => {
    test("refuses a remote submitter", () => {
        // The submitter fronts a funded relayer key and has no application
        // authentication; a published page must never point at one.
        expect(() => assertLoopbackSubmitter(`https://${PUBLIC_BOOTSTRAP_HOST}/revoke`)).toThrow(
            /must be loopback/,
        );
    });

    test("accepts loopback", () => {
        expect(() => assertLoopbackSubmitter("http://127.0.0.1:8082")).not.toThrow();
    });

    test("refuses a value that is not a URL", () => {
        expect(() => assertLoopbackSubmitter("127.0.0.1:8082")).toThrow(/not a valid URL/);
    });
});

describe("assertBootstrapEndpoint", () => {
    test("accepts the chosen public host over https", () => {
        expect(() =>
            assertBootstrapEndpoint(`https://${PUBLIC_BOOTSTRAP_HOST}/bootstrap`),
        ).not.toThrow();
    });

    test("refuses the chosen public host over plain http", () => {
        // The scheme is part of the pin, not decoration: the request carries an owner
        // signature over a permission context.
        expect(() => assertBootstrapEndpoint(`http://${PUBLIC_BOOTSTRAP_HOST}/bootstrap`)).toThrow(
            /must be https/,
        );
    });

    test("accepts loopback", () => {
        expect(() => assertBootstrapEndpoint("http://localhost:8083")).not.toThrow();
    });

    test("refuses another host, without echoing the path", () => {
        let message = "";
        try {
            assertBootstrapEndpoint(KEYED_PRIVATE_RPC);
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toContain("must be https://");
        expect(message).not.toContain(KEYED_PATH_SECRET);
    });
});

describe("assertPublicSubmitterEndpoint", () => {
    test("accepts the chosen public host over https", () => {
        expect(() =>
            assertPublicSubmitterEndpoint(`https://${PUBLIC_BOOTSTRAP_HOST}/revoke`),
        ).not.toThrow();
    });

    test("refuses the chosen public host over plain http", () => {
        expect(() =>
            assertPublicSubmitterEndpoint(`http://${PUBLIC_BOOTSTRAP_HOST}/revoke`),
        ).toThrow(/must be https/);
    });

    test("refuses another host, without echoing the path", () => {
        let message = "";
        try {
            assertPublicSubmitterEndpoint(KEYED_PRIVATE_RPC);
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toContain("must be https://");
        expect(message).not.toContain(KEYED_PATH_SECRET);
    });

    test("stays a separate variable from the loopback submitter", () => {
        // The two names mean different services. If this guard ever delegated to
        // `assertLoopbackSubmitter`, the sponsored public endpoint Studio ships would stop
        // building; if that one ever delegated to this, a remote submitter would be
        // publishable. One value proves they disagree.
        const publicEndpoint = `https://${PUBLIC_BOOTSTRAP_HOST}/revoke`;
        expect(() => assertPublicSubmitterEndpoint(publicEndpoint)).not.toThrow();
        expect(() => assertLoopbackSubmitter(publicEndpoint)).toThrow();
    });
});

describe("assertSiteSurface", () => {
    test.each(["combined", "landing", "app"])("accepts %s", (surface) => {
        expect(() => assertSiteSurface(surface)).not.toThrow();
    });

    test("refuses anything else", () => {
        expect(() => assertSiteSurface("studio")).toThrow(/must be one of/);
    });
});

describe("assertBuildEnv", () => {
    /**
     * One bad value per guarded variable.
     *
     * This is the list that replaced five hand-written calls in the config body. Deleting
     * an entry from `BUILD_GUARDS` now fails here, which is what the old shape could not
     * do — a deleted call left every gate green.
     */
    const REJECTED: ReadonlyArray<readonly [string, string]> = [
        ["VITE_SITE_SURFACE", "studio"],
        ["VITE_RPC_URL", KEYED_PRIVATE_RPC],
        ["VITE_REVOCATION_SUBMITTER_URL", `https://${PUBLIC_BOOTSTRAP_HOST}/revoke`],
        ["VITE_BOOTSTRAP_URL", KEYED_PRIVATE_RPC],
        ["VITE_REVOCATION_SUBMITTER_PUBLIC_URL", KEYED_PRIVATE_RPC],
    ];

    test("every guarded variable is one this function actually rejects", () => {
        expect(REJECTED.map(([name]) => name).sort()).toEqual(
            BUILD_GUARDS.map((guard) => guard.variable).sort(),
        );
    });

    test.each(REJECTED)("rejects a bad %s", (variable, value) => {
        expect(() => assertBuildEnv({[variable]: value}, {})).toThrow();
    });

    test("reads the process environment when the loaded env has no such value", () => {
        // `loadEnv` only sees `.env` files. A credential exported in the shell reaches the
        // bundle by the same route and must fail the same way.
        expect(() => assertBuildEnv({}, {VITE_RPC_URL: KEYED_PRIVATE_RPC})).toThrow(
            /must be the public GIWA/,
        );
    });

    test("a loaded value wins over the process environment", () => {
        // `.env.production` is what a deploy actually ships, so a clean shell must not be
        // able to mask a bad file.
        expect(() =>
            assertBuildEnv(
                {VITE_RPC_URL: KEYED_PRIVATE_RPC},
                {VITE_RPC_URL: `https://${PUBLIC_GIWA_HOST}`},
            ),
        ).toThrow(/must be the public GIWA/);
    });

    test("an empty environment passes", () => {
        expect(() => assertBuildEnv({}, {})).not.toThrow();
    });
});

describe("the Vite config applies the guards", () => {
    /**
     * The mutation this exists for: delete the guard call from `defineConfig`'s body.
     *
     * Every test above passes with that edit in place, because they call the functions
     * directly. Only running the real exported config catches it. The config resolves
     * values with `loadEnv(mode, process.cwd(), "VITE_")`, so the test runs from a
     * directory with no `.env` files — otherwise the result would depend on whether this
     * machine happens to have `apps/web/.env.production`, which is the exact
     * one-filesystem dependence this whole file exists to remove.
     */
    test("a keyed private RPC URL fails the config, not just the guard", async () => {
        const cwd = process.cwd();
        const empty = await mkdtemp(join(tmpdir(), "mapae-build-guards-"));
        const previous = process.env["VITE_RPC_URL"];
        process.env["VITE_RPC_URL"] = KEYED_PRIVATE_RPC;
        try {
            process.chdir(empty);
            const config = (await import("./vite.config")).default as (env: {
                command: string;
                mode: string;
            }) => unknown;
            expect(() => config({command: "build", mode: "production"})).toThrow(
                /must be the public GIWA/,
            );
        } finally {
            process.chdir(cwd);
            if (previous === undefined) delete process.env["VITE_RPC_URL"];
            else process.env["VITE_RPC_URL"] = previous;
        }
    });
});
