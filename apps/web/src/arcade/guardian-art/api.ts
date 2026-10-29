import {BaseError, ContractFunctionRevertedError, createPublicClient, http, isAddress, type Address, type Hex} from "viem";
import {giwaSepolia, parseNodeRpcUrl} from "@mapae/shared";
import {guardianAbi} from "@mapae/arcade/guardian-abi";
import {GUARDIAN_MAX_SUPPLY, guardianName, guardianTraits, guardianTokenId} from "@mapae/arcade/guardians";
import {BACKDROP_COLORS, SEAL_COLORS} from "@mapae/arcade/guardian-art";
import {fromEdgeCache} from "../../lib/edge-cache";
import {guardianAppearance} from "../guardian";
import {guardianLayers} from "../guardian-layers";

type Birth = {seed: Hex; revealed: boolean};
type ArtDependencies = {
    collection?: string;
    /** The operator's dedicated GIWA RPC (Worker secret `GIWA_SEPOLIA_RPC_URL`); unset only in local dev. */
    rpcUrl?: string;
    assets: {fetch(request: Request): Promise<Response>};
    /** The edge cache; absent where the runtime has none. */
    cache?: Promise<Cache>;
    readBirth?: (id: bigint) => Promise<Birth>;
};
/** Bump whenever the layer art or the composition below changes, so cached revealed images are redrawn. */
export const ART_REVISION = 1;
/** Revealed art is immutable on chain, so the edge keeps it a week; browsers get a day. */
const EDGE_MAX_AGE = 604800, CLIENT_CACHE = "public, max-age=86400, immutable";
const headers = {"Content-Type": "image/svg+xml; charset=utf-8", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'none'; sandbox", "Access-Control-Allow-Origin": "*"};
const error = (status: number, extra: Record<string, string> = {}) => new Response(null, {status, headers: {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra}});
/** Only a chain or asset outage is 503, and it tells the caller to come back shortly. */
const unavailable = () => error(503, {"Retry-After": "5"});

/** The dedicated endpoint when configured, else the public one (the same rule as the sponsor's `RPC_URL`). Cloudflare egress is often refused by the public endpoint. */
export function guardianArtRpcUrl(rpcUrl?: string): string {
    return parseNodeRpcUrl(rpcUrl?.trim() || giwaSepolia.rpcUrls.default.http[0]);
}

/** One `birth` read per uncached image, so pacing has nothing to do; viem's own backoff retries 403/408/429/5xx and rate-limit codes. */
export function birthReader(collection: Address, rpcUrl?: string): (id: bigint) => Promise<Birth> {
    const client = createPublicClient({chain: giwaSepolia, transport: http(guardianArtRpcUrl(rpcUrl), {retryCount: 2, retryDelay: 200, timeout: 4000})});
    return async tokenId => {
        const [seed, , revealed] = await client.readContract({address: collection, abi: guardianAbi, functionName: "birth", args: [tokenId]});
        return {seed, revealed};
    };
}

export const guardianArtCacheKey = (origin: string, id: string, collection: string) =>
    new Request(`${origin}/api/arcade/guardians/${id}/image.svg?collection=${collection.toLowerCase()}&art=${ART_REVISION}`);

async function embeddedImage(response: Response): Promise<string> {
    if (!response.ok || response.headers.get("Content-Type")?.split(";")[0] !== "image/webp") throw new Error("Guardian artwork unavailable");
    const reader = response.body?.getReader(); if (!reader) throw new Error("Empty artwork");
    const parts: Uint8Array[] = []; let total = 0;
    for (;;) {
        const part = await reader.read(); if (part.done) break;
        total += part.value.byteLength;
        if (total > 524288) {await reader.cancel(); throw new Error("Artwork exceeds limit");}
        parts.push(part.value);
    }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const part of parts) {bytes.set(part, offset); offset += part.byteLength;}
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return `data:image/webp;base64,${btoa(binary)}`;
}

