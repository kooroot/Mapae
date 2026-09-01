/**
 * D5 완료판정 증명 — MCP tool 한 번 호출로 사람 개입 0으로 완주.
 *
 *   402 → 한도 안에서 leaf 서명 → facilitator 정산 → 티켓 + tx
 *
 * 판매자는 호스티드 상점이다: 임시 STORE_PATH에 데모 상점을 시드하고, 아메리카노를
 * 두 번, 같은 값의 로고 시안을 한 번 산 뒤 주문 장부를 상점 파일에서 직접 읽어
 * 세 주문이 서로 다른 intent로 적혔는지 확인한다.
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
    readRenamedEnv,
} from "@mapae/delegation";
import {
    assertRpcTarget,
    fromTokenAmount,
    giwaSepolia,
    parseNodeRpcUrl,
    redactForLog,
} from "@mapae/shared";
import {startForkSourceProxy} from "./fork-source-proxy";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {decodeDelegations} from "@metamask/smart-accounts-kit/utils";
import {Database} from "bun:sqlite";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
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

/**
 * Opt-in: forces the broadcast-but-unconfirmed path instead of the happy path.
 * See `proveUnconfirmedIsNotRejected`.
 */
const FORCED_UNCONFIRMED = Boolean(process.env.SETTLEMENT_RECEIPT_TIMEOUT_MS);

const ANVIL_PORT = 8546;
const FACILITATOR_PORT = 8181;
const SELLER_PORT = 3101;
const FORK_RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const FACILITATOR_URL = `http://127.0.0.1:${FACILITATOR_PORT}`;
const SELLER_URL = `http://127.0.0.1:${SELLER_PORT}`;
const REPO = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

/**
 * The seeded shops (`apps/delegated-seller/seed.ts`). The cap arithmetic below is
 * written against these prices: three 1.00 payments fill a 3.0/60s cap exactly, and
 * the 2.50 croissant is the request that cannot fit afterwards.
 */
const AMERICANO = "/s/demo-cafe/americano";
/** Same price and same payTo as the americano — the intent differs only by the leaf. */
const LOGO = "/s/demo-studio/logo";
const CROISSANT = "/s/demo-cafe/croissant";
const ONE_TUSDC_BASE = "1000000";

/** Refuse to run at all unless every child will be pinned to a local node. */
const assertLoopbackRpc = (value: string): string =>
    assertRpcTarget(value, "loopback", "this would broadcast to GIWA");

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
/** Loopback listeners this run owns — closed alongside the children on any exit path. */
const listeners: {stop(): void}[] = [];
/** The temp directory holding this run's store file — removed with the children. */
let storeDir: string | undefined;

function childEnv(overrides: Record<string, string>): Record<string, string> {
    return {PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...overrides};
}

