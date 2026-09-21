import {createPublicClient, getAddress, isAddress, zeroAddress} from "viem";
import type {Account, Address, Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {
    GIWA_SEPOLIA_CAIP2,
    MOCK_USDC,
    giwaSepolia,
    isLoopbackHost,
    parseNodeRpcUrl,
    toTokenAmount,
    type Erc7710PaymentRequirements,
} from "@mapae/shared";
import {isPermissionContext, parseActiveDeploymentArtifactJson} from "./config.js";
import {parseFrameworkDeploymentManifestJson} from "./deployment-record.js";
import {verifyActiveFrameworkDeployment} from "./live-verifier.js";
import {decodeDelegations} from "@metamask/smart-accounts-kit/utils";
import {readDelegationStatus} from "./delegation-status.js";
import type {DelegationStatus} from "./delegation-status.js";
import type {DelegatedLeafProvider, PreflightVerdict} from "./payment-client.js";
import {throttledHttp} from "./rpc.js";
import {createMapaeDelegationProvider} from "./x402.js";

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Everything an autonomous delegated-payment agent needs, loaded once. Shared by
 * the CLI agent and the D5 MCP server so the env/file/verify glue exists in exactly
 * one place — two copies of it would drift the same way two copies of the domain do.
 */
export interface DelegatedAgentRuntime {
    account: Account;
    provider: DelegatedLeafProvider;
    /**
     * 서명 전 판정. 운영자가 env로 정한 런타임 지출 정책을 먼저 보고, 그것을 통과하면
     * enforcer의 남은 기간 잔량을 읽는다.
     *
     * 금액 하나가 아니라 요구사항 전체를 받는다 — 수취처 허용목록은 `payTo`를 봐야
     * 판정할 수 있고, 금액만 넘기는 시그니처로는 그 판정이 서명 뒤로 밀린다.
     */
    preflight: (requirements: Erc7710PaymentRequirements) => Promise<PreflightVerdict>;
    /** env에서 읽은 런타임 지출 한도. 보고용이고, 강제는 `preflight`가 한다. */
    spendPolicy: AgentSpendPolicy;
    delegationManager: Address;
    trustedFacilitators: Address[];
    sellerUrl: URL;
    facilitatorUrl: URL;
    frameworkAdmin: Address;
    rpcUrl: string;
}

export interface LoadDelegatedAgentRuntimeOptions {
    /** Defaults to process.env. */
    env?: Record<string, string | undefined>;
    /** Reads a file's UTF-8 text; defaults to Bun.file. Injectable for tests. */
    readTextFile?: (path: string) => Promise<string>;
    /** Defaults to the global fetch (used only for the facilitator /supported call). */
    fetchImpl?: typeof fetch;
}

function readHttpUrl(
    env: Record<string, string | undefined>,
    name: string,
    fallback: string,
): URL {
    const value = env[name]?.trim() || fallback;
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error(`${name} must be an absolute HTTP(S) URL without credentials`);
    }
    const loopback = isLoopbackHost(url.hostname);
    if (url.protocol !== "https:" && !loopback) {
        throw new Error(`${name} must use HTTPS unless it is loopback`);
    }
    return url;
}

function readRpcUrl(env: Record<string, string | undefined>): string {
    return parseNodeRpcUrl(
        env.GIWA_SEPOLIA_RPC_URL?.trim() || giwaSepolia.rpcUrls.default.http[0],
    );
}

function readAddress(env: Record<string, string | undefined>, name: string): Address {
    const value = env[name]?.trim() ?? "";
    if (!isAddress(value)) throw new Error(`${name} must be an address`);
    const address = getAddress(value);
    if (address === zeroAddress) throw new Error(`${name} must not be zero`);
    return address;
}

function readAgentKey(env: Record<string, string | undefined>): Hex {
    const value = env.AGENT_PRIVATE_KEY?.trim() ?? "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error("AGENT_PRIVATE_KEY must be a 32-byte session key");
    }
    return value as Hex;
}

/* ------------------------------------------------------------------ *
 * 런타임 지출 정책
 * ------------------------------------------------------------------ */

