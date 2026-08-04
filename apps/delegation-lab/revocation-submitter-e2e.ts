/**
 * Boot `apps/revocation-submitter` for real and drive the kill switch through it.
 *
 * The unit tests cover `validateRevocationSubmission` and `judgeSubmissionReadiness`, and
 * the negative-path suite proves a validated struct is what the EntryPoint accepts. None
 * of that starts the service. Until this ran, the process itself — env parsing, the
 * deployment artifact read, the startup relayer check, `/health`, single-flight, the
 * simulate-then-broadcast path, and the `UserOperationEvent.success` assertion — had never
 * executed once.
 *
 * Everything happens on a local Anvil fork of GIWA. The account, its owner key and the
 * agent key are all throwaway and created here; no production key is read, and the real
 * payer account is never touched.
 *
 * ── SAFETY ────────────────────────────────────────────────────────────────────────────
 * `apps/revocation-submitter/.env` points GIWA_SEPOLIA_RPC_URL at real GIWA. If the
 * override were ever dropped, the child would broadcast `handleOps` to the live chain.
 * So the child's RPC is asserted loopback before anything is spawned, and the real GIWA
 * relayer nonce is read before and after to prove nothing was broadcast.
 */
import {
    DEFAULT_REVOCATION_GAS,
    FRAMEWORK_COMPOSITION_ID,
    SPONSORED_REVOCATION_GAS,
    buildRevocationSubmissionBody,
    buildRevocationUserOperation,
    buildSponsoredRevocationApproval,
    finalizeRevocationUserOperation,
    isDelegationRevoked,
    parseActiveDeploymentArtifactJson,
    preparePeriodDelegation,
    readAccountOwner,
    readRevocationNonce,
    readRevocationPrefundState,
    withDelegationSignature,
    buildD3Policies,
} from "@mapae/delegation";
import {assertRpcTarget, giwaSepolia, parseNodeRpcUrl, redactForLog} from "@mapae/shared";
import {EntryPoint as EntryPointAbi} from "@metamask/delegation-abis";
import {Implementation, toMetaMaskSmartAccount} from "@metamask/smart-accounts-kit";
import {encodeDelegations} from "@metamask/smart-accounts-kit/utils";
import {
    createPublicClient,
    createWalletClient,
    defineChain,
    getAddress,
    http,
    keccak256,
    publicActions,
    stringToHex,
    type Address,
    type Hex,
    type PublicClient,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {startForkSourceProxy} from "./fork-source-proxy";

const ANVIL_PORT = 8547;
const SUBMITTER_PORT = 8183;
const FORK_RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const SUBMITTER_URL = `http://127.0.0.1:${SUBMITTER_PORT}`;
const REPO = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const FORK_BLOCK = 31_606_000;

/**
 * Every key here is derived, high-entropy and throwaway. None of the well-known Anvil dev
 * keys are usable against a GIWA fork, and not only for the reason already documented for
 * signers.
 *
 * `0xf39Fd6e5…92266` and `0x70997970…c79C8` both carry an EIP-7702 designator on GIWA
 * (`0xef0100…6bd9b715…89606`) — a sweeper that forwards the account's entire balance on
 * receipt. For a signer that shows up as ERC-1271 routing. For a *relayer* it is worse and
 * silent: `EntryPoint._compensate` pays the beneficiary with `beneficiary.call{value: …}`,
 * which runs the sweeper's code, so one successful `handleOps` empties the relayer.
 * Measured here — the relayer went from 1 ETH to 0.00024 ETH in the handleOps block while
 * the transaction itself cost 0.00017 ETH, and `debug_traceTransaction` showed the balance
 * leaving in a nested CALL to `0x1330d9…7d8869`. It reads like a fee-estimation bug and is
 * not one.
 */
const signerKey = (label: string) =>
    keccak256(stringToHex(`mapae.revocation-submitter-e2e.v1.${label}`)) as Hex;

const children: {name: string; proc: Bun.Subprocess}[] = [];
/** Loopback listeners this run owns — closed alongside the children on any exit path. */
const listeners: {stop(): void}[] = [];

/**
 * The lettered cases, recorded as they pass. The closing line used to read `PASS — 8/8` as
 * a string literal, which is a claim rather than a measurement: delete a case in a refactor
 * and it still says eight. Every case here fails by throwing, so passed and total are the
 * same number, and printing the letters makes a missing one visible at a glance.
 *
 * Same rule the preflight runbook already states for its condition total — a count that is
 * written down instead of counted lets a shrunken run read as a whole one.
 */
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
    assertRpcTarget(value, "loopback", "this would broadcast to GIWA");

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

interface RevokeResponse {
    success?: boolean;
    transaction?: string;
    delegationHash?: string;
    reason?: string;
    detail?: Record<string, string>;
}

async function postRevoke(body: unknown): Promise<{status: number; body: RevokeResponse}> {
    const response = await fetch(`${SUBMITTER_URL}/revoke`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
    });
    return {status: response.status, body: (await response.json()) as RevokeResponse};
}

