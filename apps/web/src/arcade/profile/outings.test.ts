import {describe, expect, test} from "bun:test";
import type {Address} from "viem";
import {guardianName,guardianTraits,guardianTraitsHash,type GuardianSnapshot} from "@mapae/arcade/guardians";
import {ARCADE_RULESET_VERSION, type ActivityOutcome} from "@mapae/arcade";
import type {OutingStatus, OutingView} from "@mapae/arcade/outings";
import {kstDay, rankedSeed} from "@mapae/arcade/ranking";
import type {ProfileRepository} from "./repository";
import {profileApi} from "./api";
import {tokenHash} from "../../lib/siwe-session";
import {outingsApi, parseOutingStatus, type OutingFetcher} from "./outings";
const owner = "0x1111111111111111111111111111111111111111" as Address, other = "0x2222222222222222222222222222222222222222" as Address;
const token = "1".repeat(64), receiptToken = "private-server-token".repeat(3), now = 1_800_000_000_000;
const url = "https://mapae.io/api/arcade/profile/outings";
const seed = `0x${"77".repeat(32)}` as const, traits=guardianTraits(seed);
const guardian:GuardianSnapshot={chainId:91342,collection:other,tokenId:"1",owner,ownershipEpoch:"1",seed,traitsHash:guardianTraitsHash(seed),ruleset:ARCADE_RULESET_VERSION};
function repository() {
    const limits = new Map<string, number>();
    const repo: ProfileRepository = {
        async rateLimit(k, _until, limit) {const n = (limits.get(k) ?? 0) + 1; limits.set(k, n); return n <= limit;},
        async challenge() {}, async consumeChallenge() {return null;}, async session() {}, async identity(hash, origin) {return hash === await tokenHash(token) ? {owner, origin, expires_at: now + 1000} : null;}, async logout() {}, async cleanup() {},
    }; return {repo};
}
const request = (method = "GET", path = "", input?: unknown, headers: Record<string, string> = {}) => new Request(url + path, {method, headers: {Origin: "https://mapae.io", "Content-Type": "application/json", Cookie: `__Host-mapae-arcade-session=${token}`, "X-Mapae-Wallet": owner, ...headers}, ...(input === undefined ? {} : {body: JSON.stringify(input)})});
const start = () => ({id: "outing-one", tokenId: "1", goal:"explore", choice: "race", admissions: 2, permissionContext: "0x1234", locale: "ko"});
function outcome(seed = 123, score = 80): ActivityOutcome {return {game: "race", score, achievement:{victory:false}, replay: {version: ARCADE_RULESET_VERSION, seed}, summary: {ko: "도착!", en: "Finished!"}, metrics: [], ranking: [], transcript: []};}
function job(index = 1, count = 1): OutingView {
    return {id: `outing-${index.toString().padStart(4, "0")}`, characterId: "nft-1", guardian, profile: {name: guardianName(1, "ko"), color: traits.color, temperament: traits.temperament, goal: "explore", aptitudes:traits.aptitudes}, locale: "ko", choice: "race", status: "complete", admissions: count, spent: count, reservedAdmissions: 0,
        createdAt: now - 1000, updatedAt: now, expiresAt: now + 1000, error: null,
        results: Array.from({length: count}, (_, i) => ({id: `result-${index}-${i}`, game: "race" as const, seed: index + i, at: now - 1000 + index * 40 + i, transaction: `0x${(index * 100 + i).toString(16).padStart(64, "0")}`, outcome: outcome(index + i, index + i)}))};
}
const status = (jobs: OutingView[] = []): OutingStatus => ({enabled: true, agent: other, jobs});
const respond = (value: unknown, code = 200) => (async () => Response.json(value, {status: code})) as OutingFetcher;
const deps = (repo: ProfileRepository, fetcher = respond(status())) => ({receiptToken, fetcher});
function handler(repo: ProfileRepository, fetcher = respond(status())) {return {now, outings: (r: Request, a: Address, v: unknown) => outingsApi(r, a, v, deps(repo, fetcher))};}