/**
 * 운영자가 env로 정한 이 런타임의 지출 한도. 금액은 토큰 base unit이다.
 *
 * 온체인 caveat은 **기간** 한도다 — 며칠치 예산을 한 칸에 담고 있으므로, 잘못 든 자원
 * 경로 하나가 한 세션에 그 예산 전부를 쓸 수 있다. 체인은 그것을 막지 않는다: 각 결제가
 * 개별적으로는 전부 합법이기 때문이다. 세 한도는 그 폭을 좁히는 운영자 쪽 장치이고,
 * **최종 한도는 여전히 체인이다.**
 *
 * 미설정 칸은 `undefined`이며 그 한도는 없는 것으로 한다. 기본 숫자를 두지 않는 것은
 * 의도다 — 운영자가 정한 적 없는 예산을 코드가 정하면, 거절의 원인이 운영자가 읽을 수
 * 있는 어디에도 적혀 있지 않게 된다.
 */
export interface AgentSpendPolicy {
    /** 호출당 상한. 이 금액을 넘는 오퍼는 서명하지 않는다. */
    maxPerPaymentBase?: bigint;
    /**
     * 이 런타임 인스턴스가 서명할 수 있는 누적 총액.
     *
     * 세션 = 런타임 인스턴스의 수명 = MCP 서버 프로세스의 수명이다. 프로세스를 다시
     * 띄우면 누적은 0에서 다시 시작한다. 이 한도는 한 세션 안에서 잘못된 루프가 기간
     * 예산을 태우는 폭을 좁히는 장치이고 영속 예산 관리가 아니다 — 재시작을 넘겨 남는
     * 예산은 `apps/payment-scheduler`가 `maxTotalBase`로 DB에 들고 있다.
     */
    maxSessionTotalBase?: bigint;
    /** 서명을 허용할 수취처(체크섬). 미설정이면 판매자가 고른 `payTo`를 제한하지 않는다. */
    allowedPayTo?: readonly Address[];
}

/**
 * 금액 한도 하나를 읽는다. 미설정은 `undefined`, 잘못된 값은 예외다.
 *
 * 부팅에서 실패하는 쪽을 고른 이유: 오타 하나를 무시하고 넘어가면 런타임은 조용히
 * 무제한으로 돈다. 그 상태는 관측되지 않는다 — 한도가 걸리지 않는 것과 한도가 없는 것이
 * 밖에서 똑같이 보이기 때문이다. `FUND_AMOUNT_MUSDC`가 같은 방식으로 실패한다.
 */
function readSpendCap(
    env: Record<string, string | undefined>,
    name: string,
): bigint | undefined {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    let base: bigint;
    try {
        base = toTokenAmount(raw);
    } catch {
        throw new Error(
            `${name} must be a decimal ${MOCK_USDC.symbol} amount with at most ` +
                `${MOCK_USDC.decimals} fractional digits`,
        );
    }
    // `toTokenAmount`는 음수와 과다 소수를 이미 거절하지만 `"0"`은 통과시킨다. 0은 모든
    // 결제를 거절하는 한도이고, 그것을 원한다면 에이전트를 띄우지 않는 것이 맞다. 여기서
    // 받아 주면 "한도를 끄려면 변수를 비운다"는 규칙과 값 하나가 겹쳐 모호해진다.
    if (base <= 0n) {
        throw new Error(`${name} must be positive — unset the variable to remove the limit`);
    }
    return base;
}

/**
 * 수취처 허용목록. 쉼표로 구분한 주소 목록이고, 미설정은 `undefined`(제한 없음)다.
 *
 * 값이 있는데 주소가 하나도 남지 않는 경우(`","`)는 미설정으로 접지 않고 거절한다. 목록을
 * 적으려다 실패한 것이므로, 제한이 사라진 채 도는 것보다 부팅에서 멈추는 쪽이 맞다.
 */
function readPayToAllowlist(
    env: Record<string, string | undefined>,
    name: string,
): readonly Address[] | undefined {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    const entries = raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    if (entries.length === 0) {
        throw new Error(`${name} is set but lists no address — unset it to allow any payTo`);
    }
    return entries.map((entry) => {
        if (!isAddress(entry)) throw new Error(`${name} entry is not an address: ${entry}`);
        const address = getAddress(entry);
        // 판매자 오퍼는 `assertErc7710Offer`가 이미 0 주소를 거절한다. 허용목록에 0을
        // 적는 것은 어떤 오퍼와도 맞을 수 없는 항목이므로 오타로 보고 거절한다.
        if (address === zeroAddress) throw new Error(`${name} must not list the zero address`);
        return address;
    });
}

