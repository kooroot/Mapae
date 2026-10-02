import {Database} from "bun:sqlite";
import {readFileSync} from "node:fs";
import {test, expect} from "bun:test";
import {ARCADE_PAY_TO, ARCADE_SELLER} from "@mapae/arcade/tickets";
import {MOCK_USDC, GIWA_SEPOLIA_CAIP2} from "@mapae/shared";
import {checkoutApi, checkoutRepository, type CheckoutDependencies} from "./checkout";
import {profileRepository} from "./repository";
import {PROFILE_GENERATION, profileState, projectProfile} from "./model";
import {d1} from "./test-db";
import {addCharacter, newArcadeState, newCompanion} from "../state";
import {admitActivity} from "../activity";
const owner = "0x1111111111111111111111111111111111111111", payer = "0x2222222222222222222222222222222222222222", manager = "0x3333333333333333333333333333333333333333", tx = `0x${"a".repeat(64)}`;
async function setup() {
    const db = new Database(":memory:"); db.exec(readFileSync(new URL("../../../schema/arcade.sql", import.meta.url), "utf8"));
    const repo = checkoutRepository(d1(db)), profiles = profileRepository(d1(db));
    await profiles.write(owner, 0, projectProfile(addCharacter(newArcadeState(), newCompanion("hero", {name: "마루", color: "jade", temperament: "calm"}))), Date.now());
    let submissions = 0, paid = false, loseResponse = false;
    const deps: CheckoutDependencies = {repo, profiles, payer: async () => payer, manager, receiptToken: "test-receipt-token-32-characters-long",
        fetcher: Object.assign(async (url: URL | RequestInfo, init?: RequestInit) => {
            expect(init?.redirect).toBe("manual"); expect(new Headers(init?.headers).has("Cookie")).toBe(false);
            if (new URL(String(url)).pathname === "/health") return Response.json({ok: true, arcadeRecovery: true});
            if (String(url) === `${ARCADE_SELLER}/race`) {submissions++; paid = true; if (loseResponse) throw new Error("lost response"); return Response.json({});}
            expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-receipt-token-32-characters-long");
            const active = await repo.active(owner);
            return paid ? Response.json({intent: active?.intent, game: "race", payer, transaction: tx, amount: "1000000", asset: MOCK_USDC.address.toLowerCase(), payTo: ARCADE_PAY_TO.toLowerCase(), network: GIWA_SEPOLIA_CAIP2}) : Response.json({}, {status: 404});
        }, {preconnect: fetch.preconnect})};
    const input = {generation: PROFILE_GENERATION, requestId: crypto.randomUUID(), characterId: "hero", game: "race", header: btoa(JSON.stringify({payload: {delegator: payer, delegationManager: manager, permissionContext: "0x1234"}}))};
    const call = (method: string, value: unknown = input, path = "", who = owner) => checkoutApi(new Request(`https://mapae.io/api/arcade/profile/checkout${path}`, {method}), who as typeof owner, value, deps);
    return {db, repo, profiles, deps, input, call, submissions: () => submissions, lose: () => {loseResponse = true;}};
}
test("lost response and new device recover the paid ticket without another submission", async () => {
    const s = await setup(); try {
        s.lose(); await expect(s.call("POST")).rejects.toThrow("lost response");
        const response = await s.call("GET", null), body = await response.json<any>();
        expect(body.pending.receipt.transaction).toBe(tx); expect(body.pending.header).toBeUndefined();
        expect(s.submissions()).toBe(1);
        expect((await s.call("POST")).status).toBe(200); expect(s.submissions()).toBe(1);
        expect((await s.call("POST", {...s.input, requestId: crypto.randomUUID()})).status).toBe(409);
    } finally {s.db.close();}
});
test("admission requires a saved matching activity and is claimed once across devices", async () => {
    const s = await setup(); try {
        await s.call("POST"); const ack = {generation: PROFILE_GENERATION, requestId: s.input.requestId};
        expect((await s.call("POST", ack, "/ack")).status).toBe(409);
        const snapshot = await s.profiles.read(owner);
        const result = admitActivity(profileState(snapshot.profile), {id: s.input.requestId, characterId: "hero", game: "race", mode: "rules", source: "mapae-giwa", ticketId: tx, model: null, reason: "test", giwa: {balanceAfter: "9.00", allowanceAfter: "0.00"}}, Date.now());
        if (!result.ok) throw new Error("fixture");
        await s.profiles.write(owner, snapshot.revision, projectProfile(result.demo), Date.now());
        const claims = await Promise.all([s.call("POST", ack, "/ack"), s.call("POST", ack, "/ack")]);
        const values = await Promise.all(claims.map(r => r.json<any>()));
        expect(values.filter(v => v.admitted)).toHaveLength(1); expect(await s.repo.active(owner)).toBeNull();
        expect((await s.call("POST")).status).toBe(409); expect(s.submissions()).toBe(1);
    } finally {s.db.close();}
});
test("wrong payer, stale generation, missing character and another owner cannot claim checkout", async () => {
    const s = await setup(); try {
        expect((await s.call("POST", {...s.input, generation: "old"})).status).toBe(409);
        expect((await s.call("POST", {...s.input, characterId: "missing"})).status).toBe(409);
        expect((await s.call("POST", {...s.input, header: btoa(JSON.stringify({payload: {delegator: owner, delegationManager: manager, permissionContext: "0x1234"}}))})).status).toBe(400);
        expect((await s.call("POST", s.input, "", payer)).status).toBe(409);
        expect(s.submissions()).toBe(0);
    } finally {s.db.close();}
});
test("D1 failure prevents payment; post-payment D1 failure is recovered through the seller", async () => {
    const s = await setup(); try {
        const original = s.repo.register;
        s.repo.register = async () => {throw new Error("D1 unavailable");};
        await expect(s.call("POST")).rejects.toThrow(); expect(s.submissions()).toBe(0);
        s.repo.register = original;
        const save = s.repo.paid; s.repo.paid = async () => {throw new Error("D1 unavailable");};
        await expect(s.call("POST")).rejects.toThrow(); expect(s.submissions()).toBe(1);
        s.repo.paid = save;
        expect((await (await s.call("GET")).json<any>()).pending.receipt.transaction).toBe(tx);
        expect(s.submissions()).toBe(1);
    } finally {s.db.close();}
});
test("old mini, wrong recovery secret, redirects and mismatched receipts fail without a new charge", async () => {
    const s = await setup(); try {
        const fetcher = s.deps.fetcher;
        s.deps.receiptToken = undefined;
        expect((await s.call("POST")).status).toBe(503); expect(s.submissions()).toBe(0);
        s.deps.receiptToken = "test-receipt-token-32-characters-long";
        s.deps.fetcher = Object.assign(async () => Response.json({ok: true}), {preconnect: fetch.preconnect});
        expect((await s.call("POST")).status).toBe(503); expect(await s.repo.active(owner)).toBeNull();
        s.deps.fetcher = Object.assign(async (url: URL | RequestInfo, init?: RequestInit) => {
            if (String(url).includes("/settlements/")) return Response.json({}, {status: 401});
            return fetcher!(url, init);
        }, {preconnect: fetch.preconnect});
        await expect(s.call("POST")).rejects.toThrow("seller_unavailable"); expect(s.submissions()).toBe(0);
        s.deps.fetcher = fetcher; s.lose(); await expect(s.call("POST")).rejects.toThrow();
        for (const response of [Response.json({}, {status: 302, headers: {Location: "https://evil.test"}}), Response.json({game: "shop"})]) {
            s.deps.fetcher = Object.assign(async (_url: URL | RequestInfo, init?: RequestInit) => {expect(init?.redirect).toBe("manual"); return response;}, {preconnect: fetch.preconnect});
            await expect(s.call("GET")).rejects.toThrow();
            expect((await s.repo.active(owner))?.receipt).toBeNull();
        }
        expect(s.submissions()).toBe(1);
    } finally {s.db.close();}
});
