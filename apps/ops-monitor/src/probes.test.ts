import {expect, test} from "bun:test";
import {MOCK_USDC} from "../../../packages/shared/src/token";
import {metricsHealthy, PROBE_TARGETS, runProbes, validProbe, type Fetcher} from "./probes";

const ticket = {accepts: [{network: "eip155:91342", amount: "1000000", asset: MOCK_USDC.address}]};
const healthyResponse = (url: string): Response => {
    if (url.endsWith("/health")) return Response.json({ok: true});
    if (url.endsWith("/profile/session")) return Response.json({error: {code: "login_required"}}, {status: 401});
    if (url.endsWith("/stamp")) return Response.json(ticket, {status: 402});
    if (url.endsWith("/faucet/status")) return Response.json({
        musdc: {enabled: true, targetBase: "1000000000", windowMs: 86_400_000, missions: ["x_follow_mapae"]},
        eth: {enabled: true, amountWei: "500000000000000", windowMs: 604_800_000, missions: ["x_follow_mapae"]},
        siteKey: "0x4AAAAAAA-site",
    });
    if (url.endsWith("seller.mapae.io/metrics")) return Response.json({orders: {}});
    if (url.endsWith("facilitator.mapae.io/metrics")) return Response.json({budget: {remainingWei: "50", limitWei: "100"}, last24h: {failed: 1, total: 30}});
    return new Response("<html>", {status: 200});
};

test("every public target and both metrics endpoints pass on a healthy fleet", async () => {
    const seen: RequestInit[] = [];
    const fetcher: Fetcher = async (url, init) => {seen.push(init ?? {}); return healthyResponse(url);};
    const checks = await runProbes(fetcher, {seller: "s".repeat(16), facilitator: "f".repeat(16)});
    expect(checks.map(c => c.name)).toEqual([...PROBE_TARGETS.map(t => t.name), "seller-metrics", "facilitator-metrics"]);
    expect(checks.every(c => c.ok)).toBe(true);
    expect(seen.every(init => init.redirect === "manual")).toBe(true);
});

test("a redirect fails the probe and is never followed, so a bearer token cannot leave", async () => {
    const urls: string[] = [];
    const fetcher: Fetcher = async url => {urls.push(url); return url.includes("metrics") || url.endsWith("/health") ? new Response(null, {status: 302, headers: {Location: "https://evil.example/"}}) : healthyResponse(url);};
    const checks = await runProbes(fetcher, {seller: "s".repeat(16), facilitator: "f".repeat(16)});
    for (const name of ["seller", "facilitator", "seller-metrics", "facilitator-metrics"]) expect(checks.find(c => c.name === name)).toMatchObject({ok: false, status: 302});
    expect(urls.some(u => u.includes("evil.example"))).toBe(false);
});

test("network errors and non-JSON bodies fail closed without metrics keys", async () => {
    const checks = await runProbes(async url => {if (url.includes("seller")) throw new Error("boom"); return new Response("not json", {status: 200});});
    expect(checks.find(c => c.name === "seller")).toMatchObject({ok: false, status: 0});
    expect(checks.find(c => c.name === "facilitator")?.ok).toBe(false);
    expect(checks.find(c => c.name === "web")?.ok).toBe(true);
    expect(checks.some(c => c.name.endsWith("-metrics"))).toBe(false);
});

test("ticket probe requires the exact GIWA mUSDC offer", () => {
    expect(validProbe("ticket", new Response(null, {status: 402}), ticket)).toBe(true);
    expect(validProbe("ticket", new Response(null, {status: 402}), {accepts: [{...ticket.accepts[0], amount: "1"}]})).toBe(false);
    expect(validProbe("ticket", new Response(null, {status: 402}), {accepts: [{...ticket.accepts[0], asset: 7}]})).toBe(false);
    expect(validProbe("ticket", new Response(null, {status: 200}), ticket)).toBe(false);
});

test("facilitator metrics are validated, not cast", () => {
    const ok = {budget: {remainingWei: "11", limitWei: "100"}, last24h: {failed: 3, total: 20}};
    expect(metricsHealthy("facilitator", ok)).toBe(true);
    expect(metricsHealthy("facilitator", {...ok, budget: {remainingWei: "10", limitWei: "100"}})).toBe(false);
    expect(metricsHealthy("facilitator", {...ok, last24h: {failed: 4, total: 20}})).toBe(false);
    expect(metricsHealthy("facilitator", {...ok, last24h: {failed: 19, total: 19}})).toBe(true);
    expect(metricsHealthy("facilitator", {...ok, budget: {remainingWei: "1e30", limitWei: "100"}})).toBe(false);
    expect(metricsHealthy("facilitator", {...ok, last24h: {failed: "1", total: 20}})).toBe(false);
    expect(metricsHealthy("seller", {orders: null})).toBe(false);
});
