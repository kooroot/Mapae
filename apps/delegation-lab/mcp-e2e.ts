/**
 * D5 완료판정 증명 — MCP tool 한 번 호출로 사람 개입 0으로 완주.
 *
 *   402 → 한도 안에서 leaf 서명 → facilitator 정산 → 리소스 + tx
 *
 * GIWA Sepolia를 fork한 로컬 Anvil에서 실행한다. fork는 chainId 91342를 유지하므로
 * 실제 Framework/MockUSDC 바이트코드와 이미 서명된 root permission이 그대로 유효하다.
 *
 * ── 안전 ──────────────────────────────────────────────────────────────────
 * 각 앱의 .env는 GIWA_SEPOLIA_RPC_URL을 실제 GIWA로 가리킨다. override를 빠뜨리면
 * facilitator가 GIWA에 진짜 정산을 브로드캐스트한다. 그래서:
 *   1) 자식에게 넘길 RPC가 loopback이 아니면 아무것도 띄우기 전에 중단하고,
 *   2) 끝난 뒤 실제 GIWA의 relayer nonce가 그대로인지 확인해 무브로드캐스트를 증명한다.
 */
import {
    buildRevocationCall,
    isDelegationRevoked,
    parseActiveDeploymentArtifactJson,
    readDelegationStatus,
    readSettlementReceipts,
} from "@mapae/delegation";
import {fromTokenAmount, giwaSepolia, parseNodeRpcUrl, redactForLog} from "@mapae/shared";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {decodeDelegations} from "@metamask/smart-accounts-kit/utils";
import {
    createPublicClient,
    defineChain,
    encodeFunctionData,
    getAddress,
    http,
    isAddress,
    numberToHex,
} from "viem";
import type {Address, Hex, PublicClient} from "viem";

const ANVIL_PORT = 8546;
const FACILITATOR_PORT = 8181;
const SELLER_PORT = 3101;
const FORK_RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const FACILITATOR_URL = `http://127.0.0.1:${FACILITATOR_PORT}`;
const SELLER_URL = `http://127.0.0.1:${SELLER_PORT}`;
const RESOURCE = process.argv[2] ?? "/delegated/deliverable/inv-001";
const REPO = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

/** Refuse to run at all unless every child will be pinned to a local node. */
function assertLoopbackRpc(value: string): string {
    const url = new URL(parseNodeRpcUrl(value));
    if (!LOOPBACK.includes(url.hostname)) {
        throw new Error(
            `refusing to run: child RPC ${url.hostname} is not loopback — this would broadcast to GIWA`,
        );
    }
    return url.toString();
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

async function waitFor(
    label: string,
    probe: () => Promise<boolean>,
    timeoutMs = 120_000,
): Promise<void> {
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

const children: {name: string; proc: Bun.Subprocess}[] = [];

function spawnApp(
    name: string,
    cwd: string,
    entry: string,
    env: Record<string, string>,
): Bun.Subprocess {
    // The child loads its own .env for addresses and keys; these overrides win.
    const proc = Bun.spawn([process.execPath, "run", entry], {
        cwd,
        env: {PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env},
        stdout: "pipe",
        stderr: "pipe",
    });
    children.push({name, proc});
    // A piped stream nobody reads is worse than no stream: the child's diagnostics
    // vanish, and a chatty child can block once the pipe buffer fills. stderr is
    // near-silent in a healthy run, so forwarding it costs nothing and turns a
    // mystery failure into the facilitator's own rejection reason.
    void forwardStream(name, proc.stderr);
    return proc;
}

async function forwardStream(name: string, stream: ReadableStream<Uint8Array> | number | undefined) {
    if (!stream || typeof stream === "number") return;
    const decoder = new TextDecoder();
    try {
        for await (const chunk of stream) {
            for (const line of decoder.decode(chunk).split("\n")) {
                if (line.trim().length > 0) console.log(`[${name}] ${line}`);
            }
        }
    } catch {
        /* the child was killed during shutdown */
    }
}

function shutdown(): void {
    for (const {proc} of children) {
        try {
            proc.kill();
        } catch {
            /* already gone */
        }
    }
}

// Without this an interrupted run leaves anvil, the facilitator and the seller
// alive. The next run would then find their ports taken, fail to bind, and — since
// a stale anvil still answers with the right chain id — proceed against stale fork
// state while reporting success.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        shutdown();
        process.exit(130);
    });
}

