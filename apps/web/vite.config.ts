import {cloudflare} from "@cloudflare/vite-plugin";
import {tanstackStart} from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import {defineConfig, loadEnv, searchForWorkspaceRoot} from "vite";
import type {Plugin} from "vite";

const PUBLIC_GIWA_HOST = "sepolia-rpc.giwa.io";
/**
 * The sponsor shares the facilitator's hostname and is routed by path.
 *
 * A separate subdomain would have meant a new DNS record, a new tunnel entry and a second
 * public name to keep track of; a path rule on the existing hostname adds none of those
 * while keeping the sponsor a separate process with its own key and its own nonce space.
 */
const PUBLIC_BOOTSTRAP_HOST = "facilitator.mapae.io";
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];
const SITE_SURFACES = new Set(["combined", "landing", "app"]);

function assertSiteSurface(raw: string | undefined): void {
    const value = raw?.trim();
    if (!value || SITE_SURFACES.has(value)) return;
    throw new Error(
        `VITE_SITE_SURFACE must be one of combined, landing, or app; got "${value}".`,
    );
}

// Only these are the duplicated media the client build already owns. An
// allowlist of extensions, NOT `output.type === "asset"`: the Cloudflare
// adapter emits `wrangler.json` — the deploy manifest itself — as an asset in
// this same bundle, and deleting every asset deletes it too. That version
// built green and then failed at the first command that reads the manifest
// (`vite preview`: "Could not read file: dist/server/wrangler.json"), which is
// exactly how `wrangler deploy` would have failed later. Measured both ways:
// at HEAD the file exists; with the blanket delete it does not.
const DUPLICATED_MEDIA = /\.(woff2?|ttf|otf|png|jpe?g|webp|avif|svg|gif|css)$/i;

function keepStaticAssetsOutOfWorker(): Plugin {
    return {
        name: "mapae-client-assets-only",
        apply: "build",
        applyToEnvironment: (environment) => environment.name === "ssr",
        generateBundle(_options, bundle) {
            // The client build already owns fonts, images and CSS. Cloudflare's
            // adapter otherwise emits a second copy beside the Worker modules,
            // where it counts against the Worker upload limit.
            for (const [fileName, output] of Object.entries(bundle)) {
                if (output.type === "asset" && DUPLICATED_MEDIA.test(fileName)) {
                    delete bundle[fileName];
                }
            }
        },
    };
}

/**
 * Refuse to build when `VITE_RPC_URL` points anywhere that is not public.
 *
 * The guard lives here, not in `src/`, because Vite *bundles* modules instead of
 * executing them — a module-load guard first runs in a visitor's browser, long after the
 * value was inlined into `dist/`. That failure was measured in the since-retired console:
 * with the check only in `src/`, the build succeeded and the key was greppable in the
 * output bundle. This file needs no `src/` twin: `defineConfig` runs on every Vite start,
 * so the same guard covers `bun run dev` and `bun run build` alike.
 *
 * The stakes here are the highest in the repo: this bundle is published to Cloudflare for
 * anyone to load, so a keyed RPC URL inlined here is handed to every visitor.
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

/**
 * Refuse to build when the bootstrap endpoint is not one we chose.
 *
 * This one differs from the two above: the value is *meant* to be public, so the guard is
 * not protecting a secret. It exists because these guards are keyed by variable name, and
 * a new `VITE_` name inherits no protection at all — a typo pointing this at the keyed
 * private RPC host would inline that credential into the shipped bundle exactly as
 * `VITE_RPC_URL` would have. Same reason, different variable.
 *
 * The message names the host and never the path, for the same reason as
 * `assertPublishableRpc`: the path is the credential in the case this is guarding against.
 */
