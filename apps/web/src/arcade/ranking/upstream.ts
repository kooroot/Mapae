import {tokenHash} from "../../lib/siwe-session";

/** The seller's ranking reader; every public board, standing and share card is a validated copy of one of its answers. */
export const UPSTREAM = "https://seller.mapae.io/arcade/ranking";
const MAX_RESPONSE_BYTES = 64 * 1024;
const RATE_PER_MINUTE = 120;

export type UpstreamDependencies = {
    receiptToken?: string;
    fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
    rateLimit: (bucket: string, until: number, limit: number) => Promise<boolean>;
    now?: number;
};

export const hasReceiptToken = (deps: UpstreamDependencies): boolean => !!deps.receiptToken && deps.receiptToken.length >= 32;

/** Spends one unit of the caller's per-IP minute budget; the seconds until it refills when there is none left, else null. */
export async function ipBudget(request: Request, deps: UpstreamDependencies): Promise<number | null> {
    const now = deps.now ?? Date.now(), minute = Math.floor(now / 60_000), until = (minute + 1) * 60_000, ip = request.headers.get("CF-Connecting-IP");
    if (ip && !await deps.rateLimit(`ranking-ip:${await tokenHash(ip)}:${minute}`, until, RATE_PER_MINUTE)) return Math.max(1, Math.ceil((until - now) / 1000));
    return null;
}

/** A reader answer other than 200 or 404: the error carries the status for the one caller that reads it. */
export class UpstreamError extends Error {
    constructor(readonly status: number) {super(`upstream ${status}`);}
}
/** One bearer call to the reader at `path`: its parsed body, or `found: false` on its 404. Any other failure throws. */
export async function upstreamJson(path: string, deps: UpstreamDependencies): Promise<{found: true; value: unknown} | {found: false}> {
    const response = await (deps.fetcher ?? fetch)(`${UPSTREAM}${path}`, {
        method: "GET", headers: {Authorization: `Bearer ${deps.receiptToken}`, Accept: "application/json"}, redirect: "manual", signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) {await response.body?.cancel(); return {found: false};}
    if (!response.ok) {await response.body?.cancel(); throw new UpstreamError(response.status);}
    return {found: true, value: await boundedJson(response)};
}

async function boundedJson(response: Response): Promise<unknown> {
    const advertised = response.headers.get("Content-Length");
    if (advertised && Number(advertised) > MAX_RESPONSE_BYTES) {await response.body?.cancel(); throw new Error("too_large");}
    const reader = response.body?.getReader(); if (!reader) throw new Error("empty");
    const decoder = new TextDecoder(); let size = 0, text = "";
    for (;;) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {await reader.cancel(); throw new Error("too_large");}
        text += decoder.decode(next.value, {stream: true});
    }
    return JSON.parse(text + decoder.decode());
}
