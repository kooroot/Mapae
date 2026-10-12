import "@mapae/delegation/kit-telemetry";
import {createRouter as createTanStackRouter} from "@tanstack/react-router";
import {RouteError} from "./components/RouteError";
import {RouteNotFound} from "./components/RouteNotFound";
import {createSsrNonce} from "./lib/security";
import {routeTree} from "./routeTree.gen";

/**
 * The router entry. The name matters: `@tanstack/start-client-core` imports
 * `getRouter` from this module by path alias, so exporting it under any other
 * name fails the build with a message that points at a file inside node_modules
 * rather than at this one.
 *
 * `defaultErrorComponent` is not a preference: TanStack's fallback styles itself with
 * `style` attributes, which the document's nonce-only `style-src` refuses, so without
 * a class-styled replacement a failed page would show an unstyled one. Unknown addresses also use the
 * shared page styles and provide a way home.
 */
export function getRouter() {
    const nonce = createSsrNonce();

    return createTanStackRouter({
        routeTree,
        scrollRestoration: true,
        defaultPreload: "intent",
        defaultErrorComponent: RouteError,
        defaultNotFoundComponent: RouteNotFound,
        ...(nonce ? {ssr: {nonce}} : {}),
    });
}

declare module "@tanstack/react-router" {
    interface Register {
        router: ReturnType<typeof getRouter>;
    }
}