/**
 * Refuse to start on an occupied port instead of quietly attaching to whatever is
 * already listening. `waitFor` only checks that *something* answers correctly, so a
 * leftover fork from an earlier run would pass every readiness probe.
 */
function assertPortFree(name: string, port: number): void {
    try {
        Bun.serve({port, hostname: "127.0.0.1", fetch: () => new Response("")}).stop(true);
    } catch {
        throw new Error(
            `port ${port} is already in use, so this run's ${name} cannot start. ` +
                "A process from an earlier run is probably still alive; this run would " +
                "otherwise talk to it and report stale state as fresh. Kill it and retry.",
        );
    }
}

function readRelayerAddress(): Address {
    const value = process.env.RELAYER_ADDRESS?.trim() ?? "";
    if (!isAddress(value)) {
        throw new Error("RELAYER_ADDRESS must be set (apps/delegation-lab/.env)");
    }
    return getAddress(value);
}

async function giwaNonce(relayer: Address): Promise<string> {
    // Read-only against the real chain. Used purely as no-broadcast evidence.
    //
    // Honours the same private-endpoint override as the fork source. Any provider
    // serving GIWA Sepolia answers this identically — it is one `eth_getTransactionCount`
    // against the live chain — and pinning it to the public endpoint meant the run's own
    // safety evidence was the one call that could 429 while everything else had a way out.
    const endpoint = parseNodeRpcUrl(
        process.env.GIWA_FORK_SOURCE_RPC_URL?.trim() || giwaSepolia.rpcUrls.default.http[0],
    );
    return (await rpc(endpoint, "eth_getTransactionCount", [relayer, "latest"])) as string;
}

/** The fork-side view the console and the period checks below both read from. */
async function loadForkContext(forkRpc: string) {
    const permissionPath =
        process.env.PARENT_PERMISSION_CONTEXT_PATH ??
        `${REPO}/apps/delegation-lab/open-agent.permission.json`;
    const permission = (await Bun.file(permissionPath).json()) as {permissionContext: Hex};
    const deployment = parseActiveDeploymentArtifactJson(
        await Bun.file(`${REPO}/deployments/giwa-sepolia.framework.json`).text(),
    );

    const chain = defineChain({
        id: giwaSepolia.id,
        name: "giwa-fork",
        nativeCurrency: giwaSepolia.nativeCurrency,
        rpcUrls: {default: {http: [forkRpc]}},
    });
    const publicClient = createPublicClient({chain, transport: http(forkRpc)}) as PublicClient;

    // The period cap lives on the root permission the owner signed, so the console
    // reports that delegation — not the per-payment leaf the agent minted.
    const root = decodeDelegations(permission.permissionContext).at(-1);
    if (!root) throw new Error("permission context has no root delegation");

    return {publicClient, deployment, root};
}

/**
 * Hold until a cap period has enough life left for both payments below.
 *
 * The over-cap proof assumes the 1.0 payment and the later 2.5 request fall in the
 * same 60s window. Wall-clock seconds pass between them, so a run that starts near
 * a boundary would see the allowance reset, settle the payment that was supposed to
 * be refused, and fail on an assertion that was never about the code under test.
 */
async function awaitFreshPeriod(forkRpc: string, marginSeconds: number): Promise<void> {
    const {publicClient, deployment, root} = await loadForkContext(forkRpc);
    const status = await readDelegationStatus({
        publicClient,
        environment: deployment.environment,
        delegation: root,
    });
    const limit = status.limit;
    if (!limit || limit.periodDuration === 0n) return;

    const {timestamp} = await publicClient.getBlock();
    if (timestamp < limit.startDate) return;
    const elapsed = (timestamp - limit.startDate) % limit.periodDuration;
    const left = Number(limit.periodDuration - elapsed);
    if (left > marginSeconds) return;

    console.log(`[e2e] ${left}s left in this cap period — waiting it out so the over-cap proof is deterministic`);
    await Bun.sleep((left + 1) * 1_000);
}

/**
 * Render what the D6 console would show for the root permission: the on-chain cap
 * and remaining period balance, the validity window, revocation state, and the
 * settlement receipts taken from the enforcer's own events.
 */
