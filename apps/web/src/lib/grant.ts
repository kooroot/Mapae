import {buildRootDelegationTypedData, type PermissionArtifact} from "@mapae/delegation/signing";
import {isCanonicalSignature} from "@mapae/delegation/account-bootstrap";
import {DELEGATION_FRAMEWORK_VERSION, OWNER_ACCOUNT_SALT} from "@mapae/delegation/config";
import {MOCK_USDC, giwaSepolia, toTokenAmount} from "@mapae/shared";
import {Implementation} from "@metamask/smart-accounts-kit";
import {decodeDelegations, getCounterfactualAccountData} from "@metamask/smart-accounts-kit/utils";
import {
    getAddress,
    hashTypedData,
    isAddress,
    maxUint256,
    parseAbi,
    recoverTypedDataAddress,
    zeroAddress,
    type Address,
} from "viem";
import {deployment, publicClient} from "./config";
import type {AgentSessionKey} from "./agent-key";

export interface GrantDraft {
    agentName: string;
    delegate: string;
    amount: string;
    periodSeconds: string;
    expirySeconds: string;
    recipientMode: "any" | "fixed";
    recipient: string;
}

export type ValidGrantDraft = {
    agentName: string;
    delegate: Address;
    periodAmount: bigint;
    periodDurationSeconds: number;
    expiresAfterSeconds: number;
    recipient?: Address;
};

export type GrantDraftState =
    | {kind: "invalid"; field: keyof GrantDraft; reason: string}
    | {kind: "ok"; value: ValidGrantDraft};

export interface SessionGrant {
    id: string;
    name: string;
    source: "signed" | "imported";
    artifact: PermissionArtifact;
    amount?: bigint;
    periodSeconds?: number;
    expirySeconds?: number;
    recipient?: Address;
    /**
     * Present only when this tab generated the agent's session key. Tab memory
     * only, like the permission context — the MCP bundle export is the one exit.
     */
    agentKey?: AgentSessionKey;
}

/**
 * `DelegationManager.ANY_DELEGATE` — the sentinel that makes a delegation redeemable by
 * anyone at all.
 *
 * Refused here and only here, on purpose. A *leaf* uses it legitimately: the payment leaf
 * carries `ANY_DELEGATE` and is bound instead by a `RedeemerEnforcer` naming the
 * facilitator, which `packages/delegation/src/leaf.test.ts` pins. Pushing this check down
 * into `packages/delegation` would break that. In a *root*, though, it would hand the whole
 * period cap to any caller on the chain — so the Studio form, which only ever produces
 * roots, is exactly the right layer for the refusal.
 */
const ANY_DELEGATE: Address = getAddress("0x0000000000000000000000000000000000000a11");

function positiveSafeInteger(raw: string): number | undefined {
    if (!/^[1-9]\d*$/.test(raw.trim())) return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : undefined;
}

