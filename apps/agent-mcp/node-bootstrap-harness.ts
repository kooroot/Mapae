/**
 * Test-only entry point: the real server and the real bootstrap, minus one step.
 *
 * `node-bundle.test.ts` needs to prove the delegation runtime (viem, the smart-accounts
 * kit, the env and permission glue) comes up under plain Node. It cannot do that through
 * `index.ts` offline: the Framework verifier compares 38 contracts' live runtime bytecode
 * against pinned hashes, and no fake RPC can serve that bytecode without a copy of the
 * chain. So this harness swaps exactly that step for one that still drives the real viem
 * client over HTTP — chain id and block number — and leaves everything else as shipped.
 *
 * It refuses a non-loopback RPC: a server that skips the audited-composition check must
 * never be pointed at a real chain, even by accident.
 */
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    loadDelegatedAgentRuntime,
    type FrameworkLiveVerification,
} from "@mapae/delegation";
import {isLoopbackHost} from "@mapae/shared";
import {createAgentServer} from "./server.js";

const rpc = process.env.GIWA_SEPOLIA_RPC_URL ?? "";
if (!URL.canParse(rpc) || !isLoopbackHost(new URL(rpc).hostname)) {
    console.error("node-bootstrap-harness: GIWA_SEPOLIA_RPC_URL must be a loopback URL");
    process.exit(2);
}

const server = createAgentServer(() =>
    loadDelegatedAgentRuntime({
        verifyDeployment: async ({publicClient, deployment}) => {
            const chainId = await publicClient.getChainId();
            if (chainId !== deployment.chainId) {
                throw new Error(`fake RPC reports chain ${chainId}`);
            }
            await publicClient.getBlockNumber({cacheTime: 0});
            return {} as FrameworkLiveVerification;
        },
    }),
);

console.error("mapae agent MCP bootstrap harness running on stdio");
await server.connect(new StdioServerTransport());
