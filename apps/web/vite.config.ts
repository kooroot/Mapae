import {cloudflare} from "@cloudflare/vite-plugin";
import {tanstackStart} from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import {defineConfig, loadEnv} from "vite";

const PUBLIC_GIWA_HOST = "sepolia-rpc.giwa.io";
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];

/**
 * Refuse to build when `VITE_RPC_URL` points anywhere that is not public.
 *
 * Ported deliberately from `apps/console/vite.config.ts` rather than imported: a shared
 * helper would live in `src/`, and Vite *bundles* modules instead of executing them, so a
 * module-load guard first runs in a visitor's browser — long after the value was inlined
 * into `dist/`. The console measured that exact failure. Two copies of twelve lines is the
 * correct trade against one copy that runs too late.
 *
 * This app raises the stakes over the console's: the console is an operator tool someone
 * runs locally, and this one is published to Cloudflare for anyone to load. A keyed RPC URL
 * inlined here is handed to every visitor on the internet.
 *
 * Private RPC providers authenticate with an API key in the URL *path*, which the shared
 * `parseNodeRpcUrl` cannot see — it checks userinfo. So "it passed validation" is never
 * evidence that a URL is publishable; only the host allowlist is.
 */
function assertPublishableRpc(raw: string | undefined): void {
    const value = raw?.trim();
    if (!value) return;
    let hostname: string;
    try {
        hostname = new URL(value).hostname;
    } catch {
        throw new Error("VITE_RPC_URL is not a valid URL");
    }
    if (hostname === PUBLIC_GIWA_HOST || LOOPBACK_HOSTS.includes(hostname)) return;
    // Names the host, never the path — this message reaches build logs and CI output,
    // and the path is the credential.
    throw new Error(
        `VITE_RPC_URL must be the public GIWA endpoint (${PUBLIC_GIWA_HOST}) or loopback, got "${hostname}". ` +
            "Vite inlines this value into the shipped bundle, and this bundle is served publicly, " +
            "so a private or keyed RPC URL here would be published to every visitor. Keep private " +
            "endpoints in a server-side GIWA_SEPOLIA_RPC_URL instead.",
    );
}

/**
 * Refuse to build when the revocation submitter is not loopback.
 *
 * The submitter holds a funded relayer key and has no application authentication, which is
 * why its own process refuses any non-loopback bind. A published page pointing at a remote
 * one would be advertising that service to the internet — and the value posted to it is an
 * owner signature, a bearer authorization to disable a permission.
 *
 * A deployed build therefore has no submitter at all, and the app says so rather than
 * rendering a button that cannot work. See `src/lib/config.ts`.
 */
function assertLoopbackSubmitter(raw: string | undefined): void {
    const value = raw?.trim();
    if (!value) return;
    let hostname: string;
    try {
        hostname = new URL(value).hostname;
    } catch {
        throw new Error("VITE_REVOCATION_SUBMITTER_URL is not a valid URL");
    }
    if (LOOPBACK_HOSTS.includes(hostname)) return;
    throw new Error(
        `VITE_REVOCATION_SUBMITTER_URL must be loopback, got "${hostname}". The submitter holds a ` +
            "funded relayer key and has no application authentication; it is never reachable from a " +
            "published page.",
    );
}

export default defineConfig(({mode}) => {
    // `loadEnv` sees .env files too, not just the process environment — a credential pasted
    // into apps/web/.env must fail the same way one passed inline does.
    const env = loadEnv(mode, process.cwd(), "VITE_");
    assertPublishableRpc(env["VITE_RPC_URL"] ?? process.env["VITE_RPC_URL"]);
    assertLoopbackSubmitter(
        env["VITE_REVOCATION_SUBMITTER_URL"] ?? process.env["VITE_REVOCATION_SUBMITTER_URL"],
    );

    return {
        plugins: [
            cloudflare({viteEnvironment: {name: "ssr"}}),
            tanstackStart({
                // The landing is fixed copy over a handful of committed addresses, so it
                // ships as HTML rather than as a bundle that has to boot before anything
                // is readable. The dapp routes hydrate normally.
                prerender: {enabled: true, crawlLinks: true},
            }),
            react(),
        ],
        server: {
            host: "127.0.0.1",
            port: 5174,
            // The app reads the committed deployment artifact from the repository root.
            fs: {allow: [".."]},
        },
    };
});