function spawnApp(
    name: string,
    cwd: string,
    entry: string,
    env: Record<string, string>,
): Bun.Subprocess {
    // The child loads its own .env for addresses and keys; these overrides win.
    const proc = Bun.spawn([process.execPath, "run", entry], {
        cwd,
        env: childEnv(env),
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
    for (const listener of listeners) {
        try {
            listener.stop();
        } catch {
            /* already closed */
        }
    }
    if (storeDir) rmSync(storeDir, {recursive: true, force: true});
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
    // The settlement signer's global name; the deprecated RELAYER_ADDRESS spelling
    // still reads, with a warning, so an old lab .env survives the rename.
    const value =
        readRenamedEnv({current: "FACILITATOR_SIGNER_ADDRESS", legacy: "RELAYER_ADDRESS"}) ?? "";
    if (!isAddress(value)) {
        throw new Error("FACILITATOR_SIGNER_ADDRESS must be set (apps/delegation-lab/.env)");
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
 * Seconds until the root permission's current cap period ends, or `undefined` when
 * the permission carries no period cap (or it has not started).
 *
 * A fork mines only when something is sent, so the head block's timestamp — the clock
 * the enforcer reads — lags wall time by however long the run has idled. An empty
 * block pins it to now before the arithmetic; otherwise a reading taken after the
 * services booted would overstate what is left by the boot time.
 */
async function periodSecondsLeft(forkRpc: string): Promise<number | undefined> {
    await rpc(forkRpc, "evm_mine");
    const {publicClient, deployment, root} = await loadForkContext(forkRpc);
    const status = await readDelegationStatus({
        publicClient,
        environment: deployment.environment,
        delegation: root,
    });
    const limit = status.limit;
    if (!limit || limit.periodDuration === 0n) return undefined;

    const {timestamp} = await publicClient.getBlock();
    if (timestamp < limit.startDate) return undefined;
    const elapsed = (timestamp - limit.startDate) % limit.periodDuration;
    return Number(limit.periodDuration - elapsed);
}

/**
 * Hold until a cap period has at least `neededSeconds` of life left.
 *
 * The over-cap proof assumes the three 1.0 payments and the later 2.5 request fall in
 * the same 60s window. Wall-clock seconds pass between them, so a run that starts near
 * a boundary would see the allowance reset, settle the payment that was supposed to
 * be refused, and fail on an assertion that was never about the code under test.
 */
async function awaitFreshPeriod(forkRpc: string, neededSeconds: number): Promise<void> {
    const left = await periodSecondsLeft(forkRpc);
    if (left === undefined || left > neededSeconds) return;
    console.log(`[e2e] ${left}s left in this cap period — waiting it out so the over-cap proof is deterministic`);
    await Bun.sleep((left + 1) * 1_000);
}

/**
 * Hold until the next cap period begins, whatever is left of this one.
 *
 * Once the cap is spent, every later payment is refused by pre-flight as
 * `LIMIT_EXCEEDED` before it reaches the seller — and a kill-switch proof that sees
 * that refusal has proven nothing about the switch. The two proofs below need a
 * payment the cap would otherwise allow.
 */
async function awaitNextPeriod(forkRpc: string): Promise<void> {
    const left = await periodSecondsLeft(forkRpc);
    if (left === undefined) return;
    console.log(`[e2e] cap spent — waiting ${left}s for the next period so the kill-switch proofs are not the cap's`);
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
        // Only the fork's own blocks: the settlements we just made live there, and
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
        throw new Error("expected the settlements to emit TransferredInPeriod receipts");
    }
}

/** What `mapae_pay_for_resource` answers, as the agent's JSON text. */
type ToolBody = Record<string, unknown>;

async function pay(client: Client, resource: string): Promise<ToolBody> {
    const call = await client.callTool({
        name: "mapae_pay_for_resource",
        arguments: {resource},
    });
    const text = (call as {content?: {type: string; text?: string}[]}).content?.[0]?.text ?? "{}";
    return JSON.parse(text) as ToolBody;
}

/** The shop's answer, as the agent relays it inside a successful result. */
interface Ticket {
    ticket: {order: number; shop: {slug: string}; item: {key: string}};
    receipt: {intent: string; transaction?: string};
}

function ticketOf(body: ToolBody, resource: string): Ticket {
    if (body.ok !== true) {
        console.error("[e2e] FAILED —", JSON.stringify(body, null, 2));
        throw new Error(`payment for ${resource} did not complete: ${String(body.code)}`);
    }
    const answer = body.resource as Partial<Ticket> | undefined;
    if (
        typeof answer?.ticket?.order !== "number" ||
        typeof answer.ticket.shop?.slug !== "string" ||
        typeof answer.ticket.item?.key !== "string" ||
        typeof answer.receipt?.intent !== "string"
    ) {
        throw new Error(`${resource} answered something other than a ticket: ${JSON.stringify(body.resource)}`);
    }
    return answer as Ticket;
}

async function payForTicket(client: Client, resource: string): Promise<Ticket> {
    console.log(`[e2e] calling mapae_pay_for_resource ${resource} — no human in the loop`);
    const body = await pay(client, resource);
    const ticket = ticketOf(body, resource);
    console.log(
        `[e2e] ticket #${ticket.ticket.order}  ${ticket.ticket.shop.slug}/${ticket.ticket.item.key}  ${String(body.amount)} → ${String(body.payTo)}  tx ${String(body.transaction)}`,
    );
    return ticket;
}

/**
 * The seed is the operator's command, run exactly as the runbook runs it: the seller's
 * own directory, so `PAY_TO` comes from that app's .env — the address the shop will
 * quote — and only the store path is this run's.
 */
async function seedStore(storePath: string): Promise<void> {
    const proc = Bun.spawn([process.execPath, "run", "seed.ts"], {
        cwd: `${REPO}/apps/delegated-seller`,
        env: childEnv({STORE_PATH: storePath}),
        stdout: "inherit",
        stderr: "inherit",
    });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`seed exited with ${code}`);
}

interface OrderRow {
    id: number;
    seller_slug: string;
    item_key: string;
    payment_intent_id: string;
    payer: string;
    amount_base: string;
    tx_hash: string | null;
    status: string;
}

/**
 * A second, read-only connection to the file the seller is writing — what a
 * reconciliation script on the operator's machine would open, not what the running
 * app reports about itself.
 */
function readOrders(storePath: string): OrderRow[] {
    const db = new Database(storePath, {readonly: true});
    try {
        return db
            .query<OrderRow, []>(
                "SELECT id, seller_slug, item_key, payment_intent_id, payer, amount_base, tx_hash, status " +
                    "FROM orders ORDER BY id",
            )
            .all();
    } finally {
        db.close();
    }
}

/**
 * The orders table is the double-delivery guard, so its rows are the claim: one row
 * per settlement, keyed by an intent the leaf made unique — including for the logo,
 * whose price and payee are the americano's.
 */
function proveOrdersLedger(storePath: string, tickets: Ticket[]): void {
    const rows = readOrders(storePath);
    console.log("");
    console.log(`[orders] ${storePath}`);
    for (const row of rows) {
        console.log(
            `[orders] #${row.id}  ${row.seller_slug}/${row.item_key}  ${row.amount_base}  ${row.status}  intent ${row.payment_intent_id.slice(0, 12)}…  tx ${row.tx_hash}`,
        );
    }
    const expected = [
        {slug: "demo-cafe", key: "americano"},
        {slug: "demo-cafe", key: "americano"},
        {slug: "demo-studio", key: "logo"},
    ];
    if (rows.length !== expected.length) {
        throw new Error(`expected ${expected.length} orders rows, found ${rows.length}`);
    }
    rows.forEach((row, index) => {
        const want = expected[index];
        const ticket = tickets[index];
        if (!want || !ticket) throw new Error("orders assertion table is shorter than the rows");
        if (row.seller_slug !== want.slug || row.item_key !== want.key) {
            throw new Error(`row #${row.id} is ${row.seller_slug}/${row.item_key}, expected ${want.slug}/${want.key}`);
        }
        if (row.id !== ticket.ticket.order) {
            throw new Error(`row #${row.id} was served as ticket #${ticket.ticket.order}`);
        }
        if (row.payment_intent_id !== ticket.receipt.intent) {
            throw new Error(`row #${row.id} intent differs from the ticket's receipt`);
        }
        if (row.tx_hash !== (ticket.receipt.transaction ?? null)) {
            throw new Error(`row #${row.id} tx differs from the ticket's receipt`);
        }
        if (row.amount_base !== ONE_TUSDC_BASE || row.status !== "paid") {
            throw new Error(`row #${row.id} is ${row.amount_base} ${row.status}, expected ${ONE_TUSDC_BASE} paid`);
        }
    });
    if (new Set(rows.map((row) => row.payment_intent_id)).size !== rows.length) {
        throw new Error("two orders share a payment intent — a replay was recorded as a sale");
    }
    if (new Set(rows.map((row) => row.tx_hash)).size !== rows.length) {
        throw new Error("two orders share a settlement transaction");
    }
    if (new Set(rows.map((row) => row.payer)).size !== 1) {
        throw new Error("the three orders name different payers, but one delegator paid");
    }
    console.log("[orders] PASS — three settlements, three intents, the same-price logo included ✅");
}

/**
 * Set `SETTLEMENT_RECEIPT_TIMEOUT_MS=1` and the facilitator gives up on the receipt of a
 * transaction it has already broadcast. That is the one case where the payer is charged
 * and nobody can yet say so, and the seller must answer 504 `settlement_unknown` — never
 * 422, which asserts a balance nobody checked.
 *
 * The knob existed before this function and only forwarded the variable. Setting it made
 * the run *fail* at the `body.ok !== true` guard, so the escape hatch that was documented
 * as the way to exercise this path could not be used to exercise it.
 *
 * The status code alone would be a weak assertion — a seller that answered 504 for
 * everything would pass it. So this also reads the enforcer's own event from the fork:
 * the money really moved, and the answer was still honest about not knowing. And the
 * store must hold no order: a ticket for a payment nobody confirmed is a free item.
 */
async function proveUnconfirmedIsNotRejected(
    body: ToolBody,
    forkRpc: string,
    fromBlock: bigint,
    storePath: string,
): Promise<void> {
    console.log("");
    console.log("[unconfirmed] SETTLEMENT_RECEIPT_TIMEOUT_MS is set — receipt wait forced to give up");
    if (body.ok !== false || body.code !== "SETTLEMENT_UNKNOWN") {
        console.error("[unconfirmed] FAILED —", JSON.stringify(body, null, 2));
        throw new Error(
            `expected SETTLEMENT_UNKNOWN, got ok=${String(body.ok)} code=${String(body.code)}`,
        );
    }
    console.log(`[unconfirmed] agent code       ${String(body.code)}`);
    console.log(`[unconfirmed] agent detail     ${String(body.detail)}`);

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
        fromBlock,
    });
    if (receipts.length === 0) {
        throw new Error(
            "no settlement event on the fork — nothing was charged, so 504 was not the honest answer",
        );
    }
    const [settled] = receipts;
    console.log(
        `[unconfirmed] on-chain         ${settled?.amount !== undefined ? fromTokenAmount(settled.amount) : "?"} mUSDC moved anyway`,
    );
    const rows = readOrders(storePath);
    if (rows.length !== 0) {
        throw new Error(`the shop recorded ${rows.length} order(s) for a settlement it answered 504 to`);
    }
    console.log("[unconfirmed] orders rows      0 — no ticket for a payment nobody confirmed");
    console.log("[unconfirmed] PASS — payer was charged and the answer said so ✅");
}

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

    const body = await pay(client, AMERICANO);
    if (body.ok === true) throw new Error("payment succeeded while the Framework was paused");
    // Pre-flight knows nothing of the pause, so a refusal it would give — the cap, the
    // permission — means the request never reached the paused facilitator.
    if (["LIMIT_EXCEEDED", "PERMISSION_INACTIVE", "PERMISSION_EMPTY"].includes(String(body.code))) {
        throw new Error(`refused by pre-flight (${String(body.code)}), not by the paused Framework`);
    }
    console.log(`[pause] refused                ${String(body.code)} ${String(body.status ?? "")}`);
    console.log("[pause] PASS — a paused Framework stops the agent ✅");

    await setPaused(false);
    await Bun.sleep(6_000); // let the readiness cache pick the framework back up
    console.log("[pause] unpaused — restored for the revocation proof");
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
async function proveRevocationStops(forkRpc: string, client: Client): Promise<void> {
    const {publicClient, deployment, root} = await loadForkContext(forkRpc);
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
    const retry = await pay(client, AMERICANO);
    if (retry.ok !== false) {
        throw new Error("a revoked permission still settled — the safety model is broken");
    }
    // The agent reads the same revocation flag the console just did, before signing
    // anything — so the refusal has to be pre-flight's, by name.
    if (retry.code !== "PERMISSION_INACTIVE") {
        throw new Error(`expected PERMISSION_INACTIVE from pre-flight, got ${String(retry.code)}`);
    }
    console.log(`[revoke] refused               ${String(retry.code)} ${String(retry.status ?? "")}`);
    console.log(`[revoke] reason                ${String(retry.detail)}`);
    console.log("[revoke] PASS — revocation stops the agent on-chain ✅");
}

