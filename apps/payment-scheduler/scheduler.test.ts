import {afterEach, expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {openStore, type PaymentSchedule, type MapaeStore} from "@mapae/store";
import {type DelegatedAgentRuntime} from "@mapae/delegation";
import {buildErc7710PaymentRequirements} from "@mapae/shared";
import {tick, paymentExecutor} from "./scheduler.js";
const stores: MapaeStore[] = [], dirs: string[] = [];
afterEach(() => {for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, {recursive: true, force: true});});
function open(path = ":memory:") {const s = openStore(path); stores.push(s); return s;}
const spec: PaymentSchedule = {id: "coffee", resourcePath: "/s/cafe/coffee", payTo: "0x2000000000000000000000000000000000000001",
    maxAmountBase: 100n, maxTotalBase: 250n, maxRuns: 2, startsAt: 1000, endsAt: 100000,
    intervalMs: 10000, maxAttempts: 2, retryDelayMs: 1000};
test("time boundaries, skipped intervals, finite run count and actual total", async () => {
    const s = open().schedules; s.add(spec);
    expect(await tick(s, async () => ({outcome: "paid", amountBase: 80n}), () => 999)).toBe(0);
    await tick(s, async () => ({outcome: "paid", amountBase: 80n}), () => 35000);
    expect(s.get(spec.id)?.nextAt).toBe(41000);
    expect(s.get(spec.id)?.committedBase).toBe(80n);
    await tick(s, async () => ({outcome: "paid", amountBase: 90n}), () => 41000);
    expect(s.get(spec.id)?.status).toBe("completed"); expect(s.get(spec.id)?.committedBase).toBe(170n);
    expect(await tick(s, async () => {throw new Error("must not run");}, () => 50000)).toBe(0);
});
test("a durable claim survives interruption; another connection and restart cannot execute it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mapae-scheduler-")); dirs.push(dir); const path = join(dir, "s.db");
    const a = open(path); a.schedules.add(spec);
    const claimed = a.schedules.claim(spec.id, 1000)!;
    const b = open(path);
    expect(b.schedules.claim(spec.id, 1000)).toBeNull();
    a.close(); stores.splice(stores.indexOf(a), 1);
    expect(await tick(b.schedules, async () => {throw new Error("never");}, () => 90000)).toBe(0);
    expect(b.schedules.runs(spec.id)[0]?.outcome).toBe("unknown");
    expect(b.schedules.get(spec.id)?.committedBase).toBe(100n);
    b.schedules.finish(claimed.run.id, {outcome: "paid", amountBase: 80n}, 2000);
    b.schedules.finish(claimed.run.id, {outcome: "paid", amountBase: 80n}, 2000);
    expect(b.schedules.get(spec.id)?.committedBase).toBe(80n);
});
test("known unavailability retries with a bound, releases reservations and keeps history", async () => {
    const s = open().schedules; s.add(spec);
    await tick(s, async () => ({outcome: "unpaid", code: "SELLER_UNAVAILABLE", retry: true}), () => 1000);
    expect(s.get(spec.id)?.nextAt).toBe(2000); expect(s.get(spec.id)?.committedBase).toBe(0n);
    await tick(s, async () => ({outcome: "unpaid", code: "SELLER_UNAVAILABLE", retry: true}), () => 2000);
    expect(s.get(spec.id)?.status).toBe("paused"); expect(s.get(spec.id)?.runCount).toBe(1);
    expect(s.runs(spec.id).map(r => r.attempt)).toEqual([1, 2]);
});
test("unknown outcomes reserve the maximum and pause, cancellation survives an in-flight finish", async () => {
    const s = open().schedules; s.add(spec);
    await tick(s, async () => ({outcome: "unknown", code: "SETTLEMENT_UNKNOWN"}), () => 1000);
    expect(s.get(spec.id)?.status).toBe("paused"); expect(s.get(spec.id)?.committedBase).toBe(100n);
    s.add({...spec, id: "second"});
    await tick(s, async () => {s.cancel("second"); return {outcome: "paid", amountBase: 80n};}, () => 1000);
    expect(s.get("second")?.status).toBe("cancelled"); expect(s.get("second")?.committedBase).toBe(80n);
});
test("total cap and end time prohibit new claims even with remaining run slots", async () => {
    const s = open().schedules; s.add({...spec, maxTotalBase: 100n});
    await tick(s, async () => ({outcome: "paid", amountBase: 80n}), () => 1000);
    expect(s.get(spec.id)?.status).toBe("completed");
    s.add({...spec, id: "expired"}); expect(s.claim("expired", 100000)).toBeNull();
    expect(s.get("expired")?.status).toBe("completed");
});
test("invalid bounds and paths cannot enter the database", () => {
    const s = open().schedules;
    for (const change of [{intervalMs: 0}, {maxRuns: Infinity}, {maxAttempts: 11}, {maxTotalBase: 99n}, {resourcePath: "//evil.test"}, {resourcePath: "/secret?token=x"}, {endsAt: 999}]) expect(() => s.add({...spec, ...change})).toThrow();
    expect(s.list()).toEqual([]);
});
const manager = "0x4000000000000000000000000000000000000001" as const;
const facilitator = "0x3000000000000000000000000000000000000001" as const;
function setup(offerAmount = 80n, recipient = spec.payTo, status = 200, cancelWhileSigning = false) {
    const s = open().schedules; s.add(spec); let signatures = 0, calls = 0;
    const runtime = {sellerUrl: new URL("https://seller.test"), delegationManager: manager, trustedFacilitators: [facilitator],
        preflight: async () => ({ok: true}), provider: async () => {signatures++; if (cancelWhileSigning) s.cancel(spec.id);
            return {delegationManager: manager, permissionContext: `0x${"ab".repeat(64)}`, delegator: spec.payTo};}} as Pick<DelegatedAgentRuntime, "sellerUrl" | "delegationManager" | "trustedFacilitators" | "preflight" | "provider">;
    const fetchImpl = (async () => {
        calls++;
        if (calls === 1) return Response.json({x402Version: 2, resource: {url: "https://seller.test/s/cafe/coffee", mimeType: "application/json"}, accepts: [buildErc7710PaymentRequirements({payTo: recipient, amount: offerAmount, facilitatorAddresses: [facilitator]})]}, {status: 402});
        return Response.json({receipt: {transaction: `0x${"cd".repeat(32)}`}}, {status});
    }) as unknown as typeof fetch;
    return {s, execute: paymentExecutor(s, runtime, () => 1000, fetchImpl), signatures: () => signatures, calls: () => calls};
}
test("the real payment client checks recipient and per-payment cap before signing", async () => {
    for (const [amount, recipient] of [[101n, spec.payTo], [80n, "0x2000000000000000000000000000000000000002"]] as const) {
        const f = setup(amount, recipient); await tick(f.s, f.execute, () => 1000);
        expect(f.signatures()).toBe(0); expect(f.calls()).toBe(1); expect(f.s.runs(spec.id)[0]?.code).toBe("POLICY_DENIED");
        expect(f.s.get(spec.id)?.committedBase).toBe(0n);
    }
});
test("real 402 sign/pay succeeds and persists receipt metadata only", async () => {
    const f = setup(); await tick(f.s, f.execute, () => 1000);
    expect(f.signatures()).toBe(1); expect(f.s.runs(spec.id)[0]?.outcome).toBe("paid"); expect(f.s.get(spec.id)?.committedBase).toBe(80n);
    expect(JSON.stringify(f.s.runs(spec.id), (_, v) => typeof v === "bigint" ? String(v) : v)).not.toContain("abababab");
});
test("cancellation while signing prevents header dispatch", async () => {
    const f = setup(80n, spec.payTo, 200, true); await tick(f.s, f.execute, () => 1000);
    expect(f.signatures()).toBe(1); expect(f.calls()).toBe(1); expect(f.s.get(spec.id)?.status).toBe("cancelled");
});
test("HTTP 504 pauses whereas known HTTP 503 schedules a bounded retry", async () => {
    for (const status of [504, 503]) {
        const f = setup(80n, spec.payTo, status); await tick(f.s, f.execute, () => 1000);
        expect(f.s.get(spec.id)?.status).toBe(status === 504 ? "paused" : "active");
        expect(f.s.get(spec.id)?.committedBase).toBe(status === 504 ? 100n : 0n);
    }
});
