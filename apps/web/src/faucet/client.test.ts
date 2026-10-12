import {afterEach, describe, expect, test} from "bun:test";
import {createSiweMessage} from "viem/siwe";
import {checkFaucetSiweMessage, claimFaucet, FaucetError, readFaucetAccount, readFaucetStatus} from "./client";

const OWNER = "0x00000000000000000000000000000000000000a1";
const PAYER = "0x00000000000000000000000000000000000000b2";
const realFetch = globalThis.fetch;
afterEach(() => {globalThis.fetch = realFetch;});

function answer(status: number, body: unknown, seen: Request[] = []) {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Request(new URL(String(input), "https://faucet.mapae.io"), init));
        return Response.json(body, {status});
    }) as typeof fetch;
    return seen;
}

async function refusal(promise: Promise<unknown>): Promise<FaucetError> {
    try {await promise;} catch (e) {if (e instanceof FaucetError) return e;}
    throw new Error("expected a FaucetError");
}

const message = (over: Partial<Parameters<typeof createSiweMessage>[0]> = {}) => createSiweMessage({
    address: OWNER, chainId: 91342, domain: "faucet.mapae.io", uri: "https://faucet.mapae.io/", version: "1", nonce: "abcdefgh12345678", ...over,
});
const expected = {owner: OWNER, host: "faucet.mapae.io", origin: "https://faucet.mapae.io"} as const;

describe("the SIWE message the page agrees to sign", () => {
    test("names this host, this origin's root, GIWA Sepolia and the connected wallet", () => {
        expect(checkFaucetSiweMessage(message(), expected)).toBe(true);
    });

    test.each([
        ["another host", {domain: "mapae.io"}],
        ["the arcade's path", {uri: "https://faucet.mapae.io/ko/arcade"}],
        ["another chain", {chainId: 1}],
        ["another wallet", {address: "0x00000000000000000000000000000000000000c3"}],
    ] as const)("refuses %s", (_name, over) => {
        expect(checkFaucetSiweMessage(message(over), expected)).toBe(false);
    });

    test("refuses text that is not a SIWE message", () => {
        expect(checkFaucetSiweMessage("sign this to win", expected)).toBe(false);
    });
});

describe("faucet requests", () => {
    test("status keeps the Turnstile site key and refuses a missing one", async () => {
        const status = {musdc: {enabled: true, targetBase: "1000000000", windowMs: 86_400_000, missions: ["x_follow_mapae"]}, eth: {enabled: false, amountWei: "50000000000000000", windowMs: 604_800_000, missions: [], minMainnetNonce: 1}};
        answer(200, {...status, siteKey: "0x4AAAAAAA-test"});
        expect((await readFaucetStatus()).siteKey).toBe("0x4AAAAAAA-test");
        answer(200, status);
        expect((await refusal(readFaucetStatus())).code).toBe("invalid_response");
    });

    test("a claim names the wallet, posts JSON and returns only a validated view", async () => {
        const seen = answer(200, {kind: "musdc", state: "pending", amount: "1000000000", recipient: PAYER, transaction: `0x${"ab".repeat(32)}`});
        const view = await claimFaucet(OWNER, {kind: "musdc", turnstile: "token", missions: ["x_follow_mapae"]});
        expect(view.state).toBe("pending");
        expect(seen[0]!.headers.get("X-Mapae-Wallet")).toBe(OWNER);
        expect(seen[0]!.headers.get("Content-Type")).toBe("application/json");
        expect(await seen[0]!.json() as unknown).toEqual({kind: "musdc", turnstile: "token", missions: ["x_follow_mapae"]});
    });

    test("a view for the other kind is refused", async () => {
        answer(200, {kind: "eth", state: "confirmed", amount: "1", recipient: OWNER});
        expect((await refusal(claimFaucet(OWNER, {kind: "musdc", turnstile: "t", missions: []}))).code).toBe("invalid_response");
    });

    test("a cooldown carries its reopening time", async () => {
        answer(429, {error: {code: "cooldown", nextAt: 1_900_000_000_000}});
        const e = await refusal(claimFaucet(OWNER, {kind: "musdc", turnstile: "t", missions: []}));
        expect([e.code, e.nextAt]).toEqual(["cooldown", 1_900_000_000_000]);
    });

    test("401 always asks for a fresh sign-in, and unknown codes read as unavailable", async () => {
        answer(401, {error: {code: "anything"}});
        expect((await refusal(readFaucetAccount(OWNER))).code).toBe("login_required");
        answer(403, {error: {code: "origin_denied"}});
        expect((await refusal(readFaucetAccount(OWNER))).code).toBe("unavailable");
    });

    test("an account answered for another wallet is refused", async () => {
        const other = "0x00000000000000000000000000000000000000c3";
        answer(200, {owner: other, recipients: {musdc: PAYER, eth: other}, musdc: null, eth: null});
        expect((await refusal(readFaucetAccount(OWNER))).code).toBe("invalid_response");
    });
});