/**
 * Everything this run needs, checked together before anything is spawned.
 *
 * This command is what the README points a reader at, so its first failure is the first
 * thing many people see of the project. Without this it reported them one at a time and
 * in the worst possible order: `FACILITATOR_SIGNER_ADDRESS must be set` first, then — only after
 * anvil had forked GIWA over the network, some fifteen seconds in — a child process died
 * and printed a *source listing* of `apps/facilitator-erc7710/index.ts` around the line
 * that throws, with the actual missing thing (`FACILITATOR_SIGNER_PRIVATE_KEY`, in that app's own
 * `.env`) buried in it. Measured from a clean clone, not imagined.
 *
 * Two properties matter more than the wording. It runs before the fork, so a missing
 * `.env` costs no network round trip. And it collects *all* of them, so filling one in
 * does not just buy you the next stack trace.
 *
 * The child `.env` files are checked for existence rather than contents. Reading their
 * variables from here would put a second copy of each app's requirements in this file,
 * and a copy that drifts is worse than a check that stops one step short.
 */
async function assertPrerequisites(): Promise<void> {
    const missing: string[] = [];

    if (!process.env.FACILITATOR_SIGNER_ADDRESS?.trim() && !process.env.RELAYER_ADDRESS?.trim()) {
        missing.push("FACILITATOR_SIGNER_ADDRESS is unset — see apps/delegation-lab/.env.example");
    }
    const permissionPath =
        process.env.PARENT_PERMISSION_CONTEXT_PATH ??
        `${REPO}/apps/delegation-lab/open-agent.permission.json`;
    if (!(await Bun.file(permissionPath).exists())) {
        missing.push(
            `${permissionPath} is absent — a root permission signed by the account owner's ` +
                "wallet. It is gitignored, so a clone never has one",
        );
    }
    for (const app of ["facilitator-erc7710", "delegated-seller"]) {
        if (!(await Bun.file(`${REPO}/apps/${app}/.env`).exists())) {
            missing.push(`apps/${app}/.env is absent — copy .env.example and fill it in`);
        }
    }
    if (missing.length === 0) return;

    console.error("[e2e] cannot start — this run replays a specific deployment:");
    for (const item of missing) console.error(`  ✗ ${item}`);
    console.error("");
    console.error("  Setup: docs/giwa-demo-runbook.md");
    console.error("  To exercise the same enforcement with nothing of ours, run");
    console.error("  `bun run test:negative` — hermetic, no keys, no signed permission.");
    process.exit(1);
}

