import react from "@vitejs/plugin-react";
import {defineConfig, loadEnv} from "vite";

const PUBLIC_GIWA_HOST = "sepolia-rpc.giwa.io";
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];

/**
 * Refuse to build when `VITE_RPC_URL` points anywhere that is not public.
 *
 * This has to live in the config, not in application code. Vite *bundles* modules, it
 * does not execute them, so a module-load guard inside `src/` runs for the first time in
 * a visitor's browser — long after the value was inlined into `dist/`. Measured: with the
 * check only in `src/config.ts`, `bun run build` succeeded and the key was greppable in
 * `dist/assets/index-*.js`.
 *
 * The runtime guard in `src/config.ts` is kept as well, because it covers `bun run dev`
 * and any consumer that imports the module without going through this config. This one is
 * what actually stops a credential from being published.
 *
 * Private RPC providers authenticate with an API key in the URL *path*, which the shared
 * `parseNodeRpcUrl` cannot see (it checks userinfo). So "it passed validation" is not
 * evidence that a URL is safe to publish — only the host allowlist is.
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
            "Vite inlines this value into the shipped bundle, so a private or keyed RPC URL " +
            "here would be published to every visitor. Keep private endpoints in a server-side " +
            "GIWA_SEPOLIA_RPC_URL instead.",
    );
}

/**
 * Refuse to build when the submitter is not loopback.
 *
 * Different reason from the RPC guard above — this value is not a secret. It is where an
 * owner's revocation signature gets posted, and that signature is a bearer authorization
 * to disable a permission. The submitter also holds a funded relayer key and has no
 * application authentication. Catching a remote origin here rather than at render keeps a
 * misconfiguration from becoming a blank page: `configuredSubmitterUrl` is called during
 * render, and an uncaught throw there unmounts the root.
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
        `VITE_REVOCATION_SUBMITTER_URL must be loopback, got "${hostname}". The submitter ` +
            "holds a funded relayer key and has no application authentication; put a TLS " +
            "reverse proxy in front of it before it is reachable remotely.",
    );
}

export default defineConfig(({mode}) => {
    // `loadEnv` sees .env files too, not just the process environment — a credential
    // pasted into apps/console/.env must fail the same way one passed inline does.
    const env = loadEnv(mode, process.cwd(), "VITE_");
    assertPublishableRpc(env["VITE_RPC_URL"] ?? process.env["VITE_RPC_URL"]);
    assertLoopbackSubmitter(
        env["VITE_REVOCATION_SUBMITTER_URL"] ?? process.env["VITE_REVOCATION_SUBMITTER_URL"],
    );

    return {
        plugins: [react()],
        server: {
            host: "127.0.0.1",
            port: 5173,
            // The console reads the committed deployment artifact from the repo root.
            fs: {allow: [".."]},
        },
    };
});
