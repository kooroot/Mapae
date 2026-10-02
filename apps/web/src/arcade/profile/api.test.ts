import {PROFILE_GENERATION} from "./model";
import {describe, expect, test} from "bun:test";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import {profileApi} from "./api";
import type {Challenge, ProfileRepository} from "./repository";
import {emptyProfile, projectProfile, type ProfileSnapshot} from "./model";
import {addCharacter, newArcadeState, newCompanion} from "../state";
const origin = "https://mapae.io", now = 1_790_870_000_000;
function repository(): ProfileRepository {
    const profiles = new Map<string, ProfileSnapshot>(), challenges = new Map<string, Challenge>();
    const sessions = new Map<string, {owner: string; origin: string; expires_at: number}>(), limits = new Map<string, number>();
    return {
        async rateLimit(key, _until, max) {const n = (limits.get(key) ?? 0) + 1; limits.set(key, n); return n <= max;},
        async challenge(hash, v) {challenges.set(hash, v);},
        async consumeChallenge(hash, site, at) {const v = challenges.get(hash); if (!v || v.origin !== site || v.expires_at <= at) return null; challenges.delete(hash); return v;},
        async session(hash, v) {sessions.set(hash, v);},
        async identity(hash, site, at) {const v = sessions.get(hash); return v && v.origin === site && v.expires_at > at ? v : null;},
        async logout(hash) {sessions.delete(hash);},
        async read(owner) {return profiles.get(owner) ?? {owner, generation: PROFILE_GENERATION, revision: 0, profile: emptyProfile()};},
        async write(owner, revision, profile) {if ((profiles.get(owner)?.revision ?? 0) !== revision) return false; profiles.set(owner, {owner, generation: PROFILE_GENERATION, revision: revision + 1, profile}); return true;},
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
const profile = () => projectProfile(addCharacter(newArcadeState(), newCompanion("guardian", {name: "마루", color: "jade", temperament: "calm"})));
describe("wallet-owned server profiles", () => {
    test("an address alone cannot read or write a profile", async () => {
        const repo = repository(), user = account();
        for (const method of ["GET", "PUT"]) expect((await profileApi(request("", method, method === "PUT" ? {generation: PROFILE_GENERATION, revision: 0, profile: profile()} : undefined, {"X-Mapae-Wallet": user.address}), repo, {now})).status).toBe(401);
    });
    test("two independently signed device sessions share characters and scores", async () => {
        const repo = repository(), user = account(), mobile = await login(repo, user), desktop = await login(repo, user);
        expect((await profileApi(request("", "PUT", {generation: PROFILE_GENERATION, revision: 0, profile: profile()}, mobile.headers), repo, {now})).status).toBe(200);
        const loaded = await profileApi(request("", "GET", undefined, desktop.headers), repo, {now});
        expect(await loaded.json<object>()).toEqual({owner: user.address.toLowerCase(), generation: PROFILE_GENERATION, revision: 1, profile: profile()});
        expect(loaded.headers.get("Cache-Control")).toContain("no-store");
    });
    test("a different wallet session cannot select another owner", async () => {
        const repo = repository(), a = await login(repo), b = await login(repo);
        expect((await profileApi(request("", "PUT", {generation: PROFILE_GENERATION, revision: 0, profile: profile()}, {...b.headers, "X-Mapae-Wallet": a.user.address}), repo, {now})).status).toBe(401);
        expect((await repo.read(a.user.address.toLowerCase())).revision).toBe(0);
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
        for (const headers of hostileHeaders) expect((await profileApi(request("", "PUT", {generation: PROFILE_GENERATION, revision: 0, profile: profile()}, {...user.headers, ...headers}), repo, {now})).status).toBe(403);
        expect((await profileApi(request("?owner=another", "GET", undefined, user.headers), repo, {now})).status).toBe(403);
        expect((await profileApi(request("", "GET", undefined, user.headers, "https://evil.test"), repo, {now})).status).toBe(403);
    });
    test("two writes at the same revision cannot silently overwrite each other", async () => {
        const repo = repository(), user = await login(repo);
        const r = await Promise.all([1, 2].map(() => profileApi(request("", "PUT", {generation: PROFILE_GENERATION, revision: 0, profile: profile()}, user.headers), repo, {now})));
        expect(r.map(v => v.status).sort()).toEqual([200, 409]);
        expect((await repo.read(user.user.address.toLowerCase())).revision).toBe(1);
    });
    test("invalid and oversized records are refused; credential fields never persist", async () => {
        const repo = repository(), user = await login(repo);
        for (const value of [{characters: [{}], activities: [], runs: []}, {characters: [], activities: [{}], runs: []}]) expect((await profileApi(request("", "PUT", {generation: PROFILE_GENERATION, revision: 0, profile: value}, user.headers), repo, {now})).status).toBe(400);
        expect((await profileApi(request("", "PUT", {generation: PROFILE_GENERATION, revision: 0, profile: {...profile(), extra: "a".repeat(800_000)}}, user.headers), repo, {now})).status).toBe(413);
        const r = await profileApi(request("", "PUT", {generation: PROFILE_GENERATION, revision: 0, profile: {...profile(), privateKey: "must-not-persist", permissionContext: "must-not-persist"}}, user.headers), repo, {now});
        expect(r.status).toBe(200); expect(await r.text()).not.toContain("must-not-persist");
    });
    test("sessions expire and logout revokes only that browser session", async () => {
        const repo = repository(), user = await login(repo), otherDevice = await login(repo, user.user);
        expect((await profileApi(request("", "GET", undefined, user.headers), repo, {now: now + 8 * 86400_000})).status).toBe(401);
        expect((await profileApi(request("/logout", "POST", {}, user.headers), repo, {now})).status).toBe(200);
        expect((await profileApi(request("", "GET", undefined, user.headers), repo, {now})).status).toBe(401);
        expect((await profileApi(request("", "GET", undefined, otherDevice.headers), repo, {now})).status).toBe(200);
    });
    test("challenge rate limits bound unauthenticated storage growth", async () => {
        const repo = repository(), user = account();
        for (let i = 0; i < 20; i++) expect((await profileApi(request("/challenge", "POST", {address: user.address}), repo, {now})).status).toBe(200);
        expect((await profileApi(request("/challenge", "POST", {address: user.address}), repo, {now})).status).toBe(429);
    });
});

test("authenticated limits are wallet-wide and expose a bounded retry delay", async () => {
    const repo = repository(), a = await login(repo), b = await login(repo, a.user);
    for (let i = 0; i < 60; i++) expect((await profileApi(request("", "GET", undefined, (i % 2 ? a : b).headers), repo, {now})).status).toBe(200);
    const limited = await profileApi(request("", "GET", undefined, b.headers), repo, {now});
    expect(limited.status).toBe(429); expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await profileApi(request("", "GET", undefined, a.headers), repo, {now: now + 60_000})).status).toBe(200);
    for (let i = 0; i < 30; i++) expect((await profileApi(request("", "PUT", {generation: PROFILE_GENERATION, revision: i, profile: profile()}, a.headers), repo, {now})).status).toBe(200);
    expect((await profileApi(request("", "PUT", {generation: PROFILE_GENERATION, revision: 30, profile: profile()}, b.headers), repo, {now})).status).toBe(429);
});
test("pre-restore clients cannot write even at the same revision", async () => {
    const repo = repository(), user = await login(repo);
    const result = await profileApi(request("", "PUT", {generation: "old", revision: 0, profile: profile()}, user.headers), repo, {now});
    expect(result.status).toBe(409); expect((await repo.read(user.user.address.toLowerCase())).profile.characters).toHaveLength(0);
});
test("checkout callbacks never run before wallet authentication and same-origin checks", async () => {
    const repo = repository(); let calls = 0;
    const options = {now, checkout: async () => {calls++; return Response.json({});}};
    expect((await profileApi(request("/checkout", "POST", {}), repo, options)).status).toBe(401);
    const user = await login(repo);
    expect((await profileApi(request("/checkout", "POST", {}, {...user.headers, Origin: "https://evil.test"}), repo, options)).status).toBe(403);
    expect(calls).toBe(0);
    expect((await profileApi(request("/checkout", "GET", undefined, user.headers), repo, options)).status).toBe(200);
    expect(calls).toBe(1);
});
