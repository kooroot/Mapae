import {
    createStartHandler,
    defaultStreamHandler,
    defineHandlerCallback,
} from "@tanstack/react-start/server";
import {createServerEntry} from "@tanstack/react-start/server-entry";
import {siteSurface} from "./lib/config";
import {createContentSecurityPolicy} from "./lib/security";

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
        createContentSecurityPolicy(nonce, siteSurface),
    );
    return defaultStreamHandler(context);
});

const fetch = createStartHandler(streamWithSecurityHeaders);

export default createServerEntry({fetch});
