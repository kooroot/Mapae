/**
 * Stand a GIWA fork up and leave it standing, so a person can drive the revoke button
 * with a real browser wallet.
 *
 * This is the one leg no automated suite can close. `revocation-submitter-e2e.ts` already
 * proves the whole byte path end to end — build → sign → POST → CORS preflight →
 * simulate → `handleOps` → `UserOperationEvent.success` — but it signs with a viem
 * `LocalAccount`. What a wallet extension does (render the struct to a human, enforce
 * `domain.chainId`, let the account be switched, let the request be refused) is not in
 * that path at all, and stubbing an injected provider only proves the stub.
 *
 * So this file does everything *except* the signature, and then stops and waits.
 *
 * ── Why a fork is enough here ─────────────────────────────────────────────────────────
 * The signature is offline EIP-712, and the fork keeps chain id 91342. So the digest a
 * wallet is asked to sign on this fork is byte-identical to the one it would be asked to
 * sign against live GIWA — same domain, same `verifyingContract`, same `entryPoint`. And
 * because the fork carries GIWA's real state, the account under the cursor is the real
 * payer `0xA4e4d00E…DDF382` with its real owner, not a throwaway. The only things live
 * GIWA would add are a mined transaction and an explorer link.
 *
 * A consequence worth stating: MetaMask does **not** need a custom network. It compares
 * `domain.chainId` against the selected network, and real GIWA Sepolia is also 91342 —
 * so the owner can stay on GIWA Sepolia and still sign. The wallet never talks to the
 * fork; only this process and the console do.
 *
 * ── SAFETY ────────────────────────────────────────────────────────────────────────────
 * Nothing here reaches live GIWA. The submitter child is pinned to the loopback fork
 * before it is spawned, and the real GIWA relayer nonce is read at start and again at
 * shutdown to prove it. The upstream endpoint is used for `eth_getLogs`-style reads only,
 * which is what forking is.
 */
