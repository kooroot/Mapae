import {Hono, type Context} from "hono";
import {DelegationManager} from "@metamask/smart-accounts-kit/contracts";
import {
    PaymentIntentSingleFlight,
    buildDelegatedTransfer,
    parseActiveDeploymentArtifactJson,
    parseFrameworkDeploymentManifestJson,
    validateDelegatedPayment,
    verifyActiveFrameworkDeployment,
    verifyFrameworkOperationalState,
    throttledHttp,
    type FrameworkLiveVerification,
    type ValidatedDelegatedPayment,
} from "@mapae/delegation";
import {
    GIWA_SEPOLIA_CAIP2,
    X402_VERSION,
    giwaSepolia,
    toTokenAmount,
} from "@mapae/shared";
import {
    createPublicClient,
    createWalletClient,
    getAddress,
    isAddress,
    publicActions,
    zeroAddress,
    type Address,
    type Hex,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";

const MAX_BODY_CHARACTERS = 150_000;

function readPort(): number {
    const value = Number(process.env.PORT ?? 8081);
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
        throw new Error("PORT must be an integer between 1 and 65535");
    }
    return value;
}

function readHost(): string {
    const value = process.env.HOST?.trim() || "127.0.0.1";
    if (!["127.0.0.1", "localhost", "::1"].includes(value)) {
        throw new Error("HOST must be loopback; put a TLS reverse proxy in front for remote access");
    }
    return value;
}

function readRpcUrl(): string {
    const value = process.env.GIWA_SEPOLIA_RPC_URL?.trim() || giwaSepolia.rpcUrls.default.http[0];
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) {
        throw new Error("GIWA_SEPOLIA_RPC_URL must be HTTPS without embedded credentials");
    }
    return url.toString();
}

function readRelayerKey(): Hex {
    const value = process.env.RELAYER_PRIVATE_KEY?.trim() ?? "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error("RELAYER_PRIVATE_KEY must be a 32-byte hex private key");
    }
    return value as Hex;
}

function readRelayerAddress(): Address {
    const value = process.env.RELAYER_ADDRESS?.trim() ?? "";
    if (!isAddress(value)) throw new Error("RELAYER_ADDRESS must be an address");
    const address = getAddress(value);
    if (address === zeroAddress) throw new Error("RELAYER_ADDRESS must not be zero");
    return address;
}

function readPositiveInteger(name: string, fallback: number): bigint {
    const raw = process.env[name]?.trim() || String(fallback);
    if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
    return BigInt(raw);
}

async function readDeployment() {
    const path =
        process.env.DELEGATION_DEPLOYMENT_PATH ??
        "../../deployments/giwa-sepolia.framework.json";
    const file = Bun.file(path);
    if (!(await file.exists())) {
        throw new Error(`delegation deployment artifact not found: ${path}`);
    }
    return parseActiveDeploymentArtifactJson(await file.text());
}

async function readManifest() {
    const path =
        process.env.DELEGATION_MANIFEST_PATH ??
        "../../deployments/giwa-sepolia.framework-manifest.json";
    const file = Bun.file(path);
    if (!(await file.exists())) {
        throw new Error(`Framework composition manifest not found: ${path}`);
    }
    return parseFrameworkDeploymentManifestJson(await file.text());
}

function readFrameworkAdmin(): Address {
    const value = process.env.FRAMEWORK_ADMIN_ADDRESS?.trim() ?? "";
    if (!isAddress(value)) throw new Error("FRAMEWORK_ADMIN_ADDRESS must be an address");
    const address = getAddress(value);
    if (address === zeroAddress) throw new Error("FRAMEWORK_ADMIN_ADDRESS must not be zero");
    return address;
}

