import {createPublicClient, getAddress, isAddress, zeroAddress} from "viem";
import type {Account, Address, Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {GIWA_SEPOLIA_CAIP2, giwaSepolia, parseNodeRpcUrl} from "@mapae/shared";
import {isPermissionContext, parseActiveDeploymentArtifactJson} from "./config.js";
import {parseFrameworkDeploymentManifestJson} from "./deployment-record.js";
import {verifyActiveFrameworkDeployment} from "./live-verifier.js";
import {decodeDelegations} from "@metamask/smart-accounts-kit/utils";
import {readDelegationStatus} from "./delegation-status.js";
import type {DelegationStatus} from "./delegation-status.js";
import type {DelegatedLeafProvider, PreflightVerdict} from "./payment-client.js";
import {throttledHttp} from "./rpc.js";
import {createMapaeDelegationProvider} from "./x402.js";

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Everything an autonomous delegated-payment agent needs, loaded once. Shared by
 * the CLI agent and the D5 MCP server so the env/file/verify glue exists in exactly
 * one place — two copies of it would drift the same way two copies of the domain do.
 */
export interface DelegatedAgentRuntime {
    account: Account;
    provider: DelegatedLeafProvider;
    /** Reads the enforcer's remaining period balance before a payment is attempted. */
    preflight: (amount: bigint) => Promise<PreflightVerdict>;
    delegationManager: Address;
    trustedFacilitators: Address[];
    sellerUrl: URL;
    facilitatorUrl: URL;
    frameworkAdmin: Address;
    rpcUrl: string;
}

export interface LoadDelegatedAgentRuntimeOptions {
    /** Defaults to process.env. */
    env?: Record<string, string | undefined>;
    /** Reads a file's UTF-8 text; defaults to Bun.file. Injectable for tests. */
    readTextFile?: (path: string) => Promise<string>;
    /** Defaults to the global fetch (used only for the facilitator /supported call). */
    fetchImpl?: typeof fetch;
}

function readHttpUrl(
    env: Record<string, string | undefined>,
    name: string,
    fallback: string,
): URL {
    const value = env[name]?.trim() || fallback;
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error(`${name} must be an absolute HTTP(S) URL without credentials`);
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !loopback) {
        throw new Error(`${name} must use HTTPS unless it is loopback`);
    }
    return url;
}

function readRpcUrl(env: Record<string, string | undefined>): string {
    return parseNodeRpcUrl(
        env.GIWA_SEPOLIA_RPC_URL?.trim() || giwaSepolia.rpcUrls.default.http[0],
    );
}

function readAddress(env: Record<string, string | undefined>, name: string): Address {
    const value = env[name]?.trim() ?? "";
    if (!isAddress(value)) throw new Error(`${name} must be an address`);
    const address = getAddress(value);
    if (address === zeroAddress) throw new Error(`${name} must not be zero`);
    return address;
}

function readAgentKey(env: Record<string, string | undefined>): Hex {
    const value = env.AGENT_PRIVATE_KEY?.trim() ?? "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error("AGENT_PRIVATE_KEY must be a 32-byte session key");
    }
    return value as Hex;
}

async function readText(
    readTextFile: (path: string) => Promise<string>,
    path: string,
    label: string,
): Promise<string> {
    try {
        return await readTextFile(path);
    } catch {
        throw new Error(`${label} not found or unreadable: ${path}`);
    }
}

