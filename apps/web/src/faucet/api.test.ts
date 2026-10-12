import {afterEach, describe, expect, test} from "bun:test";
import {Database} from "bun:sqlite";
import {readFileSync} from "node:fs";
import {FAUCET_ETH_AMOUNT_WEI, FAUCET_ETH_WINDOW_MS, FAUCET_TARGET_BASE, FAUCET_WINDOW_MS} from "@mapae/delegation/faucet-policy";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import {parseSiweMessage} from "viem/siwe";
import {profileApi} from "../arcade/profile/api";
import {profileRepository, type ProfileRepository} from "../arcade/profile/repository";
import {d1} from "../arcade/profile/test-db";
import {FAUCET_ORIGIN, faucetApi, hmac, type FaucetApiDependencies} from "./api";

const now = 1_790_870_000_000;
const TOKEN = "s".repeat(40), SALT = "n".repeat(40), SITE_KEY = "0x4AAAAAAA-site", SECRET = "0x4AAAAAAA-secret";
const PAYER = "0x00000000000000000000000000000000000000b2";
const HASH = `0x${"ab".repeat(32)}`;
const STATUS = {
    musdc: {enabled: true, targetBase: String(FAUCET_TARGET_BASE), windowMs: FAUCET_WINDOW_MS, missions: ["x_follow_mapae"]},
    eth: {enabled: false, amountWei: String(FAUCET_ETH_AMOUNT_WEI), windowMs: FAUCET_ETH_WINDOW_MS, missions: [], minMainnetNonce: 1},
};

const dbs: Database[] = [];
afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
});
function repo(): ProfileRepository {
    const db = new Database(":memory:");
    dbs.push(db);
    db.exec(readFileSync(new URL("../../schema/arcade.sql", import.meta.url), "utf8"));
    return profileRepository(d1(db));
}

type Call = {url: string; init?: RequestInit; body?: Record<string, unknown>};
/** A fake network: siteverify and the faucet service, each answering from a handler the test sets. */
function network(handlers: {siteverify?: (body: Record<string, unknown>) => unknown; service?: (path: string, call: Call) => Response} = {}) {
    const calls: Call[] = [];
    const fetcher = async (url: string, init?: RequestInit) => {
        const call: Call = {url, init, body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined};
        calls.push(call);
        if (url.startsWith("https://challenges.cloudflare.com/")) return Response.json(handlers.siteverify?.(call.body!) ?? {success: false});
        if (url.startsWith("https://facilitator.mapae.io/faucet")) {
            const path = url.slice("https://facilitator.mapae.io/faucet".length);
            if (handlers.service) return handlers.service(path, call);
            if (path === "/status") return Response.json(STATUS);
            return Response.json({reason: "unavailable"}, {status: 503});
        }
        throw new Error(`unexpected fetch ${url}`);
    };
    return {fetcher, calls, service: () => calls.filter((c) => c.url.startsWith("https://facilitator.mapae.io/")), siteverify: () => calls.filter((c) => c.url.startsWith("https://challenges"))};
}

function deps(repository: ProfileRepository, fetcher: FaucetApiDependencies["fetcher"], extra: Partial<FaucetApiDependencies> = {}): FaucetApiDependencies {
    return {repo: repository, serviceToken: TOKEN, ipSalt: SALT, turnstileSecret: SECRET, siteKey: SITE_KEY, fetcher, now, ...extra};
}

