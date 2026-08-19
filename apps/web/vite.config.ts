import {cloudflare} from "@cloudflare/vite-plugin";
import {tanstackStart} from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import {defineConfig, loadEnv, searchForWorkspaceRoot} from "vite";
import type {Plugin} from "vite";
import {assertBuildEnv} from "./build-guards";

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

export default defineConfig(({mode}) => {
    // `loadEnv` sees .env files too, not just the process environment — a credential pasted
    // into apps/web/.env must fail the same way one passed inline does.
    const env = loadEnv(mode, process.cwd(), "VITE_");
    assertBuildEnv(env);
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
