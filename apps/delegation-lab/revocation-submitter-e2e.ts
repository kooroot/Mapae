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
    buildRevocationSubmissionBody,
    buildRevocationUserOperation,
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

function shutdown(): void {
    for (const {proc} of children) {
        try {
            proc.kill();
        } catch {
            /* already gone */
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
    const anvil = Bun.spawn(
        [
            "anvil",
            "--port",
            String(ANVIL_PORT),
            "--silent",
            "--fork-url",
            upstream,
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
    console.log(
        `[e2e] A unfunded       409 prefund_short (short ${unfunded.body.detail?.["shortfall"]} wei) ✅`,
    );

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
    console.log(`[e2e] B foreign sender 400 invalid_submission ✅`);

    // ── C. the real thing ─────────────────────────────────────────────────────────────
    const relayerBefore = await publicClient.getBalance({address: relayer.address});
    const ok = await postRevoke(body);
    if (ok.status !== 200 || !ok.body.success || !ok.body.transaction) {
        throw new Error(`revocation failed: ${ok.status} ${JSON.stringify(ok.body)}`);
    }
    if (!(await revoked())) {
        throw new Error("submitter reported success but the delegation is still enabled");
    }
    console.log(`[e2e] C revoked        tx ${ok.body.transaction} ✅`);
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
    console.log(`[e2e] D deposit spent  409 prefund_short ✅`);

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
    console.log(`[e2e] E replay funded  ${replay.status} ${replay.body.reason} (AA25 nonce) ✅`);

    // ── no-broadcast evidence ─────────────────────────────────────────────────────────
    const nonceAfter = BigInt(
        (await rpc(upstream, "eth_getTransactionCount", [relayer.address, "latest"])) as string,
    );
    if (nonceAfter !== nonceBefore) {
        throw new Error(
            `relayer GIWA nonce moved ${nonceBefore} → ${nonceAfter} — something was broadcast`,
        );
    }
    console.log(`[e2e] relayer GIWA nonce after   ${nonceAfter} (unchanged — nothing broadcast) ✅`);
    console.log("");
    console.log("[e2e] revocation submitter service PASS — 5/5");
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
