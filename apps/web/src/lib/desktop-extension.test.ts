import {expect, test} from "bun:test";
import {DESKTOP_EXTENSION_PATH, desktopPasteValues} from "./desktop-extension";

const permissionContext = "0xabcdef0123" as const;
const privateKey = `0x${"1f".repeat(32)}` as const;

test("a grant holding its agent key yields the bare key hex and the permission code", () => {
    const values = desktopPasteValues({artifact: {permissionContext} as never, agentKey: {privateKey, address: "0x0000000000000000000000000000000000000001"}});
    expect(values.agentPrivateKey).toBe(privateKey);
    expect(values.agentPrivateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(values.agentPrivateKey).not.toContain("\n");
    expect(values.agentPrivateKey).not.toContain("=");
    expect(values.permissionContext).toBe(permissionContext);
});

test("a grant without an agent key marks the key unavailable and keeps the permission code", () => {
    const values = desktopPasteValues({artifact: {permissionContext} as never});
    expect(values.agentPrivateKey).toBeUndefined();
    expect(values.permissionContext).toBe(permissionContext);
});

test("the download path is the fixed public path", () => {
    expect(DESKTOP_EXTENSION_PATH).toBe("/mapae.mcpb");
});

test("_headers serves the download path as an attachment zip", async () => {
    const headers = await Bun.file(new URL("../../public/_headers", import.meta.url)).text();
    const block = headers.split(/\n(?=\/)/).find((entry) => entry.startsWith(`${DESKTOP_EXTENSION_PATH}\n`));
    expect(block).toBeDefined();
    expect(block).toMatch(/Content-Type: application\/(zip|octet-stream)/);
    expect(block).toContain("Content-Disposition: attachment");
});
