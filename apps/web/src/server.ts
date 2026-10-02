import {env} from "cloudflare:workers";
import {checkoutApi, checkoutRepository} from "./arcade/profile/checkout";
import {derivePayerAccount} from "./lib/grant";
import {deployment} from "./lib/config";
import {profileApi} from "./arcade/profile/api";
import {profileRepository} from "./arcade/profile/repository";
import {
    createStartHandler,
    defaultStreamHandler,
    defineHandlerCallback,
} from "@tanstack/react-start/server";
import {createServerEntry} from "@tanstack/react-start/server-entry";
import {siteSurface} from "./lib/config";
import {createContentSecurityPolicy} from "./lib/security";
import {arcadeProductionApi} from "./arcade/production-api";

// `siteSurface` is a `VITE_` value fixed at build time, for the SSR bundle as much
// as the client one: a literal when `build:app` / `build:landing` set the variable,
// an empty build-time env object (`combined`) when nothing does. The Worker never
// reads its runtime environment for it, so it sees the surface the root route
// already branches on for the document's title.
const streamWithSecurityHeaders = defineHandlerCallback((context) => {
    const nonce = context.router.options.ssr?.nonce;
    if (!nonce) {
        throw new Error("SSR router did not provide a CSP nonce");
    }

    context.responseHeaders.set(
        "Content-Security-Policy",
        createContentSecurityPolicy(nonce, /\/(?:ko\/)?arcade\/?$/.test(new URL(context.request.url).pathname) ? "app" : siteSurface),
    );
    return defaultStreamHandler(context);
});

const start = createStartHandler(streamWithSecurityHeaders);

export default createServerEntry({fetch: (request, options) =>
    new URL(request.url).pathname.startsWith("/api/arcade/profile")
        ? profileApi(request, profileRepository(env.ARCADE_DB), {development: import.meta.env.DEV, checkout: (r, owner, input) => checkoutApi(r, owner, input, {repo: checkoutRepository(env.ARCADE_DB), profiles: profileRepository(env.ARCADE_DB), payer: derivePayerAccount, manager: deployment.environment.DelegationManager, receiptToken: env.ARCADE_RECEIPT_TOKEN})})
        : new URL(request.url).pathname.startsWith("/api/arcade/")
        ? arcadeProductionApi(request)
        : start(request, options),
});