export function validateGrantDraft(draft: GrantDraft): GrantDraftState {
    const agentName = draft.agentName.trim();
    if (!agentName) {
        return {kind: "invalid", field: "agentName", reason: "에이전트 이름을 입력해 주세요."};
    }
    if (agentName.length > 40) {
        return {
            kind: "invalid",
            field: "agentName",
            reason: "에이전트 이름은 40자 이내로 입력해 주세요.",
        };
    }
    if (!isAddress(draft.delegate.trim())) {
        return {
            kind: "invalid",
            field: "delegate",
            reason: "에이전트의 0x 지갑 주소를 확인해 주세요.",
        };
    }
    if (getAddress(draft.delegate.trim()) === zeroAddress) {
        return {
            kind: "invalid",
            field: "delegate",
            reason: "에이전트 주소로 0x0 주소를 사용할 수 없습니다.",
        };
    }
    if (getAddress(draft.delegate.trim()) === ANY_DELEGATE) {
        return {
            kind: "invalid",
            field: "delegate",
            reason: "이 주소는 누구나 사용할 수 있는 값이라 에이전트 주소로 쓸 수 없습니다.",
        };
    }

    let periodAmount: bigint;
    try {
        periodAmount = toTokenAmount(draft.amount);
    } catch {
        return {
            kind: "invalid",
            field: "amount",
            reason: "금액은 소수점 6자리 이하의 양수로 입력해 주세요.",
        };
    }
    if (periodAmount <= 0n) {
        return {
            kind: "invalid",
            field: "amount",
            reason: "금액은 0보다 커야 합니다.",
        };
    }
    if (periodAmount > maxUint256) {
        return {
            kind: "invalid",
            field: "amount",
            reason: "금액이 온체인 uint256 범위를 넘습니다.",
        };
    }

    const periodDurationSeconds = positiveSafeInteger(draft.periodSeconds);
    if (!periodDurationSeconds) {
        return {
            kind: "invalid",
            field: "periodSeconds",
            reason: "결제 주기를 선택해 주세요.",
        };
    }
    const expiresAfterSeconds = positiveSafeInteger(draft.expirySeconds);
    if (!expiresAfterSeconds) {
        return {
            kind: "invalid",
            field: "expirySeconds",
            reason: "권한 유효 기간을 선택해 주세요.",
        };
    }
    if (expiresAfterSeconds < periodDurationSeconds) {
        return {
            kind: "invalid",
            field: "expirySeconds",
            reason: "권한 유효 기간은 결제 주기보다 짧을 수 없습니다.",
        };
    }

    let recipient: Address | undefined;
    if (draft.recipientMode === "fixed") {
        if (!isAddress(draft.recipient.trim())) {
            return {
                kind: "invalid",
                field: "recipient",
                reason: "허용할 수취인의 0x 주소를 확인해 주세요.",
            };
        }
        recipient = getAddress(draft.recipient.trim());
        if (recipient === zeroAddress) {
            return {
                kind: "invalid",
                field: "recipient",
                reason: "수취인으로 0x0 주소를 사용할 수 없습니다.",
            };
        }
        if (recipient === ANY_DELEGATE) {
            return {
                kind: "invalid",
                field: "recipient",
                reason: "이 주소는 누구나 사용할 수 있는 값이라 수취인으로 쓸 수 없습니다.",
            };
        }
    }

    return {
        kind: "ok",
        value: {
            agentName,
            delegate: getAddress(draft.delegate.trim()),
            periodAmount,
            periodDurationSeconds,
            expiresAfterSeconds,
            recipient,
        },
    };
}

/**
 * What the agent can actually spend right now — which is not what the caveat allows.
 *
 * The enforcer caps how much may leave the account; it says nothing about how much is in
 * it. Showing the cap alone is how a freshly bootstrapped account displays "3 mUSDC
 * available" over a zero balance: the first payment then dies inside the token transfer
 * rather than at the enforcer, and the user reads "settlement failed" when the true answer
 * is "you have not funded this account".
 *
 * `undefined` balance is `"unknown"`, never zero. A read we could not make is a question we
 * could not answer, and answering it "empty" would put a false warning in front of an
 * account that is fine.
 */
export function judgeSpendable(params: {available: bigint; balance: bigint | undefined}): {
    spendable: bigint;
    limitedBy: "cap" | "balance" | "unknown";
} {
    if (params.balance === undefined) {
        return {spendable: params.available, limitedBy: "unknown"};
    }
    if (params.balance < params.available) {
        return {spendable: params.balance, limitedBy: "balance"};
    }
    return {spendable: params.available, limitedBy: "cap"};
}

const ERC20_BALANCE_ABI = parseAbi([
    "function balanceOf(address account) view returns (uint256)",
]);

/** The payer's token balance, or `undefined` when the chain read failed. */
export async function readPayerBalance(payer: Address): Promise<bigint | undefined> {
    try {
        return await publicClient.readContract({
            address: MOCK_USDC.address,
            abi: ERC20_BALANCE_ABI,
            functionName: "balanceOf",
            args: [payer],
        });
    } catch {
        return undefined;
    }
}