/** 세 한도를 env에서 읽는다. 잘못된 값은 여기서 예외가 되어 부팅을 세운다. */
export function parseAgentSpendPolicy(
    env: Record<string, string | undefined>,
): AgentSpendPolicy {
    return {
        maxPerPaymentBase: readSpendCap(env, "AGENT_MAX_PAYMENT_MUSDC"),
        maxSessionTotalBase: readSpendCap(env, "AGENT_SESSION_BUDGET_MUSDC"),
        allowedPayTo: readPayToAllowlist(env, "AGENT_ALLOWED_PAY_TO"),
    };
}

/**
 * 한 런타임 인스턴스의 지출 정책 상태.
 *
 * 판정과 누적이 두 개로 나뉘어 있는 것은 **서명이 유일한 되돌릴 수 없는 순간**이기
 * 때문이다. `judge`는 서명 전에 물어보는 쪽이라 상태를 바꾸지 않고, `wrap`이 감싼
 * provider가 서명을 실제로 마친 금액만 누적에 더한다. 한쪽이 판정도 하고 누적도 하면
 * 체인이 거절한 결제(`LIMIT_EXCEEDED`)가 세션 예산을 먹어, 기간이 돌아온 뒤에도
 * 프로세스를 다시 띄워야 하는 상태가 생긴다.
 *
 * 세는 단위가 **서명**이지 청구가 아닌 것도 의도다. 서명된 leaf는 bearer 권한이고,
 * 판매자가 자원을 주지 못했더라도 facilitator는 그것을 청구할 수 있다. 정산 성공만 세면
 * 실패한 왕복마다 예산이 되살아나 한도가 한도가 아니게 된다.
 *
 * 판정과 서명 사이에는 await가 하나 있다. MCP 서버가 tool 호출을 동시에 처리하면 두
 * 호출이 각각 판정을 통과한 뒤 둘 다 서명할 수 있고, 그때 세션 총액은 진행 중인 결제
 * 하나만큼 예산을 넘을 수 있다 — 그 초과분의 상한이 호출당 상한이며, 두 한도를 같이
 * 설정하는 이유가 그것이다.
 */
export interface AgentSpendGate {
    /** 서명 전 판정. 상태를 바꾸지 않으므로 몇 번 불러도 같은 답이다. */
    judge: (requirements: Pick<Erc7710PaymentRequirements, "amount" | "payTo">) => PreflightVerdict;
    /**
     * 서명된 금액만 누적에 더하도록 leaf provider를 감싼다.
     *
     * provider를 감싸는 형태인 것은 누적 지점을 잊을 수 없게 하려는 것이다 — 누적을
     * 부르는 별도 메서드라면, 새 호출 경로가 그것을 부르지 않아도 컴파일된다.
     */
    wrap: (provider: DelegatedLeafProvider) => DelegatedLeafProvider;
}

/**
 * 정책 판정자를 만든다. 반환된 게이트는 **이 인스턴스의** 세션 누적을 들고 있다.
 *
 * 전제: `judge`에 넘기는 `requirements`는 `assertErc7710Offer`를 통과한 오퍼다
 * (`amount`는 양의 정수 문자열, `payTo`는 0이 아닌 주소). 검증되지 않은 판매자 JSON을
 * 직접 넣으면 안 된다 — `payForDelegatedResource`가 그 순서를 지킨다.
 */
