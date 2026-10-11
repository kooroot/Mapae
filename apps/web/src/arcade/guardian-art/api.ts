import {createPublicClient, http, isAddress, type Address, type Hex} from "viem";
import {giwaSepolia} from "@mapae/shared";
import {guardianAbi} from "@mapae/arcade/guardian-abi";
import {GUARDIAN_MAX_SUPPLY, guardianName, guardianTraits, guardianTokenId} from "@mapae/arcade/guardians";
import {BACKDROP_COLORS, SEAL_COLORS, type Guardian} from "../guardian";
import {guardianLayers} from "../guardian-layers";

type Birth = {seed: Hex; revealed: boolean};
type ArtDependencies = {collection?: string; assets: {fetch(request: Request): Promise<Response>}; readBirth?: (id: bigint) => Promise<Birth>};
const headers = {"Content-Type": "image/svg+xml; charset=utf-8", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'none'; sandbox", "Access-Control-Allow-Origin": "*"};
const error = (status: number) => new Response(null, {status, headers: {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}});

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

/** Standalone NFT image: all artwork is embedded, so an SVG image needs no subrequests. */
export async function guardianArtApi(request: Request, deps: ArtDependencies): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/api\/arcade\/guardians\/([1-9][0-9]*)\/image.svg$/.exec(url.pathname);
    if (!match || url.search || !guardianTokenId(match[1]) || BigInt(match[1]) > BigInt(GUARDIAN_MAX_SUPPLY)) return error(404);
    if (request.method !== "GET" && request.method !== "HEAD") return error(405);
    if (!deps.collection || !isAddress(deps.collection)) return error(503);
    try {
        const read = deps.readBirth ?? (async (tokenId: bigint) => {
            const client = createPublicClient({chain: giwaSepolia, transport: http(undefined, {retryCount: 1, timeout: 10000})});
            const [seed, , revealed] = await client.readContract({address: deps.collection as Address, abi: guardianAbi, functionName: "birth", args: [tokenId]});
            return {seed, revealed};
        });
        const birth = await read(BigInt(match[1]));
        if (!birth.revealed) {
            const pending = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" rx="28" fill="#ead3a5"/><text x="200" y="185" text-anchor="middle" fill="#303445" font-size="24">Mapae Guardian</text><text x="200" y="225" text-anchor="middle" fill="#303445" font-size="16">Awaiting onchain reveal</text></svg>';
            return new Response(request.method === "HEAD" ? null : pending, {headers: {...headers, "Cache-Control": "public, max-age=10"}});
        }
        const t = guardianTraits(birth.seed), tones = BACKDROP_COLORS[t.backdrop];
        const appearance: Guardian = {version: 1, seed: birth.seed.slice(2, 18), zodiac: t.zodiac, backdrop: t.backdrop, charm: t.charm, wardrobe: {hat: t.hat, outfit: t.outfit, shoes: t.shoes}};
        const layers = guardianLayers(appearance);
        const paths = [...new Set(layers.map(layer => layer.src))];
        const embedded = new Map(await Promise.all(paths.map(async path => [path, await embeddedImage(await deps.assets.fetch(new Request(new URL(path, url.origin), {signal: AbortSignal.timeout(10000)})))] as const)));
        const clips = layers.map((layer, i) => layer.clip ? `<clipPath id="fit-${i}" clipPathUnits="userSpaceOnUse"><polygon points="${layer.clip.map(p => `${p.x},${p.y}`).join(" ")}"/></clipPath>` : "").join("");
        const art = layers.map((layer, i) => `<image href="${embedded.get(layer.src)}" x="${layer.x}" y="${layer.y}" width="${layer.width}" height="${layer.height}" preserveAspectRatio="${layer.stretch ? "none" : "xMidYMax meet"}"${layer.clip ? ` clip-path="url(#fit-${i})"` : ""}/>`).join("");
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" role="img"><title>${guardianName(match[1], "ko")} (${guardianName(match[1], "en")}) · Mapae Guardians</title><defs>${clips}</defs><rect width="400" height="400" rx="28" fill="${tones[1]}"/><circle cx="200" cy="186" r="156" fill="${tones[0]}"/>${art}<rect x="8" y="8" width="384" height="384" rx="22" fill="none" stroke="${SEAL_COLORS[t.color]}" stroke-width="3"/></svg>`;
        return new Response(request.method === "HEAD" ? null : svg, {headers: {...headers, "Cache-Control": "public, max-age=86400, immutable", ETag: `"guardian-${deps.collection.toLowerCase()}-${match[1]}-${birth.seed}"`}});
    } catch {return error(503);}
}
