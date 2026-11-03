import {afterAll, beforeAll, expect, test} from "bun:test";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import type {DelegatedAgentRuntime} from "@mapae/delegation";
import {
    GIWA_SEPOLIA_CAIP2,
    buildErc7710PaymentRequirements,
    encodePaymentResponseHeader,
    type SettleResponse,
} from "@mapae/shared";
import {getAddress, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {createAgentServer} from "./server.js";

/**
 * The pay tool's result is what a Claude Desktop user reads to decide whether they paid.
 * These cases drive the real server in-process against a scripted seller (no network):
 * the global fetch answers the 402 offer, then whatever the case needs on the retry.
 */
const MANAGER = getAddress("0x4000000000000000000000000000000000000001");
const FACILITATOR = getAddress("0x3000000000000000000000000000000000000001");
const PAYEE = getAddress("0x2000000000000000000000000000000000000001");
const DELEGATOR = getAddress("0x5000000000000000000000000000000000000001");
const PRIVATE_KEY = `0x${"11".repeat(32)}` as Hex;
const PERMISSION_CONTEXT = `0x${"ab".repeat(64)}` as Hex;
const TX = `0x${"cd".repeat(32)}` as Hex;
const SELLER = new URL("http://127.0.0.1:3001");
const RESOURCE = "/s/demo-cafe/americano";

/** What the preflight answers; set per case. */
let verdict: {ok: true} | {ok: false; code: "LIMIT_EXCEEDED"; detail: string} = {ok: true};

const runtime = {
    account: privateKeyToAccount(PRIVATE_KEY),
    provider: async () => ({
        delegationManager: MANAGER,
        permissionContext: PERMISSION_CONTEXT,
        delegator: DELEGATOR,
    }),
    preflight: async () => verdict,
    spendPolicy: {},
    delegationManager: MANAGER,
    trustedFacilitators: [FACILITATOR],
    sellerUrl: SELLER,
    facilitatorUrl: new URL("http://127.0.0.1:3002"),
} as unknown as DelegatedAgentRuntime;

const offer = {
    x402Version: 2,
    resource: {url: new URL(RESOURCE, SELLER).toString(), description: "test", mimeType: "application/json"},
    accepts: [
        buildErc7710PaymentRequirements({payTo: PAYEE, amount: 1_000_000n, facilitatorAddresses: [FACILITATOR]}),
    ],
};

function receipt(patch: Record<string, unknown>): string {
    return encodePaymentResponseHeader({
        success: true,
        network: GIWA_SEPOLIA_CAIP2,
        payer: DELEGATOR,
        ...patch,
    } as unknown as SettleResponse);
}

/** What the scripted seller answers to the paid retry; set per case. */
let retry: () => Response = () => new Response(null, {status: 500});
const realFetch = globalThis.fetch;
let client: Client;

beforeAll(async () => {
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        const paid = new Headers(init?.headers).has("payment-signature");
        if (!paid) {
            return new Response(JSON.stringify(offer), {
                status: 402,
                headers: {"content-type": "application/json"},
            });
        }
        return retry();
    }) as typeof fetch;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createAgentServer(async () => runtime).connect(serverSide);
    client = new Client({name: "mapae-pay-result", version: "0.0.0"});
    await client.connect(clientSide);
});

afterAll(async () => {
    globalThis.fetch = realFetch;
    await client?.close();
});

async function pay(): Promise<{isError: boolean; body: Record<string, unknown>; raw: string}> {
    const result = await client.callTool({name: "mapae_pay_for_resource", arguments: {resource: RESOURCE}});
    const content = result.content as {type: string; text: string}[];
    const raw = content[0]!.text;
    // No result, success or failure, may carry the key or the bearer permission context.
    expect(raw).not.toContain(PRIVATE_KEY.slice(2));
    expect(raw).not.toContain(PERMISSION_CONTEXT.slice(2));
    return {isError: result.isError === true, body: JSON.parse(raw) as Record<string, unknown>, raw};
}

function json(body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: {"content-type": "application/json", ...headers},
    });
}

test("a seller receipt hash makes the payment confirmed, with an explorer link", async () => {
    retry = () => json({ticket: "ok"}, {"Payment-Response": receipt({transaction: TX})});
    const {isError, body} = await pay();
    expect(isError).toBe(false);
    expect(body.ok).toBe(true);
    expect(body.transaction).toBe(TX);
    expect(body.settlement).toBe("confirmed");
    expect(body.explorerUrl).toBe(`https://sepolia-explorer.giwa.io/tx/${TX}`);
    expect(String(body.next)).toContain("explorerUrl");
    expect(body.resource).toEqual({ticket: "ok"});
    expect(body.amount).toBe("1.0 mUSDC");
    expect(body.payTo).toBe(PAYEE);
});

test("no hash from the seller is unconfirmed and points at the Studio receipt screen", async () => {
    retry = () => json({ticket: "ok"});
    const {body} = await pay();
    expect(body.ok).toBe(true);
    expect(body.transaction).toBeUndefined();
    expect(body.settlement).toBe("unconfirmed");
    expect(body).not.toHaveProperty("explorerUrl");
    expect(String(body.next)).toContain("Studio receipt screen");
});

test("SETTLEMENT_UNKNOWN with a seller-named hash says do not retry and links the hash", async () => {
    retry = () =>
        new Response(null, {
            status: 504,
            headers: {"Payment-Response": receipt({success: false, errorReason: "settlement_pending", transaction: TX})},
        });
    const {isError, body} = await pay();
    expect(isError).toBe(true);
    expect(body.code).toBe("SETTLEMENT_UNKNOWN");
    expect(body.retry).toBe(false);
    expect(body.explorerUrl).toBe(`https://sepolia-explorer.giwa.io/tx/${TX}`);
    expect(String(body.next)).toContain("Do not pay again");
});

test("SETTLEMENT_UNKNOWN without a hash still says do not retry, with no link", async () => {
    retry = () => new Response(null, {status: 504});
    const {body} = await pay();
    expect(body.code).toBe("SETTLEMENT_UNKNOWN");
    expect(body.retry).toBe(false);
    expect(body).not.toHaveProperty("explorerUrl");
    expect(String(body.next)).toContain("balance");
});

test("SELLER_UNAVAILABLE is marked retryable; PAYMENT_REJECTED keeps its old shape", async () => {
    retry = () => new Response(null, {status: 503});
    const unavailable = (await pay()).body;
    expect(unavailable.code).toBe("SELLER_UNAVAILABLE");
    expect(unavailable.retry).toBe(true);

    retry = () => new Response(null, {status: 402});
    const rejected = (await pay()).body;
    expect(rejected.code).toBe("PAYMENT_REJECTED");
    expect(Object.keys(rejected).sort()).toEqual(["code", "detail", "ok", "status"]);
});

test("LIMIT_EXCEEDED is marked retryable", async () => {
    verdict = {ok: false, code: "LIMIT_EXCEEDED", detail: "1.0 mUSDC left in this period"};
    try {
        const {body} = await pay();
        expect(body.code).toBe("LIMIT_EXCEEDED");
        expect(body.retry).toBe(true);
    } finally {
        verdict = {ok: true};
    }
});