describe("authenticated server outings", () => {
    test("anonymous, wrong wallet and cross-origin callers never reach the trusted server", async () => {
        const {repo} = repository(); let calls = 0; const opts = handler(repo, (async () => {calls++; return Response.json(status());}) as OutingFetcher);
        for (const headers of [{Cookie: ""}, {"X-Mapae-Wallet": other}] as Record<string, string>[]) expect((await profileApi(request("GET", "", undefined, headers), repo, opts)).status).toBe(401);
        for (const headers of [{Origin: "https://evil.test"}, {"Sec-Fetch-Site": "cross-site"}, {"Content-Type": "text/plain"}] as Record<string, string>[]) expect((await profileApi(request("POST", "", start(), headers), repo, opts)).status).toBe(403);
        expect(calls).toBe(0); expect((await profileApi(request("GET"), repo, opts)).status).toBe(200); expect(calls).toBe(1);
    });
    test("only token and owner operating choices reach the fixed private seller",async()=>{
        const {repo}=repository();let received:{url:string;init:RequestInit}|undefined;
        const fetcher:OutingFetcher=async(url,init)=>{received={url,init:init!};return Response.json(status());};
        expect((await profileApi(request("POST","",start()),repo,handler(repo,fetcher))).status).toBe(200);
        expect(received!.url).toBe("https://seller.mapae.io/arcade/outing");expect(received!.init.redirect).toBe("manual");
        expect(received!.init.headers).toEqual({Authorization:`Bearer ${receiptToken}`,"X-Mapae-Owner":owner,Accept:"application/json","Content-Type":"application/json"});
        expect(JSON.parse(String(received!.init.body))).toEqual(start());
    });
    test("profile score, traits and shop memory cannot alter the NFT request",async()=>{
        const {repo}=repository();let calls=0;const fetcher:OutingFetcher=async()=>{calls++;return Response.json(status());};
        for(const patch of [{owner:other},{profile:{temperament:'bold'}},{shopMemory:{npc:'twins'}},{characterId:'old-character'},{score:99999}])
            expect((await outingsApi(request("POST"),owner,{...start(),...patch},deps(repo,fetcher))).status).toBe(400);
        expect(calls).toBe(0);
    });
    test("rejects malformed tokens, obsolete payload fields and invalid operating fields",async()=>{
        const {repo}=repository();let calls=0;const opts=handler(repo,async()=>{calls++;return Response.json(status());});
        for(const patch of [{id:'short'},{tokenId:'01'},{tokenId:(1n<<256n).toString()},{admissions:37},{admissions:0},{admissions:1.5},{choice:'bad'},{locale:'fr'},{permissionContext:'0x123'},{goal:'steal'}])
            expect((await profileApi(request('POST','',{...start(),...patch}),repo,opts)).status).toBe(400);
        expect((await profileApi(request('POST','',{...start(),generation:'old'}),repo,opts)).status).toBe(400);expect(calls).toBe(0);
    });
    test("stop and resume use the authenticated owner and refuse other methods", async () => {
        const {repo} = repository(), calls: string[] = [];
        const fetcher = (async (target, init) => {calls.push(String(target)); expect((init!.headers as Record<string, string>)["X-Mapae-Owner"]).toBe(owner); expect(init!.body).toBe("{}"); return Response.json(status());}) as OutingFetcher;
        for (const action of ["stop", "resume"]) expect((await profileApi(request("POST", `/outing-one/${action}`, {owner: other}), repo, handler(repo, fetcher))).status).toBe(200);
        expect(calls).toEqual(["https://seller.mapae.io/arcade/outing/outing-one/stop", "https://seller.mapae.io/arcade/outing/outing-one/resume"]);
        expect((await profileApi(request("GET", "/outing-one/stop"), repo, handler(repo))).status).toBe(405); expect((await profileApi(request("DELETE"), repo, handler(repo))).status).toBe(405);
        expect((await profileApi(request("GET", "?owner=other"), repo, handler(repo))).status).toBe(403);
    });
    test("body cap and wallet-wide rate limits apply before the bridge", async () => {
        const {repo} = repository(); let calls = 0; const opts = handler(repo, (async () => {calls++; return Response.json(status());}) as OutingFetcher);
        expect((await profileApi(request("POST", "", {...start(), padding: "a".repeat(65_536)}), repo, opts)).status).toBe(413); expect(calls).toBe(0);
        for (let i = 0; i < 30; i++) expect((await profileApi(request("GET"), repo, opts)).status).toBe(200);
        const limited = await profileApi(request("GET"), repo, opts); expect(limited.status).toBe(429); expect(limited.headers.has("Retry-After")).toBe(true);
    });
    test("disabled configuration reports no service and never submits a start", async () => {
        let called = false; const dependency = {fetcher: (async () => {called = true; throw Error();}) as OutingFetcher};
        const r = await outingsApi(request(), owner, null, dependency); expect(r.status).toBe(200); expect(await r.json<unknown>()).toEqual({enabled: false, agent: null, jobs: []});
        expect((await outingsApi(request("POST"), owner, start(), dependency)).status).toBe(503); expect(called).toBe(false);
    });
});

