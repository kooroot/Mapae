/**
 * D5 실증 — MCP tool 한 번 호출로 GIWA Sepolia에 실제 결제를 정산하고 증거를 남긴다.
 *
 * `mcp-e2e.ts`와 같은 흐름을 같은 코드로 돌리되 대상이 fork가 아니라 실제 체인이다.
 * 그래서 이 파일은 그 스크립트가 하지 않는 일을 한다: 브로드캐스트 전후의 체인 상태를
 * 직접 읽어 대조하고, 결제가 실제로 일어났다는 것과 payer가 가스를 한 푼도 쓰지 않았다는
 * 것을 각각 독립된 관측으로 증명한다.
 *
 * ── 안전 ──────────────────────────────────────────────────────────────────
 * 기본 동작은 드라이런이다. `--broadcast` 없이는 사전점검만 하고 MCP를 호출하지 않는다.
 * 이 저장소의 상시 규칙("GIWA 브로드캐스트는 매번 별도 승인")에서 사람의 승인이 코드에
 * 도달하는 지점이 바로 그 플래그다. forge의 관례를 그대로 따랐다.
 *
 * loopback RPC는 거부한다 — fork를 상대로 만든 증거는 증거가 아니다.
 *
 * 사용:
 *   cd apps/delegation-lab
 *   bun run run:giwa                      # 드라이런
 *   bun run run:giwa -- --broadcast       # 실제 정산 (승인 필요)
 */
import {
    parseActiveDeploymentArtifactJson,
    readDelegationStatus,
    reconcileSettlement,
    throttledHttp,
    readRenamedEnv,
} from "@mapae/delegation";
import {
    MOCK_USDC,
    assertRpcTarget,
    explorerTxUrl,
    fromTokenAmount,
    giwaSepolia,
    redactForLog,
    toTokenAmount,
} from "@mapae/shared";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {decodeDelegations} from "@metamask/smart-accounts-kit/utils";
import {createPublicClient, formatEther, getAddress, isAddress} from "viem";
import type {Address, Hex, PublicClient} from "viem";

const REPO = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

const BROADCAST = process.argv.includes("--broadcast");
const RESOURCE = process.argv.find((a) => a.startsWith("/s/")) ?? "/s/demo-cafe/americano";
/** 시드된 상점의 가격표(`apps/delegated-seller/seed.ts`). */
const PRICES: Record<string, string> = {"/s/demo-cafe/americano": "1.00", "/s/demo-cafe/croissant": "2.50"};

/** 이 스크립트가 한 번에 정산해도 되는 절대 상한. caveat이 진짜 통제지만, 사고는 여기서도 막는다. */
const HARD_CEILING = toTokenAmount("3.00");

const balanceOfAbi = [
    {
        type: "function", name: "balanceOf", stateMutability: "view",
        inputs: [{name: "a", type: "address"}], outputs: [{type: "uint256"}],
    },
] as const;

/** 정산 서명자의 전역 이름. RELAYER_ADDRESS는 폐기된 옛 철자로, 경고와 함께 읽힌다. */
function readFacilitatorSignerEnv(): Address {
    const value =
        readRenamedEnv({current: "FACILITATOR_SIGNER_ADDRESS", legacy: "RELAYER_ADDRESS"}) ?? "";
    if (!isAddress(value)) {
        throw new Error("FACILITATOR_SIGNER_ADDRESS must be set to an address");
    }
    return getAddress(value);
}

interface Snapshot {
    block: bigint;
    payerMusdc: bigint;
    payerEth: bigint;
    vendorMusdc: bigint;
    relayerEth: bigint;
    relayerNonce: number;
    remaining: bigint | undefined;
}

async function snapshot(
    publicClient: PublicClient,
    payer: Address,
    vendor: Address,
    relayer: Address,
    readRemaining: () => Promise<bigint | undefined>,
): Promise<Snapshot> {
    const musdc = getAddress(MOCK_USDC.address);
    const [block, payerMusdc, payerEth, vendorMusdc, relayerEth, relayerNonce, remaining] =
        await Promise.all([
            publicClient.getBlockNumber(),
            publicClient.readContract({address: musdc, abi: balanceOfAbi, functionName: "balanceOf", args: [payer]}),
            publicClient.getBalance({address: payer}),
            publicClient.readContract({address: musdc, abi: balanceOfAbi, functionName: "balanceOf", args: [vendor]}),
            publicClient.getBalance({address: relayer}),
            publicClient.getTransactionCount({address: relayer}),
            readRemaining(),
        ]);
    return {block, payerMusdc, payerEth, vendorMusdc, relayerEth, relayerNonce, remaining};
}

