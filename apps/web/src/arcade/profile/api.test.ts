import {describe, expect, test} from "bun:test";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import {profileApi, profileSessionOwner} from "./api";
import type {Challenge, ProfileRepository} from "./repository";
import {profileRepository} from './repository';
import {Database} from 'bun:sqlite';
import {readFileSync} from 'node:fs';
import {d1} from './test-db';
const origin = "https://mapae.io", now = 1_790_870_000_000;
function repository(): ProfileRepository {
    const challenges = new Map<string, Challenge>();
    const sessions = new Map<string, {owner: string; origin: string; expires_at: number}>(), limits = new Map<string, number>();
    return {
        async rateLimit(key, _until, max) {const n = (limits.get(key) ?? 0) + 1; limits.set(key, n); return n <= max;},
        async challenge(hash, v) {challenges.set(hash, v);},
        async consumeChallenge(hash, site, at) {const v = challenges.get(hash); if (!v || v.origin !== site || v.expires_at <= at) return null; challenges.delete(hash); return v;},
        async session(hash, v) {sessions.set(hash, v);},
        async identity(hash, site, at) {const v = sessions.get(hash); return v && v.origin === site && v.expires_at > at ? v : null;},
        async logout(hash) {sessions.delete(hash);},
        async cleanup() {},
    };
}
const account = () => privateKeyToAccount(generatePrivateKey());
const request = (path = "", method = "GET", body?: unknown, headers: Record<string, string> = {}, site = origin) => new Request(`${site}/api/arcade/profile${path}`, {method, headers: {Origin: site, "Content-Type": "application/json", ...headers}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
const cookie = (r: Response, name: string) => r.headers.getSetCookie().find(v => v.startsWith(name + "="))?.split(";")[0] ?? "";
async function challenge(repo: ProfileRepository, user = account()) {
    const response = await profileApi(request("/challenge", "POST", {address: user.address}), repo, {now});
    expect(response.status).toBe(200);
    const {message} = await response.json<{message: string}>();
    return {user, response, message, signature: await user.signMessage({message}), headers: {Cookie: cookie(response, "__Host-mapae-arcade-challenge")}};
}
async function login(repo: ProfileRepository, user = account()) {
    const ch = await challenge(repo, user);
    const response = await profileApi(request("/login", "POST", {signature: ch.signature}, ch.headers), repo, {now});
    expect(response.status).toBe(200);
    return {user, headers: {Cookie: cookie(response, "__Host-mapae-arcade-session"), "X-Mapae-Wallet": user.address}};
}
describe("wallet sessions without mutable characters", () => {
    test("existing D1 character rows are never read or rewritten during login or NFT queries", async () => {
        const db = new Database(':memory:');
        try {
            db.exec(readFileSync(new URL('../../../schema/arcade.sql', import.meta.url), 'utf8'));
            db.exec('CREATE TABLE arcade_profiles (owner TEXT PRIMARY KEY, profile TEXT)');
            const user = account();
            // An invalid old snapshot would fail if any character parser still ran.
            db.query('INSERT INTO arcade_profiles VALUES (?, ?)').run(user.address.toLowerCase(), 'obsolete-unparseable-character');
            const repo = profileRepository(d1(db)), signed = await login(repo, user);
            const response = await profileApi(request('/session', 'GET', undefined, signed.headers), repo, {now});
            expect(await response.json<unknown>()).toEqual({owner: user.address.toLowerCase()});
            const roster = await profileApi(request('/guardians', 'GET', undefined, signed.headers), repo, {now, guardians: async () => Response.json({guardians: []})});
            expect(await roster.json<unknown>()).toEqual({guardians: []});
            expect(db.query('SELECT profile FROM arcade_profiles').get()).toEqual({profile: 'obsolete-unparseable-character'});
        } finally {db.close();}
    });
    test("a session returns only the verified owner and rejects another wallet", async () => {
        const repo = repository(), user = await login(repo);
        expect((await profileApi(request('/session'), repo, {now})).status).toBe(401);
        const response = await profileApi(request('/session', 'GET', undefined, user.headers), repo, {now});
        expect(response.status).toBe(200);
        expect(await response.json<unknown>()).toEqual({owner: user.user.address.toLowerCase()});
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
        expect((await profileApi(request('/session', 'GET', undefined, {...user.headers, 'X-Mapae-Wallet': account().address}), repo, {now})).status).toBe(401);
        expect((await profileApi(request('/session', 'PUT', {}, user.headers), repo, {now})).status).toBe(405);
    });
    test("retired character and standalone checkout endpoints are unavailable even after signing in", async () => {
        const repo = repository(), user = await login(repo);
        for (const path of ['', '/checkout', '/checkout/ack']) {
            for (const method of ['GET', 'PUT', 'POST']) {
                const response = await profileApi(request(path, method, method === 'GET' ? undefined : {profile: {characters: [{id: 'old-friend', name: '하수'}]}}, user.headers), repo, {now});
                expect(response.status).toBe(404);
                expect(await response.json<unknown>()).toEqual({error: {code: 'not_found'}});
            }
        }
        const ch = await challenge(repo);
        expect(ch.message).toContain('NFT guardians and outings');
        expect(ch.message).not.toContain('sync your characters');
    });


    test("signatures require a one-use expiring challenge and browser cookie", async () => {
        const repo = repository(), ch = await challenge(repo);
        expect(ch.message).toContain("Chain ID: 91342"); expect(ch.message).toContain("does not authorize payments");
        expect(ch.response.headers.get("Set-Cookie")).toContain("HttpOnly; Secure; SameSite=Strict");
        expect((await profileApi(request("/login", "POST", {signature: ch.signature}), repo, {now})).status).toBe(400);
        const attempts = await Promise.all([1, 2].map(() => profileApi(request("/login", "POST", {signature: ch.signature}, ch.headers), repo, {now})));
        expect(attempts.map(r => r.status).sort()).toEqual([200, 401]);
        const expired = await challenge(repo);
        expect((await profileApi(request("/login", "POST", {signature: expired.signature}, expired.headers), repo, {now: now + 300_001})).status).toBe(401);
    });
    test("another signer and another origin cannot reuse the message", async () => {
        const repo = repository(), ch = await challenge(repo);
        const signature = await account().signMessage({message: ch.message});
        expect((await profileApi(request("/login", "POST", {signature}, ch.headers), repo, {now})).status).toBe(401);
        const second = await challenge(repo);
        expect((await profileApi(request("/login", "POST", {signature: second.signature}, second.headers, "https://app.mapae.io"), repo, {now})).status).toBe(401);
    });
    test("cross-site writes, unknown hosts and query-selected profiles fail closed", async () => {
        const repo = repository(), user = await login(repo);
        const hostileHeaders: Record<string, string>[] = [{Origin: "https://evil.test"}, {"Sec-Fetch-Site": "cross-site"}, {"Content-Type": "text/plain"}];
        for (const headers of hostileHeaders) expect((await profileApi(request("/session", "PUT", {}, {...user.headers, ...headers}), repo, {now})).status).toBe(403);
        expect((await profileApi(request("?owner=another", "GET", undefined, user.headers), repo, {now})).status).toBe(403);
        expect((await profileApi(request("/session", "GET", undefined, user.headers, "https://evil.test"), repo, {now})).status).toBe(403);
    });

    test("sessions expire and logout revokes only that browser session", async () => {
        const repo = repository(), user = await login(repo), otherDevice = await login(repo, user.user);
        expect((await profileApi(request("/session", "GET", undefined, user.headers), repo, {now: now + 8 * 86400_000})).status).toBe(401);
        expect((await profileApi(request("/logout", "POST", {}, user.headers), repo, {now})).status).toBe(200);
        expect((await profileApi(request("/session", "GET", undefined, user.headers), repo, {now})).status).toBe(401);
        expect((await profileApi(request("/session", "GET", undefined, otherDevice.headers), repo, {now})).status).toBe(200);
    });
    test("challenge rate limits bound unauthenticated storage growth", async () => {
        const repo = repository(), user = account();
        for (let i = 0; i < 20; i++) expect((await profileApi(request("/challenge", "POST", {address: user.address}), repo, {now})).status).toBe(200);
        expect((await profileApi(request("/challenge", "POST", {address: user.address}), repo, {now})).status).toBe(429);
    });
});

test("authenticated limits are wallet-wide and expose a bounded retry delay", async () => {
    const repo = repository(), a = await login(repo), b = await login(repo, a.user);
    for (let i = 0; i < 60; i++) expect((await profileApi(request("/session", "GET", undefined, (i % 2 ? a : b).headers), repo, {now})).status).toBe(200);
    const limited = await profileApi(request("/session", "GET", undefined, b.headers), repo, {now});
    expect(limited.status).toBe(429); expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await profileApi(request("/session", "GET", undefined, a.headers), repo, {now: now + 60_000})).status).toBe(200);

});
test("guardian routes derive their actor from SIWE and only allow a bounded history cursor", async () => {
    const repo = repository(); let calls = 0;
    const user = await login(repo);
    const options = {now, guardians: async (_request: Request, owner: string) => {calls++; expect(owner).toBe(user.user.address.toLowerCase()); return Response.json({});}};
    expect((await profileApi(request("/guardians"), repo, options)).status).toBe(401);
    expect((await profileApi(request("/guardians", "GET", undefined, {...user.headers, "X-Mapae-Wallet": account().address}), repo, options)).status).toBe(401);
    expect((await profileApi(request("/guardians/1?before=12", "GET", undefined, user.headers), repo, options)).status).toBe(200);
    for (const path of ["/guardians?before=12", "/guardians/1?before=0", "/guardians/1?before=9007199254740992", "/guardians/1?before=12&owner=other"]) expect((await profileApi(request(path, "GET", undefined, user.headers), repo, options)).status).toBe(403);
    const claim = "/guardians/1/claims";
    expect((await profileApi(request(claim, "GET", undefined, user.headers), repo, options)).status).toBe(405);
    expect((await profileApi(request(claim, "POST", {}, {...user.headers, Origin: "https://evil.test"}), repo, options)).status).toBe(403);
    expect((await profileApi(request(claim, "POST", {}, user.headers), repo, options)).status).toBe(200);
    expect(calls).toBe(2);
});

test("foreground attribution requires a live session and measurement failure cannot break login", async () => {
    const repo = repository(), ch = await challenge(repo); let calls = 0;
    const response = await profileApi(request("/login", "POST", {signature: ch.signature}, ch.headers), repo, {now, onAuthenticated: async (_request, owner) => {calls++; expect(owner).toBe(ch.user.address.toLowerCase()); throw Error("metrics outage");}});
    expect(response.status).toBe(200); expect(calls).toBe(1);
    const headers = {Cookie: cookie(response, "__Host-mapae-arcade-session")};
    expect(await profileSessionOwner(request("/guardians", "GET", undefined, headers), repo, now)).toBe(ch.user.address.toLowerCase());
    expect(await profileSessionOwner(request("/guardians", "GET", undefined, {"X-Mapae-Wallet": ch.user.address}), repo, now)).toBe(null);
    expect(await profileSessionOwner(request("/guardians", "GET", undefined, headers), repo, now + 8 * 86400000)).toBe(null);
});
