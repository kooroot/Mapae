import {expect, test} from "bun:test";
import {assertAnvil} from "./fork.js";
import {paymentMode} from "./index.js";
test("fork mode cannot attach an existing potentially live facilitator", () => {
    expect(() => paymentMode({ARCADE_PAYMENT_MODE: "fork", ARCADE_ALLOW_LOCAL_FORK: "true", GIWA_SEPOLIA_RPC_URL: "http://127.0.0.1:8545", FACILITATOR_URL: "http://127.0.0.1:8081"})).toThrow("external FACILITATOR_URL");
    expect(() => paymentMode({ARCADE_PAYMENT_MODE: "fork", GIWA_SEPOLIA_RPC_URL: "http://127.0.0.1:8545"})).toThrow("explicit");
});
test("a loopback JSON-RPC proxy reporting a public node fails the Anvil challenge", async () => {
    const remote = (async () => Response.json([{id: 1, result: "op-geth/v1"}, {id: 2, error: {code: -32601}}])) as unknown as typeof fetch;
    await expect(assertAnvil("http://127.0.0.1:8545", remote)).rejects.toThrow("Anvil");
});
test("Anvil transport prohibits redirects and requires both version and node info", async () => {
    const local = (async (_url: unknown, init?: RequestInit) => {
        expect(init?.redirect).toBe("error");
        expect(JSON.parse(String(init?.body))).toHaveLength(2);
        return Response.json([{id: 1, result: "anvil/v1.3"}, {id: 2, result: {currentBlockNumber: 1}}]);
    }) as unknown as typeof fetch;
    await expect(assertAnvil("http://127.0.0.1:8545", local)).resolves.toBeUndefined();
    await expect(assertAnvil("https://sepolia-rpc.giwa.io", local)).rejects.toThrow("loopback");
});
