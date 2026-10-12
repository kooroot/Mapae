import {Hono, type Context} from "hono";
import {
    assertFundedKeySeparation,
    ownerPayerAccount,
    parseActiveDeploymentArtifactJson,
    throttledHttp,
} from "@mapae/delegation";
import {parseFaucetMissionList} from "@mapae/delegation/faucet-policy";
import {GIWA_SEPOLIA_CAIP2, MOCK_USDC, giwaSepolia, parseNodeRpcUrl, redactForLog} from "@mapae/shared";
import {openFaucetStore} from "@mapae/store/faucet";
import {
    BaseError,
    InvalidInputRpcError,
    TransactionReceiptNotFoundError,
    TransactionRejectedRpcError,
    WaitForTransactionReceiptTimeoutError,
    createPublicClient,
    getAddress,
    http,
    isAddress,
    parseAbi,
    zeroAddress,
    type Address,
    type Hex,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {mainnet} from "viem/chains";
import {
    bearerMatches,
    createFaucet,
    parseClaimRequest,
    type BroadcastResult,
    type FaucetChain,
    type ReceiptStatus,
} from "./claims";

/**
 * The faucet service: the one process that holds the faucet key.
 *
 * It answers only the faucet Worker. The Worker proves wallet ownership (SIWE on
 * faucet.mapae.io), runs Turnstile and derives the network keys; this service trusts
 * nothing a browser could send, because no browser can reach it — every route but a
 * loopback `/health` wants the Worker's bearer, and any request carrying `Origin` is
 * refused outright. It binds loopback; the tunnel's `^/faucet` path rule on
 * facilitator.mapae.io is the only public path, as for the bootstrap sponsor.
 */

const BALANCE_ABI = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);
const MAX_BODY_BYTES = 4_096;
const RECONCILE_INTERVAL_MS = 15_000;
const DEFAULT_MAINNET_RPC = "https://ethereum-rpc.publicnode.com";

function readPort(): number {
    const value = Number(process.env.PORT ?? 8084);
    if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error("PORT must be an integer between 1 and 65535");
    return value;
}

function readHost(): string {
    const value = process.env.HOST?.trim() || "127.0.0.1";
    // Literal list: `0.0.0.0` is the one value a bind must refuse.
    if (!["127.0.0.1", "localhost", "::1"].includes(value)) {
        throw new Error("HOST must be loopback; the Cloudflare Tunnel is the only public path");
    }
    return value;
}

/** `"true"`, `"false"` or nothing (off). Any other spelling refuses boot rather than guessing. */
function readSwitch(name: string): boolean {
    const raw = process.env[name]?.trim().toLowerCase() ?? "";
    if (raw === "" || raw === "false") return false;
    if (raw === "true") return true;
    throw new Error(`${name} must be "true" or "false"`);
}

function readPositiveInteger(name: string, fallback: bigint): bigint {
    const raw = process.env[name]?.trim() || String(fallback);
    if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
    return BigInt(raw);
}

function readOptionalAddress(name: string): Address | undefined {
    const value = process.env[name]?.trim();
    if (!value) return undefined;
    if (!isAddress(value)) throw new Error(`${name} must be an address`);
    return getAddress(value);
}

function readKey(): Hex {
    const value = process.env.FAUCET_PRIVATE_KEY?.trim() ?? "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("FAUCET_PRIVATE_KEY must be a 32-byte hex private key");
    return value as Hex;
}

const HOST = readHost();
const PORT = readPort();
const ENABLED = readSwitch("FAUCET_ENABLED");
const TOKEN = process.env.FAUCET_SERVICE_TOKEN?.trim() ?? "";
if (TOKEN.length < 32) throw new Error("FAUCET_SERVICE_TOKEN must be at least 32 characters; the Worker sends the same value");
const RPC_URL = parseNodeRpcUrl(process.env.GIWA_SEPOLIA_RPC_URL?.trim() || giwaSepolia.rpcUrls.default.http[0]);
const MAINNET_RPC_URL = parseNodeRpcUrl(process.env.ETH_MAINNET_RPC_URL?.trim() || DEFAULT_MAINNET_RPC);
const ETH_MISSIONS = parseFaucetMissionList(process.env.FAUCET_ETH_MISSIONS);
const ETH_DAILY_WEI = readPositiveInteger("FAUCET_ETH_DAILY_WEI", 500_000_000_000_000_000n);
const MIN_BALANCE_WEI = readPositiveInteger("FAUCET_MIN_BALANCE_WEI", 20_000_000_000_000_000n);
const STORE_PATH = process.env.STORE_PATH?.trim() || "./data/faucet.sqlite";
if (ENABLED && STORE_PATH === ":memory:") throw new Error("an enabled faucet requires a persistent STORE_PATH; a restart must not reset every window");