async function main(): Promise<void> {
    await assertPrerequisites();
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
    // The key never reaches argv — `--fork-url` has no env alias, and argv is readable
    // through `ps`. A loopback proxy holds it and hands anvil a keyless address.
    const source = startForkSourceProxy(upstream);
    listeners.push(source);
    const anvil = Bun.spawn(
        ["anvil", "--fork-url", source.url, "--port", String(ANVIL_PORT), "--silent"],
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

    // A store this run owns: seeded by the operator's command, read back as a file.
    storeDir = mkdtempSync(join(tmpdir(), "mapae-e2e-"));
    const storePath = join(storeDir, "seller.sqlite");
    await seedStore(storePath);
    spawnApp("seller", `${REPO}/apps/delegated-seller`, "index.ts", {
        HOST: "127.0.0.1",
        PORT: String(SELLER_PORT),
        FACILITATOR_URL,
        STORE_PATH: storePath,
    });
    await waitFor("seller", async () =>
        (await fetch(`${SELLER_URL}/health`, {signal: AbortSignal.timeout(5_000)})).ok,
    );
    console.log(`[e2e] seller up on ${SELLER_URL} — store ${storePath}`);

    // The MCP server runs with the delegated agent's cwd so it inherits that
    // app's .env (session key, artifact paths, parent permission) unchanged.
    const client = new Client({name: "mapae-e2e", version: "0.0.0"});
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [`${REPO}/apps/agent-mcp/index.ts`],
        cwd: `${REPO}/apps/delegated-agent`,
        env: childEnv({GIWA_SEPOLIA_RPC_URL: forkRpc, SELLER_URL, FACILITATOR_URL}),
        stderr: "inherit",
    });
    await client.connect(transport);
    console.log("[e2e] MCP server connected");

    // The three payments and the over-cap request have to share one cap period for
    // the over-cap proof to mean anything; 50s of the 60s window is ample for them.
    await awaitFreshPeriod(forkRpc, 50);

    const firstBody = await pay(client, AMERICANO);
    if (FORCED_UNCONFIRMED) {
        await proveUnconfirmedIsNotRejected(firstBody, forkRpc, forkBaseBlock, storePath);
        await transport.close();
        // Everything below needs a payment that was *answered*. This run deliberately
        // has none, and the cap it consumed is real, so continuing would report
        // failures that belong to the setup rather than to the code.
        console.log("");
        console.log("[e2e] PASS — a broadcast-but-unconfirmed settlement answers 504");
        return;
    }
    const first = ticketOf(firstBody, AMERICANO);
    console.log(`[e2e] ticket #${first.ticket.order}  ${first.ticket.shop.slug}/${first.ticket.item.key}  tx ${String(firstBody.transaction)}`);
    // The same item again: a fresh leaf, so a fresh intent and a second ticket — not
    // the first one replayed.
    const second = await payForTicket(client, AMERICANO);
    // Another shop's item at the americano's price and payee. The intent is bound to
    // the amount and payTo, not the item, so only the leaf tells these apart.
    const third = await payForTicket(client, LOGO);

    // D6 data layer: the console's two screens, read from the state these payments
    // just produced. Nothing here is stored off-chain.
    await reportConsoleState(forkRpc, forkBaseBlock);

    // The shop's own ledger, read from the file.
    proveOrdersLedger(storePath, [first, second, third]);

    // D5 pre-flight: 3.0 is already spent against a 3.0/60s cap, so a 2.5 payment
    // cannot fit. The agent must say so from the chain's own accounting instead of
    // walking into the seller and reporting a status code.
    console.log("");
    console.log(`[preflight] requesting ${CROISSANT} (2.5) — 3.0 already spent of a 3.0 cap`);
    const overCap = await pay(client, CROISSANT);
    if (overCap.code !== "LIMIT_EXCEEDED") {
        throw new Error(`expected LIMIT_EXCEEDED before payment, got ${String(overCap.code)}`);
    }
    console.log(`[preflight] refused            ${String(overCap.code)}`);
    console.log(`[preflight] reason             ${String(overCap.detail)}`);

    // Both kill-switch proofs pay again, so they need a period the cap allows.
    await awaitNextPeriod(forkRpc);

    // Framework-level kill switch, then the per-delegation one.
    await provePauseStops(forkRpc, client);

    // D6 safety model: revoke, then prove the same call is refused.
    await proveRevocationStops(forkRpc, client);
    await transport.close();

    const nonceAfter = await giwaNonce(relayer);
    console.log("");
    console.log(`[e2e] tickets      #${first.ticket.order} #${second.ticket.order} #${third.ticket.order} (${AMERICANO} ×2, ${LOGO})`);
    console.log(`[e2e] amount       ${String(firstBody.amount)} → ${String(firstBody.payTo)} each`);
    console.log(`[e2e] relayer GIWA nonce after   ${BigInt(nonceAfter)}`);
    if (BigInt(nonceAfter) !== BigInt(nonceBefore)) {
        throw new Error("GIWA relayer nonce moved — a real broadcast escaped the fork");
    }
    console.log("[e2e] GIWA nonce unchanged → nothing was broadcast to GIWA ✅");
    console.log("");
    console.log("[e2e] PASS — three MCP calls completed 402 → sign → settle → ticket");
}

try {
    await main();
} catch (error) {
    console.error(`[e2e] ${redactForLog(error)}`);
    process.exitCode = 1;
} finally {
    shutdown();
}
