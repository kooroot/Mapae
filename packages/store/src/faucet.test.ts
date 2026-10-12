import {afterEach, describe, expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {openFaucetStore, type FaucetReserveInput, type FaucetReserveLimits, type FaucetStore} from "./faucet.js";

const T0 = 1_760_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const OWNER = `0x${"a1".repeat(20)}`;
const PAYER = `0x${"b2".repeat(20)}`;
const IP = "1".repeat(64);
const SUBNET = "2".repeat(64);
const HASH = `0x${"cd".repeat(32)}`;
const RAW = "0x02f8aa";

const MUSDC: FaucetReserveLimits = {windowMs: DAY, dayMs: DAY, perIp: 5, perSubnet: 20, perDay: 1000};
const ETH: FaucetReserveLimits = {windowMs: 7 * DAY, dayMs: DAY, perIp: 1, perSubnet: 3, dailyAmount: 5n * 10n ** 17n};
const ETH_AMOUNT = 5n * 10n ** 16n;

const dirs: string[] = [];
const stores: FaucetStore[] = [];
afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});
function open(path = ":memory:"): FaucetStore {
    const store = openFaucetStore(path);
    stores.push(store);
    return store;
}
function tempPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "mapae-faucet-"));
    dirs.push(dir);
    return join(dir, "faucet.sqlite");
}
const owner = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const key = (n: number) => n.toString(16).padStart(64, "0");
function input(overrides: Partial<FaucetReserveInput> = {}): FaucetReserveInput {
    return {kind: "musdc", owner: OWNER, recipient: PAYER, ipKey: IP, subnetKey: SUBNET, amount: 0n, ...overrides};
}
function reserved(store: FaucetStore, value: FaucetReserveInput, now: number, limits = MUSDC) {
    const result = store.reserve(value, now, limits);
    if (!result.ok) throw new Error(`expected a reservation, got ${result.refusal.kind}`);
    return result.claim;
}
function confirm(store: FaucetStore, id: string, nonce: number, now: number) {
    expect(store.markSigned(id, {amount: 1n, nonce, txHash: `0x${nonce.toString(16).padStart(64, "0")}`, rawTx: RAW}, now)).toBe(true);
    expect(store.markSent(id, now)).toBe(true);
    expect(store.markConfirmed(id, now)).toBe(true);
}

