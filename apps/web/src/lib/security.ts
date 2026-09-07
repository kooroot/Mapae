import type {SiteSurface} from "./config";

const CSP_NONCE_PATTERN = /^[A-Za-z0-9_-]{32}$/;

/**
 * The document's fixed security headers, applied by the root route.
 *
 * Cloudflare's `public/_headers` only decorates static-asset responses; the SSR
 * document comes out of the Worker, which that file never sees. So the same set
 * lives twice — here for the document, in `_headers` for `/assets/*` and the rest.
 * The two copies were kept in step by hand and nothing checked it; the audit found
 * the set incomplete (no HSTS) on both surfaces. `security.test.ts` parses the `/*`
 * block of that file and asserts it equals this object, so the next header cannot
 * land in one copy only — a header missing from both is what the HSTS test catches.
 *
 * HSTS is one year with subdomains and no `preload`: preload is irreversible on
 * the browsers' side, and the user chose to keep the exit. The CSP is not in this
 * object on purpose — it carries the request nonce, so `src/server.ts` attaches it
 * per response from {@link createContentSecurityPolicy}.
 */
export const DOCUMENT_SECURITY_HEADERS: Readonly<Record<string, string>> = {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=()",
};

/**
 * TanStack Start emits a small inline streaming bootstrap before the external
 * client bundle. A request nonce lets that bootstrap run without weakening the
 * whole document with `unsafe-inline`.
 *
 * `getRouter` is called once per SSR request, so this value is request-scoped.
 * The browser recovers the same value from the root document's own `csp-nonce`
 * meta — the first in the head, rendered by `__root.tsx` — which TanStack's
 * hydration reads back before React renders; it must not mint a second one.
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
 * `style-src` is `'self'` plus the request nonce: no `'unsafe-inline'`, and no `-attr`
 * escape hatch. The production document earns that on its own — its only stylesheet
 * is a `<link>` to this origin, and it emits no `<style>`. `bun run dev` did not, and
 * an earlier split was reverted for it: Vite's dev client injects each CSS import as
 * a `<style>` and copies its nonce from the `nonce` IDL property of the first
 * `meta[property=csp-nonce]`, while TanStack's meta carries the value in `content`
 * alone — so the injected styles had no nonce, every dev page rendered unstyled and
 * CSS HMR was dead. The root document now renders its own `meta[property=csp-nonce]`
 * ahead of TanStack's, with the value as both `content` (what TanStack's hydration
 * reads) and `nonce` (what Vite reads), so the policy developers work under is the
 * one that ships. A nonce cannot bless a `style="…"` attribute — CSP has no such
 * mechanism short of `'unsafe-hashes'` — so the app renders none: the three that
 * existed went to the stylesheet and the CSSOM, which the policy does not police.
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
        `style-src 'self' 'nonce-${nonce}'`,
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