async function reportConsoleState(forkRpc: string, fromBlock: bigint): Promise<void> {
    const {publicClient, deployment, root} = await loadForkContext(forkRpc);

    const status = await readDelegationStatus({
        publicClient,
        environment: deployment.environment,
        delegation: root,
    });
    const receipts = await readSettlementReceipts({
        publicClient,
        environment: deployment.environment,
        delegationHash: status.delegationHash,
        // Only the fork's own blocks: the settlement we just made lives there, and
        // the upstream RPC rejects wider spans.
        fromBlock,
    });

    console.log("");
    console.log("[console] ── 위임/한도 ──────────────────────────────");
    console.log(`[console] delegator   ${status.delegator}`);
    console.log(`[console] delegate    ${status.delegate}`);
    if (status.limit) {
        console.log(
            `[console] cap         ${fromTokenAmount(status.limit.periodAmount)} mUSDC / ${status.limit.periodDuration}s`,
        );
    }
    if (status.remaining !== undefined) {
        console.log(
            `[console] remaining   ${fromTokenAmount(status.remaining)} mUSDC (period ${status.currentPeriod})`,
        );
    }
    if (status.validity) {
        console.log(`[console] expires     ${new Date(Number(status.validity.notAfter) * 1000).toISOString()}`);
    }
    console.log(`[console] revoked     ${status.revoked}  expired ${status.expired}`);

    console.log("[console] ── 영수증 ────────────────────────────────");
    if (receipts.length === 0) {
        console.log("[console] (none)");
    }
    for (const receipt of receipts) {
        // The event carries a running period total; the payment is the delta. Only
        // the first row in a window has no predecessor to subtract.
        const moved =
            receipt.amount !== undefined
                ? `paid ${fromTokenAmount(receipt.amount)}`
                : `spent-in-period ${fromTokenAmount(receipt.transferredInCurrentPeriod)}`;
        console.log(
            `[console] ${new Date(Number(receipt.transferTimestamp) * 1000).toISOString()}  ` +
                `${moved} mUSDC  tx ${receipt.transactionHash}`,
        );
    }
    if (receipts.length === 0) {
        throw new Error("expected the settlement to emit a TransferredInPeriod receipt");
    }
}

/**
 * Prove the safety mechanism, not just the happy path: revoke the root permission
 * and confirm the agent is stopped on-chain.
 *
 * `DeleGatorCore.disableDelegation` is `onlyEntryPointOrSelf`, so in production the
 * owner submits it as an EntryPoint UserOperation signed in their wallet. That
 * owner key is deliberately not on this machine, so the fork exercises the *Self*
 * branch by impersonating the smart account. What is being proven here is the
 * consequence — revoked delegations stop settling — not the wallet signature path.
 */
/**
 * Prove the Framework kill switch actually stops payments.
 *
 * Two layers should refuse a redemption while the manager is paused: our own
 * `verifyFrameworkOperationalState` gate, and the `whenNotPaused` modifier on
 * `redeemDelegations`. This exercises the first — the readiness cache is waited out
 * so the refusal is the gate's, not a lucky on-chain revert — and restores the
 * framework afterwards so the revocation proof that follows stays independent.
 */