describe("reserve", () => {
    test("records a reserved claim and hands back the same claim while it is in flight", () => {
        const store = open();
        const first = store.reserve(input(), T0, MUSDC);
        expect(first.ok && first.created).toBe(true);
        if (!first.ok) return;
        expect(first.claim).toMatchObject({kind: "musdc", owner: OWNER, recipient: PAYER, state: "reserved", amount: "0", nonce: null});

        // A double click, a retry after a dropped reply: no second claim, no key needed.
        const again = store.reserve(input({ipKey: key(9)}), T0 + 1_000, MUSDC);
        expect(again).toEqual({ok: true, claim: first.claim, created: false});
        expect(store.unsettled()).toHaveLength(1);
    });

    test("a counted claim holds the owner's window and says when it opens", () => {
        const store = open();
        const claim = reserved(store, input(), T0);
        confirm(store, claim.id, 0, T0 + 5_000);
        expect(store.reserve(input(), T0 + HOUR, MUSDC)).toEqual({ok: false, refusal: {kind: "cooldown", nextAt: T0 + DAY}});
        expect(store.reserve(input(), T0 + DAY - 1, MUSDC).ok).toBe(false);
        expect(store.reserve(input(), T0 + DAY, MUSDC).ok).toBe(true);
    });

    test("the window is per kind: a stablecoin claim does not hold the ETH window", () => {
        const store = open();
        confirm(store, reserved(store, input(), T0).id, 0, T0);
        expect(store.reserve(input({kind: "eth", recipient: OWNER, amount: ETH_AMOUNT}), T0 + 1, ETH).ok).toBe(true);
    });

    test("skipped and failed claims never consume a window or a network slot", () => {
        const store = open();
        const skipped = reserved(store, input(), T0);
        expect(store.markSkipped(skipped.id, T0)).toBe(true);
        const failed = reserved(store, input(), T0 + 1);
        expect(store.markFailed(failed.id, T0 + 1)).toBe(true);
        const next = store.reserve(input(), T0 + 2, MUSDC);
        expect(next.ok && next.created).toBe(true);
    });

    test("an address bucket gets perIp counted claims a day, then rate_limited", () => {
        const store = open();
        for (let n = 1; n <= MUSDC.perIp; n += 1) confirm(store, reserved(store, input({owner: owner(n)}), T0 + n).id, n, T0 + n);
        expect(store.reserve(input({owner: owner(99)}), T0 + 10, MUSDC)).toEqual({ok: false, refusal: {kind: "rate_limited"}});
        // A different address bucket in the same subnet still gets through…
        expect(store.reserve(input({owner: owner(99), ipKey: key(2)}), T0 + 10, MUSDC).ok).toBe(true);
        // …and the day rolls.
        expect(store.reserve(input({owner: owner(100)}), T0 + DAY + 1, MUSDC).ok).toBe(true);
    });

    test("a subnet bucket caps a farm that rotates addresses inside one block", () => {
        const store = open();
        for (let n = 1; n <= ETH.perSubnet; n += 1) {
            reserved(store, input({kind: "eth", owner: owner(n), recipient: owner(n), ipKey: key(n), amount: ETH_AMOUNT}), T0 + n, ETH);
        }
        expect(store.reserve(input({kind: "eth", owner: owner(9), recipient: owner(9), ipKey: key(9), amount: ETH_AMOUNT}), T0 + 9, ETH))
            .toEqual({ok: false, refusal: {kind: "rate_limited"}});
        expect(store.reserve(input({kind: "eth", owner: owner(9), recipient: owner(9), ipKey: key(9), subnetKey: key(10), amount: ETH_AMOUNT}), T0 + 9, ETH).ok).toBe(true);
    });

    test("the stablecoin's daily count is global and refuses once full", () => {
        const store = open();
        const limits = {...MUSDC, perDay: 3};
        for (let n = 1; n <= 3; n += 1) reserved(store, input({owner: owner(n), ipKey: key(n), subnetKey: key(n)}), T0 + n, limits);
        expect(store.reserve(input({owner: owner(9), ipKey: key(9), subnetKey: key(9)}), T0 + 9, limits))
            .toEqual({ok: false, refusal: {kind: "budget_exhausted"}});
    });

    test("ETH's daily wei cap counts committed amounts, including the claim being admitted", () => {
        const store = open();
        const limits = {...ETH, perIp: 99, perSubnet: 99, dailyAmount: 3n * ETH_AMOUNT};
        const eth = (n: number) => input({kind: "eth", owner: owner(n), recipient: owner(n), amount: ETH_AMOUNT});
        for (let n = 1; n <= 3; n += 1) reserved(store, eth(n), T0 + n, limits);
        expect(store.reserve(eth(4), T0 + 4, limits)).toEqual({ok: false, refusal: {kind: "budget_exhausted"}});
        // A claim that failed gives its share back.
        expect(store.markFailed(store.latest("eth", owner(1))!.id, T0 + 5)).toBe(true);
        expect(store.reserve(eth(4), T0 + 6, limits).ok).toBe(true);
    });

    test("admission answers like reserve without writing", () => {
        const store = open();
        expect(store.admission(input(), T0, MUSDC)).toBeUndefined();
        expect(store.unsettled()).toHaveLength(0);
        const claim = reserved(store, input(), T0);
        expect(store.admission(input(), T0 + 1, MUSDC)).toEqual({kind: "inflight", claim});
    });

    test("two handles on one file cannot both take the last slot", () => {
        const path = tempPath();
        const a = open(path);
        const b = open(path);
        const limits = {...MUSDC, perIp: 1};
        const first = a.reserve(input({owner: owner(1)}), T0, limits);
        const second = b.reserve(input({owner: owner(2)}), T0, limits);
        expect(first.ok).toBe(true);
        expect(second).toEqual({ok: false, refusal: {kind: "rate_limited"}});
        // And one owner cannot hold two in-flight claims of a kind through two handles.
        const third = b.reserve(input({owner: owner(1), ipKey: key(3)}), T0, limits);
        expect(third.ok && !third.created).toBe(true);
    });

    test("refuses inputs that would let one owner or one network appear as two", () => {
        const store = open();
        expect(() => store.reserve(input({owner: OWNER.toUpperCase().replace("0X", "0x")}), T0, MUSDC)).toThrow(TypeError);
        expect(() => store.reserve(input({recipient: "0x1234"}), T0, MUSDC)).toThrow(TypeError);
        expect(() => store.reserve(input({ipKey: "203.0.113.7"}), T0, MUSDC)).toThrow(TypeError);
        expect(() => store.reserve(input({amount: -1n}), T0, MUSDC)).toThrow(TypeError);
        expect(() => store.reserve(input({kind: "btc" as "eth"}), T0, MUSDC)).toThrow(TypeError);
    });
});

