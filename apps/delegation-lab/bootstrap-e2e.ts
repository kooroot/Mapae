/**
 * Boot `apps/account-bootstrap` for real and drive sponsored onboarding through it.
 *
 * The unit tests cover `validateAccountBootstrap`, `SpendBudget` and the faucet policy
 * (`planTopUp`, `FaucetGate`) as pure functions. None of that starts the service, and none
 * of it proves the claim the whole design rests on: that a root signed *before* the payer
 * account exists is still the signature the deployed account accepts. That claim is only
 * settled by deploying the account from the signature and then verifying ERC-1271 against
 * the real bytecode, which is what case H does.
 *
 * Everything happens on a local Anvil fork of GIWA against the real Framework bytecode.
 * The sponsor key, the owner key and the agent address are throwaway and derived here; no
 * production key is read and the real payer account is never touched.
 *
 * ── SAFETY ────────────────────────────────────────────────────────────────────────────
 * `apps/account-bootstrap/.env` points GIWA_SEPOLIA_RPC_URL at real GIWA. If the override
 * were dropped the child would deploy accounts on the live chain with the operator's own
 * money. So the child's RPC is asserted loopback before anything is spawned, and the
 * sponsor's real GIWA nonce is read before and after to prove nothing was broadcast.
 */
import {
    FAUCET_TARGET_BASE,
    FRAMEWORK_COMPOSITION_ID,
    OWNER_ACCOUNT_SALT,
    buildD3Policies,
    buildRootDelegationTypedData,
    buildSponsoredBootstrapApproval,
    parseActiveDeploymentArtifactJson,
    preparePeriodDelegation,
    readAccountOwner,
    withDelegationSignature,
} from "@mapae/delegation";
import {assertRpcTarget, giwaSepolia, parseNodeRpcUrl, redactForLog} from "@mapae/shared";
import {Implementation} from "@metamask/smart-accounts-kit";
import {
    encodeDelegations,
    getCounterfactualAccountData,
} from "@metamask/smart-accounts-kit/utils";
import {
    concatHex,
    createPublicClient,
    defineChain,
    encodeFunctionData,
    getAddress,
    hashTypedData,
    http,
    keccak256,
    numberToHex,
    parseAbi,
    stringToHex,
    type Address,
    type Hex,
    type PublicClient,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {startForkSourceProxy} from "./fork-source-proxy";

const ANVIL_PORT = 8548;
const BOOTSTRAP_PORT = 8184;
const FORK_RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const BOOTSTRAP_URL = `http://127.0.0.1:${BOOTSTRAP_PORT}`;
const REPO = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const FORK_BLOCK = 31_606_000;
const MOCK_USDC = getAddress("0xcfeb694719A09caeb80798e2011298F29CDa4e92");

const ERC1271_ABI = parseAbi([
    "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);
const ERC20_ABI = parseAbi([
    "function balanceOf(address account) view returns (uint256)",
    "function transfer(address to, uint256 value) returns (bool)",
]);

/**
 * Derived, high-entropy, throwaway. The well-known Anvil dev keys are unusable against a
 * GIWA fork: several carry an EIP-7702 designator on the real chain, which the fork
 * inherits, and a designator on a *funded* account is a sweeper that empties it.
 */
const signerKey = (label: string) =>
    keccak256(stringToHex(`mapae.bootstrap-e2e.v1.${label}`)) as Hex;

const children: {name: string; proc: Bun.Subprocess}[] = [];
const listeners: {stop(): void}[] = [];
const cases: string[] = [];

function passed(letter: string, detail: string): void {
    cases.push(letter);
    console.log(`[e2e] ${letter} ${detail} ✅`);
}

function shutdown(): void {
    for (const {proc} of children) {
        try {
            proc.kill();
        } catch {
            /* already gone */
        }
    }
    for (const listener of listeners) {
        try {
            listener.stop();
        } catch {
            /* already closed */
        }
    }
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        shutdown();
        process.exit(130);
    });
}

const assertLoopback = (value: string): string =>
    assertRpcTarget(value, "loopback", "this would deploy accounts on GIWA with real money");

function assertPortFree(name: string, port: number): void {
    try {
        Bun.serve({port, hostname: "127.0.0.1", fetch: () => new Response("")}).stop(true);
    } catch {
        throw new Error(`port ${port} is in use, so this run's ${name} cannot start`);
    }
}

async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
    const response = await fetch(url, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}),
        signal: AbortSignal.timeout(20_000),
    });
    const body = (await response.json()) as {result?: unknown; error?: {message?: string}};
    if (body.error) throw new Error(`${method}: ${body.error.message ?? "rpc error"}`);
    return body.result;
}