/**
 * The browser leg, checked against the running service.
 *
 * Every other case here uses Bun's server-side `fetch`, which does not enforce CORS — so
 * the whole suite passed while the console's revoke button was unable to reach this
 * service from a page at all. `content-type: application/json` is not CORS-safelisted, so
 * the browser sends this exact preflight first and drops the POST unless it is answered.
 * Asserting on the response rather than relying on enforcement is what makes a
 * non-browser client able to catch a browser-only failure.
 */
async function proveCorsPreflight(): Promise<void> {
    const preflight = async (origin: string) =>
        fetch(`${SUBMITTER_URL}/revoke`, {
            method: "OPTIONS",
            headers: {
                Origin: origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
            signal: AbortSignal.timeout(10_000),
        });

    const console_ = await preflight("http://127.0.0.1:5173");
    const allowOrigin = console_.headers.get("access-control-allow-origin");
    const allowHeaders = console_.headers.get("access-control-allow-headers") ?? "";
    if (console_.status !== 204 || allowOrigin !== "http://127.0.0.1:5173") {
        throw new Error(
            `console preflight failed: ${console_.status} allow-origin=${allowOrigin} — the revoke button cannot reach the submitter from a browser`,
        );
    }
    if (!allowHeaders.toLowerCase().includes("content-type")) {
        throw new Error(`preflight did not allow content-type (got "${allowHeaders}")`);
    }
    // A wildcard cannot reach here — the equality check above already pins the exact
    // origin. `judgeCorsRequest` carries the "never `*`" assertion instead.
    passed("F", `preflight      204 · allow-origin ${allowOrigin} · content-type`);

    const stranger = await preflight("http://evil.example");
    if (stranger.status !== 403 || stranger.headers.get("access-control-allow-origin") !== null) {
        throw new Error(
            `an unlisted origin was not refused: ${stranger.status} ${stranger.headers.get("access-control-allow-origin")}`,
        );
    }
    passed("G", "foreign origin 403, no allow-origin");

    // The suite's own POSTs carry no Origin. That path has to keep working, or this
    // guard would have fixed the browser by breaking every script.
    const noOrigin = await fetch(`${SUBMITTER_URL}/health`, {signal: AbortSignal.timeout(10_000)});
    if (!noOrigin.ok) throw new Error("a request with no Origin was refused");
    passed("H", `no Origin      ${noOrigin.status} — scripts unaffected`);
}

async function main(): Promise<void> {
    const forkRpc = assertLoopback(FORK_RPC);
    const upstream = parseNodeRpcUrl(
        process.env["GIWA_FORK_SOURCE_RPC_URL"]?.trim() || giwaSepolia.rpcUrls.default.http[0],
    );
    console.log("[e2e] no-broadcast guard: submitter pinned to", forkRpc);
    assertPortFree("anvil", ANVIL_PORT);
    assertPortFree("submitter", SUBMITTER_PORT);

    const relayerKey = signerKey("relayer");
    const relayer = privateKeyToAccount(relayerKey);
    const nonceBefore = BigInt(
        (await rpc(upstream, "eth_getTransactionCount", [relayer.address, "latest"])) as string,
    );
    console.log(`[e2e] relayer GIWA nonce before  ${nonceBefore}`);

    // ── fork ──────────────────────────────────────────────────────────────────────────
    // The key never reaches argv — `--fork-url` has no env alias, and argv is readable
    // through `ps`. A loopback proxy holds it and hands anvil a keyless address.
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
    void forward("anvil", anvil.stderr);
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
    const relayerClient = createWalletClient({
        account: relayer,
        chain,
        transport: http(forkRpc),
    }).extend(publicActions);
    const deployment = parseActiveDeploymentArtifactJson(
        await Bun.file(`${REPO}/deployments/giwa-sepolia.framework.json`).text(),
    );
    const entryPoint = getAddress(deployment.environment.EntryPoint);

    await rpc(forkRpc, "anvil_setBalance", [relayer.address, "0xde0b6b3a7640000"]);
    // A designator here would make `_compensate` sweep the relayer mid-run; fail loudly
    // instead, because the symptom is an "insufficient funds" three cases later.
    if ((await publicClient.getCode({address: relayer.address})) !== undefined) {
        throw new Error(`relayer ${relayer.address} carries code — pick a different derived key`);
    }

    // ── a throwaway payer account with a throwaway owner ──────────────────────────────
    const owner = privateKeyToAccount(signerKey("owner"));
    const agent = privateKeyToAccount(signerKey("agent"));
    const account = await toMetaMaskSmartAccount({
        client: publicClient,
        implementation: Implementation.Hybrid,
        signer: {account: owner},
        environment: deployment.environment,
        deployParams: [owner.address, [], [], []],
        deploySalt: keccak256(stringToHex("submitter-e2e")) as Hex,
    });
    const factory = await account.getFactoryArgs();
    if (!factory.factory || !factory.factoryData) throw new Error("no factory args");
    await publicClient.waitForTransactionReceipt({
        hash: await relayerClient.sendTransaction({to: factory.factory, data: factory.factoryData}),
    });
    const onChainOwner = await readAccountOwner({publicClient, account: account.address});
    if (onChainOwner !== owner.address) {
        throw new Error(`owner() is ${onChainOwner}, expected ${owner.address}`);
    }
    console.log(`[e2e] payer account   ${account.address} (owner ${owner.address})`);

    const token = getAddress("0xcfeb694719A09caeb80798e2011298F29CDa4e92");
    const now = Number((await publicClient.getBlock()).timestamp);
    const unsigned = preparePeriodDelegation({
        environment: deployment.environment,
        delegator: account.address,
        delegate: agent.address,
        policy: buildD3Policies(token)["open-agent"],
        startDate: now - 1,
    });
    const delegation = withDelegationSignature(
        unsigned,
        await account.signDelegation({delegation: unsigned, chainId: chain.id}),
    );
    const permissionContext = encodeDelegations([delegation]);

    // ── the submitter, for real ───────────────────────────────────────────────────────
    const submitter = Bun.spawn([process.execPath, "run", "index.ts"], {
        cwd: `${REPO}/apps/revocation-submitter`,
        env: {
            PATH: process.env["PATH"] ?? "",
            HOME: process.env["HOME"] ?? "",
            HOST: "127.0.0.1",
            PORT: String(SUBMITTER_PORT),
            // The override that keeps this off GIWA. Asserted loopback above.
            GIWA_SEPOLIA_RPC_URL: forkRpc,
            PAYER_ACCOUNT_ADDRESS: account.address,
            RELAYER_ADDRESS: relayer.address,
            RELAYER_PRIVATE_KEY: relayerKey,
            DELEGATION_DEPLOYMENT_PATH: `${REPO}/deployments/giwa-sepolia.framework.json`,
        },
        stdout: "pipe",
        stderr: "pipe",
    });
    children.push({name: "submitter", proc: submitter});
    void forward("submitter", submitter.stderr);
    await waitFor("submitter", async () => (await fetch(`${SUBMITTER_URL}/health`)).ok);

    const health = (await (await fetch(`${SUBMITTER_URL}/health`)).json()) as {
        ok: boolean;
        payer: string;
        payerDeposit: string | null;
        submitter: string;
    };
    if (!health.ok) throw new Error("submitter reports unhealthy at startup");
    if (getAddress(health.payer) !== account.address) {
        throw new Error(`submitter serves ${health.payer}, expected ${account.address}`);
    }
    console.log(`[e2e] /health ok       payer ${health.payer}  deposit ${health.payerDeposit}`);

    // ── build and sign one revocation ─────────────────────────────────────────────────
    const nonce = await readRevocationNonce({publicClient, entryPoint, sender: account.address});
    const built = buildRevocationUserOperation({
        delegation,
        entryPoint,
        chainId: chain.id,
        nonce,
        gas: DEFAULT_REVOCATION_GAS,
    });
    const signed = finalizeRevocationUserOperation(built, await owner.signTypedData(built.typedData));
    const body = buildRevocationSubmissionBody({permissionContext, packed: signed.packed});

    const revoked = () =>
        isDelegationRevoked({
            publicClient,
            delegationManager: getAddress(deployment.environment.DelegationManager),
            delegation,
        });

    // ── A. unfunded: the deposit gate answers before anything is spent ────────────────
    const unfunded = await postRevoke(body);
    if (unfunded.status !== 409 || unfunded.body.reason !== "prefund_short") {
        throw new Error(
            `expected 409 prefund_short, got ${unfunded.status} ${JSON.stringify(unfunded.body)}`,
        );
    }
    if (await revoked()) throw new Error("delegation was disabled by a refused submission");
    passed("A", `unfunded       409 prefund_short (short ${unfunded.body.detail?.["shortfall"]} wei)`);

    // ── fund exactly the required prefund ─────────────────────────────────────────────
    await publicClient.waitForTransactionReceipt({
        hash: await relayerClient.writeContract({
            address: entryPoint,
            abi: EntryPointAbi,
            functionName: "depositTo",
            args: [account.address],
            value: built.requiredPrefund,
        }),
    });
    const prefund = await readRevocationPrefundState({
        publicClient,
        entryPoint,
        sender: account.address,
        requiredPrefund: built.requiredPrefund,
    });
    if (!prefund.ready) throw new Error("deposit did not arm the kill switch");
    if (prefund.nativeBalance !== 0n) {
        throw new Error(`payer holds ${prefund.nativeBalance} wei of ETH — it must stay 0`);
    }
    console.log(
        `[e2e] armed            deposit ${prefund.deposit} wei, payer ETH still ${prefund.nativeBalance} ✅`,
    );

    /**
     * Positive proof the child is on the fork, not GIWA. The fork and GIWA share a chain
     * id, so nothing in the response distinguishes them by name — but this account was
     * created seconds ago on the fork and does not exist upstream, so a GIWA-connected
     * child could only ever answer `0` here. Bun was measured to let an inherited env var
     * beat a `.env` file, which is what makes the override above load-bearing.
     */
    const armed = (await (await fetch(`${SUBMITTER_URL}/health`)).json()) as {
        payerDeposit: string | null;
    };
    if (armed.payerDeposit !== String(built.requiredPrefund)) {
        throw new Error(
            `submitter reports deposit ${armed.payerDeposit}, fork holds ${built.requiredPrefund} — ` +
                "the service is reading a different chain than this test funded",
        );
    }
    console.log(`[e2e] /health          sees the fork deposit ${armed.payerDeposit} ✅`);

    // ── B. an operation for a different account is refused before any chain read ──────
    const foreign = await postRevoke({
        ...body,
        userOperation: {...body.userOperation, sender: relayer.address},
    });
    if (foreign.status !== 400 || foreign.body.reason !== "invalid_submission") {
        throw new Error(
            `expected 400 invalid_submission, got ${foreign.status} ${JSON.stringify(foreign.body)}`,
        );
    }
    passed("B", "foreign sender 400 invalid_submission");

    // ── C. the real thing ─────────────────────────────────────────────────────────────
    const relayerBefore = await publicClient.getBalance({address: relayer.address});
    const ok = await postRevoke(body);
    if (ok.status !== 200 || !ok.body.success || !ok.body.transaction) {
        throw new Error(`revocation failed: ${ok.status} ${JSON.stringify(ok.body)}`);
    }
    if (!(await revoked())) {
        throw new Error("submitter reported success but the delegation is still enabled");
    }
    passed("C", `revoked        tx ${ok.body.transaction}`);
    /**
     * The relayer must come out of `handleOps` roughly whole: it fronts the gas and the
     * EntryPoint reimburses it from the payer's deposit. Asserting the economics — rather
     * than just "the transaction succeeded" — is what turns the EIP-7702 sweep described
     * at the top of this file into a named failure. Without it the loss is invisible here
     * and surfaces later as an unrelated "insufficient funds".
     */
    const receipt = await publicClient.getTransactionReceipt({hash: ok.body.transaction as Hex});
    const gasPaid = receipt.gasUsed * receipt.effectiveGasPrice;
    const relayerAfter = await publicClient.getBalance({address: relayer.address});
    if (relayerAfter + gasPaid < relayerBefore) {
        throw new Error(
            `relayer lost ${relayerBefore - relayerAfter} wei but only spent ${gasPaid} on gas — ` +
                "value left the beneficiary outside the fee path (check for an EIP-7702 designator)",
        );
    }
    console.log(
        `[e2e] relayer economics gas ${gasPaid} wei, reimbursed to ${relayerAfter} wei ✅`,
    );

    // ── D. the deposit was actually spent, so it is not a one-time arming trick ───────
    const spent = await postRevoke(body);
    if (spent.status !== 409 || spent.body.reason !== "prefund_short") {
        throw new Error(
            `expected the deposit to be consumed, got ${spent.status} ${JSON.stringify(spent.body)}`,
        );
    }
    passed("D", "deposit spent  409 prefund_short");

    /**
     * ── E. replay, with the deposit re-armed ──────────────────────────────────────────
     *
     * D alone does not prove replay protection: it was refused by the deposit gate, which
     * sits in front of the chain. Re-funding removes that gate, so the only thing left to
     * stop a byte-identical resubmission is the EntryPoint's own nonce — which is what
     * this case is actually asserting.
     */
    await publicClient.waitForTransactionReceipt({
        hash: await relayerClient.writeContract({
            address: entryPoint,
            abi: EntryPointAbi,
            functionName: "depositTo",
            args: [account.address],
            value: built.requiredPrefund,
        }),
    });
    const replay = await postRevoke(body);
    if (replay.status === 200 || replay.body.success) {
        throw new Error("a replayed revocation succeeded — the nonce is not binding");
    }
    const why = replay.body.detail?.["message"] ?? "";
    if (!/AA25|nonce/i.test(why)) {
        throw new Error(`replay was refused, but not by the nonce: ${replay.status} ${why}`);
    }
    passed("E", `replay funded  ${replay.status} ${replay.body.reason} (AA25 nonce)`);

    // ── F/G/H. the browser leg ────────────────────────────────────────────────────────
    await proveCorsPreflight();

    /**
     * ── the sponsored public mode, same binary, second shape ──────────────────────────
     *
     * Everything above ran the pinned single-payer service. The cases below restart the
     * child with PAYER_ACCOUNT_ADDRESS unset — the shape that goes behind the tunnel —
     * where a dedicated sponsor arms the EntryPoint deposit at revoke time and every
     * response body is a closed enum. A *fresh* account is used on purpose: the first
     * one's deposit was re-armed by case E, so its shortfall is zero and the deposit leg
     * this mode exists for would never run against it.
     */
    const sponsorKey = signerKey("sponsor");
    const sponsor = privateKeyToAccount(sponsorKey);
    const sponsorNonceUpstreamBefore = BigInt(
        (await rpc(upstream, "eth_getTransactionCount", [sponsor.address, "latest"])) as string,
    );
    await rpc(forkRpc, "anvil_setBalance", [sponsor.address, "0xde0b6b3a7640000"]);
    if ((await publicClient.getCode({address: sponsor.address})) !== undefined) {
        throw new Error(`sponsor ${sponsor.address} carries code — pick a different derived key`);
    }

    const owner2 = privateKeyToAccount(signerKey("owner2"));
    const agent2 = privateKeyToAccount(signerKey("agent2"));
    const agent3 = privateKeyToAccount(signerKey("agent3"));
    const account2 = await toMetaMaskSmartAccount({
        client: publicClient,
        implementation: Implementation.Hybrid,
        signer: {account: owner2},
        environment: deployment.environment,
        deployParams: [owner2.address, [], [], []],
        deploySalt: keccak256(stringToHex("submitter-e2e-sponsored")) as Hex,
    });
    const factory2 = await account2.getFactoryArgs();
    if (!factory2.factory || !factory2.factoryData) throw new Error("no factory args (account2)");
    await publicClient.waitForTransactionReceipt({
        hash: await relayerClient.sendTransaction({
            to: factory2.factory,
            data: factory2.factoryData,
        }),
    });
    console.log(`[e2e] sponsored payer  ${account2.address} (owner ${owner2.address})`);

    const grantFrom2 = (delegate: Address) => {
        const unsignedGrant = preparePeriodDelegation({
            environment: deployment.environment,
            delegator: account2.address,
            delegate,
            policy: buildD3Policies(token)["open-agent"],
            startDate: now - 1,
        });
        return unsignedGrant;
    };
    const unsigned2 = grantFrom2(agent2.address);
    const delegation2 = withDelegationSignature(
        unsigned2,
        await account2.signDelegation({delegation: unsigned2, chainId: chain.id}),
    );
    const context2 = encodeDelegations([delegation2]);
    const unsigned3 = grantFrom2(agent3.address);
    const delegation3 = withDelegationSignature(
        unsigned3,
        await account2.signDelegation({delegation: unsigned3, chainId: chain.id}),
    );
    const context3 = encodeDelegations([delegation3]);

    const sponsoredEnv = {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        HOST: "127.0.0.1",
        PORT: String(SUBMITTER_PORT),
        GIWA_SEPOLIA_RPC_URL: forkRpc,
        // No PAYER_ACCOUNT_ADDRESS — that absence *is* the mode selector, and the boot
        // guards below it (kill switch + approval + dedicated key) are what keep the
        // absence from ever being an accident in production.
        RELAYER_ADDRESS: relayer.address,
        RELAYER_PRIVATE_KEY: relayerKey,
        REVOCATION_SPONSOR_ENABLED: "true",
        REVOCATION_SPONSOR_APPROVAL: buildSponsoredRevocationApproval(FRAMEWORK_COMPOSITION_ID),
        REVOCATION_SPONSOR_PRIVATE_KEY: sponsorKey,
        REVOCATION_SPONSOR_ADDRESS: sponsor.address,
        // The production default is 2/hour, sized so one IP cannot exhaust the daily
        // budget. Every case below arrives from the same loopback address, so that default
        // would refuse the suite itself after two requests — a property of the harness, not
        // of the service. Case O restarts with "1" and is what proves the limit binds.
        REVOCATION_RATE_PER_HOUR: "50",
        DELEGATION_DEPLOYMENT_PATH: `${REPO}/deployments/giwa-sepolia.framework.json`,
    };

    async function waitForPortRelease(port: number): Promise<void> {
        await waitFor(
            `port ${port} release`,
            async () => {
                try {
                    Bun.serve({port, hostname: "127.0.0.1", fetch: () => new Response("")}).stop(
                        true,
                    );
                    return true;
                } catch {
                    return false;
                }
            },
            15_000,
        );
    }

    let sponsoredChild = submitter;
    async function restartSponsored(overrides: Record<string, string> = {}): Promise<void> {
        sponsoredChild.kill();
        await waitForPortRelease(SUBMITTER_PORT);
        sponsoredChild = Bun.spawn([process.execPath, "run", "index.ts"], {
            cwd: `${REPO}/apps/revocation-submitter`,
            env: {...sponsoredEnv, ...overrides},
            stdout: "pipe",
            stderr: "pipe",
        });
        children.push({name: "submitter-sponsored", proc: sponsoredChild});
        void forward("submitter-sponsored", sponsoredChild.stderr);
        await waitFor("sponsored submitter", async () => (await fetch(`${SUBMITTER_URL}/health`)).ok);
    }
    await restartSponsored();

    // ── I. the sponsored /health names its mode and budget, and no payer ──────────────
    const sponsoredHealth = (await (await fetch(`${SUBMITTER_URL}/health`)).json()) as {
        ok: boolean;
        mode?: string;
        sponsor?: string;
        payer?: string;
        budgetRemainingWei?: string;
    };
    if (sponsoredHealth.mode !== "sponsored" || !sponsoredHealth.ok) {
        throw new Error(`expected sponsored health, got ${JSON.stringify(sponsoredHealth)}`);
    }
    if (getAddress(sponsoredHealth.sponsor ?? "0x") !== sponsor.address) {
        throw new Error(`health names sponsor ${sponsoredHealth.sponsor}, expected ${sponsor.address}`);
    }
    if (sponsoredHealth.payer !== undefined) {
        throw new Error("sponsored health still names a pinned payer");
    }
    if (typeof sponsoredHealth.budgetRemainingWei !== "string") {
        throw new Error("sponsored health does not report its budget");
    }
    passed("I", `sponsored mode budget ${sponsoredHealth.budgetRemainingWei} wei`);

    // ── J. an unfunded account revokes, the sponsor pays, the gift is measured ────────
    const revoked2 = () =>
        isDelegationRevoked({
            publicClient,
            delegationManager: getAddress(deployment.environment.DelegationManager),
            delegation: delegation2,
        });
    const preState = await readRevocationPrefundState({
        publicClient,
        entryPoint,
        sender: account2.address,
        requiredPrefund: 1n,
    });
    if (preState.deposit !== 0n || preState.nativeBalance !== 0n) {
        throw new Error("sponsored payer must start with zero deposit and zero ETH");
    }
    const nonce2 = await readRevocationNonce({publicClient, entryPoint, sender: account2.address});
    const built2 = buildRevocationUserOperation({
        delegation: delegation2,
        entryPoint,
        chainId: chain.id,
        nonce: nonce2,
        gas: SPONSORED_REVOCATION_GAS,
    });
    const signed2 = finalizeRevocationUserOperation(
        built2,
        await owner2.signTypedData(built2.typedData),
    );
    const body2 = buildRevocationSubmissionBody({permissionContext: context2, packed: signed2.packed});
    const sponsorBefore = await publicClient.getBalance({address: sponsor.address});
    const sponsoredOk = await postRevoke(body2);
    if (sponsoredOk.status !== 200 || !sponsoredOk.body.success || !sponsoredOk.body.transaction) {
        throw new Error(
            `sponsored revocation failed: ${sponsoredOk.status} ${JSON.stringify(sponsoredOk.body)}`,
        );
    }
    if (!(await revoked2())) {
        throw new Error("sponsored submitter reported success but the delegation is still enabled");
    }
    const sponsorAfter = await publicClient.getBalance({address: sponsor.address});
    if (sponsorAfter >= sponsorBefore) {
        throw new Error("the sponsor spent nothing — who paid the deposit?");
    }
    const postState = await readRevocationPrefundState({
        publicClient,
        entryPoint,
        sender: account2.address,
        requiredPrefund: built2.requiredPrefund,
    });
    if (postState.nativeBalance !== 0n) {
        throw new Error(`sponsored payer holds ${postState.nativeBalance} wei ETH — must stay 0`);
    }
    /**
     * The leftover is the gift: the EntryPoint refunds the unused prefund into the
     * *sender's* deposit, where its owner can withdraw it. Asserting it exists and is
     * bounded by the sponsored profile's prefund is what keeps the faucet arithmetic in
     * this suite instead of in a postmortem.
     */
    if (postState.deposit === 0n || postState.deposit >= built2.requiredPrefund) {
        throw new Error(
            `leftover deposit ${postState.deposit} wei out of ${built2.requiredPrefund} — ` +
                "the refund path did not behave as documented",
        );
    }
    passed(
        "J",
        `sponsored      tx ${sponsoredOk.body.transaction} · sponsor spent ${sponsorBefore - sponsorAfter} wei · leftover ${postState.deposit} wei`,
    );

    // ── K. a non-owner signature is refused before the sponsor spends anything ────────
    const sponsorTxCountBeforeK = BigInt(
        (await rpc(forkRpc, "eth_getTransactionCount", [sponsor.address, "latest"])) as string,
    );
    const nonce3 = await readRevocationNonce({publicClient, entryPoint, sender: account2.address});
    const built3 = buildRevocationUserOperation({
        delegation: delegation3,
        entryPoint,
        chainId: chain.id,
        nonce: nonce3,
        gas: SPONSORED_REVOCATION_GAS,
    });
    // `owner` signs — a canonical, well-formed signature from the *wrong* key. The account
    // itself answers `isValidSignature` with a non-magic value, and the refusal must land
    // before any depositTo leaves the sponsor.
    const foreignSigned = finalizeRevocationUserOperation(
        built3,
        await owner.signTypedData(built3.typedData),
    );
    const foreignBody = buildRevocationSubmissionBody({
        permissionContext: context3,
        packed: foreignSigned.packed,
    });
    const foreignOwner = await postRevoke(foreignBody);
    if (foreignOwner.status !== 403 || foreignOwner.body.reason !== "invalid_account_signature") {
        throw new Error(
            `expected 403 invalid_account_signature, got ${foreignOwner.status} ${JSON.stringify(foreignOwner.body)}`,
        );
    }
    const sponsorTxCountAfterK = BigInt(
        (await rpc(forkRpc, "eth_getTransactionCount", [sponsor.address, "latest"])) as string,
    );
    if (sponsorTxCountAfterK !== sponsorTxCountBeforeK) {
        throw new Error("a refused signature still moved the sponsor's nonce — ordering is broken");
    }
    passed("K", "foreign owner  403 invalid_account_signature, sponsor untouched");

    // ── L. replaying a finished revocation is refused before any spend ────────────────
    const replay2 = await postRevoke(body2);
    if (replay2.status !== 409 || replay2.body.reason !== "already_revoked") {
        throw new Error(
            `expected 409 already_revoked, got ${replay2.status} ${JSON.stringify(replay2.body)}`,
        );
    }
    const sponsorTxCountAfterL = BigInt(
        (await rpc(forkRpc, "eth_getTransactionCount", [sponsor.address, "latest"])) as string,
    );
    if (sponsorTxCountAfterL !== sponsorTxCountBeforeK) {
        throw new Error("a replay after success cost the sponsor a deposit");
    }
    passed("L", "replay done    409 already_revoked, no second deposit");

    /**
     * ── P. an operation signed below the fee floor is refused ─────────────────────────
     *
     * The ceiling alone does not protect the relayer. The EntryPoint reimburses it at
     * `min(maxFeePerGas, tip + baseFee)` of the *signed* operation while the relayer's own
     * transaction costs `baseFee + tip` — 267 wei versus ~1,000,267 wei as measured on
     * GIWA. An operation signed just above the base fee therefore passes
     * `fee_below_basefee` and reimburses a fraction of what was fronted, and because its
     * prefund shrinks with the fee, the daily budget barely counts it. This case pins the
     * floor that closes it.
     */
    const cheapGas = {...SPONSORED_REVOCATION_GAS, maxFeePerGas: 300n, maxPriorityFeePerGas: 300n};
    const cheapBuilt = buildRevocationUserOperation({
        delegation: delegation3,
        entryPoint,
        chainId: chain.id,
        nonce: await readRevocationNonce({publicClient, entryPoint, sender: account2.address}),
        gas: cheapGas,
    });
    const cheapBody = buildRevocationSubmissionBody({
        permissionContext: context3,
        packed: finalizeRevocationUserOperation(
            cheapBuilt,
            await owner2.signTypedData(cheapBuilt.typedData),
        ).packed,
    });
    const sponsorNonceBeforeP = BigInt(
        (await rpc(forkRpc, "eth_getTransactionCount", [sponsor.address, "latest"])) as string,
    );
    const cheap = await postRevoke(cheapBody);
    if (cheap.status !== 400 || cheap.body.reason !== "invalid_submission") {
        throw new Error(
            `expected 400 invalid_submission for a below-floor fee, got ${cheap.status} ${JSON.stringify(cheap.body)}`,
        );
    }
    const sponsorNonceAfterP = BigInt(
        (await rpc(forkRpc, "eth_getTransactionCount", [sponsor.address, "latest"])) as string,
    );
    if (sponsorNonceAfterP !== sponsorNonceBeforeP) {
        throw new Error("a below-floor submission still cost the sponsor a deposit");
    }
    passed("P", "fee 300 wei    400 invalid_submission, relayer never fronts it");

    // ── M. the daily budget is a real bound, not a speed bump ─────────────────────────
    await restartSponsored({REVOCATION_DAILY_WEI: "1"});
    const ownerSigned3 = finalizeRevocationUserOperation(
        built3,
        await owner2.signTypedData(built3.typedData),
    );
    const budgetBody = buildRevocationSubmissionBody({
        permissionContext: context3,
        packed: ownerSigned3.packed,
    });
    const exhausted = await postRevoke(budgetBody);
    if (exhausted.status !== 503 || exhausted.body.reason !== "budget_exhausted") {
        throw new Error(
            `expected 503 budget_exhausted, got ${exhausted.status} ${JSON.stringify(exhausted.body)}`,
        );
    }
    const stillEnabled = await isDelegationRevoked({
        publicClient,
        delegationManager: getAddress(deployment.environment.DelegationManager),
        delegation: delegation3,
    });
    if (stillEnabled) throw new Error("a budget-refused revocation still executed");
    passed("M", "budget 1 wei   503 budget_exhausted, nothing spent");

    // ── N/O. closed bodies and the rate limit, on a fresh 1/hour child ────────────────
    await restartSponsored({REVOCATION_RATE_PER_HOUR: "1"});
    const closed = await postRevoke({garbage: true});
    if (closed.status !== 400 || closed.body.reason !== "invalid_submission") {
        throw new Error(
            `expected 400 invalid_submission, got ${closed.status} ${JSON.stringify(closed.body)}`,
        );
    }
    /**
     * The pinned mode ships `detail.message` because it is loopback-only; the public mode
     * must not — a viem error carries the whole transport URL, and the path of a keyed RPC
     * URL is a credential. Asserting the *absence* of the field is what keeps that split
     * from regressing silently.
     */
    if ("detail" in closed.body) {
        throw new Error(
            `sponsored refusal leaked a detail body: ${JSON.stringify(closed.body)}`,
        );
    }
    passed("N", "closed body    400 invalid_submission, no detail field");

    const flooded = await postRevoke({garbage: true});
    if (flooded.status !== 429 || flooded.body.reason !== "rate_limited") {
        throw new Error(
            `expected 429 rate_limited, got ${flooded.status} ${JSON.stringify(flooded.body)}`,
        );
    }
    passed("O", "rate 1/hour    429 rate_limited on the second request");

    // ── no-broadcast evidence ─────────────────────────────────────────────────────────
    const nonceAfter = BigInt(
        (await rpc(upstream, "eth_getTransactionCount", [relayer.address, "latest"])) as string,
    );
    if (nonceAfter !== nonceBefore) {
        throw new Error(
            `relayer GIWA nonce moved ${nonceBefore} → ${nonceAfter} — something was broadcast`,
        );
    }
    const sponsorNonceUpstreamAfter = BigInt(
        (await rpc(upstream, "eth_getTransactionCount", [sponsor.address, "latest"])) as string,
    );
    if (sponsorNonceUpstreamAfter !== sponsorNonceUpstreamBefore) {
        throw new Error(
            `sponsor GIWA nonce moved ${sponsorNonceUpstreamBefore} → ${sponsorNonceUpstreamAfter} — something was broadcast`,
        );
    }
    console.log(`[e2e] relayer GIWA nonce after   ${nonceAfter} (unchanged — nothing broadcast) ✅`);
    console.log(
        `[e2e] sponsor GIWA nonce after   ${sponsorNonceUpstreamAfter} (unchanged — nothing broadcast) ✅`,
    );
    console.log("");
    console.log(`[e2e] revocation submitter service PASS — ${cases.length} cases (${cases.join("")})`);
}

async function forward(name: string, stream: ReadableStream<Uint8Array> | number | undefined) {
    if (!stream || typeof stream === "number") return;
    const decoder = new TextDecoder();
    try {
        for await (const chunk of stream) {
            for (const line of decoder.decode(chunk).split("\n")) {
                if (line.trim().length > 0) console.log(`[${name}] ${line}`);
            }
        }
    } catch {
        /* killed during shutdown */
    }
}

try {
    await main();
} catch (error) {
    console.error(`[e2e] ${redactForLog(error)}`);
    process.exitCode = 1;
} finally {
    shutdown();
}