describe("claim states", () => {
    test("walks reserved → signed → sent → confirmed and records what was sent", () => {
        const store = open();
        const claim = reserved(store, input(), T0);
        expect(store.markSigned(claim.id, {amount: 999n, nonce: 7, txHash: HASH, rawTx: RAW}, T0 + 1)).toBe(true);
        expect(store.get(claim.id)).toMatchObject({state: "signed", amount: "999", nonce: 7, tx_hash: HASH, raw_tx: RAW});
        expect(store.markSent(claim.id, T0 + 2)).toBe(true);
        expect(store.markConfirmed(claim.id, T0 + 3)).toBe(true);
        expect(store.get(claim.id)).toMatchObject({state: "confirmed", updated_at: T0 + 3});
        expect(store.unsettled()).toHaveLength(0);
    });

    test("only a reserved claim can be signed, so a claim the reconciler failed is never broadcast", () => {
        const store = open();
        const claim = reserved(store, input(), T0);
        expect(store.markFailed(claim.id, T0 + 1)).toBe(true);
        expect(store.markSigned(claim.id, {amount: 1n, nonce: 0, txHash: HASH, rawTx: RAW}, T0 + 2)).toBe(false);
        expect(store.get(claim.id)?.state).toBe("failed");
    });

    test("final states are final", () => {
        const store = open();
        const claim = reserved(store, input(), T0);
        confirm(store, claim.id, 0, T0);
        expect(store.markFailed(claim.id, T0 + 1)).toBe(false);
        expect(store.markSent(claim.id, T0 + 1)).toBe(false);
        expect(store.markSkipped(claim.id, T0 + 1)).toBe(false);
        const skipped = reserved(store, input({owner: owner(5)}), T0);
        expect(store.markSkipped(skipped.id, T0)).toBe(true);
        expect(store.markConfirmed(skipped.id, T0 + 1)).toBe(false);
    });

    test("a confirmation cannot skip the signature: a reserved row has nothing to confirm", () => {
        const store = open();
        const claim = reserved(store, input(), T0);
        expect(store.markConfirmed(claim.id, T0 + 1)).toBe(false);
        expect(store.markSent(claim.id, T0 + 1)).toBe(false);
    });

    test("a signed-but-unsent claim survives a restart with its bytes, ready to rebroadcast", () => {
        const path = tempPath();
        const before = open(path);
        const claim = reserved(before, input(), T0);
        before.markSigned(claim.id, {amount: 5n, nonce: 3, txHash: HASH, rawTx: RAW}, T0 + 1);
        before.close();
        stores.splice(stores.indexOf(before), 1);

        const after = open(path);
        expect(after.unsettled()).toEqual([expect.objectContaining({id: claim.id, state: "signed", nonce: 3, tx_hash: HASH, raw_tx: RAW})]);
        expect(after.nextNonce()).toBe(4);
    });

    test("refuses a signature without a positive amount or with mixed-case bytes", () => {
        const store = open();
        const claim = reserved(store, input(), T0);
        expect(() => store.markSigned(claim.id, {amount: 0n, nonce: 0, txHash: HASH, rawTx: RAW}, T0)).toThrow(TypeError);
        expect(() => store.markSigned(claim.id, {amount: 1n, nonce: -1, txHash: HASH, rawTx: RAW}, T0)).toThrow(TypeError);
        expect(() => store.markSigned(claim.id, {amount: 1n, nonce: 0, txHash: HASH.toUpperCase(), rawTx: RAW}, T0)).toThrow(TypeError);
    });
});