const ERC1271_MAGIC_VALUE = "0x1626ba7e";
const ERC1271_ABI = parseAbi([
    "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);

/**
 * A browser signature is not accepted merely because the wallet returned bytes.
 * The deployed HybridDeleGator must accept the exact delegation digest through
 * ERC-1271, which is the same check settlement later relies on.
 *
 * When the account is not deployed yet there is nothing on chain to ask, so the offline
 * pair in {@link verifyUndeployedPermissionArtifact} stands in — see that function for why
 * it is equivalent rather than weaker. Deployment is still mandatory before any payment:
 * `DelegationManager` takes an EOA branch for a codeless delegator and reverts
 * `InvalidEOASignature`, so a grant on an undeployed account cannot settle. This function
 * decides which check applies; it never lets a grant through unchecked.
 */
export async function verifyPermissionArtifact(artifact: PermissionArtifact): Promise<void> {
    const chain = decodeDelegations(artifact.permissionContext);
    const root = chain.at(-1);
    if (!root) throw new Error("서명 결과에 루트 권한이 없습니다.");

    const typedData = buildRootDelegationTypedData(
        getAddress(deployment.environment.DelegationManager),
        root,
    );

    const code = await publicClient.getCode({address: artifact.delegator});
    if (!code || code === "0x") {
        await verifyUndeployedPermissionArtifact(artifact.delegator, root, typedData);
        return;
    }

    const digest = hashTypedData(typedData);
    const magic = await publicClient.readContract({
        address: artifact.delegator,
        abi: ERC1271_ABI,
        functionName: "isValidSignature",
        args: [digest, root.signature],
    });
    if (magic.toLowerCase() !== ERC1271_MAGIC_VALUE) {
        throw new Error("지불 계정이 이 서명을 승인하지 않았습니다.");
    }
}

/**
 * Verify a root signature against an account that does not exist yet.
 *
 * This reproduces, offline, exactly what the deployed account would compute.
 * `HybridDeleGator._isValidSignature` branches on signature length: exactly 65 bytes takes
 * `ECDSA.recover(hash, sig) == owner()`, and `owner()` is fixed at construction by the
 * CREATE2 initcode. Every account this app derives uses `deployParams: [owner, [], [], []]`,
 * so `authorizedKeys` is empty and the P256 branch can only return `SIG_VALIDATION_FAILED`.
 * Recovering the signer and requiring `CREATE2(signer)` to equal the delegator therefore
 * answers the same question the chain would, using the same inputs.
 *
 * The canonical-form check is not pedantry. OpenZeppelin's `ECDSA.recover` reverts on
 * `s` above half-order and on `v` outside {27, 28}, while viem's recover accepts both. A
 * malleable signature would verify here, get an account deployed for it, and then revert
 * forever on chain — we would pay and the user still could not pay.
 */
async function verifyUndeployedPermissionArtifact(
    delegator: Address,
    root: {signature: `0x${string}`},
    typedData: ReturnType<typeof buildRootDelegationTypedData>,
): Promise<void> {
    if (!isCanonicalSignature(root.signature)) {
        throw new Error(
            "지갑이 만든 서명이 온체인에서 거부되는 형식입니다. 다른 지갑으로 다시 시도해 주세요.",
        );
    }
    let signer: Address;
    try {
        signer = await recoverTypedDataAddress({...typedData, signature: root.signature});
    } catch {
        throw new Error("서명을 해석할 수 없습니다.");
    }
    const derived = await getCounterfactualAccountData({
        factory: getAddress(deployment.environment.SimpleFactory),
        implementations: deployment.environment.implementations,
        implementation: Implementation.Hybrid,
        deployParams: [getAddress(signer), [], [], []],
        deploySalt: OWNER_ACCOUNT_SALT,
    });
    if (getAddress(derived.address) !== getAddress(delegator)) {
        throw new Error("이 서명은 해당 지불 계정의 소유자가 만든 것이 아닙니다.");
    }
}

/**
 * Ask the sponsor to deploy the payer account, then confirm on chain.
 *
 * The request body carries the signed permission context and nothing else — no owner
 * address, no salt, no bytecode. Everything the sponsor acts on is reconstructed from that
 * signature, so there is no field a caller can steer. The post-deploy `getCode` read is
 * not decoration: a success response is the sponsor's claim, and the account either has
 * code or it does not.
 */
export async function requestSponsoredBootstrap(
    endpoint: string,
    artifact: PermissionArtifact,
): Promise<void> {
    let response: Response;
    try {
        response = await fetch(`${endpoint}/bootstrap`, {
            method: "POST",
            redirect: "error",
            headers: {"content-type": "application/json"},
            body: JSON.stringify({permissionContext: artifact.permissionContext}),
            signal: AbortSignal.timeout(90_000),
        });
    } catch {
        throw new Error("지불 계정 준비 서버에 연결하지 못했습니다.");
    }
    if (!response.ok) {
        // The body is a closed enum by design; map it rather than rendering it, so a new
        // server-side reason can never become UI text nobody wrote.
        const reason = await response
            .json()
            .then((body: unknown) => (body as {reason?: string}).reason)
            .catch(() => undefined);
        throw new Error(bootstrapRefusalMessage(reason));
    }
    const code = await publicClient.getCode({address: artifact.delegator});
    if (!code || code === "0x") {
        throw new Error("지불 계정 배포가 아직 확인되지 않았습니다. 잠시 후 다시 시도해 주세요.");
    }
}

function bootstrapRefusalMessage(reason: string | undefined): string {
    switch (reason) {
        case "bootstrap_disabled":
            return "지불 계정 준비 기능이 현재 꺼져 있습니다.";
        case "rate_limited":
            return "요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.";
        case "budget_exhausted":
        case "sponsor_unfunded":
            return "오늘 준비 가능한 계정 수를 모두 사용했습니다. 잠시 후 다시 시도해 주세요.";
        case "fee_too_high":
            return "네트워크 수수료가 일시적으로 높습니다. 잠시 후 다시 시도해 주세요.";
        case "malformed_request":
        case "gas_estimate_rejected":
            return "이 권한으로는 지불 계정을 준비할 수 없습니다.";
        default:
            return "지불 계정을 준비하지 못했습니다.";
    }
}

export function signedSessionGrant(
    artifact: PermissionArtifact,
    value: ValidGrantDraft,
    agentKey?: AgentSessionKey,
): SessionGrant {
    return {
        id: `${artifact.createdAt}:${artifact.delegate}:${artifact.permissionContext.slice(-18)}`,
        name: value.agentName,
        source: "signed",
        artifact,
        amount: value.periodAmount,
        periodSeconds: value.periodDurationSeconds,
        expirySeconds: value.expiresAfterSeconds,
        recipient: value.recipient,
        agentKey,
    };
}

export function importedSessionGrant(permissionContext: `0x${string}`): SessionGrant {
    const links = decodeDelegations(permissionContext);
    const leaf = links[0];
    const root = links.at(-1);
    if (!leaf || !root) throw new Error("비어 있는 권한 코드는 가져올 수 없습니다.");
    const createdAt = Math.floor(Date.now() / 1000);
    return {
        id: `imported:${createdAt}:${permissionContext.slice(-18)}`,
        name: `에이전트 ${getAddress(leaf.delegate).slice(0, 8)}`,
        source: "imported",
        artifact: {
            frameworkVersion: DELEGATION_FRAMEWORK_VERSION,
            chainId: giwaSepolia.id,
            role: "imported",
            delegator: getAddress(root.delegator),
            delegate: getAddress(leaf.delegate),
            permissionContext,
            createdAt,
        },
    };
}

export function tokenLabel(): string {
    return `${MOCK_USDC.symbol} · GIWA Sepolia`;
}
