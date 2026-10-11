import {env} from "cloudflare:workers";
import {outingsApi} from "./arcade/profile/outings";
import {profileApi, profileSessionOwner} from "./arcade/profile/api";
import {profileRepository} from "./arcade/profile/repository";
import {engagementApi, recordAuthenticatedEngagement} from "./arcade/engagement/api";
import {engagementRepository} from "./arcade/engagement/repository";
import {guardiansApi} from "./arcade/profile/guardians";
import {guardianArtApi} from "./arcade/guardian-art/api";
import type {ExecutionContext, ScheduledController} from "@cloudflare/workers-types";
import {
    createStartHandler,
    defaultStreamHandler,
    defineHandlerCallback,
} from "@tanstack/react-start/server";
import {createServerEntry} from "@tanstack/react-start/server-entry";
import {createContentSecurityPolicy} from "./lib/security";
import {arcadeProductionApi} from "./arcade/production-api";

// One policy for every page: the landing, the arcade and the Studio share an origin,
// so no route may loosen it. Only the nonce varies, per response.
const streamWithSecurityHeaders = defineHandlerCallback((context) => {
    const nonce = context.router.options.ssr?.nonce;
    if (!nonce) {
        throw new Error("SSR router did not provide a CSP nonce");
    }

    context.responseHeaders.set(
        "Content-Security-Policy",
        createContentSecurityPolicy(nonce),
    );
    return defaultStreamHandler(context);
});

const start = createStartHandler(streamWithSecurityHeaders);

const entry = createServerEntry({fetch: (request, options) => {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/arcade/guardians/")) return guardianArtApi(request, {collection: env.ARCADE_GUARDIAN_ADDRESS, assets: env.ASSETS});
    if (path === "/api/arcade/engagement") return engagementApi(request, engagementRepository(env.ARCADE_DB), {
        development: import.meta.env.DEV, resolveOwner: r => profileSessionOwner(r, profileRepository(env.ARCADE_DB)),
    });
    if (path.startsWith("/api/arcade/profile")) {
        const profiles = profileRepository(env.ARCADE_DB);
        return profileApi(request, profiles, {
            development: import.meta.env.DEV,
            guardians: (r, owner, input) => guardiansApi(r, owner, input, {receiptToken: env.ARCADE_RECEIPT_TOKEN}),
            onAuthenticated: (r, owner, now) => recordAuthenticatedEngagement(r, engagementRepository(env.ARCADE_DB), owner, now),
            outings: (r, owner, input) => outingsApi(r, owner, input, {receiptToken: env.ARCADE_RECEIPT_TOKEN}),
        });
    }
    return path.startsWith("/api/arcade/") ? arcadeProductionApi(request) : start(request, options);
}});

export default {...entry, scheduled(_event: ScheduledController, _bindings: unknown, context: ExecutionContext) {
    context.waitUntil(engagementRepository(env.ARCADE_DB).cleanup(Date.now()));
}};