describe("nonces, history and pruning", () => {
    test("nextNonce is one past the highest signed, sent or confirmed nonce, ignoring failed rows", () => {
        const store = open();
        expect(store.nextNonce()).toBe(0);
        const a = reserved(store, input({owner: owner(1)}), T0);
        confirm(store, a.id, 4, T0);
        const b = reserved(store, input({owner: owner(2), ipKey: key(2)}), T0);
        store.markSigned(b.id, {amount: 1n, nonce: 5, txHash: HASH, rawTx: RAW}, T0);
        expect(store.nextNonce()).toBe(6);
        store.markFailed(b.id, T0 + 1);
        expect(store.nextNonce()).toBe(5);
    });

    test("inflight sums the ETH that signed and sent claims carry and counts every one of them", () => {
        const store = open();
        expect(store.inflight()).toEqual({wei: 0n, count: 0});
        const mint = reserved(store, input({owner: owner(1)}), T0);
        store.markSigned(mint.id, {amount: 7n, nonce: 0, txHash: `0x${"01".repeat(32)}`, rawTx: RAW}, T0);
        const grant = reserved(store, input({kind: "eth", owner: owner(2), recipient: owner(2), ipKey: key(2), amount: ETH_AMOUNT}), T0, ETH);
        store.markSigned(grant.id, {amount: ETH_AMOUNT, nonce: 1, txHash: `0x${"02".repeat(32)}`, rawTx: RAW}, T0);
        store.markSent(grant.id, T0);
        reserved(store, input({kind: "eth", owner: owner(3), recipient: owner(3), ipKey: key(3), amount: ETH_AMOUNT}), T0, ETH);
        expect(store.inflight()).toEqual({wei: ETH_AMOUNT, count: 2});
        store.markConfirmed(grant.id, T0 + 1);
        expect(store.inflight()).toEqual({wei: 0n, count: 1});
    });

    test("latest is the owner's newest claim of the kind, in any state", () => {
        const store = open();
        expect(store.latest("musdc", OWNER)).toBeUndefined();
        const first = reserved(store, input(), T0);
        store.markSkipped(first.id, T0);
        const second = reserved(store, input(), T0 + 1);
        expect(store.latest("musdc", OWNER)?.id).toBe(second.id);
        expect(store.latest("eth", OWNER)).toBeUndefined();
    });

    test("prune drops old finished rows and never an in-flight one", () => {
        const store = open();
        const done = reserved(store, input({owner: owner(1)}), T0);
        confirm(store, done.id, 0, T0);
        const stuck = reserved(store, input({owner: owner(2), ipKey: key(2)}), T0);
        store.markSigned(stuck.id, {amount: 1n, nonce: 1, txHash: HASH, rawTx: RAW}, T0);
        expect(store.prune(T0 + 30 * DAY)).toBe(1);
        expect(store.get(done.id)).toBeUndefined();
        expect(store.get(stuck.id)?.state).toBe("signed");
    });
});
