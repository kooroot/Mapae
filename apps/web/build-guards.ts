/**
 * Build-time refusals for the `VITE_` values that get inlined into the shipped bundle.
 *
 * These live beside `vite.config.ts` rather than in `src/` on purpose, and the reason is
 * measured: Vite *bundles* modules instead of executing them, so a guard that runs at
 * module load first runs in a visitor's browser — long after the value was inlined into
 * `dist/`. With the check only in `src/`, the since-retired console built green and the key
 * was greppable in the output bundle. `defineConfig` runs on every Vite start, so calling
 * these from the config covers `bun run dev` and `bun run build` alike.
 *
 * They are a separate module from the config for one reason: **until they were extracted,
 * nothing in this repository ever ran them.** Every guard opens by returning on an empty
 * value, and the only source of `VITE_` values is `apps/web/.env.production`, which is
 * gitignored — so on a CI checkout `loadEnv` returns `{}` and all five return immediately.
 * Deleting a call from the config body, or widening the host allowlist, left `bun run check`
 * fully green. The tests beside this file are the first thing that has ever exercised them.
 *
 * The empty-value pass is deliberate and stays: absence means the variable is unset, and an
 * unset variable is a legitimate development state. What was wrong was never the early
 * return — it was that no configured value was checked anywhere.
 */

export const PUBLIC_GIWA_HOST = "sepolia-rpc.giwa.io";
/**
 * The sponsor shares the facilitator's hostname and is routed by path.
 *
 * A separate subdomain would have meant a new DNS record, a new tunnel entry and a second
 * public name to keep track of; a path rule on the existing hostname adds none of those
 * while keeping the sponsor a separate process with its own key and its own nonce space.
 */
export const PUBLIC_BOOTSTRAP_HOST = "facilitator.mapae.io";
export const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];
export const SITE_SURFACES = new Set(["combined", "landing", "app"]);

export function assertSiteSurface(raw: string | undefined): void {
    const value = raw?.trim();
    if (!value || SITE_SURFACES.has(value)) return;
    throw new Error(
        `VITE_SITE_SURFACE must be one of combined, landing, or app; got "${value}".`,
    );
}

/**
 * Refuse to build when `VITE_RPC_URL` points anywhere that is not public.
 *
 * The stakes here are the highest in the repo: this bundle is published to Cloudflare for
 * anyone to load, so a keyed RPC URL inlined here is handed to every visitor.
 *
 * Private RPC providers authenticate with an API key in the URL *path*, which the shared
 * `parseNodeRpcUrl` cannot see — it checks userinfo. So "it passed validation" is never
 * evidence that a URL is publishable; only the host allowlist is.
 */
export function assertPublishableRpc(raw: string | undefined): void {
    const value = raw?.trim();
    if (!value) return;
    let hostname: string;
    try {
        hostname = new URL(value).hostname;
    } catch {
        throw new Error("VITE_RPC_URL is not a valid URL");
    }
    if (hostname === PUBLIC_GIWA_HOST || LOOPBACK_HOSTS.includes(hostname)) return;
    // Names the host, never the path — this message reaches build logs and CI output,
    // and the path is the credential.
    throw new Error(
        `VITE_RPC_URL must be the public GIWA endpoint (${PUBLIC_GIWA_HOST}) or loopback, got "${hostname}". ` +
            "Vite inlines this value into the shipped bundle, and this bundle is served publicly, " +
            "so a private or keyed RPC URL here would be published to every visitor. Keep private " +
            "endpoints in a server-side GIWA_SEPOLIA_RPC_URL instead.",
    );
}

/**
 * Refuse to build when the revocation submitter is not loopback.
 *
 * The submitter holds a funded relayer key and has no application authentication, which is
 * why its own process refuses any non-loopback bind. A published page pointing at a remote
 * one would be advertising that service to the internet — and the value posted to it is an
 * owner signature, a bearer authorization to disable a permission.
 *
 * A deployed build therefore has no submitter at all, and the app says so rather than
 * rendering a button that cannot work. See `src/lib/config.ts`.
 */
