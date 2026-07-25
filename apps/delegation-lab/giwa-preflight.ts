/**
 * GIWA 브로드캐스트 직전 사전점검 — 읽기 전용 GO / NO-GO.
 *
 * 실제 GIWA Sepolia 헤드 상태에서, 결제 한 건이 성공하기 위해 참이어야 하는 조건을
 * 전부 읽어 확인한다. 서명하지 않고, 트랜잭션을 보내지 않고, 개인키를 읽지 않는다.
 *
 * ── 왜 fork가 아니라 실제 체인인가 ────────────────────────────────────────
 * `mcp-e2e.ts`는 자식 RPC가 loopback이 아니면 거부한다. 여기서는 정반대로 loopback을
 * 거부한다. 사전점검의 값어치는 전부 "지금 이 순간 진짜 체인이 어떤 상태인가"에 있고,
 * fork를 상대로 통과한 GO는 GO가 아니라 거짓 안심이기 때문이다. 두 가드는 대칭이며
 * 각자 자기 스크립트가 잘못된 대상에 붙는 것을 막는다.
 *
 * 사용:
 *   cd apps/delegation-lab && bun run preflight:giwa [inv-001]
 */
import {
    parseActiveDeploymentArtifactJson,
    parseFrameworkDeploymentManifestJson,
    readDelegationStatus,
    throttledHttp,
    verifyActiveFrameworkDeployment,
} from "@mapae/delegation";
import {
    GIWA_SEPOLIA_CAIP2,
    MOCK_USDC,
    assertRpcTarget,
    fromTokenAmount,
    giwaSepolia,
    redactForLog,
    toTokenAmount,
} from "@mapae/shared";
import {decodeDelegations} from "@metamask/smart-accounts-kit/utils";
import {createPublicClient, formatEther, getAddress, isAddress} from "viem";
import type {Address, Hex, PublicClient} from "viem";

const REPO = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

/** 판매자가 붙여둔 가격표. 사전점검은 이 금액이 통과하는지를 묻는다. */
const PRICES: Record<string, string> = {"inv-001": "1.00", "inv-002": "2.50"};
const INVOICE = process.argv[2] ?? "inv-001";

/** 브로드캐스트에 드는 가스의 상한 추정 — relayer 잔고 판정에만 쓴다. */
const REDEMPTION_GAS_CEILING = 1_500_000n;

type Line = {ok: boolean; label: string; detail: string};
const lines: Line[] = [];

function record(ok: boolean, label: string, detail: string): void {
    lines.push({ok, label, detail});
    console.log(`  ${ok ? "✅" : "❌"} ${label.padEnd(28)} ${detail}`);
}

function readAddressEnv(name: string): Address | undefined {
    const value = process.env[name]?.trim() ?? "";
    return isAddress(value) ? getAddress(value) : undefined;
}

/** 서비스가 떠 있으면 확인하고, 없으면 그렇다고만 말한다 — 부재는 NO-GO가 아니다. */
async function probe(url: URL): Promise<Response | undefined> {
    try {
        return await fetch(url, {redirect: "error", signal: AbortSignal.timeout(4_000)});
    } catch {
        return undefined;
    }
}