const account = privateKeyToAccount(readKey());
const expected = readOptionalAddress("FAUCET_ADDRESS");
if (expected === undefined || expected === zeroAddress) throw new Error("FAUCET_ADDRESS must be the faucet wallet's address");
if (account.address !== expected) throw new Error(`FAUCET_PRIVATE_KEY resolves to ${account.address}, expected ${expected}`);

// Its own nonce space: a key shared with the sponsor, the facilitator, the deployer or
// the revocation sponsor would race their broadcasts and merge their balances.
assertFundedKeySeparation({
    FAUCET_ADDRESS: account.address,
    BOOTSTRAP_ADDRESS: readOptionalAddress("BOOTSTRAP_ADDRESS"),
    FACILITATOR_SIGNER_ADDRESS: readOptionalAddress("FACILITATOR_SIGNER_ADDRESS"),
    DEPLOYER_ADDRESS: readOptionalAddress("DEPLOYER_ADDRESS"),
    REVOCATION_SPONSOR_ADDRESS: readOptionalAddress("REVOCATION_SPONSOR_ADDRESS"),
});

const deploymentPath = process.env.DELEGATION_DEPLOYMENT_PATH ?? "../../deployments/giwa-sepolia.framework.json";
const deploymentFile = Bun.file(deploymentPath);
if (!(await deploymentFile.exists())) throw new Error(`delegation deployment artifact not found: ${deploymentPath}`);
const deployment = parseActiveDeploymentArtifactJson(await deploymentFile.text());
// Testnet only: the stablecoin's mint is permissionless here and nowhere else.
if (deployment.chainId !== giwaSepolia.id) throw new Error("the faucet runs on GIWA Sepolia only");

const giwa = createPublicClient({chain: giwaSepolia, transport: throttledHttp(RPC_URL)});
const ethereum = createPublicClient({chain: mainnet, transport: http(MAINNET_RPC_URL, {timeout: 5_000, retryCount: 1})});

/**
 * A node that answers the broadcast with a JSON-RPC error did not take it; one that
 * already holds it took it. Anything else — a timeout, a 5xx, a rate limit — is ambiguous
 * and throws, so the claim stays `signed` and the reconciler decides.
 */
async function sendRaw(raw: Hex): Promise<BroadcastResult> {
    try {
        await giwa.sendRawTransaction({serializedTransaction: raw});
        return "accepted";
    } catch (error) {
        if (error instanceof BaseError && /already known|known transaction|already imported/i.test(error.message)) return "accepted";
        const refused = error instanceof BaseError && error.walk((e) => e instanceof InvalidInputRpcError || e instanceof TransactionRejectedRpcError);
        if (refused) {
            console.warn(`[faucet] node refused a broadcast — ${redactForLog(error)}`);
            return "rejected";
        }
        throw error;
    }
}

const chain: FaucetChain = {
    balance: (address) => giwa.getBalance({address}),
    tokenBalance: (address) => giwa.readContract({address: MOCK_USDC.address, abi: BALANCE_ABI, functionName: "balanceOf", args: [address]}),
    code: (address) => giwa.getCode({address}),
    baseFee: async () => (await giwa.getBlock({blockTag: "latest"})).baseFeePerGas ?? null,
    nonce: (address, blockTag) => giwa.getTransactionCount({address, blockTag}),
    sendRaw,
    async receipt(hash): Promise<ReceiptStatus | null> {
        try {
            return (await giwa.getTransactionReceipt({hash})).status;
        } catch (error) {
            if (error instanceof TransactionReceiptNotFoundError) return null;
            throw error;
        }
    },
    async waitForReceipt(hash, timeout): Promise<ReceiptStatus | null> {
        try {
            return (await giwa.waitForTransactionReceipt({hash, confirmations: 1, timeout})).status;
        } catch (error) {
            if (error instanceof WaitForTransactionReceiptTimeoutError) return null;
            throw error;
        }
    },
    mainnetNonce: (owner) => ethereum.getTransactionCount({address: owner, blockTag: "latest"}),
    payer: async (owner) => (await ownerPayerAccount(deployment.environment, owner)).address,
};

