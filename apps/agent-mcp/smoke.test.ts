import {afterAll, beforeAll, expect, test} from "bun:test";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Boots the real server over stdio with a deliberately unconfigured environment.
 *
 * The point is the D5 contract: a misconfigured agent must answer with a reason
 * instead of dying. If the server ever went back to eager bootstrapping, the
 * spawn would fail here rather than returning RUNTIME_UNAVAILABLE.
 */
const serverPath = new URL("./index.ts", import.meta.url).pathname;
let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
    client = new Client({name: "mapae-smoke", version: "0.0.0"});
    transport = new StdioClientTransport({
        command: process.execPath,
        args: [serverPath],
        // No AGENT_PRIVATE_KEY / SELLER_URL: PATH only, so the runtime cannot load.
        env: {PATH: process.env.PATH ?? ""},
    });
    await client.connect(transport);
});

afterAll(async () => {
    await transport?.close();
});

function parseToolText(result: unknown): Record<string, unknown> {
    const content = (result as {content?: {type: string; text?: string}[]}).content ?? [];
    const first = content[0];
    if (!first || first.type !== "text" || !first.text) {
        throw new Error("tool did not return text content");
    }
    return JSON.parse(first.text) as Record<string, unknown>;
}

test("advertises exactly the two D5 automation tools", async () => {
    const {tools} = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["mapae_pay_for_resource", "mapae_status"]);

    const pay = tools.find((tool) => tool.name === "mapae_pay_for_resource");
    expect(pay?.inputSchema?.properties).toHaveProperty("resource");
});

test("an unconfigured runtime returns a reason instead of killing the server", async () => {
    const result = await client.callTool({name: "mapae_status", arguments: {}});
    expect(result.isError).toBe(true);

    const body = parseToolText(result);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("RUNTIME_UNAVAILABLE");
    expect(String(body.detail)).toContain("AGENT_PRIVATE_KEY");

    // Never leak key material or the bearer permission context in a failure.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("permissionContext");
    expect(serialized).not.toMatch(/0x[0-9a-fA-F]{64}/);
});

test("the server survives a failed call and still answers the next one", async () => {
    const result = await client.callTool({
        name: "mapae_pay_for_resource",
        arguments: {resource: "/delegated/deliverable/inv-001"},
    });
    expect(result.isError).toBe(true);
    expect(parseToolText(result).code).toBe("RUNTIME_UNAVAILABLE");
});
