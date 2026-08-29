"use strict";
/**
 * mapae-hello-probe — an MCP stdio server with one tool and zero dependencies.
 *
 * It exists to answer a single question on 2026-08-31: does this Claude Desktop account
 * (Free / Pro) install a `.mcpb` bundle and call a tool from it? Nothing here touches the
 * network, a key, or the real Mapae server (`apps/agent-mcp`).
 *
 * This file must run under plain Node >= 18 as CommonJS *and* as an ES module. Claude
 * Desktop unpacks the bundle into a directory of its own, where no package.json exists and
 * Node loads `.js` as CommonJS; inside this repository the nearest package.json
 * (`apps/delegation-lab`) says `"type": "module"`, so the same file loads as ESM. Using only
 * globals — no `require`, no `import`, no `module.exports`, no `__dirname` — keeps both true.
 *
 * Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout. stdout carries protocol
 * messages only; every log line goes to stderr.
 */

const SERVER_NAME = "mapae-hello-probe";
const SERVER_VERSION = "0.1.0";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const ACCEPTED_PROTOCOL_VERSIONS = new Set(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);
const HELLO_TEXT = "마패 프로브 응답 — 이 계정에서 .mcpb 설치와 실행이 됩니다 (플랜 기록용)";

const TOOLS = [
    {
        name: "mapae_hello",
        description:
            "마패 .mcpb 설치 프로브. 인자 없이 호출하면 고정 문장 하나를 돌려준다 — " +
            "이 계정에서 확장 설치와 도구 호출이 되는지 확인하는 용도다.",
        inputSchema: {type: "object", properties: {}},
    },
];

const log = (message) => process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({jsonrpc: "2.0", id, result});
const fail = (id, code, message) => send({jsonrpc: "2.0", id, error: {code, message}});
const isRequestId = (id) => typeof id === "string" || typeof id === "number";

function handleRequest({id, method, params}) {
    switch (method) {
        case "initialize": {
            const requested = params?.protocolVersion;
            const protocolVersion = ACCEPTED_PROTOCOL_VERSIONS.has(requested)
                ? requested
                : DEFAULT_PROTOCOL_VERSION;
            log(`initialize from ${params?.clientInfo?.name ?? "unknown client"} (protocol ${protocolVersion})`);
            return reply(id, {
                protocolVersion,
                capabilities: {tools: {}},
                serverInfo: {name: SERVER_NAME, version: SERVER_VERSION},
            });
        }
        case "ping":
            return reply(id, {});
        case "tools/list":
            return reply(id, {tools: TOOLS});
        case "tools/call": {
            const name = params?.name;
            if (name !== "mapae_hello") return fail(id, -32602, `Unknown tool: ${String(name)}`);
            return reply(id, {content: [{type: "text", text: HELLO_TEXT}]});
        }
        default:
            log(`method not found: ${method}`);
            return fail(id, -32601, `Method not found: ${method}`);
    }
}

function handleNotification({method}) {
    if (method === "notifications/initialized") log("client initialized");
    else log(`notification ignored: ${method}`);
}

function dispatch(line) {
    let message;
    try {
        message = JSON.parse(line);
    } catch {
        return fail(null, -32700, "Parse error");
    }
    const isObject = message !== null && typeof message === "object" && !Array.isArray(message);
    const id = isObject && isRequestId(message.id) ? message.id : null;
    if (
        !isObject ||
        message.jsonrpc !== "2.0" ||
        typeof message.method !== "string" ||
        (message.id !== undefined && id === null)
    ) {
        return fail(id, -32600, "Invalid Request");
    }
    if (message.id === undefined) return handleNotification(message);
    return handleRequest(message);
}

// Chunks arrive at arbitrary boundaries; keep the unfinished tail until its newline lands.
// setEncoding makes Node reassemble multi-byte UTF-8 sequences split across chunks.
let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) dispatch(line);
    }
});
process.stdin.on("end", () => {
    const tail = buffered.trim();
    buffered = "";
    if (tail) dispatch(tail);
    log("stdin closed, exiting");
    // Nothing else holds the event loop open, so the process ends on its own once the
    // pending stdout writes have drained — an explicit exit here could truncate them.
});
process.stdout.on("error", (error) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
});

log(`listening on stdio — node ${process.version} on ${process.platform}`);