/**
 * Standalone NFT image: all artwork is embedded, so an SVG image needs no subrequests.
 * A revealed seed never changes, so its image is cached at the edge and a hit costs no RPC read.
 */
export async function guardianArtApi(request: Request, deps: ArtDependencies): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/api\/arcade\/guardians\/([1-9][0-9]*)\/image.svg$/.exec(url.pathname);
    if (!match || url.search || !guardianTokenId(match[1]) || BigInt(match[1]) > BigInt(GUARDIAN_MAX_SUPPLY)) return error(404);
    if (request.method !== "GET" && request.method !== "HEAD") return error(405);
    if (!deps.collection || !isAddress(deps.collection)) return unavailable();
    const id = match[1], key = guardianArtCacheKey(url.origin, id, deps.collection);
    const cache = deps.cache ? await deps.cache.catch(() => undefined) : undefined;
    const hit = await cache?.match(key).catch(() => undefined);
    if (hit) return fromEdgeCache(hit, CLIENT_CACHE, request.method);
    let birth: Birth;
    try {
        birth = await (deps.readBirth ?? birthReader(deps.collection, deps.rpcUrl))(BigInt(id));
    } catch (cause) {
        // `_requireOwned` reverts for an id never minted or burned: a short shared 404, not an outage.
        if (cause instanceof BaseError && cause.walk(e => e instanceof ContractFunctionRevertedError)) return error(404, {"Cache-Control": "public, max-age=30"});
        return unavailable();
    }
    if (!birth.revealed) {
        // Never cached at the edge: the reveal lands within minutes.
        const pending = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" rx="28" fill="#ead3a5"/><text x="200" y="185" text-anchor="middle" fill="#303445" font-size="24">Mapae Guardian</text><text x="200" y="225" text-anchor="middle" fill="#303445" font-size="16">Awaiting onchain reveal</text></svg>';
        return new Response(request.method === "HEAD" ? null : pending, {headers: {...headers, "Cache-Control": "public, max-age=10"}});
    }
    try {
        const t = guardianTraits(birth.seed), tones = BACKDROP_COLORS[t.backdrop], layers = guardianLayers(guardianAppearance(birth.seed));
        const paths = [...new Set(layers.map(layer => layer.src))];
        const embedded = new Map(await Promise.all(paths.map(async path => [path, await embeddedImage(await deps.assets.fetch(new Request(new URL(path, url.origin), {signal: AbortSignal.timeout(10000)})))] as const)));
        const clips = layers.map((layer, i) => layer.clip ? `<clipPath id="fit-${i}" clipPathUnits="userSpaceOnUse"><polygon points="${layer.clip.map(p => `${p.x},${p.y}`).join(" ")}"/></clipPath>` : "").join("");
        const art = layers.map((layer, i) => `<image href="${embedded.get(layer.src)}" x="${layer.x}" y="${layer.y}" width="${layer.width}" height="${layer.height}" preserveAspectRatio="${layer.stretch ? "none" : "xMidYMax meet"}"${layer.clip ? ` clip-path="url(#fit-${i})"` : ""}/>`).join("");
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" role="img"><title>${guardianName(id, "ko")} (${guardianName(id, "en")}) · Mapae Guardians</title><defs>${clips}</defs><rect width="400" height="400" rx="28" fill="${tones[1]}"/><circle cx="200" cy="186" r="156" fill="${tones[0]}"/>${art}<rect x="8" y="8" width="384" height="384" rx="22" fill="none" stroke="${SEAL_COLORS[t.color]}" stroke-width="3"/></svg>`;
        const etag = `"guardian-${deps.collection.toLowerCase()}-${id}-${birth.seed}"`;
        await cache?.put(key, new Response(svg, {headers: {...headers, "Cache-Control": `public, max-age=${EDGE_MAX_AGE}`, ETag: etag}})).catch(() => {/* A cold cache only costs the next viewer one RPC read. */});
        return new Response(request.method === "HEAD" ? null : svg, {headers: {...headers, "Cache-Control": CLIENT_CACHE, ETag: etag}});
    } catch {return unavailable();}
}
