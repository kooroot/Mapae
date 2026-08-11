/**
 * The forwarding address for `gitbook.mapae.io`.
 *
 * The book moved to `docs.mapae.io`, but the old hostname is the answer filed in a
 * submission form and is in whatever bookmarks were taken while it was the public home.
 * Retiring it would break those links; serving the book from both would split search
 * ranking between two identical sites and leave readers unsure which is real. So the old
 * host keeps resolving and says, permanently, where the book went.
 *
 * This is a *separate* Worker from the book itself, with no assets bound to it, and that
 * is the point. Cloudflare serves a matched asset without invoking the Worker, so putting
 * the redirect on the docs Worker would have required `run_worker_first` — routing all
 * ninety-odd font files and a 3.5 MB mermaid bundle through a script on every visit, to
 * serve a legacy host. `docs.mapae.io` stays pure assets and runs no code; the redirect
 * costs an invocation only when someone follows a stale link, and can be deleted outright
 * the day that stops happening.
 */
export const CANONICAL_HOST = "docs.mapae.io";

/**
 * Where a request should be sent, or `undefined` when it is already there.
 *
 * The path, query and fragment survive untouched — a redirect that drops the path sends
 * every deep link to the cover page, which is a broken link wearing a `200`.
 */
export function redirectTarget(requestUrl: string): string | undefined {
    const url = new URL(requestUrl);
    // A request already on the canonical host must not be redirected to itself; this Worker
    // is not routed there, so the only way to reach this branch is a misconfiguration, and
    // an infinite redirect is a far worse way to find out about one than a 404.
    if (url.hostname === CANONICAL_HOST) return undefined;
    url.hostname = CANONICAL_HOST;
    // The old host was HTTPS-only; fixing the scheme keeps a stray HTTP request from being
    // redirected twice.
    url.protocol = "https:";
    return url.toString();
}

export default {
    fetch(request: Request): Response {
        const target = redirectTarget(request.url);
        return target
            ? Response.redirect(target, 301)
            : new Response("This host only forwards to https://docs.mapae.io\n", {
                  status: 404,
                  headers: {"content-type": "text/plain; charset=utf-8"},
              });
    },
};