async function main(): Promise<void> {
    const price = PRICES[INVOICE];
    if (!price) throw new Error(`unknown invoice ${INVOICE} — expected one of ${Object.keys(PRICES).join(", ")}`);
    const amount = toTokenAmount(price);

    const rpcUrl = assertRpcTarget(
        process.env.GIWA_SEPOLIA_RPC_URL?.trim() || giwaSepolia.rpcUrls.default.http[0],
        "live",
        "a preflight against a fork is a false GO",
    );
    const publicClient = createPublicClient({
        chain: giwaSepolia,
        transport: throttledHttp(rpcUrl),
    }) as PublicClient;

    console.log(`\n[preflight] GIWA Sepolia · ${new URL(rpcUrl).host} · 읽기 전용`);
    console.log(`[preflight] 대상 결제: ${INVOICE} = ${price} mUSDC\n`);

    const [block, deployment, manifest, permission] = await Promise.all([
        publicClient.getBlock(),
        Bun.file(`${REPO}/deployments/giwa-sepolia.framework.json`)
            .text()
            .then(parseActiveDeploymentArtifactJson),
        Bun.file(`${REPO}/deployments/giwa-sepolia.framework-manifest.json`)
            .text()
            .then(parseFrameworkDeploymentManifestJson),
        Bun.file(
            process.env.PARENT_PERMISSION_CONTEXT_PATH ??
                `${REPO}/apps/delegation-lab/open-agent.permission.json`,
        ).json() as Promise<{permissionContext: Hex; role?: string}>,
    ]);

    console.log(`── 체인 ────────────────────────────────────────────────`);
    record(true, "head block", `${block.number} · ${new Date(Number(block.timestamp) * 1000).toISOString()}`);

    // Framework가 감사받은 그 구성 그대로인지. 에이전트 런타임이 부팅 때 하는 검사와
    // 같은 것을 미리 돌려서, 실패를 데모 도중이 아니라 여기서 보게 한다.
    const admin = readAddressEnv("FRAMEWORK_ADMIN_ADDRESS");
    if (admin) {
        try {
            await verifyActiveFrameworkDeployment({
                publicClient,
                deployment,
                manifest,
                expectedFrameworkAdmin: admin,
            });
            record(true, "framework 구성", `38-unit 검증 통과 · admin ${admin.slice(0, 10)}…`);
        } catch (error) {
            record(false, "framework 구성", redactForLog(error));
        }
    } else {
        record(false, "framework 구성", "FRAMEWORK_ADMIN_ADDRESS 미설정 — 검증 생략");
    }

    console.log(`\n── 위임 체인 ──────────────────────────────────────────`);
    const chain = decodeDelegations(permission.permissionContext);
    const statuses = await Promise.all(
        chain.map((delegation) =>
            readDelegationStatus({publicClient, environment: deployment.environment, delegation}),
        ),
    );

    // 루트가 마지막. `decodeDelegations`는 leaf-first로 돌려준다.
    const root = statuses.at(-1);
    if (!root) throw new Error("permission context has no root delegation");
    record(true, "체인 길이", `${chain.length}단 · role=${permission.role ?? "?"}`);
    record(true, "payer (delegator)", root.delegator);
    record(true, "agent (delegate)", root.delegate);

    let tightest: bigint | undefined;
    for (const [index, status] of statuses.entries()) {
        const tag = index === statuses.length - 1 ? "root" : `link ${index}`;
        record(!status.revoked, `${tag} 회수`, status.revoked ? "회수됨" : "유효");
        record(!status.expired && !status.notYetActive, `${tag} 유효창`,
            status.expired ? "만료됨"
            : status.notYetActive ? "미개시"
            : status.validity
              ? `~ ${new Date(Number(status.validity.notAfter) * 1000).toISOString()}`
              : "제한 없음");
        if (status.remaining !== undefined) {
            if (tightest === undefined || status.remaining < tightest) tightest = status.remaining;
            record(true, `${tag} 주기 잔량`,
                `${fromTokenAmount(status.remaining)} mUSDC` +
                (status.limit ? ` / ${fromTokenAmount(status.limit.periodAmount)} per ${status.limit.periodDuration}s` : ""));
        }
    }

    record(
        tightest === undefined || amount <= tightest,
        "한도 대비 결제액",
        tightest === undefined
            ? "주기 caveat 없음"
            : `${price} ≤ ${fromTokenAmount(tightest)} mUSDC`,
    );

    console.log(`\n── 자금 ────────────────────────────────────────────────`);
    const musdc = getAddress(MOCK_USDC.address);
    const payerBalance = await publicClient.readContract({
        address: musdc,
        abi: [{
            type: "function", name: "balanceOf", stateMutability: "view",
            inputs: [{name: "a", type: "address"}], outputs: [{type: "uint256"}],
        }] as const,
        functionName: "balanceOf",
        args: [root.delegator],
    });
    record(payerBalance >= amount, "payer mUSDC",
        `${fromTokenAmount(payerBalance)} (필요 ${price})`);

    // payer가 가스를 한 푼도 들지 않는 것이 데모의 핵심 주장이다. 0이 정상이며,
    // 0이 아니라고 실패는 아니지만 보이게는 해둔다.
    const payerEth = await publicClient.getBalance({address: root.delegator});
    record(true, "payer ETH", `${formatEther(payerEth)} (0이 설계값 — 가스리스)`);

    const relayer = readAddressEnv("RELAYER_ADDRESS");
    if (relayer) {
        const [relayerEth, fees] = await Promise.all([
            publicClient.getBalance({address: relayer}),
            publicClient.estimateFeesPerGas(),
        ]);
        const worstCase = REDEMPTION_GAS_CEILING * (fees.maxFeePerGas ?? 0n);
        record(relayerEth > worstCase, "relayer ETH",
            `${formatEther(relayerEth)} (최악 ${formatEther(worstCase)})`);
    } else {
        record(false, "relayer ETH", "RELAYER_ADDRESS 미설정 — 확인 불가");
    }

    console.log(`\n── 서비스 (떠 있으면 확인) ─────────────────────────────`);
    const facilitatorUrl = new URL(process.env.FACILITATOR_URL?.trim() || "http://127.0.0.1:8081");
    const supported = await probe(new URL("/supported", facilitatorUrl));
    if (!supported) {
        record(false, "facilitator", `${facilitatorUrl.host} 응답 없음 — 실행 전에 띄울 것`);
    } else if (!supported.ok) {
        record(false, "facilitator", `/supported → ${supported.status}`);
    } else {
        const body = (await supported.json()) as {signers?: Record<string, unknown>};
        const signers = body.signers?.[GIWA_SEPOLIA_CAIP2];
        const advertised = Array.isArray(signers) ? signers.map(String) : [];
        const matches = relayer !== undefined
            && advertised.some((s) => isAddress(s) && getAddress(s) === relayer);
        record(advertised.length > 0, "facilitator signer",
            advertised.length ? advertised.join(", ") : "GIWA signer 광고 없음");
        record(matches, "signer == RELAYER_ADDRESS",
            matches ? "일치" : "불일치 — 잔고를 확인한 지갑이 실제 정산 지갑이 아님");
    }

    const sellerUrl = new URL(process.env.SELLER_URL?.trim() || "http://127.0.0.1:3001");
    const offer = await probe(new URL(`/delegated/deliverable/${INVOICE}`, sellerUrl));
    if (!offer) {
        record(false, "seller", `${sellerUrl.host} 응답 없음 — 실행 전에 띄울 것`);
    } else if (offer.status !== 402) {
        record(false, "seller 402", `${offer.status} — 402가 아님`);
    } else {
        const body = (await offer.json()) as {accepts?: {amount?: string; payTo?: string; network?: string}[]};
        const first = body.accepts?.[0];
        const asked = first?.amount ? BigInt(first.amount) : undefined;
        record(asked === amount, "seller 402 금액",
            asked === undefined ? "amount 없음" : `${fromTokenAmount(asked)} mUSDC`);
        record(first?.network === GIWA_SEPOLIA_CAIP2, "seller 402 network",
            first?.network ?? "없음");
        record(Boolean(first?.payTo && isAddress(first.payTo)), "seller payTo",
            first?.payTo ?? "없음");
    }

    const failed = lines.filter((line) => !line.ok);
    console.log(`\n────────────────────────────────────────────────────────`);
    if (failed.length === 0) {
        console.log(`✅ GO — ${lines.length}개 조건 전부 충족. 브로드캐스트는 별도 승인 후 수동 실행.`);
    } else {
        console.log(`❌ NO-GO — ${failed.length}/${lines.length} 실패:`);
        for (const line of failed) console.log(`     · ${line.label}: ${line.detail}`);
    }
    console.log(`[preflight] 이 스크립트는 읽기만 했다. 서명도 전송도 없음.\n`);
    process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
    console.error(`[preflight] ${redactForLog(error)}`);
    process.exit(1);
});