async function provePauseStops(forkRpc: string, client: Client): Promise<void> {
    const {publicClient, deployment} = await loadForkContext(forkRpc);
    const manager = getAddress(deployment.environment.DelegationManager);
    const owner = (await publicClient.readContract({
        address: manager,
        abi: [
            {
                type: "function",
                name: "owner",
                inputs: [],
                outputs: [{type: "address"}],
                stateMutability: "view",
            },
        ],
        functionName: "owner",
    })) as Address;

    console.log("");
    console.log(`[pause] framework owner        ${owner}`);
    const setPaused = async (paused: boolean): Promise<void> => {
        await rpc(forkRpc, "anvil_setBalance", [owner, numberToHex(10n ** 18n)]);
        await rpc(forkRpc, "anvil_impersonateAccount", [owner]);
        const hash = (await rpc(forkRpc, "eth_sendTransaction", [
            {
                from: owner,
                to: manager,
                // pause() / unpause() — no arguments, so the selector is the calldata.
                data: encodeFunctionData({
                    abi: [
                        {
                            type: "function",
                            name: paused ? "pause" : "unpause",
                            inputs: [],
                            outputs: [],
                            stateMutability: "nonpayable",
                        },
                    ],
                    functionName: paused ? "pause" : "unpause",
                }),
                gas: numberToHex(200_000n),
            },
        ])) as Hex;
        await publicClient.waitForTransactionReceipt({hash});
        await rpc(forkRpc, "anvil_stopImpersonatingAccount", [owner]);
    };

    await setPaused(true);
    console.log("[pause] DelegationManager      paused");

    // The facilitator caches its readiness verdict for 5s; wait it out so the
    // refusal below comes from the gate rather than from a stale-cache round trip.
    await Bun.sleep(6_000);
    const health = (await (await fetch(`${FACILITATOR_URL}/health`)).json()) as {
        ok?: boolean;
        frameworkError?: string | null;
    };
    console.log(`[pause] facilitator health     ok=${health.ok}`);
    console.log(`[pause] facilitator reason     ${health.frameworkError}`);
    if (health.ok !== false) throw new Error("facilitator reported healthy while paused");
    // Not just unhealthy — it has to say which dependency failed, or an operator
    // cannot tell a pause from an RPC outage.
    if (!health.frameworkError?.includes("not operationally active")) {
        throw new Error(`health did not explain the pause: ${String(health.frameworkError)}`);
    }

    const attempt = await client.callTool({
        name: "mapae_pay_for_resource",
        arguments: {resource: RESOURCE},
    });
    const body = JSON.parse(
        (attempt as {content?: {type: string; text?: string}[]}).content?.[0]?.text ?? "{}",
    ) as Record<string, unknown>;
    if (body.ok === true) throw new Error("payment succeeded while the Framework was paused");
    console.log(`[pause] refused                ${String(body.code)} ${String(body.status ?? "")}`);
    console.log("[pause] PASS — a paused Framework stops the agent ✅");

    await setPaused(false);
    await Bun.sleep(6_000); // let the readiness cache pick the framework back up
    console.log("[pause] unpaused — restored for the revocation proof");
}

async function proveRevocationStops(
    forkRpc: string,
    client: Client,
): Promise<void> {
    const permissionPath =
        process.env.PARENT_PERMISSION_CONTEXT_PATH ??
        `${REPO}/apps/delegation-lab/open-agent.permission.json`;
    const permission = (await Bun.file(permissionPath).json()) as {permissionContext: Hex};
    const deployment = parseActiveDeploymentArtifactJson(
        await Bun.file(`${REPO}/deployments/giwa-sepolia.framework.json`).text(),
    );
    const chain = defineChain({
        id: giwaSepolia.id,
        name: "giwa-fork",
        nativeCurrency: giwaSepolia.nativeCurrency,
        rpcUrls: {default: {http: [forkRpc]}},
    });
    const publicClient = createPublicClient({chain, transport: http(forkRpc)}) as PublicClient;

    const root = decodeDelegations(permission.permissionContext).at(-1);
    if (!root) throw new Error("permission context has no root delegation");
    const delegationManager = getAddress(deployment.environment.DelegationManager);

    const before = await isDelegationRevoked({publicClient, delegationManager, delegation: root});
    console.log("");
    console.log(`[revoke] revoked before        ${before}`);
    if (before) throw new Error("root permission was already revoked before the test");

    const call = buildRevocationCall(root);
    await rpc(forkRpc, "anvil_setBalance", [call.to, numberToHex(10n ** 18n)]);
    await rpc(forkRpc, "anvil_impersonateAccount", [call.to]);
    const txHash = (await rpc(forkRpc, "eth_sendTransaction", [
        {from: call.to, to: call.to, data: call.data, gas: numberToHex(500_000n)},
    ])) as Hex;
    await publicClient.waitForTransactionReceipt({hash: txHash});
    await rpc(forkRpc, "anvil_stopImpersonatingAccount", [call.to]);
    console.log(`[revoke] disableDelegation tx  ${txHash}`);

    const after = await isDelegationRevoked({publicClient, delegationManager, delegation: root});
    console.log(`[revoke] revoked after         ${after}`);
    if (!after) throw new Error("revocation did not take effect on chain");

    // The console's own read must agree — this is what the delegation screen shows.
    const status = await readDelegationStatus({
        publicClient,
        environment: deployment.environment,
        delegation: root,
    });
    if (!status.revoked) throw new Error("console status read disagrees with the chain");
    console.log("[revoke] console status        회수됨");

    console.log("[revoke] retrying the same MCP payment — it must now be refused");
    const retry = await client.callTool({
        name: "mapae_pay_for_resource",
        arguments: {resource: RESOURCE},
    });
    const retryText =
        (retry as {content?: {type: string; text?: string}[]}).content?.[0]?.text ?? "";
    const retryBody = JSON.parse(retryText) as Record<string, unknown>;
    if (retryBody.ok !== false) {
        throw new Error("a revoked permission still settled — the safety model is broken");
    }
    console.log(
        `[revoke] refused               ${String(retryBody.code)} ${String(retryBody.status ?? "")}`,
    );
    console.log(`[revoke] reason                ${String(retryBody.detail)}`);
    console.log("[revoke] PASS — revocation stops the agent on-chain ✅");
}

