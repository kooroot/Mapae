import type {SiteSurface} from "./config";

const CSP_NONCE_PATTERN = /^[A-Za-z0-9_-]{32}$/;

/**
 * TanStack Start emits a small inline streaming bootstrap before the external
 * client bundle. A request nonce lets that bootstrap run without weakening the
 * whole document with `unsafe-inline`.
 *
 * `getRouter` is called once per SSR request, so this value is request-scoped.
 * The browser recovers the same value from TanStack's `csp-nonce` meta tag
 * during hydration; it must not mint a second one.
 */
export function createSsrNonce(): string | undefined {
    if (typeof document !== "undefined") return undefined;
    return globalThis.crypto.randomUUID().replaceAll("-", "");
}

/**
 * The policy for one response, shaped by which product the build is.
 *
 * Cloudflare Web Analytics is a zone setting: the edge injects a beacon script into
 * the landing's HTML and the beacon posts to `cloudflareinsights.com`, so the landing
 * has to name that pair or the beacon dies in the console. A `script-src` entry is
 * full-page code execution for whoever controls the origin, and the Studio's custody
 * argument is that the agent key never leaves this tab — one policy for both surfaces
 * handed that origin the Studio too, for a beacon that was never injected there. Only
 * a build that is nothing but the landing admits the pair; `combined` hosts the Studio
 * as well, so it takes the Studio's policy.
 *
 * `connect-src` is what the page fetches, not what it links to. The explorer is
 * reached only through `<a href>`, which CSP does not police, so it is not here; the
 * RPC host is what viem reads, and the facilitator host carries both `/bootstrap` and
 * `/revoke` — CSP polices origins, not paths, so the one entry is a precondition of
 * onboarding and of the kill switch alike.
 *
 * Styles are split three ways. The production document emits exactly one stylesheet
 * element — a `<link>` to this origin that TanStack stamps with the request nonce —
 * and no `<style>` at all, so `style-src-elem` needs only `'self'` plus the nonce.
 * The `style="…"` attributes React renders (transition delays, one meter width) have
 * no nonce mechanism, hence `style-src-attr 'unsafe-inline'`. The plain `style-src`
 * keeps today's `'unsafe-inline'` for browsers that predate the granular directives;
 * the ones that understand them ignore it.
 */
export function createContentSecurityPolicy(nonce: string, surface: SiteSurface): string {
    if (!CSP_NONCE_PATTERN.test(nonce)) {
        throw new Error("CSP nonce must be a 128-bit URL-safe value");
    }
    const telemetry = surface === "landing";

    return [
        "default-src 'self'",
        [
            "script-src 'self'",
            `'nonce-${nonce}'`,
            ...(telemetry ? ["https://static.cloudflareinsights.com"] : []),
        ].join(" "),
        "style-src 'self' 'unsafe-inline'",
        `style-src-elem 'self' 'nonce-${nonce}'`,
        "style-src-attr 'unsafe-inline'",
        "font-src 'self'",
        "img-src 'self' data:",
        [
            "connect-src 'self'",
            "https://sepolia-rpc.giwa.io",
            "https://facilitator.mapae.io",
            ...(telemetry ? ["https://cloudflareinsights.com"] : []),
        ].join(" "),
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "object-src 'none'",
    ].join("; ");
}
