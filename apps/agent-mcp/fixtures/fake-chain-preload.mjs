/**
 * `node --import` preload for `node-bundle.test.ts`: the fake RPC and the fake facilitator,
 * in the server's own process, with no socket.
 *
 * Earlier the test served both from `Bun.serve` on loopback; a sandbox that refuses even
 * a loopback `bind` could not run it. This replaces `globalThis.fetch` before the bundle
 * loads, so only requests to the two fixture origins below are answered here; everything
 * else goes to the real fetch, and the fixture origins themselves point at closed ports,
 * so a request that slips past this file fails instead of reaching anything.
 *
 * The bundle is not touched: viem's http transport and the facilitator `/supported` call
 * both use the global fetch, and the RPC answers come from `framework-chain.rpc.json`, so
 * the audited bytecode verifier runs unmodified.
 *
 * Env (set by the test, never by the server):
 *   FAKE_CHAIN_RECORDING      path of the recorded JSON-RPC answers
 *   FAKE_CHAIN_LOG            path; one JSON line per RPC call {method, key, miss}
 *   FAKE_CHAIN_CODE_OVERRIDE  when set, every eth_getCode answers this
 *   FAKE_FACILITATOR_SIGNER   the signer `/supported` lists for eip155:91342
 */
import {appendFileSync, readFileSync} from "node:fs";

export const FAKE_RPC_URL = "http://127.0.0.1:1/";
export const FAKE_FACILITATOR_URL = "http://127.0.0.1:2/";

const recording = JSON.parse(readFileSync(process.env.FAKE_CHAIN_RECORDING, "utf8"));
const log = process.env.FAKE_CHAIN_LOG;
const codeOverride = process.env.FAKE_CHAIN_CODE_OVERRIDE;
const signer = process.env.FAKE_FACILITATOR_SIGNER;
const realFetch = globalThis.fetch;

function answer(call) {
    const key = `${call.method} ${JSON.stringify(call.params ?? [])}`;
    let reply;
    if (codeOverride && call.method === "eth_getCode") reply = {jsonrpc: "2.0", id: call.id, result: codeOverride};
    else if (key in recording) reply = {jsonrpc: "2.0", id: call.id, result: recording[key]};
    else {
        reply = {jsonrpc: "2.0", id: call.id, error: {code: -32601, message: "fake rpc: not in the recording"}};
    }
    if (log) appendFileSync(log, `${JSON.stringify({method: call.method, key, miss: "error" in reply})}\n`);
    return reply;
}

globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (`${url.origin}/` === FAKE_RPC_URL) {
        const body = await request.json();
        return Response.json(Array.isArray(body) ? body.map(answer) : answer(body));
    }
    if (`${url.origin}/` === FAKE_FACILITATOR_URL) {
        if (url.pathname !== "/supported") return new Response(null, {status: 404});
        return Response.json({signers: {"eip155:91342": [signer]}});
    }
    return realFetch(input, init);
};