async function readTrustedFacilitators(
    facilitatorUrl: URL,
    fetchImpl: typeof fetch,
): Promise<Address[]> {
    const response = await fetchImpl(new URL("/supported", facilitatorUrl), {
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`facilitator /supported returned ${response.status}`);
    const body = (await response.json()) as {signers?: Record<string, unknown>};
    const values = body.signers?.[GIWA_SEPOLIA_CAIP2];
    if (!Array.isArray(values) || values.length === 0) {
        throw new Error("facilitator advertised no GIWA signer");
    }
    return values.map((value) => {
        if (typeof value !== "string" || !isAddress(value)) {
            throw new Error("facilitator advertised an invalid signer");
        }
        return getAddress(value);
    });
}

/**
 * Load env + on-chain deployment, verify the Framework is the exact audited
 * composition, and build the payment-specific leaf provider. Read-only against the
 * chain (never broadcasts). Throws on any misconfiguration so a caller never starts
 * with a half-built runtime.
 */
export async function loadDelegatedAgentRuntime(
    options: LoadDelegatedAgentRuntimeOptions = {},
): Promise<DelegatedAgentRuntime> {
    const env = options.env ?? (process.env as Record<string, string | undefined>);
    const readTextFile = options.readTextFile ?? ((path: string) => Bun.file(path).text());
    const fetchImpl = options.fetchImpl ?? fetch;

    const account = privateKeyToAccount(readAgentKey(env));
    const sellerUrl = readHttpUrl(env, "SELLER_URL", "http://127.0.0.1:3001");
    const facilitatorUrl = readHttpUrl(env, "FACILITATOR_URL", "http://127.0.0.1:8081");
    const rpcUrl = readRpcUrl(env);
    const frameworkAdmin = readAddress(env, "FRAMEWORK_ADMIN_ADDRESS");

    const deploymentPath =
        env.DELEGATION_DEPLOYMENT_PATH ?? "../../deployments/giwa-sepolia.framework.json";
    const manifestPath =
        env.DELEGATION_MANIFEST_PATH ??
        "../../deployments/giwa-sepolia.framework-manifest.json";
    const parentPath = env.PARENT_PERMISSION_CONTEXT_PATH ?? "./open-agent.permission.json";

    const [deployment, manifest, parentText, trustedFacilitators] = await Promise.all([
        readText(readTextFile, deploymentPath, "deployment artifact").then(
            parseActiveDeploymentArtifactJson,
        ),
        readText(readTextFile, manifestPath, "Framework manifest").then(
            parseFrameworkDeploymentManifestJson,
        ),
        readText(readTextFile, parentPath, "parent permission file"),
        readTrustedFacilitators(facilitatorUrl, fetchImpl),
    ]);

    const parent = JSON.parse(parentText) as {permissionContext?: unknown};
    if (!isPermissionContext(parent.permissionContext)) {
        throw new Error("parent permissionContext is missing, malformed, or too large");
    }

    const publicClient = createPublicClient({
        chain: giwaSepolia,
        transport: throttledHttp(rpcUrl),
    });
    await verifyActiveFrameworkDeployment({
        publicClient,
        deployment,
        manifest,
        expectedFrameworkAdmin: frameworkAdmin,
    });

    const provider = createMapaeDelegationProvider({
        account,
        environment: deployment.environment,
        parentPermissionContext: parent.permissionContext,
        facilitatorAddresses: trustedFacilitators,
    });

    // The caps live on the permissions the owner and any intermediate manager
    // signed, not on the leaf the agent mints per payment. Every link carries its
    // own caveats and the DelegationManager enforces all of them, so pre-flight
    // reads the whole chain: checking only the root would clear a payment that a
    // re-delegated child's tighter cap refuses on-chain.
    const chain = decodeDelegations(parent.permissionContext);
    // `isPermissionContext` above checks shape and length, not content, so a well-formed
    // encoding of an empty `Delegation[]` reaches here. An agent whose permission holds no
    // links has nothing to spend under; failing at bootstrap says so once rather than
    // once per payment. `judgePreflight` guards the same state for callers that build
    // their own status list.
    if (chain.length === 0) {
        throw new Error("parent permissionContext decodes to no delegations");
    }

    const preflight = async (amount: bigint): Promise<PreflightVerdict> =>
        judgePreflight(
            await Promise.all(
                chain.map((delegation) =>
                    readDelegationStatus({
                        publicClient,
                        environment: deployment.environment,
                        delegation,
                    }),
                ),
            ),
            amount,
        );

    return {
        account,
        provider,
        preflight,
        delegationManager: getAddress(deployment.environment.DelegationManager),
        trustedFacilitators,
        sellerUrl,
        facilitatorUrl,
        frameworkAdmin,
        rpcUrl,
    };
}

/**
 * Resolve a caller-supplied resource path against the seller origin, rejecting
 * anything that could escape it (protocol-relative, backslash, cross-origin).
 */
/**
 * Decide whether a payment may be signed, given every link's on-chain status.
 *
 * Split from the chain reads on purpose, the same way `revoke-state.ts` splits the
 * console's revoke gate from its component: this is the decision that stands between an
 * agent and a signature, and a decision reachable only through a bootstrap that wants
 * env vars, files and an RPC is a decision nobody tests.
 *
 * Two orderings here are deliberate rather than incidental.
 *
 * **Inactive before over-cap.** A revoked or expired permission is refused even when the
 * amount fits. Reporting `LIMIT_EXCEEDED` for a permission that is not usable at any
 * amount would send the operator to raise a cap that was never the problem.
 *
 * **Tightest link, not the root.** Every link's caveats are enforced by the
 * DelegationManager, so a re-delegated child's smaller cap binds even when the root has
 * room. Checking only the root would clear a payment the chain then refuses — the agent
 * would sign, the settlement would revert, and the failure would surface as a facilitator
 * error rather than as the limit doing its job.
 */
export function judgePreflight(statuses: DelegationStatus[], amount: bigint): PreflightVerdict {
    // An empty chain must not read as "no limits apply".
    //
    // Everything below is a loop, so with no statuses each one falls through and the
    // function clears the payment — measured at 999 mUSDC against a chain it had read
    // nothing from. That state is reachable: `isPermissionContext` is a shape-and-length
    // guard on hex, and a well-formed ABI encoding of an empty `Delegation[]` is 130
    // characters that passes it and decodes to `[]`.
    //
    // The settlement would still be refused on-chain, so this was never a route to funds.
    // What it defeated is the reason this function exists — reporting a cause from the
    // chain's own accounting instead of walking into the seller and relaying a status
    // code. "We read nothing" is not "we read no limits".
    if (statuses.length === 0) {
        return {
            ok: false,
            code: "PERMISSION_EMPTY",
            detail: "permission context decodes to no delegations — nothing to spend under",
        };
    }
    for (const status of statuses) {
        if (status.revoked) {
            return {ok: false, code: "PERMISSION_INACTIVE", detail: "permission was revoked"};
        }
        if (status.expired) {
            return {ok: false, code: "PERMISSION_INACTIVE", detail: "permission has expired"};
        }
        if (status.notYetActive) {
            return {ok: false, code: "PERMISSION_INACTIVE", detail: "permission is not active yet"};
        }
    }

    let tightest: bigint | undefined;
    for (const status of statuses) {
        if (status.remaining === undefined) continue;
        if (tightest === undefined || status.remaining < tightest) tightest = status.remaining;
    }
    if (tightest !== undefined && amount > tightest) {
        return {
            ok: false,
            code: "LIMIT_EXCEEDED",
            detail: `payment of ${amount} exceeds ${tightest} left in this period`,
        };
    }
    return {ok: true};
}

export function resolveResourceTarget(sellerUrl: URL, resourcePath: string): URL {
    if (
        !resourcePath.startsWith("/") ||
        resourcePath.startsWith("//") ||
        resourcePath.includes("\\")
    ) {
        throw new Error("resource must be an absolute path on the seller origin");
    }
    const target = new URL(resourcePath, sellerUrl);
    if (target.origin !== sellerUrl.origin) {
        throw new Error("resource escaped the seller origin");
    }
    return target;
}
