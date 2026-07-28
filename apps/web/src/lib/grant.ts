import {buildRootDelegationTypedData, type PermissionArtifact} from "@mapae/delegation/signing";
import {DELEGATION_FRAMEWORK_VERSION} from "@mapae/delegation/config";
import {MOCK_USDC, giwaSepolia, toTokenAmount} from "@mapae/shared";
import {decodeDelegations} from "@metamask/smart-accounts-kit/utils";
import {
    getAddress,
    hashTypedData,
    isAddress,
    maxUint256,
    parseAbi,
    zeroAddress,
    type Address,
} from "viem";
import {deployment, publicClient} from "./config";

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
}

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

const ERC1271_MAGIC_VALUE = "0x1626ba7e";
const ERC1271_ABI = parseAbi([
    "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);

/**
 * A browser signature is not accepted merely because the wallet returned bytes.
 * The deployed HybridDeleGator must accept the exact delegation digest through
 * ERC-1271, which is the same check settlement later relies on.
 */
export async function verifyPermissionArtifact(artifact: PermissionArtifact): Promise<void> {
    const chain = decodeDelegations(artifact.permissionContext);
    const root = chain.at(-1);
    if (!root) throw new Error("서명 결과에 루트 권한이 없습니다.");

    const code = await publicClient.getCode({address: artifact.delegator});
    if (!code || code === "0x") {
        throw new Error("지불 계정이 아직 GIWA에 배포되지 않아 권한을 활성화할 수 없습니다.");
    }

    const typedData = buildRootDelegationTypedData(
        getAddress(deployment.environment.DelegationManager),
        root,
    );
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

export function signedSessionGrant(
    artifact: PermissionArtifact,
    value: ValidGrantDraft,
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