export function createAgentSpendGate(policy: AgentSpendPolicy): AgentSpendGate {
    let signedBase = 0n;
    return {
        judge: (requirements) => {
            const amount = BigInt(requirements.amount);
            const payTo = getAddress(requirements.payTo);

            // 허용목록이 먼저다. 낯선 수취처로 가는 결제를 금액 초과로 보고하면 운영자는
            // 한도를 올리러 가고, 정작 봐야 할 것(에이전트가 왜 그 판매자를 골랐는가)을
            // 보지 않는다. 금액과 무관하게 거절되는 조건이므로 순서가 결과를 바꾼다.
            if (policy.allowedPayTo && !policy.allowedPayTo.includes(payTo)) {
                return {
                    ok: false,
                    code: "SPEND_POLICY_REFUSED",
                    detail: `payTo ${payTo} is not in AGENT_ALLOWED_PAY_TO`,
                };
            }
            if (policy.maxPerPaymentBase !== undefined && amount > policy.maxPerPaymentBase) {
                return {
                    ok: false,
                    code: "SPEND_POLICY_REFUSED",
                    detail:
                        `payment of ${amount} exceeds the AGENT_MAX_PAYMENT_MUSDC cap of ` +
                        `${policy.maxPerPaymentBase}`,
                };
            }
            // `>`이지 `>=`가 아니다 — 예산과 정확히 같은 총액까지는 예산 안이다. 마지막
            // 한 단위를 쓸 수 없게 만들면 설정한 숫자와 실제 한도가 달라진다.
            if (
                policy.maxSessionTotalBase !== undefined &&
                signedBase + amount > policy.maxSessionTotalBase
            ) {
                return {
                    ok: false,
                    code: "SPEND_POLICY_REFUSED",
                    detail:
                        `payment of ${amount} would take this session to ` +
                        `${signedBase + amount}, over the AGENT_SESSION_BUDGET_MUSDC of ` +
                        `${policy.maxSessionTotalBase}`,
                };
            }
            return {ok: true};
        },
        wrap: (provider) => async (requirements) => {
            const leaf = await provider(requirements);
            // 서명이 던졌다면 여기 닿지 않는다 — 존재하지 않는 leaf는 청구될 수 없다.
            signedBase += BigInt(requirements.amount);
            return leaf;
        },
    };
}

async function readText(
    readTextFile: (path: string) => Promise<string>,
    path: string,
    label: string,
): Promise<string> {
    try {
        return await readTextFile(path);
    } catch {
        throw new Error(`${label} not found or unreadable: ${path}`);
    }
}

