import {expect, test} from "bun:test";
import {ContractFunctionExecutionError, ContractFunctionRevertedError, HttpRequestError, pad, toHex, type Hex} from "viem";
import {giwaSepolia} from "@mapae/shared";
import {guardianAbi} from "@mapae/arcade/guardian-abi";
import {guardianTraits} from "@mapae/arcade/guardians";
import {ART_REVISION, guardianArtApi, guardianArtCacheKey, guardianArtRpcUrl} from "./api";

const url = 'https://mapae.io/api/arcade/guardians/1/image.svg';
const collection = `0x${'11'.repeat(20)}`;
const image = () => new Response(new Uint8Array([82, 73, 70, 70]), {headers: {'Content-Type': 'image/webp'}});
function memoryCache() {
    const entries = new Map<string, Response>();
    const cache = {
        async match(key: Request) {return entries.get(key.url)?.clone();},
        async put(key: Request, value: Response) {entries.set(key.url, value);},
    } as unknown as Cache;
    return {entries, cache: Promise.resolve(cache)};
}
const reverted = () => new ContractFunctionExecutionError(new ContractFunctionRevertedError({abi: guardianAbi, functionName: 'birth'}), {abi: guardianAbi, functionName: 'birth', args: [1n], contractAddress: collection as Hex});
test('revealed NFT image embeds fixed assets and preserves sloping hat fit without external URLs', async () => {
    let seed: Hex = pad('0x00');
    for (let i = 0; i < 5000; i++) {const s = pad(toHex(i)); const t = guardianTraits(s); if (t.zodiac === 'dragon' && t.hat === 'satgat') {seed = s; break;}}
    expect(guardianTraits(seed).hat).toBe('satgat');
    const paths: string[] = [];
    const result = await guardianArtApi(new Request(url), {collection, readBirth: async id => {expect(id).toBe(1n); return {seed, revealed: true};}, assets: {fetch: async request => {paths.push(new URL(request.url).pathname); return image();}}});
    expect(result.status).toBe(200);
    const svg = await result.text();
    expect(svg).toContain('<polygon'); expect(svg).toContain('preserveAspectRatio="none"');
    expect(svg).toContain('data:image/webp;base64,');
    expect(svg).not.toContain('href="http'); expect(svg).not.toContain('href="/');
    expect(paths).toContain('/arcade/wardrobe/head-dragon.webp');
    expect(paths.filter(p => p.endsWith('hat-satgat.webp'))).toHaveLength(1);
    expect(result.headers.get('etag')).toContain(seed);
});
test('pending state never pretends a seed is revealed and fails closed without chain/config/art', async () => {
    const deps = {collection, readBirth: async () => ({seed: pad('0x00'), revealed: false}), assets: {fetch: async () => image()}};
    const pending = await guardianArtApi(new Request(url), deps);
    expect(await pending.text()).toContain('Awaiting onchain reveal');
    expect(pending.headers.get('cache-control')).toBe('public, max-age=10');
    expect((await guardianArtApi(new Request(url), {...deps, collection: undefined})).status).toBe(503);
    const down = await guardianArtApi(new Request(url), {...deps, readBirth: async () => {throw new HttpRequestError({url: 'https://rpc.example', status: 403});}});
    expect(down.status).toBe(503); expect(down.headers.get('retry-after')).toBe('5'); expect(down.headers.get('cache-control')).toBe('no-store');
    expect((await guardianArtApi(new Request(url), {...deps, readBirth: async () => ({seed: pad('0x00'), revealed: true}), assets: {fetch: async () => new Response('bad')}})).status).toBe(503);
});
test('public image endpoint bounds IDs and denies arbitrary paths, queries and writes before RPC', async () => {
    const deps = {collection, assets: {fetch: async () => image()}, readBirth: async () => {throw Error('must not reach RPC');}};
    for (const path of ['0', '01', '10001', '-1', '1e2']) expect((await guardianArtApi(new Request(url.replace('/1/', `/${path}/`)), deps)).status).toBe(404);
    expect((await guardianArtApi(new Request(url + '?seed=chosen'), deps)).status).toBe(404);
    expect((await guardianArtApi(new Request(url, {method: 'POST'}), deps)).status).toBe(405);
});
test('a revealed image is drawn once and then served from the edge cache without another RPC read', async () => {
    const {entries, cache} = memoryCache(); let reads = 0, fetches = 0;
    const deps = {collection, cache, readBirth: async () => {reads++; return {seed: pad('0x01'), revealed: true};}, assets: {fetch: async () => {fetches++; return image();}}};
    const first = await guardianArtApi(new Request(url), deps), body = await first.text();
    const second = await guardianArtApi(new Request(url), deps);
    expect(reads).toBe(1); expect(entries.size).toBe(1); const drawn = fetches;
    expect(await second.text()).toBe(body);
    expect(second.headers.get('cache-control')).toBe('public, max-age=86400, immutable');
    expect(second.headers.get('etag')).toBe(first.headers.get('etag'));
    expect(second.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect([...entries.values()][0]!.headers.get('cache-control')).toBe('public, max-age=604800');
    const head = await guardianArtApi(new Request(url, {method: 'HEAD'}), deps);
    expect(head.status).toBe(200); expect(head.body).toBeNull(); expect(reads).toBe(1); expect(fetches).toBe(drawn);
});
test('pending art, unminted ids and outages are never written to the edge cache', async () => {
    const {entries, cache} = memoryCache();
    const deps = {collection, cache, assets: {fetch: async () => image()}};
    expect((await guardianArtApi(new Request(url), {...deps, readBirth: async () => ({seed: pad('0x00'), revealed: false})})).status).toBe(200);
    const missing = await guardianArtApi(new Request(url), {...deps, readBirth: async () => {throw reverted();}});
    expect(missing.status).toBe(404); expect(missing.headers.get('cache-control')).toBe('public, max-age=30');
    expect((await guardianArtApi(new Request(url), {...deps, readBirth: async () => {throw new Error('socket hang up');}})).status).toBe(503);
    expect((await guardianArtApi(new Request(url), {...deps, readBirth: async () => ({seed: pad('0x00'), revealed: true}), assets: {fetch: async () => new Response('bad')}})).status).toBe(503);
    expect(entries.size).toBe(0);
});
test('the cache key pins the collection and the art revision, and the reader prefers the dedicated RPC', () => {
    const key = new URL(guardianArtCacheKey('https://mapae.io', '7', `0x${'AB'.repeat(20)}`).url);
    expect(key.pathname).toBe('/api/arcade/guardians/7/image.svg');
    expect(key.searchParams.get('collection')).toBe(`0x${'ab'.repeat(20)}`);
    expect(key.searchParams.get('art')).toBe(String(ART_REVISION));
    expect(guardianArtRpcUrl('https://giwa.example/v1/key ')).toBe('https://giwa.example/v1/key');
    expect(guardianArtRpcUrl(undefined)).toBe(new URL(giwaSepolia.rpcUrls.default.http[0]).toString());
    expect(guardianArtRpcUrl('  ')).toBe(guardianArtRpcUrl(undefined));
    expect(() => guardianArtRpcUrl('http://giwa.example')).toThrow();
});
test('a misconfigured dedicated RPC fails closed as an outage, not a missing token', async () => {
    const result = await guardianArtApi(new Request(url), {collection, rpcUrl: 'ftp://giwa.example', assets: {fetch: async () => image()}});
    expect(result.status).toBe(503);
});
