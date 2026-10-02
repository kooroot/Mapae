import {describe, expect, test} from "bun:test";
import {arcadeProductionApi} from "./production-api";
import {ARCADE_SELLER} from "@mapae/arcade/tickets";

const origin = "https://mapae.io";
const request = (path: string, options?: RequestInit) => new Request(`${origin}/api/arcade/${path}`, options);
describe("public arcade boundary", () => {
    test("shared payer and model endpoints are absent; status is explicit", async () => {
        const status = await arcadeProductionApi(request("status"));
        const body = await status.json<{model: {configured: boolean}; giwa: object; payments: object}>();
        expect(body.model.configured).toBe(false);
        expect(body.giwa).toMatchObject({ticketPrice: "1.00", unit: "mUSDC"});
        expect(body.payments).toMatchObject({ticketPrice: "1.00", unit: "mUSDC"});
        for (const path of ["decide", "tickets", "tickets/example/consume"]) {
            expect((await arcadeProductionApi(request(path, {method: "POST"}))).status).toBe(404);
        }
    });
    test("rejects cross-origin, missing-origin, GET payments, oversized headers and arbitrary targets before fetch", async () => {
        let calls = 0;
        const upstream = Object.assign(async () => {calls++; return Response.json({});}, {preconnect: fetch.preconnect});
        const cases: [string, RequestInit][] = [
            ["giwa/race", {method: "POST", headers: {"Payment-Signature": "YQ=="}}],
            ["giwa/race", {method: "POST", headers: {Origin: "https://evil.test", "Payment-Signature": "YQ=="}}],
            ["giwa/race", {headers: {"Payment-Signature": "YQ=="}}],
            ["giwa/race", {method: "POST", headers: {Origin: origin, "Payment-Signature": "a".repeat(24_001)}}],
            ["giwa/race?url=https://evil.test", {}], ["giwa/%2f%2fevil.test", {}],
            ["giwa/race", {method: "POST", headers: {Origin: origin, "Payment-Signature": "YQ=="}, body: "secret"}],
        ];
        for (const [path, init] of cases) expect((await arcadeProductionApi(request(path, init), upstream)).status).toBeGreaterThanOrEqual(400);
        expect(calls).toBe(0);
    });
    test("only fixed seller receives the single payment header, never cookies or client auth", async () => {
        const upstream = Object.assign(async (url: URL | RequestInfo, init?: RequestInit) => {
            expect(String(url)).toBe(`${ARCADE_SELLER}/race`);
            expect(init?.redirect).toBe("manual");
            expect(new Headers(init?.headers).get("Payment-Signature")).toBe("YQ==");
            expect(new Headers(init?.headers).has("Cookie")).toBe(false);
            expect(new Headers(init?.headers).has("Authorization")).toBe(false);
            return Response.json({ticket: "example"}, {headers: {"Set-Cookie": "secret", "Payment-Response": "receipt"}});
        }, {preconnect: fetch.preconnect});
        const response = await arcadeProductionApi(request("giwa/race", {method: "POST", headers: {Origin: origin,
            "Payment-Signature": "YQ==", Cookie: "private", Authorization: "private"}}), upstream);
        expect(response.status).toBe(200);
        expect(response.headers.has("Set-Cookie")).toBe(false);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(response.headers.get("Payment-Response")).toBe("receipt");
    });
    test("redirects cannot forward payment authority or expose their destination", async () => {
        for (const status of [301, 302, 303, 307, 308]) {
            for (const signed of [false, true]) {
                let calls = 0;
                const upstream = Object.assign(async (_url: URL | RequestInfo, init?: RequestInit) => {
                    calls++;
                    expect(init?.redirect).toBe("manual");
                    return Response.json({private: "upstream detail"}, {status, headers: {Location: "https://evil.test/collect"}});
                }, {preconnect: fetch.preconnect});
                const response = await arcadeProductionApi(request("giwa/race", signed ? {method: "POST",
                    headers: {Origin: origin, "Payment-Signature": "YQ=="}} : undefined), upstream);
                expect(calls).toBe(1);
                expect(response.status).toBe(502);
                expect(response.headers.has("Location")).toBe(false);
                expect(await response.json<object>()).toEqual({error: {code: signed ? "settlement_unknown" : "seller_unavailable",
                    message: "The arcade request could not be completed."}});
            }
        }
    });
    test("unbounded and non-JSON replies fail closed; transport failure stays ambiguous", async () => {
        for (const upstreamResponse of [new Response("a".repeat(70_000), {headers: {"Content-Type": "application/json"}}), new Response("<script>evil</script>")]) {
            const upstream = Object.assign(async () => upstreamResponse, {preconnect: fetch.preconnect});
            expect((await arcadeProductionApi(request("giwa/race"), upstream)).status).toBe(502);
        }
        const upstream = Object.assign(async () => {throw new Error("a private bearer authorization");}, {preconnect: fetch.preconnect});
        const response = await arcadeProductionApi(request("giwa/race", {method: "POST", headers: {Origin: origin, "Payment-Signature": "YQ=="}}), upstream);
        expect(response.status).toBe(504);
        expect(await response.text()).not.toContain("private bearer");
    });
});
