import {ARCADE_SELLER, ARCADE_TICKETS, ARCADE_TICKET_PRICE} from "@mapae/arcade/tickets";
import {MOCK_USDC} from "@mapae/shared";

const HEADERS = {"Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'"};
const error = (code: string, status: number) => Response.json({error: {code, message: "The arcade request could not be completed."}}, {status, headers: HEADERS});

/** No server key, shared payer or LLM budget is reachable from the public arcade. */
export async function arcadeProductionApi(request: Request, upstream: typeof fetch = fetch): Promise<Response> {
    const url = new URL(request.url);
    if (url.search || url.username || url.password) return error("invalid_request", 400);
    if (url.pathname === "/api/arcade/status" && request.method === "GET") {
        return Response.json({model: {configured: false, provider: "disabled", model: null, remainingCalls: 0, maxCalls: 0},
            payments: {mode: "disabled", scope: "local-service", unit: MOCK_USDC.symbol, ticketPrice: ARCADE_TICKET_PRICE, broadcastEnabled: false},
            giwa: {network: "eip155:91342", authorization: "owner-signed-delegation", ticketPrice: ARCADE_TICKET_PRICE, unit: MOCK_USDC.symbol}}, {headers: HEADERS});
    }
    const match = /^\/api\/arcade\/giwa(?:\/(stamp|race|shop))?$/.exec(url.pathname);
    if (!match) return error("not_available", 404);
    const game = match[1];
    const signature = request.headers.get("Payment-Signature");
    if (request.method !== "GET" && request.method !== "POST") return error("method_not_allowed", 405);
    // Browser submission is a same-origin POST. GET is strictly a public quotation,
    // so crawlers, previews, prefetches and cross-site images can never pay.
    if (request.method === "GET" && signature) return error("post_required", 405);
    if (request.method === "POST" && (!game || !signature || request.headers.get("Origin") !== url.origin ||
        request.headers.get("Sec-Fetch-Site") === "cross-site")) return error("origin_denied", 403);
    if (request.body || (signature && (signature.length > 24_000 || !/^[A-Za-z0-9+/=]+$/.test(signature)))) return error("invalid_request", 400);
    if (game && !Object.hasOwn(ARCADE_TICKETS, game)) return error("not_available", 404);
    try {
        const response = await upstream(`${ARCADE_SELLER}${game ? `/${game}` : ""}`, {
            method: "GET", redirect: "manual", signal: AbortSignal.timeout(50_000),
            headers: {Accept: "application/json", ...(signature ? {"Payment-Signature": signature} : {})},
        });
        // workerd rejects redirect: "error". Stop every redirect explicitly so a
        // bearer payment header can never be forwarded to a second destination.
        if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel(); return error(signature ? "settlement_unknown" : "seller_unavailable", 502);
        }
        if (!response.headers.get("Content-Type")?.startsWith("application/json")) {
            await response.body?.cancel(); return error("seller_unavailable", 502);
        }
        // Enforce the size on decoded bytes, including chunked/gzip responses.
        const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
        if (reader) {
            for (;;) {
                const chunk = await reader.read(); if (chunk.done) break;
                size += chunk.value.byteLength;
                if (size > 65_536) {await reader.cancel(); return error("seller_response_invalid", 502);}
                chunks.push(chunk.value);
            }
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
        const headers = new Headers(HEADERS);
        for (const name of ["Payment-Required", "Payment-Response"]) {
            const value = response.headers.get(name);
            if (value && value.length <= 24_000) headers.set(name, value);
        }
        return new Response(bytes, {status: response.status, headers});
    } catch {
        // A timeout after submission is ambiguous. Never relay upstream exception
        // text, which can contain the bearer signature or a provider URL.
        return error(signature ? "settlement_unknown" : "seller_unavailable", 504);
    }
}
