import {getAddress, type Address, type Hex} from "viem";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import {giwaSepolia} from "@mapae/shared";

/**
 * An agent session key born in this browser tab.
 *
 * This is deliberately not custody. The key is generated locally, never sent
 * anywhere (the CSP's `connect-src` closes every other egress), never written to
 * browser storage, and leaves the page only through an explicit copy the user
 * performs. Its blast radius is also not the wallet's: the only authority this
 * key ever receives is the delegation the owner signs, and that authority is
 * bounded by the on-chain caveats — period cap, expiry, recipient policy.
 */
export interface AgentSessionKey {
    address: Address;
    privateKey: Hex;
}

export function generateAgentSessionKey(): AgentSessionKey {
    const privateKey = generatePrivateKey();
    return {privateKey, address: getAddress(privateKeyToAccount(privateKey).address)};
}

export interface McpBundle {
    permissionFileText: string;
    envFileText: string;
    mcpCommand: string;
    bundleText: string;
}

const HOSTED_SELLER_URL = "https://seller.mapae.io";
const HOSTED_FACILITATOR_URL = "https://facilitator.mapae.io";

/**
 * Everything the MCP setup needs, assembled where all three inputs already are.
 *
 * The three artifacts (permission file, `.env`, registration command) were
 * previously scattered across the clipboard, an `.env.example` with a
 * placeholder admin, and a guide section — and the step joining them (wrap the
 * copied hex in `{"permissionContext": …}`) was written down nowhere. The
 * browser is the one place that simultaneously holds the signed permission, the
 * generated session key, and the committed deployment artifact with the real
 * Framework admin, so it emits the finished set instead of pieces.
 */
export function buildMcpBundle(params: {
    permissionContext: Hex;
    agentKey: AgentSessionKey;
    frameworkAdmin: Address;
}): McpBundle {
    const permissionFileText = `${JSON.stringify(
        {permissionContext: params.permissionContext},
        null,
        4,
    )}\n`;

    const envFileText = [
        `AGENT_PRIVATE_KEY=${params.agentKey.privateKey}`,
        `FRAMEWORK_ADMIN_ADDRESS=${getAddress(params.frameworkAdmin)}`,
        `SELLER_URL=${HOSTED_SELLER_URL}`,
        `FACILITATOR_URL=${HOSTED_FACILITATOR_URL}`,
        `GIWA_SEPOLIA_RPC_URL=${giwaSepolia.rpcUrls.default.http[0]}`,
        "DELEGATION_DEPLOYMENT_PATH=../../deployments/giwa-sepolia.framework.json",
        "DELEGATION_MANIFEST_PATH=../../deployments/giwa-sepolia.framework-manifest.json",
        "PARENT_PERMISSION_CONTEXT_PATH=./open-agent.permission.json",
        "",
    ].join("\n");

    const mcpCommand =
        "claude mcp add mapae -- sh -c " +
        "'cd <Mapae 저장소 경로>/apps/delegated-agent && exec bun ../agent-mcp/index.ts'";

    const bundleText = [
        "# Mapae MCP 연결 번들",
        "# 이 내용은 이 브라우저에서만 만들어졌으며 어디에도 저장되어 있지 않습니다.",
        "# AGENT_PRIVATE_KEY는 비밀값입니다 — 파일로 옮긴 뒤 이 텍스트는 폐기하고,",
        "# 클립보드 기록·기기 간 클립보드 동기화를 쓴다면 그 기록도 지우세요.",
        "",
        "## 0) 저장소 준비 (Bun 설치 후)",
        "git clone --recurse-submodules https://github.com/kooroot/Mapae.git",
        "cd Mapae && bun install --frozen-lockfile",
        "",
        "## 1) 아래 내용을 apps/delegated-agent/open-agent.permission.json 으로 저장",
        permissionFileText.trimEnd(),
        "",
        "## 2) 아래 내용을 apps/delegated-agent/.env 로 저장",
        envFileText.trimEnd(),
        "",
        "## 3) MCP 클라이언트 등록 — 경로를 실제 클론 위치로 바꾸세요",
        mcpCommand,
        "",
    ].join("\n");

    return {permissionFileText, envFileText, mcpCommand, bundleText};
}
