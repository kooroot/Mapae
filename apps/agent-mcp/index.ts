import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    loadDelegatedAgentRuntime,
    payForDelegatedResource,
    resolveResourceTarget,
    type DelegatedAgentRuntime,
} from "@mapae/delegation";
import {GIWA_SEPOLIA_CAIP2, fromTokenAmount, redactForLog} from "@mapae/shared";
import {z} from "zod";

/**
 * The outermost of four stacked timeouts, and therefore the longest.
 *
 * Inward from here: the seller's HTTP idle timeout (45 s), its call to the facilitator
 * (35 s), and the facilitator's wait for a receipt (25 s). Each layer must out-wait the
 * one inside it, or the outer hop hangs up on a settlement that is still running and the
 * caller learns nothing about a payment that may already have been mined. That is not
 * hypothetical: with `Bun.serve`'s 10 s default sitting under a 60 s receipt wait, a GIWA
 * payment settled (`0x533c5cb2…9964c`) while the agent was told it had been rejected.
 *
 * 50 s also has to stay under a typical MCP client's 60 s call deadline — the client
 * giving up first would put the same ambiguity one level higher.
 */
const REQUEST_TIMEOUT_MS = 50_000;

/**
 * The runtime performs network I/O (facilitator /supported, RPC deployment
 * verification), so it is loaded lazily rather than at process start: a failure
 * during boot would kill the server before a client could see the cause, which is
 * exactly the "die silently" behaviour D5 exists to remove. Only a success is
 * cached, so fixing the environment and calling again recovers without a restart.
 */
let cachedRuntime: DelegatedAgentRuntime | undefined;
let inflight: Promise<DelegatedAgentRuntime> | undefined;

async function runtime(): Promise<DelegatedAgentRuntime> {
    if (cachedRuntime) return cachedRuntime;
    inflight ??= loadDelegatedAgentRuntime()
        .then((loaded) => {
            cachedRuntime = loaded;
            return loaded;
        })
        .finally(() => {
            inflight = undefined;
        });
    return inflight;
}

/**
 * Tool results leave this process. Redact before they do.
 *
 * `RUNTIME_UNAVAILABLE` is raised by the lazy bootstrap, which builds an RPC client — so
 * the most likely error here is a viem transport failure, and viem puts the endpoint URL
 * in its message. A private RPC endpoint carries its API key in the URL path, so the
 * unredacted form hands that key to whatever agent is driving this server. `redactForLog`
 * keeps the host and the revert reason, which is all the caller can act on anyway.
 */
function errorMessage(error: unknown): string {
    return redactForLog(error);
}

function textResult(payload: unknown, isError = false) {
    return {
        content: [{type: "text" as const, text: JSON.stringify(payload, null, 2)}],
        ...(isError ? {isError: true} : {}),
    };
}

const server = new McpServer({name: "mapae-agent", version: "0.1.0"});

server.registerTool(
    "mapae_pay_for_resource",
    {
        title: "Pay for a gated resource",
        description:
            "Fetch a resource from the Mapae seller. If it answers 402, sign a " +
            "payment-specific ERC-7710 leaf delegation within the on-chain spending " +
            "caveat and retry. Returns the resource on success, or a structured " +
            "reason on failure. Never broadcasts a transaction itself — the " +
            "facilitator settles and pays gas.",
        inputSchema: {
            resource: z
                .string()
                .min(1)
                .describe(
                    "Absolute path on the seller origin, e.g. /s/demo-cafe/americano",
                ),
        },
    },
    async ({resource}) => {
        let loaded: DelegatedAgentRuntime;
        try {
            loaded = await runtime();
        } catch (error) {
            return textResult(
                {ok: false, code: "RUNTIME_UNAVAILABLE", detail: errorMessage(error)},
                true,
            );
        }

        let target: URL;
        try {
            target = resolveResourceTarget(loaded.sellerUrl, resource);
        } catch (error) {
            return textResult(
                {ok: false, code: "INVALID_RESOURCE", detail: errorMessage(error)},
                true,
            );
        }

        const result = await payForDelegatedResource(target, {
            provider: loaded.provider,
            preflight: loaded.preflight,
            delegationManager: loaded.delegationManager,
            trustedFacilitators: loaded.trustedFacilitators,
            timeoutMs: REQUEST_TIMEOUT_MS,
        });
        if (!result.ok) {
            return textResult(
                {ok: false, code: result.code, status: result.status, detail: result.detail},
                true,
            );
        }
        return textResult({
            ok: true,
            resourceUrl: target.toString(),
            amount: `${fromTokenAmount(BigInt(result.amount))} mUSDC`,
            payTo: result.payTo,
            transaction: result.transaction,
            resource: result.resource,
        });
    },
);

server.registerTool(
    "mapae_status",
    {
        title: "Agent status",
        description:
            "Report the delegated agent's session key, seller and facilitator " +
            "endpoints, and whether the on-chain Framework deployment verified. " +
            "Never returns key material or the signed permission context.",
    },
    async () => {
        try {
            const loaded = await runtime();
            return textResult({
                ok: true,
                network: GIWA_SEPOLIA_CAIP2,
                sessionKey: loaded.account.address,
                seller: loaded.sellerUrl.toString(),
                facilitator: loaded.facilitatorUrl.toString(),
                delegationManager: loaded.delegationManager,
                trustedFacilitators: loaded.trustedFacilitators,
                frameworkVerified: true,
                limit: "enforced on-chain by the parent erc20PeriodTransfer caveat",
            });
        } catch (error) {
            return textResult(
                {ok: false, code: "RUNTIME_UNAVAILABLE", detail: errorMessage(error)},
                true,
            );
        }
    },
);

// stdout is the JSON-RPC channel; anything written there corrupts the stream.
console.error("mapae agent MCP server running on stdio");
await server.connect(new StdioServerTransport());
