import {createRouter as createTanStackRouter} from "@tanstack/react-router";
import {createSsrNonce} from "./lib/security";
import {routeTree} from "./routeTree.gen";

/**
 * The router entry. The name matters: `@tanstack/start-client-core` imports
 * `getRouter` from this module by path alias, so exporting it under any other
 * name fails the build with a message that points at a file inside node_modules
 * rather than at this one.
 */
export function getRouter() {
    const nonce = createSsrNonce();

    return createTanStackRouter({
        routeTree,
        scrollRestoration: true,
        defaultPreload: "intent",
        ...(nonce ? {ssr: {nonce}} : {}),
    });
}

declare module "@tanstack/react-router" {
    interface Register {
        router: ReturnType<typeof getRouter>;
    }
}