import {
    DEFAULT_REVOCATION_GAS,
    isDelegationRevoked,
    parseActiveDeploymentArtifactJson,
    readAccountOwner,
    readRevocationPrefundState,
    revocationPrefund,
} from "@mapae/delegation";
import {assertRpcTarget, giwaSepolia, parseNodeRpcUrl, redactForLog} from "@mapae/shared";
import {EntryPoint as EntryPointAbi} from "@metamask/delegation-abis";
import {decodeDelegations} from "@metamask/smart-accounts-kit/utils";
import {
    createPublicClient,
    createWalletClient,
    defineChain,
    formatEther,
    getAddress,
    http,
    isHex,
    keccak256,
    publicActions,
    stringToHex,
    type Address,
    type Hex,
    type PublicClient,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";

const ANVIL_PORT = 8548;
const SUBMITTER_PORT = 8184;

/**
 * Vite's default and the three ports it falls back through when they are taken, plus
 * `vite preview`. All of them, both host spellings, because a CORS allowlist that misses
 * the port the console actually got produces exactly one symptom: the revoke button does
 * nothing, silently. That is the same failure this repo already shipped once when the
 * submitter had no CORS at all, and it stayed hidden because server-side `fetch` does not
 * enforce CORS — no suite can catch it for us.
 *
 * Not hypothetical: on the machine this was written on, 5173 was already held by an
 * unrelated project, so the console would have landed on 5174.
 */
const CONSOLE_PORTS = [5173, 5174, 5175, 5176, 4173] as const;
const FORK_RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const SUBMITTER_URL = `http://127.0.0.1:${SUBMITTER_PORT}`;
const REPO = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

/**
 * Ports are deliberately not the ones the suites use (8546/8547, 8183). This process is
 * meant to sit for as long as a person needs, and colliding with a suite would make
 * whichever started second fail on a message about a port rather than about itself.
 */
const REQUIRED_PREFUND = revocationPrefund(DEFAULT_REVOCATION_GAS);

/**
 * Enough deposit for several attempts, not one.
 *
 * `EntryPoint` refunds `prefund - actualGasCost`, so a successful revocation does not burn
 * the whole 0.0007 ETH. But `revocation.ts` sets `maxPriorityFeePerGas == maxFeePerGas`,
 * which puts `getUserOpGasPrice` on its legacy branch and charges the full 1 gwei/gas
 * regardless of a base fee that is currently 251 wei — so the refund is small and one
 * execution drops the balance under `REQUIRED_PREFUND`. With headroom of one the second
 * attempt would come back `prefund_short`, and a person mid-demo would read that as the
 * kill switch being broken.
 */
const PREFUND_HEADROOM = 8n;

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

async function waitFor(label: string, probe: () => Promise<boolean>, timeoutMs = 180_000) {
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

function assertPortFree(name: string, port: number): void {
    try {
        Bun.serve({port, hostname: "127.0.0.1", fetch: () => new Response("")}).stop(true);
    } catch {
        throw new Error(`port ${port} is in use, so this run's ${name} cannot start`);
    }
}

async function main(): Promise<void> {
    const forkRpc = assertRpcTarget(FORK_RPC, "loopback", "this would broadcast to GIWA");
    const upstream = parseNodeRpcUrl(
        process.env["GIWA_FORK_SOURCE_RPC_URL"]?.trim() ||
            process.env["GIWA_SEPOLIA_RPC_URL"]?.trim() ||
            giwaSepolia.rpcUrls.default.http[0],
    );
    assertRpcTarget(upstream, "live", "a fork of loopback would prove nothing about GIWA");
    assertPortFree("anvil", ANVIL_PORT);
    assertPortFree("submitter", SUBMITTER_PORT);

    // The real account, read from the artifact rather than typed in. This lab exists to
    // put a wallet in front of *this* account; a throwaway would defeat the purpose.
    const ownerArtifact = (await Bun.file(
        `${REPO}/deployments/giwa-sepolia.owner-account.json`,
    ).json()) as {account?: string; owner?: string};
    if (!ownerArtifact.account || !ownerArtifact.owner) {
        throw new Error("owner-account.json is missing `account` or `owner`");
    }
    const payer = getAddress(ownerArtifact.account);
    const expectedOwner = getAddress(ownerArtifact.owner);

    const permissionPath =
        process.env["PARENT_PERMISSION_CONTEXT_PATH"] ?? "./open-agent.permission.json";
    const permission = (await Bun.file(permissionPath).json()) as {permissionContext?: unknown};
    const context = permission.permissionContext;
    if (typeof context !== "string" || !isHex(context) || context.length < 4) {
        throw new Error(`${permissionPath} has no usable permissionContext`);
    }
    const root = decodeDelegations(context as Hex).at(-1);
    if (!root) throw new Error("permissionContext decoded to an empty chain");

    const relayerKey = keccak256(stringToHex("mapae.revoke-fork-lab.v1.relayer")) as Hex;
    const relayer = privateKeyToAccount(relayerKey);
    const nonceBefore = BigInt(
        (await rpc(upstream, "eth_getTransactionCount", [relayer.address, "latest"])) as string,
    );

    console.log("┌─ mapae revoke lab — GIWA fork, wallet in the loop");
    console.log(`│  payer  ${payer}`);
    console.log(`│  owner  ${expectedOwner}   ← the key your wallet must hold`);
    console.log(`│  no-broadcast guard: submitter pinned to ${forkRpc}`);

    const forkBlock = process.env["SUITE_FORK_BLOCK"]?.trim();
    const anvil = Bun.spawn(
        [
            "anvil",
            "--port",
            String(ANVIL_PORT),
            "--silent",
            "--fork-url",
            upstream,
            ...(forkBlock ? ["--fork-block-number", forkBlock] : []),
            "--compute-units-per-second",
            process.env["SUITE_CUPS"]?.trim() || "300",
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

    const chain = defineChain({
        id: giwaSepolia.id,
        name: "GIWA fork",
        nativeCurrency: giwaSepolia.nativeCurrency,
        rpcUrls: {default: {http: [forkRpc]}},
    });
    const publicClient = createPublicClient({chain, transport: http(forkRpc)}) as PublicClient;
    const relayerClient = createWalletClient({account: relayer, chain, transport: http(forkRpc)}).extend(
        publicActions,
    );
    const deployment = parseActiveDeploymentArtifactJson(
        await Bun.file(`${REPO}/deployments/giwa-sepolia.framework.json`).text(),
    );
    const entryPoint = getAddress(deployment.environment.EntryPoint);
    console.log(`│  fork ready · chainId ${giwaSepolia.id} · block ${await publicClient.getBlockNumber()}`);

    // The account has to be the real one, and its owner has to be the artifact's — if the
    // fork came up against a chain where that is not true, every instruction printed below
    // would send someone to sign with a key the account will not accept.
    const onChainOwner = await readAccountOwner({publicClient, account: payer});
    if (onChainOwner !== expectedOwner) {
        throw new Error(`fork owner() is ${onChainOwner}, artifact says ${expectedOwner}`);
    }
    if (getAddress(root.delegator) !== payer) {
        throw new Error(`root delegator ${root.delegator} is not the payer ${payer}`);
    }
    const manager = getAddress(deployment.environment.DelegationManager);
    if (await isDelegationRevoked({publicClient, delegationManager: manager, delegation: root})) {
        throw new Error(
            "the root permission is already revoked on the forked state — re-sign a root before running this lab",
        );
    }

    await rpc(forkRpc, "anvil_setBalance", [relayer.address, "0xde0b6b3a7640000"]);
    // A 7702 designator on the relayer makes `EntryPoint._compensate` run a sweeper and
    // empty it mid-demo, which reads as a fee-estimation bug and is not one. The derived
    // key above avoids the known ones; this refuses anything that carries code at all.
    if ((await publicClient.getCode({address: relayer.address})) !== undefined) {
        throw new Error(`relayer ${relayer.address} carries code — pick a different derived key`);
    }

    const deposit = REQUIRED_PREFUND * PREFUND_HEADROOM;
    await publicClient.waitForTransactionReceipt({
        hash: await relayerClient.writeContract({
            address: entryPoint,
            abi: EntryPointAbi,
            functionName: "depositTo",
            args: [payer],
            value: deposit,
        }),
    });
    const funding = await readRevocationPrefundState({
        publicClient,
        entryPoint,
        sender: payer,
        requiredPrefund: REQUIRED_PREFUND,
    });
    if (!funding.ready) throw new Error(`deposit did not arm the kill switch: ${funding.shortfall} wei short`);
    // The claim the whole demo rests on, asserted rather than assumed: crediting the
    // EntryPoint deposit must leave the account's own ETH at zero.
    if (funding.nativeBalance !== 0n) {
        throw new Error(`depositTo gave the payer ${funding.nativeBalance} wei of ETH — gaslessness broken`);
    }
    console.log(
        `│  armed · deposit ${formatEther(funding.deposit)} ETH (${PREFUND_HEADROOM}× one revocation) · payer ETH ${formatEther(funding.nativeBalance)}`,
    );

    const submitter = Bun.spawn(["bun", "run", "index.ts"], {
        cwd: `${REPO}/apps/revocation-submitter`,
        env: {
            ...process.env,
            HOST: "127.0.0.1",
            PORT: String(SUBMITTER_PORT),
            GIWA_SEPOLIA_RPC_URL: forkRpc,
            DELEGATION_DEPLOYMENT_PATH: `${REPO}/deployments/giwa-sepolia.framework.json`,
            PAYER_ACCOUNT_ADDRESS: payer,
            RELAYER_ADDRESS: relayer.address,
            RELAYER_PRIVATE_KEY: relayerKey,
            REVOCATION_CONSOLE_ORIGINS: CONSOLE_PORTS.flatMap((port) => [
                `http://127.0.0.1:${port}`,
                `http://localhost:${port}`,
            ]).join(","),
        },
        stdout: "inherit",
        stderr: "inherit",
    });
    children.push({name: "submitter", proc: submitter});
    await waitFor("submitter", async () => {
        const response = await fetch(`${SUBMITTER_URL}/health`, {signal: AbortSignal.timeout(5_000)});
        return response.ok;
    });

    // Written rather than printed: `VITE_PERMISSION_CONTEXT` is ~2.6 kB, and a value that
    // long copied by hand out of a terminal is a truncation waiting to happen — which the
    // console would report as "could not decode", sending someone after the wrong bug.
    // `.env.local` because vite reads it, it outranks `.env`, and `.gitignore` covers
    // `.env.*` at every depth.
    const consoleEnv = `# Written by apps/delegation-lab/revoke-fork-lab.ts. Local fork only.
# Delete this file to point the console back at live GIWA.
VITE_RPC_URL=${forkRpc}
VITE_REVOCATION_SUBMITTER_URL=${SUBMITTER_URL}
VITE_PERMISSION_CONTEXT=${context}
`;
    const consoleEnvPath = `${REPO}/apps/console/.env.local`;
    await Bun.write(consoleEnvPath, consoleEnv);

    // Informational, not an assert: the console is not this process's child, so all the
    // lab can do is say which port vite will land on before someone goes looking for a
    // page that is not there.
    let consolePort: number = CONSOLE_PORTS[0];
    for (const port of CONSOLE_PORTS) {
        try {
            Bun.serve({port, hostname: "127.0.0.1", fetch: () => new Response("")}).stop(true);
            consolePort = port;
            break;
        } catch {
            /* taken — vite will fall through to the next one, and so will we */
        }
    }
    if (consolePort !== CONSOLE_PORTS[0]) {
        console.log(`│  note: ${CONSOLE_PORTS[0]} 은 이미 사용 중 — vite 는 ${consolePort} 로 갑니다`);
    }

    console.log("└─ ready\n");
    console.log("다음을 하세요:\n");
    console.log(`  1. 콘솔 실행 —  cd apps/console && bun run dev`);
    console.log(`     (환경은 이미 ${consoleEnvPath.replace(`${REPO}/`, "")} 에 적어뒀습니다)`);
    console.log(`  2. 브라우저에서 http://127.0.0.1:${consolePort} 열기`);
    console.log(`     — localhost 가 아니라 127.0.0.1 로 여세요. 같은 머신에서 다른 프로젝트가`);
    console.log(`       localhost:${CONSOLE_PORTS[0]} 에 service worker 를 남겨두면 그 앱이 대신 뜹니다`);
    console.log(`       (여기서 실제로 겪었습니다). 이상하면 hard reload 하거나 새 프로필을 쓰세요.`);
    console.log(`  3. MetaMask 를 GIWA Sepolia (chainId ${giwaSepolia.id}) 로 두고`);
    console.log(`     계정 ${expectedOwner} 선택`);
    console.log(`     — 커스텀 네트워크 불필요합니다. 서명은 오프라인이고 fork 도 chainId ${giwaSepolia.id} 라`);
    console.log(`       지갑이 보는 domain.chainId 가 실제 GIWA 와 동일합니다. 지갑은 fork 에 접속하지 않습니다.`);
    console.log(`  4. "위임 · 한도" 탭 → 회수 패널 → [회수 서명] 클릭 → MetaMask 승인`);
    console.log(`\n  볼 것: MetaMask 가 9-필드 PackedUserOperation 을 사람이 읽을 수 있게 보여주는가.`);
    console.log(`         callData 는 1252 바이트 hex 한 덩어리입니다 — 그게 유일한 의미 정보입니다.`);
    console.log(`\n  브로드캐스트는 이 fork(${forkRpc})로만 갑니다. 실제 GIWA 는 건드리지 않습니다.`);
    console.log(`  Ctrl-C 로 종료하면 anvil·제출기를 정리하고 실제 GIWA relayer nonce 불변을 다시 확인합니다.\n`);

    await new Promise<void>((resolve) => {
        for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => resolve());
    });

    const nonceAfter = BigInt(
        (await rpc(upstream, "eth_getTransactionCount", [relayer.address, "latest"])) as string,
    );
    if (nonceAfter !== nonceBefore) {
        throw new Error(`GIWA relayer nonce moved ${nonceBefore} → ${nonceAfter} — something broadcast`);
    }
    const revoked = await isDelegationRevoked({
        publicClient,
        delegationManager: manager,
        delegation: root,
    });
    console.log(`\n[lab] fork 상 회수 상태: ${revoked ? "회수됨 ✅ (지갑 레그 완주)" : "미회수"}`);
    console.log(`[lab] 실제 GIWA relayer nonce ${nonceBefore} → ${nonceAfter} (불변) ✅`);
    console.log(`[lab] ${consoleEnvPath.replace(`${REPO}/`, "")} 는 남겨둡니다 — 지우면 콘솔이 라이브 GIWA 를 봅니다.`);
}

try {
    await main();
} catch (error) {
    console.error(`[lab] ${redactForLog(error)}`);
    shutdown();
    process.exit(1);
}
shutdown();