const HOST = readHost();
const PORT = readPort();
const RPC_URL = readRpcUrl();
const MAX_AMOUNT = toTokenAmount(process.env.MAX_SETTLEMENT_AMOUNT ?? "10.00");
const MAX_REDEMPTION_GAS = readPositiveInteger("MAX_REDEMPTION_GAS", 1_500_000);
const relayer = privateKeyToAccount(readRelayerKey());
const expectedRelayer = readRelayerAddress();
if (relayer.address !== expectedRelayer) {
    throw new Error(
        `RELAYER_PRIVATE_KEY resolves to ${relayer.address}, expected ${expectedRelayer}`,
    );
}
const deployment = await readDeployment();
const manifest = await readManifest();
const frameworkAdmin = readFrameworkAdmin();
const manager = getAddress(deployment.environment.DelegationManager);

const publicClient = createPublicClient({chain: giwaSepolia, transport: throttledHttp(RPC_URL)});
const facilitatorClient = createWalletClient({
    account: relayer,
    chain: giwaSepolia,
    transport: throttledHttp(RPC_URL),
}).extend(publicActions);

class FrameworkReadinessGate {
    #cachedUntil: number;
    #cached: FrameworkLiveVerification;
    #pending?: Promise<FrameworkLiveVerification>;

    constructor(initial: FrameworkLiveVerification) {
        this.#cached = initial;
        this.#cachedUntil = Date.now() + 5_000;
    }

    async verify(): Promise<FrameworkLiveVerification> {
        if (Date.now() < this.#cachedUntil) return this.#cached;
        this.#pending ??= verifyFrameworkOperationalState({
            publicClient,
            deployment,
            expectedFrameworkAdmin: frameworkAdmin,
        });
        try {
            const result = await this.#pending;
            this.#cached = result;
            this.#cachedUntil = Date.now() + 5_000;
            return result;
        } finally {
            this.#pending = undefined;
        }
    }
}

const startupVerification = await verifyActiveFrameworkDeployment({
    publicClient,
    deployment,
    manifest,
    expectedFrameworkAdmin: frameworkAdmin,
});
const readiness = new FrameworkReadinessGate(startupVerification);

interface VerifyResponse {
    isValid: boolean;
    payer?: Address;
    invalidReason?: string;
}

interface SettleResponse {
    success: boolean;
    transaction?: Hex;
    network: typeof GIWA_SEPOLIA_CAIP2;
    payer?: Address;
    errorReason?: string;
}

class SettlementCoordinator {
    readonly #singleFlight = new PaymentIntentSingleFlight<SettleResponse>();
    readonly #broadcastTransactions = new Map<Hex, Hex>();

    async simulate(payment: ValidatedDelegatedPayment): Promise<void> {
        const transfer = buildDelegatedTransfer(payment);
        const simulation = await DelegationManager.simulate.redeemDelegations({
            client: facilitatorClient,
            delegationManagerAddress: manager,
            delegations: [...transfer.delegations],
            modes: [...transfer.modes],
            executions: transfer.executions.map((batch) => [...batch]),
        });
        const gas = await facilitatorClient.estimateContractGas(simulation.request);
        if (gas > MAX_REDEMPTION_GAS) {
            throw new Error(`redemption gas ${gas} exceeds configured cap`);
        }
    }

    async settle(payment: ValidatedDelegatedPayment): Promise<SettleResponse> {
        return this.#singleFlight.run(payment.paymentIntentId, () =>
            this.#settleOnce(payment),
        );
    }

    async #settleOnce(payment: ValidatedDelegatedPayment): Promise<SettleResponse> {
        let hash = this.#broadcastTransactions.get(payment.paymentIntentId);
        if (!hash) {
            const transfer = buildDelegatedTransfer(payment);
            const simulation = await DelegationManager.simulate.redeemDelegations({
                client: facilitatorClient,
                delegationManagerAddress: manager,
                delegations: [...transfer.delegations],
                modes: [...transfer.modes],
                executions: transfer.executions.map((batch) => [...batch]),
            });
            const gas = await facilitatorClient.estimateContractGas(simulation.request);
            if (gas > MAX_REDEMPTION_GAS) {
                throw new Error(`redemption gas ${gas} exceeds configured cap`);
            }
            hash = await facilitatorClient.writeContract({...simulation.request, gas});
            // Save before waiting. A receipt timeout must never trigger a duplicate broadcast.
            this.#broadcastTransactions.set(payment.paymentIntentId, hash);
        }

        const receipt = await publicClient.waitForTransactionReceipt({
            hash,
            confirmations: 1,
            timeout: 60_000,
        });
        if (receipt.status !== "success") throw new Error("redemption transaction reverted");
        return {
            success: true,
            transaction: hash,
            network: GIWA_SEPOLIA_CAIP2,
            payer: payment.payer,
        };
    }
}