function report(label: string, before: bigint, after: bigint, fmt: (v: bigint) => string): void {
    const delta = after - before;
    const sign = delta > 0n ? "+" : "";
    console.log(
        `  ${label.padEnd(22)} ${fmt(before).padStart(24)} → ${fmt(after).padStart(24)}   ${delta === 0n ? "변화 없음" : sign + fmt(delta)}`,
    );
}

async function main(): Promise<void> {
    const price = PRICES[RESOURCE];
    if (!price) throw new Error(`unknown resource ${RESOURCE}`);
    const amount = toTokenAmount(price);
    if (amount > HARD_CEILING) {
        throw new Error(`${price} exceeds this script's ${fromTokenAmount(HARD_CEILING)} ceiling`);
    }

    const rpcUrl = assertRpcTarget(
        process.env.GIWA_SEPOLIA_RPC_URL?.trim() || giwaSepolia.rpcUrls.default.http[0],
        "live",
        "evidence taken against a fork is not evidence",
    );
    const publicClient = createPublicClient({
        chain: giwaSepolia,
        transport: throttledHttp(rpcUrl),
    }) as PublicClient;

    const relayer = readFacilitatorSignerEnv();
    const sellerUrl = new URL(process.env.SELLER_URL?.trim() || "http://127.0.0.1:3001");
    const facilitatorUrl = new URL(process.env.FACILITATOR_URL?.trim() || "http://127.0.0.1:8081");

    const deployment = parseActiveDeploymentArtifactJson(
        await Bun.file(`${REPO}/deployments/giwa-sepolia.framework.json`).text(),
    );
    const permission = (await Bun.file(
        process.env.PARENT_PERMISSION_CONTEXT_PATH ??
            `${REPO}/apps/delegation-lab/open-agent.permission.json`,
    ).json()) as {permissionContext: Hex};
    const root = decodeDelegations(permission.permissionContext).at(-1);
    if (!root) throw new Error("permission context has no root delegation");

    const payer = getAddress(root.delegator);
    const readRemaining = async () =>
        (await readDelegationStatus({publicClient, environment: deployment.environment, delegation: root}))
            .remaining;

    // 판매자에게 402를 받아 실제 수취 주소를 확인한다. .env의 PAY_TO를 믿는 대신
    // 대금이 갈 주소를 판매자 자신이 말하게 한다 — 대조는 그 주소에 대해서만 뜻이 있다.
    const offer = await fetch(new URL(RESOURCE, sellerUrl), {
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
    });
    if (offer.status !== 402) throw new Error(`seller did not answer 402 (got ${offer.status})`);
    const offerBody = (await offer.json()) as {accepts?: {amount?: string; payTo?: string}[]};
    const accepted = offerBody.accepts?.[0];
    if (!accepted?.payTo || !isAddress(accepted.payTo)) throw new Error("402 carried no usable payTo");
    if (!accepted.amount || BigInt(accepted.amount) !== amount) {
        throw new Error(`402 asks ${accepted.amount}, this run is pinned to ${amount}`);
    }
    const vendor = getAddress(accepted.payTo);

    console.log(`\n[run] GIWA Sepolia · ${new URL(rpcUrl).host}`);
    console.log(`[run] ${BROADCAST ? "⚠️  실제 브로드캐스트" : "드라이런 (--broadcast 없음)"}`);
    console.log(`[run] ${RESOURCE} = ${price} mUSDC · ${payer.slice(0, 10)}… → ${vendor.slice(0, 10)}…\n`);

    const before = await snapshot(publicClient, payer, vendor, relayer, readRemaining);
    console.log(`[run] before  block ${before.block} · 주기 잔량 ${before.remaining === undefined ? "n/a" : fromTokenAmount(before.remaining)} mUSDC`);

    if (before.remaining !== undefined && amount > before.remaining) {
        throw new Error(
            `${price} exceeds the ${fromTokenAmount(before.remaining)} mUSDC left in this period — wait for the next one`,
        );
    }

    if (!BROADCAST) {
        console.log(`\n[run] 드라이런 종료. 실제 정산하려면 --broadcast 를 붙여 다시 실행.`);
        console.log(`[run] 그 때 일어날 일: MCP tool 1회 호출 → 402 → leaf 서명 → facilitator가`);
        console.log(`[run] redeemDelegations 를 GIWA에 브로드캐스트 (가스는 relayer 부담).\n`);
        return;
    }

    // MCP 서버는 delegated-agent의 cwd로 띄운다. 세션키·아티팩트 경로·부모 permission을
    // 그 앱의 .env에서 그대로 상속하도록 두는 것이 fork 실행과 유일하게 다른 점이 없게 만든다.
    const client = new Client({name: "mapae-giwa-run", version: "0.0.0"});
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [`${REPO}/apps/agent-mcp/index.ts`],
        cwd: `${REPO}/apps/delegated-agent`,
        env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            GIWA_SEPOLIA_RPC_URL: rpcUrl,
            SELLER_URL: sellerUrl.toString(),
            FACILITATOR_URL: facilitatorUrl.toString(),
        },
        stderr: "inherit",
    });
    await client.connect(transport);
    console.log(`[run] MCP 서버 연결됨 — 사람 개입 없이 tool 1회 호출`);

    let body: Record<string, unknown>;
    try {
        const call = await client.callTool({
            name: "mapae_pay_for_resource",
            arguments: {resource: RESOURCE},
        });
        const text = (call as {content?: {type: string; text?: string}[]}).content?.[0]?.text ?? "{}";
        body = JSON.parse(text) as Record<string, unknown>;
    } finally {
        await transport.close();
    }

    if (body.ok !== true) {
        console.error(`\n[run] 결제 실패 — ${JSON.stringify(body, null, 2)}`);
        throw new Error(`payment did not complete: ${String(body.code)}`);
    }

    const txHash = String(body.transaction) as Hex;
    const receipt = await publicClient.waitForTransactionReceipt({hash: txHash});
    const after = await snapshot(publicClient, payer, vendor, relayer, readRemaining);

    console.log(`\n── 온체인 대조 ─────────────────────────────────────────────────────────────`);
    report("payer mUSDC", before.payerMusdc, after.payerMusdc, fromTokenAmount);
    report("vendor mUSDC", before.vendorMusdc, after.vendorMusdc, fromTokenAmount);
    report("payer ETH", before.payerEth, after.payerEth, formatEther);
    report("relayer ETH", before.relayerEth, after.relayerEth, formatEther);
    console.log(`  ${"relayer nonce".padEnd(22)} ${String(before.relayerNonce).padStart(24)} → ${String(after.relayerNonce).padStart(24)}`);
    if (before.remaining !== undefined && after.remaining !== undefined) {
        report("주기 잔량", before.remaining, after.remaining, fromTokenAmount);
    }

    // 판정은 정산 경로가 보고한 값이 아니라 그 바깥에서 두 번 읽은 체인 상태의 차이에서
    // 나온다. 규칙 자체는 `settlement-evidence.ts`에 있고 테스트가 붙어 있다 — 체인과
    // 서비스 셋이 떠 있어야만 도달하는 코드에 그 판단을 두면 아무도 검사하지 않는다.
    const gasPaid = receipt.gasUsed * receipt.effectiveGasPrice;
    const problems = reconcileSettlement({
        before: {
            payerToken: before.payerMusdc,
            payerNative: before.payerEth,
            vendorToken: before.vendorMusdc,
            relayerNonce: before.relayerNonce,
        },
        after: {
            payerToken: after.payerMusdc,
            payerNative: after.payerEth,
            vendorToken: after.vendorMusdc,
            relayerNonce: after.relayerNonce,
        },
        amount,
        payer,
        vendor,
    });

    console.log(`\n── 결과 ────────────────────────────────────────────────────────────────────`);
    console.log(`  tx          ${txHash}`);
    console.log(`  explorer    ${explorerTxUrl(txHash)}`);
    console.log(`  block       ${receipt.blockNumber}  status ${receipt.status}`);
    console.log(`  gas         ${receipt.gasUsed} × ${receipt.effectiveGasPrice} = ${formatEther(gasPaid)} ETH — relayer 부담`);
    console.log(`  resource    ${JSON.stringify(body.resource)}`);

    const evidence = {
        network: "eip155:91342",
        resource: RESOURCE,
        amount: price,
        payer, vendor, relayer,
        transaction: txHash,
        explorer: explorerTxUrl(txHash),
        block: receipt.blockNumber.toString(),
        status: receipt.status,
        gasUsed: receipt.gasUsed.toString(),
        gasPaidByRelayer: formatEther(gasPaid),
        payerGasSpent: formatEther(before.payerEth - after.payerEth),
        periodRemainingBefore: before.remaining === undefined ? null : fromTokenAmount(before.remaining),
        periodRemainingAfter: after.remaining === undefined ? null : fromTokenAmount(after.remaining),
        capturedAtBlock: after.block.toString(),
    };
    const evidencePath = `${REPO}/apps/delegation-lab/giwa-mcp-run.evidence.json`;
    await Bun.write(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`  evidence    ${evidencePath}`);

    if (problems.length > 0) {
        console.error(`\n[run] ❌ 대조 실패:`);
        for (const p of problems) console.error(`     · ${p.code}  ${p.detail}`);
        throw new Error("on-chain reconciliation failed");
    }
    console.log(`\n[run] ✅ PASS — MCP 1회 호출로 GIWA에 정산 완료. payer 가스 지출 0.\n`);
}

main().catch((error) => {
    console.error(`[run] ${redactForLog(error)}`);
    process.exit(1);
});