async function waitFor(label: string, probe: () => Promise<boolean>, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = "";
    while (Date.now() < deadline) {
        try {
            if (await probe()) return;
        } catch (error) {
            lastError = redactForLog(error);
        }
        await Bun.sleep(500);
    }
    throw new Error(`${label} did not become ready${lastError ? ` (${lastError})` : ""}`);
}

interface BootstrapBody {
    status?: string;
    account?: string;
    transaction?: string;
    fundingTransaction?: string;
    mintedBase?: string;
    targetBase?: string;
    reason?: string;
}

async function postBootstrap(
    body: unknown,
): Promise<{status: number; body: BootstrapBody; raw: string}> {
    const response = await fetch(`${BOOTSTRAP_URL}/bootstrap`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
    });
    const raw = await response.text();
    return {status: response.status, body: JSON.parse(raw) as BootstrapBody, raw};
}

/**
 * Every refusal shape this service is allowed to emit.
 *
 * Asserted as a closed set rather than "the request failed", because the failure mode this
 * guards against is a body that carries `error.message` — which on a viem error contains
 * the transport URL, and a private GIWA endpoint carries its API key in that URL's path.
 * `bun run check:logging` covers `console.*` only, so a response body is a sink no gate
 * inspects.
 */
const ALLOWED_REASONS = new Set([
    "bootstrap_disabled",
    "malformed_request",
    "faucet_recently_used",
    "budget_exhausted",
    "sponsor_unfunded",
    "fee_too_high",
    "gas_estimate_rejected",
    "bootstrap_unavailable",
    "origin_refused",
]);