export function assertLoopbackSubmitter(raw: string | undefined): void {
    const value = raw?.trim();
    if (!value) return;
    let hostname: string;
    try {
        hostname = new URL(value).hostname;
    } catch {
        throw new Error("VITE_REVOCATION_SUBMITTER_URL is not a valid URL");
    }
    if (LOOPBACK_HOSTS.includes(hostname)) return;
    throw new Error(
        `VITE_REVOCATION_SUBMITTER_URL must be loopback, got "${hostname}". The submitter holds a ` +
            "funded relayer key and has no application authentication; it is never reachable from a " +
            "published page.",
    );
}

/**
 * Refuse to build when the bootstrap endpoint is not one we chose.
 *
 * This one differs from the two above: the value is *meant* to be public, so the guard is
 * not protecting a secret. It exists because these guards are keyed by variable name, and
 * a new `VITE_` name inherits no protection at all — a typo pointing this at the keyed
 * private RPC host would inline that credential into the shipped bundle exactly as
 * `VITE_RPC_URL` would have. Same reason, different variable.
 *
 * The message names the host and never the path, for the same reason as
 * `assertPublishableRpc`: the path is the credential in the case this is guarding against.
 */
export function assertBootstrapEndpoint(raw: string | undefined): void {
    const value = raw?.trim();
    if (!value) return;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error("VITE_BOOTSTRAP_URL is not a valid URL");
    }
    if (LOOPBACK_HOSTS.includes(url.hostname)) return;
    if (url.protocol === "https:" && url.hostname === PUBLIC_BOOTSTRAP_HOST) return;
    throw new Error(
        `VITE_BOOTSTRAP_URL must be https://${PUBLIC_BOOTSTRAP_HOST} or loopback, got "${url.hostname}". ` +
            "Vite inlines this value into the shipped bundle; an unintended host here is published " +
            "to every visitor.",
    );
}

/**
 * Refuse to build when the sponsored revocation endpoint is not one we chose.
 *
 * A deliberately *separate* variable from `VITE_REVOCATION_SUBMITTER_URL`: that name is
 * the loopback single-payer submitter and its guard above must keep refusing every
 * non-loopback host. This one is meant to be public — the same host-pin argument as
 * `assertBootstrapEndpoint`, and the same reason it exists at all: guards are keyed by
 * variable name, and a new `VITE_` name inherits no protection. A typo pointing this at
 * the keyed private RPC host would inline that credential into the shipped bundle.
 */
export function assertPublicSubmitterEndpoint(raw: string | undefined): void {
    const value = raw?.trim();
    if (!value) return;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error("VITE_REVOCATION_SUBMITTER_PUBLIC_URL is not a valid URL");
    }
    if (LOOPBACK_HOSTS.includes(url.hostname)) return;
    if (url.protocol === "https:" && url.hostname === PUBLIC_BOOTSTRAP_HOST) return;
    throw new Error(
        `VITE_REVOCATION_SUBMITTER_PUBLIC_URL must be https://${PUBLIC_BOOTSTRAP_HOST} or loopback, ` +
            `got "${url.hostname}". Vite inlines this value into the shipped bundle; an unintended ` +
            "host here is published to every visitor.",
    );
}

/**
 * Every guard, paired with the variable it reads.
 *
 * Exported as data so the config applies them in a loop and a test can assert the config
 * applies *all* of them. Deleting one call from a hand-written list of five was the
 * mutation nothing could catch; there is no list to delete from now.
 */
export const BUILD_GUARDS: ReadonlyArray<{
    readonly variable: string;
    readonly assert: (raw: string | undefined) => void;
}> = [
    {variable: "VITE_SITE_SURFACE", assert: assertSiteSurface},
    {variable: "VITE_RPC_URL", assert: assertPublishableRpc},
    {variable: "VITE_REVOCATION_SUBMITTER_URL", assert: assertLoopbackSubmitter},
    {variable: "VITE_BOOTSTRAP_URL", assert: assertBootstrapEndpoint},
    {variable: "VITE_REVOCATION_SUBMITTER_PUBLIC_URL", assert: assertPublicSubmitterEndpoint},
];

/**
 * Run every guard against the values Vite resolved.
 *
 * `loadEnv` sees .env files too, not just the process environment — a credential pasted
 * into apps/web/.env must fail the same way one passed inline does.
 */
export function assertBuildEnv(
    loaded: Record<string, string>,
    processEnv: Record<string, string | undefined> = process.env,
): void {
    for (const {variable, assert} of BUILD_GUARDS) {
        assert(loaded[variable] ?? processEnv[variable]);
    }
}
