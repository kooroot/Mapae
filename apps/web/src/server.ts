import {
    createStartHandler,
    defaultStreamHandler,
    defineHandlerCallback,
} from "@tanstack/react-start/server";
import {createServerEntry} from "@tanstack/react-start/server-entry";
import {siteSurface} from "./lib/config";
import {createContentSecurityPolicy} from "./lib/security";

// `siteSurface` is a `VITE_` value Vite inlines at build time, for the SSR bundle as
// much as the client one — the root route already branches on it to render each
// surface's title, so the Worker sees the same literal the document does.
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
