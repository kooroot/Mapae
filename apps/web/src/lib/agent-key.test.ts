import {describe, expect, test} from "bun:test";
import {privateKeyToAccount} from "viem/accounts";
import {getAddress} from "viem";
import {buildMcpBundle, generateAgentSessionKey} from "./agent-key";

const ADMIN = getAddress("0x00A7b901abb908ecafEC72973906424c4fDdc100");
const CONTEXT = ("0x" + "ab".repeat(120)) as `0x${string}`;

describe("generateAgentSessionKey", () => {
    test("returns a 32-byte private key whose derived address matches", () => {
        const key = generateAgentSessionKey();
        expect(key.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
        expect(getAddress(privateKeyToAccount(key.privateKey).address)).toBe(
            getAddress(key.address),
        );
    });

    test("two generations differ", () => {
        expect(generateAgentSessionKey().privateKey).not.toBe(
            generateAgentSessionKey().privateKey,
        );
    });
});

describe("buildMcpBundle", () => {
    const key = generateAgentSessionKey();
    const bundle = buildMcpBundle({
        permissionContext: CONTEXT,
        agentKey: key,
        frameworkAdmin: ADMIN,
    });

    test("permission file is exactly the JSON shape agent-runtime parses", () => {
        const parsed = JSON.parse(bundle.permissionFileText) as Record<string, unknown>;
        expect(Object.keys(parsed)).toEqual(["permissionContext"]);
        expect(parsed["permissionContext"]).toBe(CONTEXT);
    });

    test("env file carries the session key, the real admin, and the hosted endpoints", () => {
        const lines = bundle.envFileText.trimEnd().split("\n");
        expect(lines).toContain(`AGENT_PRIVATE_KEY=${key.privateKey}`);
        expect(lines).toContain(`FRAMEWORK_ADMIN_ADDRESS=${ADMIN}`);
        expect(lines).toContain("SELLER_URL=https://seller.mapae.io");
        expect(lines).toContain("FACILITATOR_URL=https://facilitator.mapae.io");
        expect(lines).toContain(
            "PARENT_PERMISSION_CONTEXT_PATH=./open-agent.permission.json",
        );
        expect(bundle.envFileText.endsWith("\n")).toBe(true);
    });

    test("no placeholder addresses survive into the env file", () => {
        expect(bundle.envFileText).not.toContain("0x3333333333333333333333333333333333333333");
    });

    test("bundle text contains all three artifacts in setup order", () => {
        const permissionAt = bundle.bundleText.indexOf("open-agent.permission.json");
        const envAt = bundle.bundleText.indexOf("apps/delegated-agent/.env");
        const commandAt = bundle.bundleText.indexOf("claude mcp add mapae");
        expect(permissionAt).toBeGreaterThan(-1);
        expect(envAt).toBeGreaterThan(permissionAt);
        expect(commandAt).toBeGreaterThan(envAt);
        expect(bundle.bundleText).toContain(CONTEXT);
        expect(bundle.bundleText).toContain(key.privateKey);
    });

    test("the registration command keeps the guide's working-directory convention", () => {
        expect(bundle.mcpCommand).toContain("apps/delegated-agent");
        expect(bundle.mcpCommand).toContain("exec bun ../agent-mcp/index.ts");
    });

    test("the default bundle is English and reaches no Korean text", () => {
        expect(bundle.bundleText).toContain("# Mapae MCP connection bundle");
        expect(bundle.bundleText).toContain(
            "# AGENT_PRIVATE_KEY is a secret — move it into the file, then discard this text,",
        );
        // Nothing Korean may be reachable when locale === "en" — that includes
        // generated text, which is copy the same as anything rendered. Ranges:
        // Hangul Jamo, Compatibility Jamo, Syllables, written as escapes so the
        // test does not depend on how an editor renders the endpoints.
        expect(bundle.bundleText).not.toMatch(
            new RegExp("[\\u1100-\\u11FF\\u3130-\\u318F\\uAC00-\\uD7A3]"),
        );
    });

    test('locale "ko" pins the Korean bundle lines verbatim', () => {
        const koBundle = buildMcpBundle(
            {permissionContext: CONTEXT, agentKey: key, frameworkAdmin: ADMIN},
            "ko",
        );
        expect(koBundle.bundleText).toContain("# Mapae MCP 연결 번들");
        expect(koBundle.bundleText).toContain(
            "# AGENT_PRIVATE_KEY는 비밀값입니다 — 파일로 옮긴 뒤 이 텍스트는 폐기하고,",
        );
        expect(koBundle.mcpCommand).toContain("<Mapae 저장소 경로>");
        // The machine-readable artifacts are locale-independent: only the human
        // instructions around them change.
        expect(koBundle.permissionFileText).toBe(bundle.permissionFileText);
        expect(koBundle.envFileText).toBe(bundle.envFileText);
    });
});