function assertBootstrapEndpoint(raw: string | undefined): void {
    const value = raw?.trim();
    if (!value) return;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error("VITE_BOOTSTRAP_URL is not a valid URL");
    }
    if (LOOPBACK_HOSTS.includes(url.hostname)) return;
    if (url.protocol === "https:" && url.hostname === PUBLIC_BOOTSTRAP_HOST) return;
    throw new Error(
        `VITE_BOOTSTRAP_URL must be https://${PUBLIC_BOOTSTRAP_HOST} or loopback, got "${url.hostname}". ` +
            "Vite inlines this value into the shipped bundle; an unintended host here is published " +
            "to every visitor.",
    );
}

/**
 * Refuse to build when the sponsored revocation endpoint is not one we chose.
 *
 * A deliberately *separate* variable from `VITE_REVOCATION_SUBMITTER_URL`: that name is
 * the loopback single-payer submitter and its guard above must keep refusing every
 * non-loopback host. This one is meant to be public — the same host-pin argument as
 * `assertBootstrapEndpoint`, and the same reason it exists at all: guards are keyed by
 * variable name, and a new `VITE_` name inherits no protection. A typo pointing this at
 * the keyed private RPC host would inline that credential into the shipped bundle.
 */
function assertPublicSubmitterEndpoint(raw: string | undefined): void {
    const value = raw?.trim();
    if (!value) return;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error("VITE_REVOCATION_SUBMITTER_PUBLIC_URL is not a valid URL");
    }
    if (LOOPBACK_HOSTS.includes(url.hostname)) return;
    if (url.protocol === "https:" && url.hostname === PUBLIC_BOOTSTRAP_HOST) return;
    throw new Error(
        `VITE_REVOCATION_SUBMITTER_PUBLIC_URL must be https://${PUBLIC_BOOTSTRAP_HOST} or loopback, ` +
            `got "${url.hostname}". Vite inlines this value into the shipped bundle; an unintended ` +
            "host here is published to every visitor.",
    );
}

export default defineConfig(({mode}) => {
    // `loadEnv` sees .env files too, not just the process environment — a credential pasted
    // into apps/web/.env must fail the same way one passed inline does.
    const env = loadEnv(mode, process.cwd(), "VITE_");
    assertSiteSurface(env["VITE_SITE_SURFACE"] ?? process.env["VITE_SITE_SURFACE"]);
    assertPublishableRpc(env["VITE_RPC_URL"] ?? process.env["VITE_RPC_URL"]);
    assertLoopbackSubmitter(
        env["VITE_REVOCATION_SUBMITTER_URL"] ?? process.env["VITE_REVOCATION_SUBMITTER_URL"],
    );
    assertBootstrapEndpoint(env["VITE_BOOTSTRAP_URL"] ?? process.env["VITE_BOOTSTRAP_URL"]);
    assertPublicSubmitterEndpoint(
        env["VITE_REVOCATION_SUBMITTER_PUBLIC_URL"] ??
            process.env["VITE_REVOCATION_SUBMITTER_PUBLIC_URL"],
    );
    return {
        plugins: [
            cloudflare({viteEnvironment: {name: "ssr"}}),
            tanstackStart({
                // Make the custom entry explicit. It attaches the request nonce
                // to the CSP response header; silently falling back to Start's
                // default entry would emit nonce-bearing scripts without the
                // matching policy.
                server: {entry: "./server.ts"},
                // Cloudflare renders both routes on the server. Keeping prerender disabled
                // avoids a second local Worker boot during `vite build`; that boot is
                // unstable under constrained file-watcher limits and adds no user-visible
                // benefit over the same SSR response.
                prerender: {enabled: false},
            }),
            react(),
            keepStaticAssetsOutOfWorker(),
        ],
        server: {
            host: "127.0.0.1",
            port: 5174,
            // Workspace dependencies and the bundled font packages live at the Bun
            // workspace root. Limiting this to `apps/` makes Vite reject those
            // files during local visual QA even though the production build owns
            // the same assets correctly.
            fs: {allow: [searchForWorkspaceRoot(process.cwd())]},
        },
    };
});