function assertEnumOnly(label: string, raw: string, body: BootstrapBody): void {
    if (body.reason !== undefined && !ALLOWED_REASONS.has(body.reason)) {
        throw new Error(`${label}: unknown refusal reason "${body.reason}"`);
    }
    // No hex beyond an address, no URL, no stack. A permission context or a transport URL
    // reaching a public body is the whole point of this assertion.
    const longHex = /0x[0-9a-fA-F]{41,}/.exec(raw);
    if (longHex) throw new Error(`${label}: body leaked a long hex value ${longHex[0].slice(0, 20)}…`);
    if (/https?:\/\//.test(raw)) throw new Error(`${label}: body leaked a URL`);
    if (/\bat\s|Error:/.test(raw)) throw new Error(`${label}: body leaked an error message`);
}

async function main(): Promise<void> {
    const forkRpc = assertLoopback(FORK_RPC);
    const upstream = parseNodeRpcUrl(
        process.env["GIWA_FORK_SOURCE_RPC_URL"]?.trim() || giwaSepolia.rpcUrls.default.http[0],
    );
    console.log("[e2e] no-broadcast guard: sponsor pinned to", forkRpc);
    assertPortFree("anvil", ANVIL_PORT);
    assertPortFree("bootstrap", BOOTSTRAP_PORT);

    const sponsorKey = signerKey("sponsor");
    const sponsor = privateKeyToAccount(sponsorKey);
    const nonceBefore = BigInt(
        (await rpc(upstream, "eth_getTransactionCount", [sponsor.address, "latest"])) as string,
    );
    console.log(`[e2e] sponsor GIWA nonce before  ${nonceBefore}`);

    const source = startForkSourceProxy(upstream);
    listeners.push(source);
    const anvil = Bun.spawn(
        [
            "anvil",
            "--port",
            String(ANVIL_PORT),
            "--silent",
            "--fork-url",
            source.url,
            "--fork-block-number",
            process.env["SUITE_FORK_BLOCK"]?.trim() || String(FORK_BLOCK),
            "--compute-units-per-second",
            process.env["SUITE_CUPS"]?.trim() || "50",
            "--retries",
            "30",
            "--fork-retry-backoff",
            "4",
        ],
        {stdout: "ignore", stderr: "pipe"},
    );
    children.push({name: "anvil", proc: anvil});
    await waitFor("anvil", async () => {
        const id = (await rpc(forkRpc, "eth_chainId")) as string;
        return Number(BigInt(id)) === giwaSepolia.id;
    });
    console.log(`[e2e] fork ready, chainId ${giwaSepolia.id} (real Framework bytecode)`);

    const chain = defineChain({
        id: giwaSepolia.id,
        name: "giwa-fork",
        nativeCurrency: giwaSepolia.nativeCurrency,
        rpcUrls: {default: {http: [forkRpc]}},
    });
    const publicClient = createPublicClient({chain, transport: http(forkRpc)}) as PublicClient;
    const deployment = parseActiveDeploymentArtifactJson(
        await Bun.file(`${REPO}/deployments/giwa-sepolia.framework.json`).text(),
    );

    await rpc(forkRpc, "anvil_setBalance", [sponsor.address, "0xde0b6b3a7640000"]);
    if ((await publicClient.getCode({address: sponsor.address})) !== undefined) {
        throw new Error(`sponsor ${sponsor.address} carries code — pick a different derived key`);
    }

    // ── the owner signs BEFORE any account exists ─────────────────────────────────────
    const owner = privateKeyToAccount(signerKey("owner"));
    const agent = privateKeyToAccount(signerKey("agent"));
    const derived = await getCounterfactualAccountData({
        factory: getAddress(deployment.environment.SimpleFactory),
        implementations: deployment.environment.implementations,
        implementation: Implementation.Hybrid,
        deployParams: [owner.address, [], [], []],
        deploySalt: OWNER_ACCOUNT_SALT,
    });
    const account = getAddress(derived.address);
    if ((await publicClient.getCode({address: account})) !== undefined) {
        throw new Error(`${account} already has code — this run cannot prove late binding`);
    }
    console.log(`[e2e] payer account   ${account} (owner ${owner.address}, NOT deployed)`);

    const now = Number((await publicClient.getBlock()).timestamp);
    const unsigned = preparePeriodDelegation({
        environment: deployment.environment,
        delegator: account,
        delegate: agent.address,
        policy: buildD3Policies(MOCK_USDC)["open-agent"],
        startDate: now - 1,
    });
    const typedData = buildRootDelegationTypedData(
        getAddress(deployment.environment.DelegationManager),
        unsigned,
    );
    const signature = await owner.signTypedData(typedData);
    const delegation = withDelegationSignature(unsigned, signature);
    const permissionContext = encodeDelegations([delegation]);
    passed("A", `signed root    against a codeless account (sig ${signature.length} chars)`);

    // ── the service, for real ─────────────────────────────────────────────────────────
    // Every spawn below passes --env-file=/dev/null: bun auto-loads the app's own .env
    // from the spawn cwd, and those values fill any name this curated env does not set.
    // A developer's real RELAYER_ADDRESS sitting next to the harness's
    // FACILITATOR_SIGNER_ADDRESS tripped the disagree-refusal here once — the suite's
    // result must not depend on what the operator keeps in that gitignored file.
    const childEnv = (overrides: Record<string, string>) => ({
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        HOST: "127.0.0.1",
        PORT: String(BOOTSTRAP_PORT),
        // The override that keeps this off GIWA. Asserted loopback above.
        GIWA_SEPOLIA_RPC_URL: forkRpc,
        BOOTSTRAP_PRIVATE_KEY: sponsorKey,
        BOOTSTRAP_ADDRESS: sponsor.address,
        DELEGATION_DEPLOYMENT_PATH: `${REPO}/deployments/giwa-sepolia.framework.json`,
        ...overrides,
    });

    // ── B. the kill switch, and the approval phrase ───────────────────────────────────
    const disabled = Bun.spawn([process.execPath, "--env-file=/dev/null", "run", "index.ts"], {
        cwd: `${REPO}/apps/account-bootstrap`,
        env: childEnv({BOOTSTRAP_ENABLED: "false"}),
        stdout: "pipe",
        stderr: "pipe",
    });
    children.push({name: "bootstrap-disabled", proc: disabled});
    await waitFor("bootstrap (disabled)", async () => (await fetch(`${BOOTSTRAP_URL}/health`)).ok);
    const off = await postBootstrap({permissionContext});
    if (off.status !== 503 || off.body.reason !== "bootstrap_disabled") {
        throw new Error(`kill switch did not hold: ${off.status} ${off.raw}`);
    }
    assertEnumOnly("disabled", off.raw, off.body);
    passed("B", "kill switch    503 bootstrap_disabled, default off");
    disabled.kill();
    await waitForPortRelease();

    // A wrong approval phrase must stop the process, not degrade it to a warning.
    const badApproval = Bun.spawn([process.execPath, "--env-file=/dev/null", "run", "index.ts"], {
        cwd: `${REPO}/apps/account-bootstrap`,
        env: childEnv({BOOTSTRAP_ENABLED: "true", BOOTSTRAP_APPROVAL: "sponsored-bootstrap-wrong"}),
        stdout: "pipe",
        stderr: "pipe",
    });
    children.push({name: "bootstrap-badapproval", proc: badApproval});
    if ((await badApproval.exited) === 0) {
        throw new Error("the service started with a mismatched approval phrase");
    }
    passed("C", "approval       mismatched phrase refuses to boot");

    // The real one.
    const approval = buildSponsoredBootstrapApproval(FRAMEWORK_COMPOSITION_ID);
    const service = Bun.spawn([process.execPath, "--env-file=/dev/null", "run", "index.ts"], {
        cwd: `${REPO}/apps/account-bootstrap`,
        env: childEnv({
            BOOTSTRAP_ENABLED: "true",
            BOOTSTRAP_APPROVAL: approval,
            BOOTSTRAP_FAUCET_ENABLED: "true",
            FACILITATOR_SIGNER_ADDRESS: privateKeyToAccount(signerKey("someone-else")).address,
        }),
        stdout: "pipe",
        stderr: "pipe",
    });
    children.push({name: "bootstrap", proc: service});
    void forward("bootstrap", service.stderr);
    await waitFor("bootstrap", async () => (await fetch(`${BOOTSTRAP_URL}/health`)).ok);

    // ── D. a key that collides with the settlement relayer must not boot ──────────────
    const collided = Bun.spawn([process.execPath, "--env-file=/dev/null", "run", "index.ts"], {
        cwd: `${REPO}/apps/account-bootstrap`,
        env: childEnv({
            BOOTSTRAP_ENABLED: "true",
            BOOTSTRAP_APPROVAL: approval,
            PORT: String(BOOTSTRAP_PORT + 1),
            // The sponsor and the facilitator relayer are the same address here.
            FACILITATOR_SIGNER_ADDRESS: sponsor.address,
        }),
        stdout: "pipe",
        stderr: "pipe",
    });
    children.push({name: "bootstrap-collide", proc: collided});
    if ((await collided.exited) === 0) {
        throw new Error("the service started while sharing the settlement relayer's nonce space");
    }
    passed("D", "key separation shared relayer address refuses to boot");

    // ── E. a stranger's signature over someone else's account is refused ──────────────
    const stranger = privateKeyToAccount(signerKey("stranger"));
    const strangerSigned = withDelegationSignature(
        unsigned,
        await stranger.signTypedData(typedData),
    );
    const foreign = await postBootstrap({
        permissionContext: encodeDelegations([strangerSigned]),
    });
    if (foreign.status !== 400 || foreign.body.reason !== "malformed_request") {
        throw new Error(`a foreign signer was not refused: ${foreign.status} ${foreign.raw}`);
    }
    assertEnumOnly("foreign signer", foreign.raw, foreign.body);
    if ((await publicClient.getCode({address: account})) !== undefined) {
        throw new Error("a refused request still deployed the account");
    }
    passed("E", "foreign signer 400, nothing deployed");

    // ── F. a malleable (high-s) signature is refused before any gas is spent ──────────
    const highS = concatHex([
        signature.slice(0, 66) as Hex,
        "0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a1",
        "0x1b",
    ]);
    const malleable = await postBootstrap({
        permissionContext: encodeDelegations([withDelegationSignature(unsigned, highS)]),
    });
    if (malleable.status !== 400) {
        throw new Error(`a high-s signature was not refused: ${malleable.status} ${malleable.raw}`);
    }
    assertEnumOnly("high-s", malleable.raw, malleable.body);
    passed("F", "high-s sig     400, refused before spending");

    // ── G. the real thing: deploy from a signature made before the account existed ────
    const sponsorBefore = await publicClient.getBalance({address: sponsor.address});
    // The keys are deterministic, so the counterfactual address is the same on every run and
    // MockUSDC.mint is permissionless: the fork inherits whatever balance real GIWA holds
    // there. J can only prove a top-up from below the target.
    const tokensBefore = await tokenBalance(account);
    if (tokensBefore >= FAUCET_TARGET_BASE) {
        throw new Error(`${account} already holds ${tokensBefore} base units — J cannot prove a top-up`);
    }
    const ok = await postBootstrap({permissionContext});
    if (ok.status !== 200 || ok.body.status !== "deployed") {
        throw new Error(`bootstrap failed: ${ok.status} ${ok.raw}`);
    }
    if (getAddress(ok.body.account as Address) !== account) {
        throw new Error(`sponsor deployed ${ok.body.account}, expected ${account}`);
    }
    const code = await publicClient.getCode({address: account});
    if (!code || code === "0x") throw new Error("service reported success but there is no code");
    const onChainOwner = await readAccountOwner({publicClient, account});
    if (onChainOwner !== owner.address) {
        throw new Error(`owner() is ${onChainOwner}, expected ${owner.address}`);
    }
    passed("G", `deployed       ${account} owner ${onChainOwner} tx ${ok.body.transaction}`);

    /**
     * ── H. the claim the whole design rests on ────────────────────────────────────────
     *
     * The signature was made when the account had no code. If the deployed account accepts
     * it through ERC-1271, then signing before deployment is safe and the sponsor can run
     * after the wallet rather than before it. If it did not, every grant created this way
     * would be dead on arrival and the user would only find out at their first payment.
     */
    const magic = await publicClient.readContract({
        address: account,
        abi: ERC1271_ABI,
        functionName: "isValidSignature",
        args: [hashTypedData(typedData), signature],
    });
    if (magic.toLowerCase() !== "0x1626ba7e") {
        throw new Error(`the deployed account rejected the pre-deployment signature (${magic})`);
    }
    passed("H", "late binding   pre-deployment signature verifies via ERC-1271");

    // ── I. the sponsor paid, and the payer still holds zero ETH ───────────────────────
    const sponsorAfter = await publicClient.getBalance({address: sponsor.address});
    if (sponsorAfter >= sponsorBefore) throw new Error("the sponsor did not pay for the deployment");
    const payerEth = await publicClient.getBalance({address: account});
    if (payerEth !== 0n) throw new Error(`payer holds ${payerEth} wei — it must stay 0`);
    passed(
        "I",
        `gas            sponsor -${sponsorBefore - sponsorAfter} wei, payer still 0 ETH`,
    );

    // ── J. the testnet faucet leg topped the account up to the target, not by a fixed sum ─
    if (!ok.body.fundingTransaction) throw new Error("faucet was enabled but no mint happened");
    const shortfall = FAUCET_TARGET_BASE - tokensBefore;
    if (ok.body.mintedBase !== String(shortfall) || ok.body.targetBase !== String(FAUCET_TARGET_BASE)) {
        throw new Error(`faucet reported minted=${ok.body.mintedBase} target=${ok.body.targetBase}, expected ${shortfall}/${FAUCET_TARGET_BASE}`);
    }
    const balance = await tokenBalance(account);
    if (balance !== FAUCET_TARGET_BASE) {
        throw new Error(`balance is ${balance} base units after the top-up, expected ${FAUCET_TARGET_BASE}`);
    }
    passed("J", `faucet         +${shortfall} base units, balance now ${balance} (the target)`);

    // ── K. idempotency: a second request at the target spends and mints nothing ──────
    const balanceBeforeRepeat = await publicClient.getBalance({address: sponsor.address});
    const again = await postBootstrap({permissionContext});
    if (again.status !== 200 || again.body.status !== "already_deployed") {
        throw new Error(`expected already_deployed, got ${again.status} ${again.raw}`);
    }
    if (again.body.mintedBase !== "0" || again.body.fundingTransaction !== undefined) {
        throw new Error(`a repeat at the target still minted: ${again.raw}`);
    }
    if ((await publicClient.getBalance({address: sponsor.address})) !== balanceBeforeRepeat) {
        throw new Error("a repeat request spent gas");
    }
    passed("K", "idempotent     already_deployed, minted 0, zero spend");

    // ── L. concurrency: five identical requests deploy exactly once ───────────────────
    // Against a fresh account, so `already_deployed` cannot mask a missing single-flight.
    const second = privateKeyToAccount(signerKey("owner-2"));
    const secondDerived = await getCounterfactualAccountData({
        factory: getAddress(deployment.environment.SimpleFactory),
        implementations: deployment.environment.implementations,
        implementation: Implementation.Hybrid,
        deployParams: [second.address, [], [], []],
        deploySalt: OWNER_ACCOUNT_SALT,
    });
    const secondUnsigned = preparePeriodDelegation({
        environment: deployment.environment,
        delegator: getAddress(secondDerived.address),
        delegate: agent.address,
        policy: buildD3Policies(MOCK_USDC)["open-agent"],
        startDate: now - 1,
    });
    const secondContext = encodeDelegations([
        withDelegationSignature(
            secondUnsigned,
            await second.signTypedData(
                buildRootDelegationTypedData(
                    getAddress(deployment.environment.DelegationManager),
                    secondUnsigned,
                ),
            ),
        ),
    ]);
    /**
     * What "coalesced" actually looks like, and why counting statuses would not show it.
     *
     * A working single-flight makes all five callers await the *same* promise, so all five
     * receive the identical response — every one of them reads `"deployed"`. Counting
     * statuses therefore proves nothing. The question is how many transactions the chain
     * saw, so that is what this asserts: one distinct hash, and a sponsor nonce that
     * advanced by exactly the number of transactions one bootstrap is allowed to make
     * (deploy, plus the mint when the testnet faucet is on).
     */
    const nonceBeforeBurst = await publicClient.getTransactionCount({address: sponsor.address});
    const burst = await Promise.all(
        Array.from({length: 5}, () => postBootstrap({permissionContext: secondContext})),
    );
    const failures = burst.filter((r) => r.status !== 200);
    if (failures.length > 0) {
        throw new Error(`concurrent burst had ${failures.length} failures: ${failures[0]?.raw}`);
    }
    const hashes = new Set(burst.map((r) => r.body.transaction).filter(Boolean));
    if (hashes.size !== 1) {
        throw new Error(
            `expected one shared transaction across 5 concurrent requests, saw ${hashes.size} — single-flight is not holding`,
        );
    }
    const nonceAfterBurst = await publicClient.getTransactionCount({address: sponsor.address});
    const spentNonces = nonceAfterBurst - nonceBeforeBurst;
    if (spentNonces !== 2) {
        throw new Error(
            `sponsor sent ${spentNonces} transactions for one account (expected 2: deploy + faucet mint)`,
        );
    }
    passed("L", `concurrency    5 requests → 1 tx, sponsor nonce +${spentNonces}`);

    /** A root signed by a fresh owner against the account that owner would get. */
    async function signedRootFor(key: Hex): Promise<{context: Hex; account: Address}> {
        const signer = privateKeyToAccount(key);
        const derived = await getCounterfactualAccountData({
            factory: getAddress(deployment.environment.SimpleFactory),
            implementations: deployment.environment.implementations,
            implementation: Implementation.Hybrid,
            deployParams: [signer.address, [], [], []],
            deploySalt: OWNER_ACCOUNT_SALT,
        });
        const account = getAddress(derived.address);
        const unsigned = preparePeriodDelegation({
            environment: deployment.environment,
            delegator: account,
            delegate: agent.address,
            policy: buildD3Policies(MOCK_USDC)["open-agent"],
            startDate: now - 1,
        });
        const context = encodeDelegations([
            withDelegationSignature(
                unsigned,
                await signer.signTypedData(
                    buildRootDelegationTypedData(
                        getAddress(deployment.environment.DelegationManager),
                        unsigned,
                    ),
                ),
            ),
        ]);
        return {context, account};
    }

    async function waitForPortRelease(): Promise<void> {
        await waitFor(
            "port release",
            async () => {
                try {
                    await fetch(`${BOOTSTRAP_URL}/health`, {signal: AbortSignal.timeout(300)});
                    return false;
                } catch {
                    return true;
                }
            },
            20_000,
        );
    }

    async function tokenBalance(holder: Address): Promise<bigint> {
        return publicClient.readContract({
            address: MOCK_USDC,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [holder],
        });
    }

    /**
     * Empty the payer's token balance so the next request would mint again.
     *
     * The payer is a deployed smart account, so the transfer is sent from it under Anvil
     * impersonation — the same way the MCP suite revokes from the payer. Its ETH is put back
     * to zero afterwards; nothing here must leave the payer looking funded.
     */
    async function drainTokens(payer: Address): Promise<void> {
        const held = await tokenBalance(payer);
        await rpc(forkRpc, "anvil_setBalance", [payer, numberToHex(10n ** 18n)]);
        await rpc(forkRpc, "anvil_impersonateAccount", [payer]);
        const hash = (await rpc(forkRpc, "eth_sendTransaction", [
            {
                from: payer,
                to: MOCK_USDC,
                data: encodeFunctionData({
                    abi: ERC20_ABI,
                    functionName: "transfer",
                    args: [sponsor.address, held],
                }),
                gas: numberToHex(100_000n),
            },
        ])) as Hex;
        const receipt = await publicClient.waitForTransactionReceipt({hash});
        await rpc(forkRpc, "anvil_stopImpersonatingAccount", [payer]);
        await rpc(forkRpc, "anvil_setBalance", [payer, "0x0"]);
        if (receipt.status !== "success") throw new Error(`draining ${payer} reverted`);
        const left = await tokenBalance(payer);
        if (left !== 0n) throw new Error(`${payer} still holds ${left} base units after draining`);
    }

    /** The same service, restarted — optionally with one bound turned down far enough to hit. */
    async function restart(overrides: Record<string, string>) {
        const proc = Bun.spawn([process.execPath, "--env-file=/dev/null", "run", "index.ts"], {
            cwd: `${REPO}/apps/account-bootstrap`,
            env: childEnv({
                BOOTSTRAP_ENABLED: "true",
                BOOTSTRAP_APPROVAL: approval,
                BOOTSTRAP_FAUCET_ENABLED: "true",
                ...overrides,
            }),
            stdout: "pipe",
            stderr: "pipe",
        });
        children.push({name: "bootstrap-variant", proc});
        void forward("bootstrap", proc.stderr);
        await waitFor("bootstrap (variant)", async () => (await fetch(`${BOOTSTRAP_URL}/health`)).ok);
        return proc;
    }

    service.kill();
    await waitForPortRelease();

    /**
     * M and N exist because deleting either bound left every other test green.
     *
     * The faucet window and the daily budget were only ever exercised as classes. K repeats
     * a request at the target, which the window never sees, and two deploys run against a
     * budget that allows thousands, so `if (!faucetGate.allows(...)) throw` or
     * `if (!budget.reserve(...)) throw` could become bare calls and nothing would notice —
     * while the live griefing ceiling silently became the sponsor's whole balance. Both
     * cases below drive the service into the bound, which is the only way the wiring is
     * asserted at all.
     */
    const third = await signedRootFor(signerKey("owner-3"));

    // The window opens from the deploy's mint. Draining the account afterwards makes the
    // second request one that WOULD mint — the only case the window is allowed to refuse.
    const gated = await restart({});
    const firstTopUp = await postBootstrap({permissionContext: third.context});
    if (firstTopUp.status !== 200 || firstTopUp.body.mintedBase === "0") {
        throw new Error(`the first top-up did not mint: ${firstTopUp.status} ${firstTopUp.raw}`);
    }
    await drainTokens(third.account);
    const overWindow = await postBootstrap({permissionContext: third.context});
    if (overWindow.status !== 429 || overWindow.body.reason !== "faucet_recently_used") {
        throw new Error(`faucet window is not wired: ${overWindow.status} ${overWindow.raw}`);
    }
    assertEnumOnly("faucet window", overWindow.raw, overWindow.body);
    if ((await tokenBalance(third.account)) !== 0n) throw new Error("a refused top-up still minted");
    passed("M", "faucet window  drained account, 2nd top-up in 24h → 429 faucet_recently_used");
    gated.kill();
    await waitForPortRelease();

    const fourth = await signedRootFor(signerKey("owner-4"));
    // One wei of daily budget: enough to construct, never enough to reserve a deploy.
    const broke = await restart({BOOTSTRAP_DAILY_WEI: "1"});
    const overBudget = await postBootstrap({permissionContext: fourth.context});
    if (overBudget.status !== 503 || overBudget.body.reason !== "budget_exhausted") {
        throw new Error(`daily budget is not wired: ${overBudget.status} ${overBudget.raw}`);
    }
    assertEnumOnly("budget exhausted", overBudget.raw, overBudget.body);
    if ((await publicClient.getCode({address: fourth.account})) !== undefined) {
        throw new Error("a budget-exhausted request still deployed");
    }
    passed("N", "budget         one-wei cap → 503 budget_exhausted, nothing deployed");
    broke.kill();
    await waitForPortRelease();

    /**
     * O. The leak guard, pointed at a path that can actually carry a viem error.
     *
     * B, E and F all refuse after pure-offline validation, so their bodies are enum-only by
     * construction and `assertEnumOnly` proves nothing about them. The branch that matters
     * is the catch-all 502, which is where a caught chain error would surface — and viem
     * embeds the whole transport URL, path key included, in every one of those. Here the
     * service is pointed at a dead endpoint whose path is a recognisable secret, so if any
     * part of that error reaches the body the assertion below sees it.
     */
    const SECRET_PATH_KEY = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
    const deadRpc = await restart({
        GIWA_SEPOLIA_RPC_URL: `http://127.0.0.1:${BOOTSTRAP_PORT + 7}/${SECRET_PATH_KEY}`,
    });
    const unreachable = await postBootstrap({permissionContext: third.context});
    if (unreachable.status !== 502 || unreachable.body.reason !== "bootstrap_unavailable") {
        throw new Error(`expected 502 bootstrap_unavailable, got ${unreachable.status} ${unreachable.raw}`);
    }
    if (unreachable.raw.includes(SECRET_PATH_KEY)) {
        throw new Error("the response body echoed the RPC URL's path key");
    }
    assertEnumOnly("unreachable node", unreachable.raw, unreachable.body);
    passed("O", "leak guard     chain failure → enum-only 502, no RPC path key");
    deadRpc.kill();
    await waitForPortRelease();

    // ── no-broadcast evidence ─────────────────────────────────────────────────────────
    const nonceAfter = BigInt(
        (await rpc(upstream, "eth_getTransactionCount", [sponsor.address, "latest"])) as string,
    );
    if (nonceAfter !== nonceBefore) {
        throw new Error(
            `sponsor GIWA nonce moved ${nonceBefore} → ${nonceAfter} — something was broadcast`,
        );
    }
    console.log(`[e2e] sponsor GIWA nonce after   ${nonceAfter} (unchanged — nothing broadcast) ✅`);
    console.log("");
    console.log(`[e2e] account bootstrap service PASS — ${cases.length} cases (${cases.join("")})`);
}

async function forward(name: string, stream: ReadableStream<Uint8Array> | number | undefined) {
    if (!stream || typeof stream === "number") return;
    const decoder = new TextDecoder();
    for await (const chunk of stream as ReadableStream<Uint8Array>) {
        const text = decoder.decode(chunk).trimEnd();
        if (text) console.log(`[${name}] ${redactForLog(text, 400)}`);
    }
}

main()
    .then(() => {
        shutdown();
        process.exit(0);
    })
    .catch((error: unknown) => {
        // `redactUrls` rather than the raw message: anvil quotes the fork URL it failed to
        // reach, and that URL carries an API key in its path.
        console.error(`[e2e] FAIL — ${redactForLog(error)}`);
        shutdown();
        process.exit(1);
    });