async function main(): Promise<void> {
    const forkRpc = assertLoopbackRpc(FORK_RPC);
    const relayer = readRelayerAddress();
    const upstream = parseNodeRpcUrl(
        process.env.GIWA_FORK_SOURCE_RPC_URL?.trim() || giwaSepolia.rpcUrls.default.http[0],
    );

    console.log("[e2e] no-broadcast guard: children pinned to", forkRpc);
    assertPortFree("fork", ANVIL_PORT);
    assertPortFree("facilitator", FACILITATOR_PORT);
    assertPortFree("seller", SELLER_PORT);

    const nonceBefore = await giwaNonce(relayer);
    console.log(`[e2e] relayer GIWA nonce before  ${BigInt(nonceBefore)}`);

    console.log(`[e2e] forking GIWA → ${forkRpc}`);
    const anvil = Bun.spawn(
        ["anvil", "--fork-url", upstream, "--port", String(ANVIL_PORT), "--silent"],
        {stdout: "ignore", stderr: "pipe"},
    );
    children.push({name: "anvil", proc: anvil});
    await waitFor("anvil", async () => {
        const id = (await rpc(forkRpc, "eth_chainId")) as string;
        return Number(BigInt(id)) === giwaSepolia.id;
    });
    console.log(`[e2e] fork ready, chainId ${giwaSepolia.id} (real Framework bytecode)`);
    const forkBaseBlock = BigInt((await rpc(forkRpc, "eth_blockNumber")) as string);

    // The relayer pays gas on the fork only; top it up so a low live balance
    // cannot make this run flaky. Fork-local, never touches GIWA.
    await rpc(forkRpc, "anvil_setBalance", [relayer, numberToHex(10n ** 18n)]);

    spawnApp("facilitator", `${REPO}/apps/facilitator-erc7710`, "index.ts", {
        GIWA_SEPOLIA_RPC_URL: forkRpc,
        HOST: "127.0.0.1",
        PORT: String(FACILITATOR_PORT),
        // Set SETTLEMENT_RECEIPT_TIMEOUT_MS=1 to force the broadcast-but-unconfirmed
        // path: the seller must answer 504 settlement_unknown, never 422.
        ...(process.env.SETTLEMENT_RECEIPT_TIMEOUT_MS
            ? {SETTLEMENT_RECEIPT_TIMEOUT_MS: process.env.SETTLEMENT_RECEIPT_TIMEOUT_MS}
            : {}),
    });
    await waitFor("facilitator", async () =>
        (await fetch(`${FACILITATOR_URL}/supported`, {signal: AbortSignal.timeout(5_000)})).ok,
    );
    // /health is a separate code path from the /supported readiness probe above and
    // reports each dependency it could not reach, so assert it rather than assume.
    const health = (await (
        await fetch(`${FACILITATOR_URL}/health`, {signal: AbortSignal.timeout(10_000)})
    ).json()) as {ok?: boolean; relayerFunded?: boolean | null; frameworkPaused?: boolean | null};
    if (health.ok !== true || health.relayerFunded !== true) {
        throw new Error(`facilitator reported unhealthy: ${JSON.stringify(health)}`);
    }
    console.log(
        `[e2e] facilitator up on ${FACILITATOR_URL} — health ok, framework paused ${health.frameworkPaused}`,
    );

    spawnApp("seller", `${REPO}/apps/delegated-seller`, "index.ts", {
        GIWA_SEPOLIA_RPC_URL: forkRpc,
        HOST: "127.0.0.1",
        PORT: String(SELLER_PORT),
        BASE_URL: SELLER_URL,
        FACILITATOR_URL,
    });
    await waitFor("seller", async () =>
        (await fetch(`${SELLER_URL}/health`, {signal: AbortSignal.timeout(5_000)})).ok,
    );
    console.log(`[e2e] seller up on ${SELLER_URL}`);

    // The MCP server runs with the delegated agent's cwd so it inherits that
    // app's .env (session key, artifact paths, parent permission) unchanged.
    const client = new Client({name: "mapae-e2e", version: "0.0.0"});
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [`${REPO}/apps/agent-mcp/index.ts`],
        cwd: `${REPO}/apps/delegated-agent`,
        env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            GIWA_SEPOLIA_RPC_URL: forkRpc,
            SELLER_URL,
            FACILITATOR_URL,
        },
        stderr: "inherit",
    });
    await client.connect(transport);
    console.log("[e2e] MCP server connected");

    // Both payments have to share one cap period for the over-cap proof to mean
    // anything; 30s of the 60s window is ample for the two calls.
    await awaitFreshPeriod(forkRpc, 30);

    console.log(`[e2e] calling mapae_pay_for_resource ${RESOURCE} — no human in the loop`);
    const call = await client.callTool({
        name: "mapae_pay_for_resource",
        arguments: {resource: RESOURCE},
    });
    const content = (call as {content?: {type: string; text?: string}[]}).content ?? [];
    const text = content[0]?.text ?? "";

    const body = JSON.parse(text) as Record<string, unknown>;
    if (body.ok !== true) {
        await transport.close();
        console.error("[e2e] FAILED —", JSON.stringify(body, null, 2));
        throw new Error(`payment did not complete: ${String(body.code)}`);
    }

    // D6 data layer: the console's two screens, read from the state this payment
    // just produced. Nothing here is stored off-chain.
    await reportConsoleState(forkRpc, forkBaseBlock);

    // D5 pre-flight: 1.0 is already spent against a 3.0/60s cap, so a 2.5 payment
    // cannot fit. The agent must say so from the chain's own accounting instead of
    // walking into the seller and reporting a status code.
    console.log("");
    console.log("[preflight] requesting inv-002 (2.5) — 1.0 already spent of a 3.0 cap");
    const overCap = await client.callTool({
        name: "mapae_pay_for_resource",
        arguments: {resource: "/delegated/deliverable/inv-002"},
    });
    const overCapBody = JSON.parse(
        (overCap as {content?: {type: string; text?: string}[]}).content?.[0]?.text ?? "{}",
    ) as Record<string, unknown>;
    if (overCapBody.code !== "LIMIT_EXCEEDED") {
        throw new Error(
            `expected LIMIT_EXCEEDED before payment, got ${String(overCapBody.code)}`,
        );
    }
    console.log(`[preflight] refused            ${String(overCapBody.code)}`);
    console.log(`[preflight] reason             ${String(overCapBody.detail)}`);

    // Framework-level kill switch, then the per-delegation one.
    await provePauseStops(forkRpc, client);

    // D6 safety model: revoke, then prove the same call is refused.
    await proveRevocationStops(forkRpc, client);
    await transport.close();

    const nonceAfter = await giwaNonce(relayer);
    console.log("");
    console.log(`[e2e] resource     ${JSON.stringify(body.resource)}`);
    console.log(`[e2e] amount       ${String(body.amount)} → ${String(body.payTo)}`);
    console.log(`[e2e] transaction  ${String(body.transaction)} (fork)`);
    console.log(`[e2e] relayer GIWA nonce after   ${BigInt(nonceAfter)}`);
    if (BigInt(nonceAfter) !== BigInt(nonceBefore)) {
        throw new Error("GIWA relayer nonce moved — a real broadcast escaped the fork");
    }
    console.log("[e2e] GIWA nonce unchanged → nothing was broadcast to GIWA ✅");
    console.log("");
    console.log("[e2e] PASS — one MCP call completed 402 → sign → settle → resource");
}

try {
    await main();
} catch (error) {
    console.error(`[e2e] ${redactForLog(error)}`);
    process.exitCode = 1;
} finally {
    shutdown();
}