const store = openFaucetStore(STORE_PATH);
const faucet = createFaucet({
    store,
    chain,
    signer: {
        address: account.address,
        sign: (tx) => account.signTransaction({...tx, chainId: giwaSepolia.id, type: "eip1559"}),
    },
    config: {enabled: ENABLED, ethMissions: ETH_MISSIONS, ethDailyWei: ETH_DAILY_WEI, minBalanceWei: MIN_BALANCE_WEI},
});

let reconciling = false;
async function reconcile(): Promise<void> {
    if (reconciling) return;
    reconciling = true;
    try {
        await faucet.reconcile();
    } catch (error) {
        console.error(`[faucet] reconcile failed — ${redactForLog(error)}`);
    } finally {
        reconciling = false;
    }
}
await reconcile();
setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS);

const app = new Hono();

app.use("*", async (c, next) => {
    // No browser has any business here. A request with `Origin` is one, or pretends to be.
    if (c.req.header("origin") !== undefined) return c.json({reason: "unavailable"}, 403);
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
});

/**
 * Loopback only, and not in the tunnel's path rule: it names the wallet and its balance,
 * a targeting oracle for anyone deciding whether a drain is worth starting. A request
 * that crossed the tunnel carries `CF-Connecting-IP`.
 */
app.get("/health", async (c) => {
    if (c.req.header("cf-connecting-ip") !== undefined) return c.body(null, 404);
    let balance: string | null = null;
    try {
        balance = String(await chain.balance(account.address));
    } catch {
        // Reported as null; the operator reads the log line from the failed read elsewhere.
    }
    return c.json({
        ok: ENABLED,
        enabled: ENABLED,
        network: GIWA_SEPOLIA_CAIP2,
        faucet: account.address,
        balanceWei: balance,
        ethMissions: ETH_MISSIONS,
        unsettled: store.unsettled().length,
    });
});

app.use("/faucet/*", async (c, next) => {
    if (!(await bearerMatches(c.req.header("authorization"), TOKEN))) return c.json({reason: "unavailable"}, 401);
    await next();
});

app.get("/faucet/status", async (c) => c.json(await faucet.status()));

app.get("/faucet/claims/:owner", async (c) => {
    const owner = c.req.param("owner");
    if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) return c.json({reason: "malformed_request"}, 400);
    return c.json(await faucet.account(getAddress(owner)));
});

app.post("/faucet/claims", async (c) => {
    const request = parseClaimRequest(await readJson(c));
    if (!request) return c.json({reason: "malformed_request"}, 400);
    const outcome = await faucet.claim(request);
    if (outcome.ok) return c.json(outcome.view);
    return c.json(outcome.nextAt === undefined ? {reason: outcome.refusal} : {reason: outcome.refusal, nextAt: outcome.nextAt}, outcome.status);
});

app.onError((error, c) => {
    console.error(`[faucet] request failed — ${redactForLog(error)}`);
    return c.json({reason: "unavailable"}, 503);
});

async function readJson(c: Context): Promise<unknown> {
    if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) return undefined;
    const text = await c.req.text();
    if (text.length === 0 || text.length > MAX_BODY_BYTES) return undefined;
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
}

console.log(`faucet listening on ${HOST}:${PORT}`);
console.log(`  network   ${GIWA_SEPOLIA_CAIP2}`);
console.log(`  enabled   ${ENABLED}`);
console.log(`  faucet    ${account.address}`);
console.log(`  eth tab   ${ENABLED && ETH_MISSIONS.length > 0 ? `on (missions ${ETH_MISSIONS.join(",")})` : "off"}`);
console.log(`  eth/day   ${ETH_DAILY_WEI} wei, floor ${MIN_BALANCE_WEI} wei`);
console.log(`  store     ${STORE_PATH}`);

// `satisfies` because Bun ignores an option it does not know. The idle timeout outlasts
// the 30 s receipt wait so the Worker never sees a dropped connection for a claim that landed.
export default {
    hostname: HOST,
    port: PORT,
    idleTimeout: 60,
    maxRequestBodySize: MAX_BODY_BYTES * 4,
    fetch: app.fetch,
} satisfies Bun.Serve.Options<undefined>;