const coordinator = new SettlementCoordinator();
const app = new Hono();

app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
});

app.get("/health", async (c) => {
    let framework: FrameworkLiveVerification | undefined;
    try {
        framework = await readiness.verify();
    } catch {
        framework = undefined;
    }
    const relayerBalance = await publicClient.getBalance({address: relayer.address});
    return c.json({
        ok: Boolean(framework) && relayerBalance > 0n,
        network: GIWA_SEPOLIA_CAIP2,
        composition: deployment.compositionId,
        delegationManager: manager,
        frameworkOwner: framework?.owner ?? null,
        frameworkPaused: framework?.paused ?? null,
        facilitator: relayer.address,
        relayerFunded: relayerBalance > 0n,
    });
});

app.get("/supported", (c) =>
    c.json({
        kinds: [
            {
                x402Version: X402_VERSION,
                scheme: "exact",
                network: GIWA_SEPOLIA_CAIP2,
                extra: {assetTransferMethod: "erc7710"},
            },
        ],
        extensions: [],
        signers: {[GIWA_SEPOLIA_CAIP2]: [relayer.address]},
    }),
);

app.post("/verify", async (c) => {
    try {
        await readiness.verify();
        const payment = validateDelegatedPayment(await readJson(c), {
            delegationManager: manager,
            facilitator: relayer.address,
            maxAmount: MAX_AMOUNT,
        });
        await coordinator.simulate(payment);
        const response: VerifyResponse = {
            isValid: true,
            payer: payment.payer,
        };
        return c.json(response);
    } catch (error) {
        logSafeFailure("verify", error);
        const response: VerifyResponse = {isValid: false, invalidReason: "delegation_rejected"};
        return c.json(response);
    }
});

app.post("/settle", async (c) => {
    try {
        await readiness.verify();
        const payment = validateDelegatedPayment(await readJson(c), {
            delegationManager: manager,
            facilitator: relayer.address,
            maxAmount: MAX_AMOUNT,
        });
        const response = await coordinator.settle(payment);
        console.log(
            `[settled] paymentIntentId=${payment.paymentIntentId} tx=${response.transaction}`,
        );
        return c.json(response);
    } catch (error) {
        logSafeFailure("settle", error);
        const response: SettleResponse = {
            success: false,
            network: GIWA_SEPOLIA_CAIP2,
            errorReason: "delegation_rejected",
        };
        return c.json(response);
    }
});

async function readJson(c: Context): Promise<unknown> {
    const contentType = c.req.header("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/json")) throw new Error("content-type must be JSON");
    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_CHARACTERS) {
        throw new Error("request body is too large");
    }
    const text = await c.req.text();
    if (text.length === 0 || text.length > MAX_BODY_CHARACTERS) {
        throw new Error("request body is empty or too large");
    }
    return JSON.parse(text) as unknown;
}

function logSafeFailure(path: string, error: unknown): void {
    // Never log permissionContext: it contains bearer-like signed delegations.
    const name = error instanceof Error ? error.name : "UnknownError";
    console.error(`[${path}] ${name}: request rejected`);
}

if (!isAddress(manager)) throw new Error("invalid DelegationManager");
console.log(`ERC-7710 facilitator listening on ${HOST}:${PORT}`);
console.log(`  network ${GIWA_SEPOLIA_CAIP2}`);
console.log(`  manager ${manager}`);
console.log(`  signer  ${relayer.address}`);

export default {hostname: HOST, port: PORT, fetch: app.fetch};