const request = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}, site = FAUCET_ORIGIN) =>
    new Request(`${site}/api/faucet${path}`, {method, headers: {Origin: site, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7", ...headers}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
const cookie = (r: Response, name: string) => r.headers.getSetCookie().find((v) => v.startsWith(name + "="))?.split(";")[0] ?? "";

async function login(repository: ProfileRepository, fetcher: FaucetApiDependencies["fetcher"], user = privateKeyToAccount(generatePrivateKey())) {
    const challenge = await faucetApi(request("/challenge", "POST", {address: user.address}), deps(repository, fetcher));
    expect(challenge.status).toBe(200);
    const {message} = await challenge.json<{message: string}>();
    const response = await faucetApi(request("/login", "POST", {signature: await user.signMessage({message})}, {Cookie: cookie(challenge, "__Host-mapae-faucet-challenge")}), deps(repository, fetcher));
    expect(response.status).toBe(200);
    return {user, owner: user.address.toLowerCase(), message, headers: {Cookie: cookie(response, "__Host-mapae-faucet-session"), "X-Mapae-Wallet": user.address}};
}

const passing = (owner: string, kind = "musdc", hostname = "faucet.mapae.io") => () => ({success: true, hostname, action: `claim-${kind}`, cdata: owner});
const view = (owner: string, kind = "musdc") => ({kind, state: "confirmed", amount: "1000000000", recipient: kind === "musdc" ? PAYER : owner, transaction: HASH, nextAt: now + FAUCET_WINDOW_MS});

describe("origin and configuration", () => {
    test("answers only on faucet.mapae.io, or a loopback dev server", async () => {
        const {fetcher} = network(), repository = repo();
        for (const site of ["https://mapae.io", "https://app.mapae.io", "http://127.0.0.1:3000"]) {
            expect((await faucetApi(request("/status", "GET", undefined, {}, site), deps(repository, fetcher))).status).toBe(403);
        }
        expect((await faucetApi(request("/status", "GET", undefined, {}, "http://127.0.0.1:3000"), deps(repository, fetcher, {development: true}))).status).toBe(200);
        expect((await faucetApi(request("/status", "GET", undefined, {"Sec-Fetch-Site": "cross-site"}), deps(repository, fetcher))).status).toBe(403);
        expect((await faucetApi(request("/status", "GET", undefined, {Origin: "https://evil.test"}), deps(repository, fetcher))).status).toBe(403);
        expect((await faucetApi(request("/claim", "POST", {}, {"Content-Type": "text/plain"}), deps(repository, fetcher))).status).toBe(403);
        expect((await faucetApi(new Request(`${FAUCET_ORIGIN}/api/faucet/status?owner=x`), deps(repository, fetcher))).status).toBe(403);
        expect((await faucetApi(request("/other"), deps(repository, fetcher))).status).toBe(404);
        expect((await faucetApi(request("/claim"), deps(repository, fetcher))).status).toBe(405);
    });

    test("any missing secret turns the faucet off rather than half on", async () => {
        const {fetcher, calls} = network(), repository = repo();
        for (const missing of [{serviceToken: undefined}, {serviceToken: "short"}, {ipSalt: undefined}, {turnstileSecret: undefined}, {siteKey: undefined}]) {
            const response = await faucetApi(request("/status"), deps(repository, fetcher, missing));
            expect(response.status).toBe(503);
            expect(await response.json<unknown>()).toEqual({error: {code: "faucet_off"}});
        }
        expect(calls).toHaveLength(0);
    });
});

describe("status", () => {
    test("is the service's status, validated, with the site key, cached at the edge", async () => {
        const net = network(), repository = repo(), store = new Map<string, Response>();
        const cache = Promise.resolve({
            match: async (key: Request) => store.get(key.url)?.clone(),
            put: async (key: Request, value: Response) => {store.set(key.url, value);},
        } as unknown as Cache);
        const first = await faucetApi(request("/status"), deps(repository, net.fetcher, {cache}));
        expect(await first.json<unknown>()).toEqual({...STATUS, siteKey: SITE_KEY});
        expect(first.headers.get("Cache-Control")).toBe("public, max-age=30");
        expect(net.service()[0]?.init?.headers).toMatchObject({Authorization: `Bearer ${TOKEN}`});
        await faucetApi(request("/status"), deps(repository, net.fetcher, {cache}));
        expect(net.service()).toHaveLength(1);
    });

    test("a reply that is not the contract is unavailable, never forwarded", async () => {
        const repository = repo();
        for (const reply of [Response.json({...STATUS, eth: {...STATUS.eth, missions: ["unknown"]}}), new Response("<html>", {status: 200}), Response.json({}, {status: 502})]) {
            const {fetcher} = network({service: () => reply});
            const response = await faucetApi(request("/status"), deps(repository, fetcher));
            expect(response.status).toBe(503);
            expect(await response.json<unknown>()).toEqual({error: {code: "unavailable"}});
        }
    });
});

describe("SIWE on the faucet origin", () => {
    test("the message names faucet.mapae.io, its root and GIWA Sepolia, and says it authorizes no payment", async () => {
        const {fetcher} = network(), signed = await login(repo(), fetcher);
        const parsed = parseSiweMessage(signed.message);
        expect(parsed).toMatchObject({domain: "faucet.mapae.io", uri: "https://faucet.mapae.io/", chainId: 91342, address: signed.user.address});
        expect(signed.message).toContain("Sign in to Mapae Faucet to receive testnet tokens. This does not authorize payments or spending.");
        expect(signed.headers.Cookie.startsWith("__Host-mapae-faucet-session=")).toBe(true);
    });

    test("an expired challenge, a reused one, or another signer cannot log in", async () => {
        const {fetcher} = network(), repository = repo(), user = privateKeyToAccount(generatePrivateKey());
        const ask = async () => {
            const response = await faucetApi(request("/challenge", "POST", {address: user.address}), deps(repository, fetcher));
            const {message} = await response.json<{message: string}>();
            return {message, headers: {Cookie: cookie(response, "__Host-mapae-faucet-challenge")}};
        };
        const expired = await ask();
        expect((await faucetApi(request("/login", "POST", {signature: await user.signMessage({message: expired.message})}, expired.headers), deps(repository, fetcher, {now: now + 300_001}))).status).toBe(401);
        const other = await ask();
        const stranger = privateKeyToAccount(generatePrivateKey());
        expect((await faucetApi(request("/login", "POST", {signature: await stranger.signMessage({message: other.message})}, other.headers), deps(repository, fetcher))).status).toBe(401);
        const once = await ask(), signature = await user.signMessage({message: once.message});
        expect((await faucetApi(request("/login", "POST", {signature}, once.headers), deps(repository, fetcher))).status).toBe(200);
        expect((await faucetApi(request("/login", "POST", {signature}, once.headers), deps(repository, fetcher))).status).toBe(401);
    });

    test("an arcade session is worthless here and a faucet session is worthless in the arcade", async () => {
        const {fetcher} = network(), repository = repo(), signed = await login(repository, fetcher);
        // The same cookie value under the arcade's name, on the arcade's origin: the row is bound to faucet.mapae.io.
        const arcadeCookie = signed.headers.Cookie.replace("__Host-mapae-faucet-session", "__Host-mapae-arcade-session");
        const arcade = await profileApi(new Request("https://mapae.io/api/arcade/profile/session", {headers: {Cookie: arcadeCookie, "X-Mapae-Wallet": signed.user.address}}), repository, {now});
        expect(arcade.status).toBe(401);
        expect((await faucetApi(request("/session", "GET", undefined, {Cookie: arcadeCookie, "X-Mapae-Wallet": signed.user.address}), deps(repository, fetcher))).status).toBe(401);
    });

    test("challenges are counted per IPv6 /64, so rotating addresses inside it buys nothing", async () => {
        const {fetcher} = network(), repository = repo();
        const ask = (n: number) => faucetApi(request("/challenge", "POST", {address: privateKeyToAccount(generatePrivateKey()).address}, {"CF-Connecting-IP": `2001:db8:1:2::${n.toString(16)}`}), deps(repository, fetcher));
        for (let n = 1; n <= 60; n += 1) expect((await ask(n)).status).toBe(200);
        expect((await ask(61)).status).toBe(429);
    });

    test("a session expires after a day and logout ends it", async () => {
        const net = network({service: (path) => path === "/status" ? Response.json(STATUS) : Response.json({reason: "unavailable"}, {status: 503})});
        const repository = repo(), signed = await login(repository, net.fetcher);
        expect((await faucetApi(request("/session", "GET", undefined, signed.headers), deps(repository, net.fetcher, {now: now + 86_400_001}))).status).toBe(401);
        expect((await faucetApi(request("/logout", "POST", {}, signed.headers), deps(repository, net.fetcher))).status).toBe(200);
        expect((await faucetApi(request("/session", "GET", undefined, signed.headers), deps(repository, net.fetcher))).status).toBe(401);
    });
});

describe("session", () => {
    test("proxies the owner's standing and refuses a reply about anyone else", async () => {
        const repository = repo();
        let answerFor = "";
        const net = network({service: () => Response.json({owner: answerFor, recipients: {musdc: PAYER, eth: answerFor}, musdc: null, eth: null})});
        const signed = await login(repository, net.fetcher);
        answerFor = signed.user.address;
        const response = await faucetApi(request("/session", "GET", undefined, signed.headers), deps(repository, net.fetcher));
        expect(await response.json<unknown>()).toEqual({owner: signed.user.address, recipients: {musdc: PAYER, eth: signed.user.address}, musdc: null, eth: null});
        expect(net.service().at(-1)?.url).toBe(`https://facilitator.mapae.io/faucet/claims/${signed.owner}`);
        answerFor = privateKeyToAccount(generatePrivateKey()).address;
        expect((await faucetApi(request("/session", "GET", undefined, signed.headers), deps(repository, net.fetcher))).status).toBe(503);
    });

    test("a tab whose wallet switched accounts is asked to sign in again", async () => {
        const {fetcher} = network(), repository = repo(), signed = await login(repository, fetcher);
        const response = await faucetApi(request("/session", "GET", undefined, {...signed.headers, "X-Mapae-Wallet": privateKeyToAccount(generatePrivateKey()).address}), deps(repository, fetcher));
        expect(response.status).toBe(401);
        expect(await response.json<unknown>()).toEqual({error: {code: "login_required"}});
    });
});

describe("claim", () => {
    const claimBody = (kind = "musdc") => ({kind, turnstile: "token-from-widget", missions: ["x_follow_mapae"]});

    test("verifies Turnstile, derives network keys and forwards a validated claim view", async () => {
        const repository = repo();
        let owner = "";
        const net = network({
            siteverify: (body) => (body.secret === SECRET && body.response === "token-from-widget" && body.remoteip === "203.0.113.7" && typeof body.idempotency_key === "string" ? passing(owner)() : {success: false}),
            service: (path, call) => path === "/claims" ? Response.json(view(String(call.body!.owner))) : Response.json(STATUS),
        });
        const signed = await login(repository, net.fetcher);
        owner = signed.owner;
        const response = await faucetApi(request("/claim", "POST", claimBody(), signed.headers), deps(repository, net.fetcher));
        expect(response.status).toBe(200);
        expect(await response.json<unknown>()).toEqual(view(owner));
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
        const forwarded = net.service().at(-1)!;
        expect(forwarded.body).toEqual({
            kind: "musdc", owner, missions: ["x_follow_mapae"],
            ipKey: await hmac(SALT, "ip:203.0.113.7"),
            subnetKey: await hmac(SALT, "subnet:203.0.113.0/24"),
        });
        expect(forwarded.body!.ipKey).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.stringify(forwarded.body)).not.toContain("203.0.113");
    });

    test("a Turnstile token for another hostname, kind or wallet is refused before the service is asked", async () => {
        const repository = repo();
        let answer: (owner: string) => unknown = () => ({success: false});
        let owner = "";
        const net = network({siteverify: () => answer(owner), service: () => Response.json(view(owner))});
        const signed = await login(repository, net.fetcher);
        owner = signed.owner;
        const cases: ((o: string) => unknown)[] = [
            () => ({success: false, "error-codes": ["timeout-or-duplicate"]}),
            (o) => passing(o, "musdc", "evil.test")(),
            (o) => passing(o, "eth")(),
            () => passing(privateKeyToAccount(generatePrivateKey()).address.toLowerCase())(),
            (o) => ({hostname: "faucet.mapae.io", action: "claim-musdc", cdata: o}),
        ];
        for (const [index, next] of cases.entries()) {
            answer = next;
            const response = await faucetApi(request("/claim", "POST", claimBody(), {...signed.headers, "CF-Connecting-IP": `198.51.100.${index}`}), deps(repository, net.fetcher));
            expect(response.status).toBe(403);
            expect(await response.json<unknown>()).toEqual({error: {code: "turnstile_failed"}});
        }
        expect(net.service().filter((c) => c.url.endsWith("/claims"))).toHaveLength(0);
    });

    test("a local dev server may accept Turnstile's test-key hostname; production may not", async () => {
        const repository = repo();
        let owner = "";
        const net = network({siteverify: () => passing(owner, "musdc", "example.com")(), service: () => Response.json(view(owner))});
        const signed = await login(repository, net.fetcher);
        owner = signed.owner;
        const dev = (headers: Record<string, string>) => new Request("http://localhost:3000/api/faucet/claim", {method: "POST", headers: {...headers, Origin: "http://localhost:3000", "Content-Type": "application/json"}, body: JSON.stringify(claimBody())});
        // The faucet session is bound to its origin, so sign in on the dev origin first.
        const challenge = await faucetApi(new Request("http://localhost:3000/api/faucet/challenge", {method: "POST", headers: {Origin: "http://localhost:3000", "Content-Type": "application/json"}, body: JSON.stringify({address: signed.user.address})}), deps(repository, net.fetcher, {development: true}));
        const {message} = await challenge.json<{message: string}>();
        const login2 = await faucetApi(new Request("http://localhost:3000/api/faucet/login", {method: "POST", headers: {Origin: "http://localhost:3000", "Content-Type": "application/json", Cookie: cookie(challenge, "__Host-mapae-faucet-challenge")}, body: JSON.stringify({signature: await signed.user.signMessage({message})})}), deps(repository, net.fetcher, {development: true}));
        const headers = {Cookie: cookie(login2, "__Host-mapae-faucet-session"), "X-Mapae-Wallet": signed.user.address};
        expect((await faucetApi(dev(headers), deps(repository, net.fetcher, {development: true}))).status).toBe(200);
        expect((await faucetApi(request("/claim", "POST", claimBody(), signed.headers), deps(repository, net.fetcher))).status).toBe(403);
    });

    test("ten claims per IP per ten minutes; the eleventh never reaches Turnstile", async () => {
        const repository = repo();
        const net = network({siteverify: () => ({success: false})});
        const users = [];
        for (let i = 0; i < 11; i += 1) users.push(await login(repository, net.fetcher));
        for (const user of users.slice(0, 10)) expect((await faucetApi(request("/claim", "POST", claimBody(), user.headers), deps(repository, net.fetcher))).status).toBe(403);
        const limited = await faucetApi(request("/claim", "POST", claimBody(), users[10]!.headers), deps(repository, net.fetcher));
        expect(limited.status).toBe(429);
        expect(await limited.json<unknown>()).toEqual({error: {code: "rate_limited"}});
        expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
        expect(net.siteverify()).toHaveLength(10);
        // Another /64 behind the same /48 is another address bucket.
        expect((await faucetApi(request("/claim", "POST", claimBody(), {...users[10]!.headers, "CF-Connecting-IP": "203.0.113.8"}), deps(repository, net.fetcher))).status).toBe(403);
    });

    test("the service's refusals pass through from the closed set only", async () => {
        const repository = repo();
        let owner = "", reply: () => Response = () => Response.json({});
        const net = network({siteverify: () => passing(owner)(), service: () => reply()});
        const signed = await login(repository, net.fetcher);
        owner = signed.owner;
        const send = async (ip: string) => faucetApi(request("/claim", "POST", claimBody(), {...signed.headers, "CF-Connecting-IP": ip}), deps(repository, net.fetcher));

        reply = () => Response.json({reason: "cooldown", nextAt: now + 3_600_000}, {status: 429});
        let response = await send("192.0.2.1");
        expect(response.status).toBe(429);
        expect(await response.json<unknown>()).toEqual({error: {code: "cooldown", nextAt: now + 3_600_000}});

        reply = () => Response.json({reason: "not_eligible"}, {status: 403});
        expect(await (await send("192.0.2.2")).json<unknown>()).toEqual({error: {code: "not_eligible"}});

        for (const [index, bad] of [
            () => Response.json({reason: "insufficient funds for gas"}, {status: 503}),
            () => Response.json({reason: "unavailable"}, {status: 401}),
            () => Response.json({kind: "musdc", state: "confirmed", amount: "1", recipient: "0x12"}),
            () => new Response("not json", {status: 200}),
        ].entries()) {
            reply = bad;
            response = await send(`192.0.2.${10 + index}`);
            expect(response.status).toBe(503);
            expect(await response.json<unknown>()).toEqual({error: {code: "unavailable"}});
        }
    });

    test("a view for another kind than the one claimed is not forwarded", async () => {
        const repository = repo();
        let owner = "";
        const net = network({siteverify: () => passing(owner, "eth")(), service: () => Response.json(view(owner, "musdc"))});
        const signed = await login(repository, net.fetcher);
        owner = signed.owner;
        expect((await faucetApi(request("/claim", "POST", claimBody("eth"), signed.headers), deps(repository, net.fetcher))).status).toBe(503);
    });

    test("a malformed body, or none signed in, never costs a Turnstile call", async () => {
        const repository = repo(), net = network();
        const signed = await login(repository, net.fetcher);
        for (const body of [{...claimBody(), kind: "btc"}, {...claimBody(), turnstile: ""}, {...claimBody(), missions: "x_follow_mapae"}, {...claimBody(), missions: ["DROP TABLE"]}]) {
            const response = await faucetApi(request("/claim", "POST", body, signed.headers), deps(repository, net.fetcher));
            expect(response.status).toBe(400);
            expect(await response.json<unknown>()).toEqual({error: {code: "malformed_request"}});
        }
        expect((await faucetApi(request("/claim", "POST", claimBody()), deps(repository, net.fetcher))).status).toBe(401);
        expect(net.siteverify()).toHaveLength(0);
    });
});