describe("untrusted seller response", () => {
    test("accepts a positive control and strips unknown fields at every public layer", () => {
        const raw = {...status([job()]), permissionContext: "secret", privateKey: "secret"}; Object.assign(raw.jobs[0]!, {header: "secret"}); Object.assign(raw.jobs[0]!.profile, {privateKey: "secret"}); Object.assign(raw.jobs[0]!.results[0]!.outcome.replay!, {signature: "secret"});
        expect(parseOutingStatus(raw)).toEqual(status([job()])); expect(JSON.stringify(parseOutingStatus(raw))).not.toContain("secret");
    });
    test("rejects malformed, duplicated, mismatched and excessive results atomically", async () => {
        const corruptions: ((s: OutingStatus) => void)[] = [s => {s.jobs[0]!.results[0]!.outcome.game = "shop";}, s => {s.jobs[0]!.results[0]!.outcome.replay!.seed++;}, s => {s.jobs[0]!.results[0]!.outcome.transcript = [{speaker: "seller", text: "x".repeat(1001)}];}, s => {s.jobs[0]!.results[0]!.transaction = "0x123";}, s => {s.jobs[0]!.spent = 0;}, s => {s.jobs[0]!.admissions = 37;}, s => {s.jobs[0]!.error = "private rpc and secret";}, s => {s.jobs.push(s.jobs[0]!);}, s => {const j = job(2); j.results[0]!.id = s.jobs[0]!.results[0]!.id; s.jobs.push(j);}, s => {s.agent = null;}, s => {s.jobs = Array.from({length: 25}, (_, i) => job(i + 1));}];
        for (const corrupt of corruptions) {const {repo} = repository(), value = status([job()]); corrupt(value); expect((await outingsApi(request(), owner, null, deps(repo, respond(value)))).status).toBe(502);}
    });
    test("a ranked round must carry the guardian's fixed seed for its day and attempt; unranked rounds stay unranked", () => {
        const ranked = (attempt: number, seedFor = attempt) => {
            const value = status([job()]), result = value.jobs[0]!.results[0]!, seed = rankedSeed("race", "2026-10-10", seedFor, "1");
            Object.assign(result, {seed, ranked: {day: "2026-10-10", attempt}}); result.outcome.replay!.seed = seed;
            return value;
        };
        expect(parseOutingStatus(ranked(2))?.jobs[0]!.results[0]!.ranked).toEqual({day: "2026-10-10", attempt: 2});
        expect(parseOutingStatus(status([job()]))?.jobs[0]!.results[0]).not.toHaveProperty("ranked");
        for (const value of [ranked(2, 1), ranked(1, 2)]) expect(parseOutingStatus(value)).toBeNull();
        const fourth = ranked(3); fourth.jobs[0]!.results[0]!.ranked = {day: "2026-10-10", attempt: 4}; expect(parseOutingStatus(fourth)).toBeNull();
        const extra = ranked(1); Object.assign(extra.jobs[0]!.results[0]!.ranked!, {bonus: 1}); expect(parseOutingStatus(extra)).toBeNull();
    });
    test("all 24 jobs can return their verified rounds beyond 1 MiB with a strict per-outcome cap", async () => {
        const {repo} = repository(), value = status(Array.from({length: 24}, (_, i) => job(i + 1, 36)));
        for (const j of value.jobs) for (const r of j.results) r.outcome.transcript = [{speaker: "game", text: "x".repeat(1000)}, {speaker: "game", text: "y".repeat(1000)}];
        expect(JSON.stringify(value).length).toBeGreaterThan(1_048_576);
        expect((await outingsApi(request(), owner, null, deps(repo, respond(value)))).status).toBe(200);
        expect(parseOutingStatus(value)?.jobs).toHaveLength(24);
        value.jobs[0]!.results[0]!.outcome.transcript = Array.from({length: 20}, () => ({speaker: "game", text: "a".repeat(1000)}));
        expect(parseOutingStatus(value)).toBeNull();
    });
    test("streamed JSON preserves Korean text split within a UTF-8 character", async () => {
        const {repo} = repository(), bytes = new TextEncoder().encode(JSON.stringify(status([job()])));
        const split = bytes.indexOf(0xeb) + 1;
        const response = new Response(new ReadableStream({start(controller) {controller.enqueue(bytes.slice(0, split)); controller.enqueue(bytes.slice(split)); controller.close();}}));
        expect((await outingsApi(request(), owner, null, deps(repo, async () => response))).status).toBe(200);
        expect(parseOutingStatus(status([job()]))?.jobs[0]?.profile.name).toBe(guardianName(1, "ko"));
        for (const name of ["#1", guardianName(1, "en"), guardianName(2, "ko")]) expect(parseOutingStatus(status([{...job(), profile: {...job().profile, name}}]))).toBeNull();
    });
    test("redirects, excessive advertised or streamed bodies and non-JSON fail closed", async () => {
        for (const response of [new Response(null, {status: 302, headers: {Location: "https://evil.test"}}), new Response("{}", {headers: {"Content-Length": "16777217"}}), new Response("a".repeat(16_777_217)), new Response("not json")]) {const {repo} = repository(); expect((await outingsApi(request(), owner, null, deps(repo, (async () => response) as OutingFetcher))).status).toBe(503);}
    });
    test("only closed seller errors reach users; operational details and auth failures do not", async () => {
        const {repo} = repository();
        for (const code of ["private_RPC_error", "unauthorized"]) {const r = await outingsApi(request(), owner, null, deps(repo, respond({error: {code, detail: receiptToken}}, 500))); expect(r.status).toBe(503); expect(await r.json<unknown>()).toEqual({error: {code: "outings_unavailable"}});}
        const r = await outingsApi(request("POST"), owner, start(), deps(repo, respond({error: {code: "invalid_permission", detail: receiptToken}}, 400))); expect(r.status).toBe(400); expect(await r.json<unknown>()).toEqual({error: {code: "invalid_permission"}});
    });
});