async function readTrustedFacilitators(
    facilitatorUrl: URL,
    fetchImpl: typeof fetch,
): Promise<Address[]> {
    const response = await fetchImpl(new URL("/supported", facilitatorUrl), {
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`facilitator /supported returned ${response.status}`);
    const body = (await response.json()) as {signers?: Record<string, unknown>};
    const values = body.signers?.[GIWA_SEPOLIA_CAIP2];
    if (!Array.isArray(values) || values.length === 0) {
        throw new Error("facilitator advertised no GIWA signer");
    }
    return values.map((value) => {
        if (typeof value !== "string" || !isAddress(value)) {
            throw new Error("facilitator advertised an invalid signer");
        }
        return getAddress(value);
    });
}

/**
 * Load env + on-chain deployment, verify the Framework is the exact audited
 * composition, and build the payment-specific leaf provider. Read-only against the
 * chain (never broadcasts). Throws on any misconfiguration so a caller never starts
 * with a half-built runtime.
 */
export async function loadDelegatedAgentRuntime(
    options: LoadDelegatedAgentRuntimeOptions = {},
): Promise<DelegatedAgentRuntime> {
    const env = options.env ?? (process.env as Record<string, string | undefined>);
    const readTextFile = options.readTextFile ?? ((path: string) => Bun.file(path).text());
    const fetchImpl = options.fetchImpl ?? fetch;

    const account = privateKeyToAccount(readAgentKey(env));
    const sellerUrl = readHttpUrl(env, "SELLER_URL", "http://127.0.0.1:3001");
    const facilitatorUrl = readHttpUrl(env, "FACILITATOR_URL", "http://127.0.0.1:8081");
    const rpcUrl = readRpcUrl(env);
    const frameworkAdmin = readAddress(env, "FRAMEWORK_ADMIN_ADDRESS");
    // 파일도 네트워크도 건드리기 전에 읽는다. 잘못된 한도는 부팅 실패이고, 그 실패가
    // RPC 왕복 뒤에 나오면 운영자는 자기 오타를 네트워크 문제로 먼저 의심한다.
    const spendPolicy = parseAgentSpendPolicy(env);

    const deploymentPath =
        env.DELEGATION_DEPLOYMENT_PATH ?? "../../deployments/giwa-sepolia.framework.json";
    const manifestPath =
        env.DELEGATION_MANIFEST_PATH ??
        "../../deployments/giwa-sepolia.framework-manifest.json";
    const parentPath = env.PARENT_PERMISSION_CONTEXT_PATH ?? "./open-agent.permission.json";

    const [deployment, manifest, parentText, trustedFacilitators] = await Promise.all([
        readText(readTextFile, deploymentPath, "deployment artifact").then(
            parseActiveDeploymentArtifactJson,
        ),
        readText(readTextFile, manifestPath, "Framework manifest").then(
            parseFrameworkDeploymentManifestJson,
        ),
        readText(readTextFile, parentPath, "parent permission file"),
        readTrustedFacilitators(facilitatorUrl, fetchImpl),
    ]);

    const parent = JSON.parse(parentText) as {permissionContext?: unknown};
    if (!isPermissionContext(parent.permissionContext)) {
        throw new Error("parent permissionContext is missing, malformed, or too large");
    }

    const publicClient = createPublicClient({
        chain: giwaSepolia,
        transport: throttledHttp(rpcUrl),
    });
    await verifyActiveFrameworkDeployment({
        publicClient,
        deployment,
        manifest,
        expectedFrameworkAdmin: frameworkAdmin,
    });

    const spendGate = createAgentSpendGate(spendPolicy);
    const provider = spendGate.wrap(
        createMapaeDelegationProvider({
            account,
            environment: deployment.environment,
            parentPermissionContext: parent.permissionContext,
            facilitatorAddresses: trustedFacilitators,
        }),
    );

    // The caps live on the permissions the owner and any intermediate manager
    // signed, not on the leaf the agent mints per payment. Every link carries its
    // own caveats and the DelegationManager enforces all of them, so pre-flight
    // reads the whole chain: checking only the root would clear a payment that a
    // re-delegated child's tighter cap refuses on-chain.
    const chain = decodeDelegations(parent.permissionContext);
    // `isPermissionContext` above checks shape and length, not content, so a well-formed
    // encoding of an empty `Delegation[]` reaches here. An agent whose permission holds no
    // links has nothing to spend under; failing at bootstrap says so once rather than
    // once per payment. `judgePreflight` guards the same state for callers that build
    // their own status list.
    if (chain.length === 0) {
        throw new Error("parent permissionContext decodes to no delegations");
    }

    /**
     * 두 판정을 합성한다. **운영자 정책이 먼저다.**
     *
     * 근거는 두 가지다. 첫째, 정책 판정은 체인을 읽지 않고 답할 수 있으므로 거절할 결제에
     * RPC 왕복을 쓰지 않는다. 둘째, 두 거절은 운영자를 다른 곳으로 보낸다 — 정책 거절은
     * `.env`에서 고칠 수 있는 것이고, 온체인 거절은 새 서명이나 다음 기간을 기다리는 것이다.
     * 정책이 이미 거절한 결제를 체인 상태로 설명하면, 고칠 수 있는 원인이 고칠 수 없는
     * 원인 뒤에 가려진다.
     */
    const preflight = async (
        requirements: Erc7710PaymentRequirements,
    ): Promise<PreflightVerdict> => {
        const policyVerdict = spendGate.judge(requirements);
        if (!policyVerdict.ok) return policyVerdict;
        return judgePreflight(
            await Promise.all(
                chain.map((delegation) =>
                    readDelegationStatus({
                        publicClient,
                        environment: deployment.environment,
                        delegation,
                    }),
                ),
            ),
            BigInt(requirements.amount),
        );
    };

    return {
        account,
        provider,
        preflight,
        spendPolicy,
        delegationManager: getAddress(deployment.environment.DelegationManager),
        trustedFacilitators,
        sellerUrl,
        facilitatorUrl,
        frameworkAdmin,
        rpcUrl,
    };
}

/**
 * Resolve a caller-supplied resource path against the seller origin, rejecting
 * anything that could escape it (protocol-relative, backslash, cross-origin).
 */
/**
 * Decide whether a payment may be signed, given every link's on-chain status.
 *
 * Split from the chain reads on purpose, the same way `revoke-state.ts` splits the
 * console's revoke gate from its component: this is the decision that stands between an
 * agent and a signature, and a decision reachable only through a bootstrap that wants
 * env vars, files and an RPC is a decision nobody tests.
 *
 * Two orderings here are deliberate rather than incidental.
 *
 * **Inactive before over-cap.** A revoked or expired permission is refused even when the
 * amount fits. Reporting `LIMIT_EXCEEDED` for a permission that is not usable at any
 * amount would send the operator to raise a cap that was never the problem.
 *
 * **Tightest link, not the root.** Every link's caveats are enforced by the
 * DelegationManager, so a re-delegated child's smaller cap binds even when the root has
 * room. Checking only the root would clear a payment the chain then refuses — the agent
 * would sign, the settlement would revert, and the failure would surface as a facilitator
 * error rather than as the limit doing its job.
 */
/**
 * The smallest remaining period allowance across a chain, or `undefined` when no link
 * carries an `ERC20PeriodTransferEnforcer` caveat at all.
 *
 * Shared because two callers computed it with the same six lines and then drew opposite
 * conclusions from `undefined` — one of them wrongly. Keeping the computation in one place
 * makes the disagreement visible as a disagreement rather than as a copy that fell behind.
 *
 * `undefined` means "there is no period cap to compare against", never "the payment fits".
 * Every caller has to say which of those it wants.
 */
export function tightestPeriodRemaining(statuses: DelegationStatus[]): bigint | undefined {
    let tightest: bigint | undefined;
    for (const status of statuses) {
        if (status.remaining === undefined) continue;
        if (tightest === undefined || status.remaining < tightest) tightest = status.remaining;
    }
    return tightest;
}

export function judgePreflight(statuses: DelegationStatus[], amount: bigint): PreflightVerdict {
    // An empty chain must not read as "no limits apply".
    //
    // Everything below is a loop, so with no statuses each one falls through and the
    // function clears the payment — measured at 999 mUSDC against a chain it had read
    // nothing from. That state is reachable: `isPermissionContext` is a shape-and-length
    // guard on hex, and a well-formed ABI encoding of an empty `Delegation[]` is 130
    // characters that passes it and decodes to `[]`.
    //
    // The settlement would still be refused on-chain, so this was never a route to funds.
    // What it defeated is the reason this function exists — reporting a cause from the
    // chain's own accounting instead of walking into the seller and relaying a status
    // code. "We read nothing" is not "we read no limits".
    if (statuses.length === 0) {
        return {
            ok: false,
            code: "PERMISSION_EMPTY",
            detail: "permission context decodes to no delegations — nothing to spend under",
        };
    }
    for (const status of statuses) {
        if (status.revoked) {
            return {ok: false, code: "PERMISSION_INACTIVE", detail: "permission was revoked"};
        }
        if (status.expired) {
            return {ok: false, code: "PERMISSION_INACTIVE", detail: "permission has expired"};
        }
        if (status.notYetActive) {
            return {ok: false, code: "PERMISSION_INACTIVE", detail: "permission is not active yet"};
        }
    }

    const tightest = tightestPeriodRemaining(statuses);
    // A chain with links but no period caveat anywhere leaves this undefined, and this
    // function deliberately clears the payment then: its question is "will the chain refuse
    // this?", and with no period cap the answer is no. That is *not* the same judgement the
    // broadcast gate in `apps/delegation-lab/giwa-preflight.ts` makes — a human reading
    // "GO — every condition met" before an irreversible settlement must not be shown a
    // missing cap as a satisfied one. The two callers share the computation above and
    // disagree on purpose; do not "fix" the inconsistency by copying one into the other.
    //
    // The empty-chain case above is different in kind and does refuse: "we read nothing" is
    // not "we read a policy with no period cap".
    if (tightest !== undefined && amount > tightest) {
        return {
            ok: false,
            code: "LIMIT_EXCEEDED",
            detail: `payment of ${amount} exceeds ${tightest} left in this period`,
        };
    }
    return {ok: true};
}

export function resolveResourceTarget(sellerUrl: URL, resourcePath: string): URL {
    if (
        !resourcePath.startsWith("/") ||
        resourcePath.startsWith("//") ||
        resourcePath.includes("\\")
    ) {
        throw new Error("resource must be an absolute path on the seller origin");
    }
    const target = new URL(resourcePath, sellerUrl);
    if (target.origin !== sellerUrl.origin) {
        throw new Error("resource escaped the seller origin");
    }
    return target;
}
