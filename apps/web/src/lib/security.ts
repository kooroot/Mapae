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

export function createContentSecurityPolicy(nonce: string): string {
    if (!CSP_NONCE_PATTERN.test(nonce)) {
        throw new Error("CSP nonce must be a 128-bit URL-safe value");
    }

    return [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}' https://static.cloudflareinsights.com`,
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self'",
        "img-src 'self' data:",
        [
            "connect-src 'self'",
            "https://sepolia-rpc.giwa.io",
            "https://sepolia-explorer.giwa.io",
            "https://cloudflareinsights.com",
        ].join(" "),
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "object-src 'none'",
    ].join("; ");
}
