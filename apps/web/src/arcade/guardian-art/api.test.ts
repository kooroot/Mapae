import {expect, test} from "bun:test";
import {pad, toHex, type Hex} from "viem";
import {guardianTraits} from "@mapae/arcade/guardians";
import {guardianArtApi} from "./api";

const url = 'https://mapae.io/api/arcade/guardians/1/image.svg';
const collection = `0x${'11'.repeat(20)}`;
const image = () => new Response(new Uint8Array([82, 73, 70, 70]), {headers: {'Content-Type': 'image/webp'}});
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
    expect((await guardianArtApi(new Request(url), {...deps, readBirth: async () => {throw Error('RPC failed');}})).status).toBe(503);
    expect((await guardianArtApi(new Request(url), {...deps, readBirth: async () => ({seed: pad('0x00'), revealed: true}), assets: {fetch: async () => new Response('bad')}})).status).toBe(503);
});
test('public image endpoint bounds IDs and denies arbitrary paths, queries and writes before RPC', async () => {
    const deps = {collection, assets: {fetch: async () => image()}, readBirth: async () => {throw Error('must not reach RPC');}};
    for (const path of ['0', '01', '10001', '-1', '1e2']) expect((await guardianArtApi(new Request(url.replace('/1/', `/${path}/`)), deps)).status).toBe(404);
    expect((await guardianArtApi(new Request(url + '?seed=chosen'), deps)).status).toBe(404);
    expect((await guardianArtApi(new Request(url, {method: 'POST'}), deps)).status).toBe(405);
});