describe("real seller and web bridge contract", () => {
    test("start, simulated paid completion and controls use one wire shape", async () => {
        const {createOutingApp} = await import("../../../../delegated-seller/outings/routes");
        const {OutingStore} = await import("../../../../delegated-seller/outings/store");
        const {OutingRunner} = await import("../../../../delegated-seller/outings/runner");
        const {repo} = repository(), store = new OutingStore(":memory:");
        const transaction = `0x${"5".repeat(64)}` as const;
        let charged = 0;
        const runner = new OutingRunner(store, other, {async pay(_job, _pending, persist) {charged++; persist("test-only-payment-intent"); return transaction;}}, {inspect:async()=>guardian}, () => now);
        const app = createOutingApp({token: receiptToken, store, runner, now: () => now, validate: async () => ({payer: other, expiresAt: now + 7200_000, contextHash: transaction})});
        const fetcher: OutingFetcher = async (target, init) => {
            const targetUrl = new URL(target); expect(targetUrl.origin).toBe("https://seller.mapae.io");
            return app.request(new Request("https://seller.mapae.io" + (targetUrl.pathname.replace("/arcade/outing", "") || "/"), init));
        };
        try {
            const post = await profileApi(request("POST", "", {...start(), admissions: 1}), repo, handler(repo, fetcher));
            expect(post.status).toBe(200); const created = await post.json<OutingStatus>(); expect(created.jobs[0]!.status).toBe("queued"); expect(created.jobs[0]!.expiresAt).toBe(now + 7200_000);
            await runner.tick(); expect(charged).toBe(1);
            const synced = await profileApi(request(), repo, handler(repo, fetcher)); expect(synced.status).toBe(200);
            const saved = await synced.json<OutingStatus>(); expect(saved.jobs[0]?.results[0]).toMatchObject({transaction, ranked: {day: kstDay(now), attempt: 1}});
            const again = await profileApi(request(), repo, handler(repo, fetcher)); expect(again.status).toBe(200); expect(await again.json<OutingStatus>()).toEqual(saved);
            expect((await profileApi(request("POST", "/outing-one/stop", {}), repo, handler(repo, fetcher))).status).toBe(200);
            expect((await profileApi(request("POST", "/missing-one/stop", {}), repo, handler(repo, fetcher))).status).toBe(404);
            const foreign = await app.request("/", {headers: {Authorization: `Bearer ${receiptToken}`, "X-Mapae-Owner": other}});
            expect((await foreign.json<OutingStatus>()).jobs).toEqual([]);
        } finally {store.close();}
    });
    test("actual disabled seller keeps GET available and returns closed POST error", async () => {
        const {createOutingApp} = await import("../../../../delegated-seller/outings/routes");
        const {repo} = repository(), app = createOutingApp({token: receiptToken});
        const fetcher: OutingFetcher = async (_target, init) => app.request(new Request("https://seller.mapae.io/", init));
        const get = await outingsApi(request(), owner, null, deps(repo, fetcher)); expect(await get.json<unknown>()).toEqual({enabled: false, agent: null, jobs: []});
        const post = await outingsApi(request("POST"), owner, start(), deps(repo, fetcher)); expect(post.status).toBe(503); expect(await post.json<unknown>()).toEqual({error: {code: "disabled"}});
    });
});
