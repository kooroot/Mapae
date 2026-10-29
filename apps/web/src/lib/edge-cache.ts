/**
 * A copy out of the Worker's edge cache, leaving with the browser cache life given here. The cache hands an entry back with
 * the zone's Browser Cache TTL (four hours) in place of the life it was stored with, so a hit's own header never reaches a
 * browser; the stored life only decides how long the edge keeps the entry.
 */
export function fromEdgeCache(hit: Response, cacheControl: string, method = "GET"): Response {
    const headers = new Headers(hit.headers);
    headers.set("Cache-Control", cacheControl);
    return new Response(method === "HEAD" ? null : hit.body, {status: hit.status, headers});
}
