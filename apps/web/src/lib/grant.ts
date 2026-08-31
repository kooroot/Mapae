import {buildRootDelegationTypedData, type PermissionArtifact} from "@mapae/delegation/signing";
import {isCanonicalSignature} from "@mapae/delegation/account-bootstrap";
import {DELEGATION_FRAMEWORK_VERSION, OWNER_ACCOUNT_SALT} from "@mapae/delegation/config";
import {readGrantsFromChain} from "@mapae/delegation/delegation-status";
import {MOCK_USDC, giwaSepolia, toTokenAmount} from "@mapae/shared";
import {Implementation} from "@metamask/smart-accounts-kit";
import {
    decodeDelegations,
    encodeDelegations,
    getCounterfactualAccountData,
} from "@metamask/smart-accounts-kit/utils";
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
import type {Locale} from "./i18n";

/**
 * Every user-facing sentence this module produces, both locales, `en` first because
 * English is the base. Producers take an optional trailing `locale` defaulting to
 * `"en"`, so existing call sites keep compiling; components pass the active locale.
 */
const MSG: Record<
    Locale,
    {
        agentNameRequired: string;
        agentNameTooLong: string;
        delegateInvalid: string;
        delegateZero: string;
        delegateAnyone: string;
        amountInvalid: string;
        amountZero: string;
        amountOverflow: string;
        periodRequired: string;
        expiryRequired: string;
        expiryShorterThanPeriod: string;
        recipientInvalid: string;
        recipientZero: string;
        recipientAnyone: string;
        noRootPermission: string;
        signatureNotAccepted: string;
        signatureNotCanonical: string;
        signatureUnreadable: string;
        signatureWrongOwner: string;
        bootstrapUnreachable: string;
        bootstrapNotConfirmed: string;
        bootstrapDisabled: string;
        bootstrapBudgetExhausted: string;
        bootstrapFeeTooHigh: string;
        bootstrapPermissionRejected: string;
        bootstrapFailed: string;
        importedEmpty: string;
        importedAgentPrefix: string;
        recoveredAgentPrefix: string;
    }
> = {
    en: {
        agentNameRequired: "Enter an agent name.",
        agentNameTooLong: "Keep the agent name to 40 characters or fewer.",
        delegateInvalid: "Check the agent's 0x wallet address.",
        delegateZero: "The 0x0 address cannot be used as the agent address.",
        delegateAnyone: "This address is usable by anyone and cannot be the agent address.",
        amountInvalid: "Enter a positive amount with at most 6 decimal places.",
        amountZero: "The amount must be greater than 0.",
        amountOverflow: "The amount exceeds the on-chain uint256 range.",
        periodRequired: "Select a payment period.",
        expiryRequired: "Select how long the permission remains valid.",
        expiryShorterThanPeriod: "The permission's validity cannot be shorter than the payment period.",
        recipientInvalid: "Check the allowed recipient's 0x address.",
        recipientZero: "The 0x0 address cannot be used as the recipient.",
        recipientAnyone: "This address is usable by anyone and cannot be the recipient.",
        noRootPermission: "The signed result contains no root permission.",
        signatureNotAccepted: "The payer account did not approve this signature.",
        signatureNotCanonical:
            "The wallet produced a signature in a form the chain rejects. Try again with a different wallet.",
        signatureUnreadable: "The signature could not be parsed.",
        signatureWrongOwner: "This signature was not made by the owner of this payer account.",
        bootstrapUnreachable: "Could not connect to the payer account setup service.",
        bootstrapNotConfirmed:
            "The payer account deployment has not been confirmed yet. Try again in a moment.",
        bootstrapDisabled: "Payer account setup is currently turned off.",
        bootstrapBudgetExhausted:
            "Today's allowance of new accounts has been used. Try again later.",
        bootstrapFeeTooHigh: "Network fees are temporarily high. Try again in a moment.",
        bootstrapPermissionRejected: "A payer account cannot be set up from this permission.",
        bootstrapFailed: "The payer account could not be set up.",
        importedEmpty: "An empty permission code cannot be imported.",
        importedAgentPrefix: "Agent",
        recoveredAgentPrefix: "Recovered agent",
    },
    ko: {
        agentNameRequired: "에이전트 이름을 입력해 주세요.",
        agentNameTooLong: "에이전트 이름은 40자 이내로 입력해 주세요.",
        delegateInvalid: "에이전트의 0x 지갑 주소를 확인해 주세요.",
        delegateZero: "에이전트 주소로 0x0 주소를 사용할 수 없습니다.",
        delegateAnyone: "이 주소는 누구나 사용할 수 있는 값이라 에이전트 주소로 쓸 수 없습니다.",
        amountInvalid: "금액은 소수점 6자리 이하의 양수로 입력해 주세요.",
        amountZero: "금액은 0보다 커야 합니다.",
        amountOverflow: "금액이 온체인 uint256 범위를 넘습니다.",
        periodRequired: "결제 주기를 선택해 주세요.",
        expiryRequired: "권한 유효 기간을 선택해 주세요.",
        expiryShorterThanPeriod: "권한 유효 기간은 결제 주기보다 짧을 수 없습니다.",
        recipientInvalid: "허용할 수취인의 0x 주소를 확인해 주세요.",
        recipientZero: "수취인으로 0x0 주소를 사용할 수 없습니다.",
        recipientAnyone: "이 주소는 누구나 사용할 수 있는 값이라 수취인으로 쓸 수 없습니다.",
        noRootPermission: "서명 결과에 루트 권한이 없습니다.",
        signatureNotAccepted: "지불 계정이 이 서명을 승인하지 않았습니다.",
        signatureNotCanonical:
            "지갑이 만든 서명이 온체인에서 거부되는 형식입니다. 다른 지갑으로 다시 시도해 주세요.",
        signatureUnreadable: "서명을 해석할 수 없습니다.",
        signatureWrongOwner: "이 서명은 해당 지불 계정의 소유자가 만든 것이 아닙니다.",
        bootstrapUnreachable: "지불 계정 준비 서버에 연결하지 못했습니다.",
        bootstrapNotConfirmed:
            "지불 계정 배포가 아직 확인되지 않았습니다. 잠시 후 다시 시도해 주세요.",
        bootstrapDisabled: "지불 계정 준비 기능이 현재 꺼져 있습니다.",
        bootstrapBudgetExhausted:
            "오늘 준비 가능한 계정 수를 모두 사용했습니다. 잠시 후 다시 시도해 주세요.",
        bootstrapFeeTooHigh: "네트워크 수수료가 일시적으로 높습니다. 잠시 후 다시 시도해 주세요.",
        bootstrapPermissionRejected: "이 권한으로는 지불 계정을 준비할 수 없습니다.",
        bootstrapFailed: "지불 계정을 준비하지 못했습니다.",
        importedEmpty: "비어 있는 권한 코드는 가져올 수 없습니다.",
        importedAgentPrefix: "에이전트",
        recoveredAgentPrefix: "복구된 에이전트",
    },
};

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

export function validateGrantDraft(draft: GrantDraft, locale: Locale = "en"): GrantDraftState {
    const m = MSG[locale];
    const agentName = draft.agentName.trim();
    if (!agentName) {
        return {kind: "invalid", field: "agentName", reason: m.agentNameRequired};
    }
    if (agentName.length > 40) {
        return {
            kind: "invalid",
            field: "agentName",
            reason: m.agentNameTooLong,
        };
    }
    if (!isAddress(draft.delegate.trim())) {
        return {
            kind: "invalid",
            field: "delegate",
            reason: m.delegateInvalid,
        };
    }
    if (getAddress(draft.delegate.trim()) === zeroAddress) {
        return {
            kind: "invalid",
            field: "delegate",
            reason: m.delegateZero,
        };
    }
    if (getAddress(draft.delegate.trim()) === ANY_DELEGATE) {
        return {
            kind: "invalid",
            field: "delegate",
            reason: m.delegateAnyone,
        };
    }

    let periodAmount: bigint;
    try {
        periodAmount = toTokenAmount(draft.amount);
    } catch {
        return {
            kind: "invalid",
            field: "amount",
            reason: m.amountInvalid,
        };
    }
    if (periodAmount <= 0n) {
        return {
            kind: "invalid",
            field: "amount",
            reason: m.amountZero,
        };
    }
    if (periodAmount > maxUint256) {
        return {
            kind: "invalid",
            field: "amount",
            reason: m.amountOverflow,
        };
    }

    const periodDurationSeconds = positiveSafeInteger(draft.periodSeconds);
    if (!periodDurationSeconds) {
        return {
            kind: "invalid",
            field: "periodSeconds",
            reason: m.periodRequired,
        };
    }
    const expiresAfterSeconds = positiveSafeInteger(draft.expirySeconds);
    if (!expiresAfterSeconds) {
        return {
            kind: "invalid",
            field: "expirySeconds",
            reason: m.expiryRequired,
        };
    }
    if (expiresAfterSeconds < periodDurationSeconds) {
        return {
            kind: "invalid",
            field: "expirySeconds",
            reason: m.expiryShorterThanPeriod,
        };
    }

    let recipient: Address | undefined;
    if (draft.recipientMode === "fixed") {
        if (!isAddress(draft.recipient.trim())) {
            return {
                kind: "invalid",
                field: "recipient",
                reason: m.recipientInvalid,
            };
        }
        recipient = getAddress(draft.recipient.trim());
        if (recipient === zeroAddress) {
            return {
                kind: "invalid",
                field: "recipient",
                reason: m.recipientZero,
            };
        }
        if (recipient === ANY_DELEGATE) {
            return {
                kind: "invalid",
                field: "recipient",
                reason: m.recipientAnyone,
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
 * Three separate things can say no, and the caveat is only one of them:
 *
 * - `halted` — the permission itself is dead (revoked, expired, or not yet active). A
 *   disabled root fails in `DelegationManager` before any caveat is consulted, so the cap
 *   is not merely unreachable, it is irrelevant. This is checked first for that reason:
 *   the answer needs no balance read and no period arithmetic.
 * - the balance — the enforcer caps how much may leave the account; it says nothing about
 *   how much is in it. Showing the cap alone is how a freshly bootstrapped account displays
 *   "3 mUSDC available" over a zero balance: the first payment then dies inside the token
 *   transfer rather than at the enforcer, and the user reads "settlement failed" when the
 *   true answer is "you have not funded this account".
 * - the cap itself, once neither of the above binds.
 *
 * `undefined` balance is `"unknown"`, never zero. A read we could not make is a question we
 * could not answer, and answering it "empty" would put a false warning in front of an
 * account that is fine.
 */
export function judgeSpendable(params: {
    available: bigint;
    balance: bigint | undefined;
    halted: boolean;
}): {
    spendable: bigint;
    limitedBy: "cap" | "balance" | "unknown" | "halted";
} {
    if (params.halted) {
        return {spendable: 0n, limitedBy: "halted"};
    }
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
export async function verifyPermissionArtifact(
    artifact: PermissionArtifact,
    locale: Locale = "en",
): Promise<void> {
    const m = MSG[locale];
    const chain = decodeDelegations(artifact.permissionContext);
    const root = chain.at(-1);
    if (!root) throw new Error(m.noRootPermission);

    const typedData = buildRootDelegationTypedData(
        getAddress(deployment.environment.DelegationManager),
        root,
    );

    const code = await publicClient.getCode({address: artifact.delegator});
    if (!code || code === "0x") {
        await verifyUndeployedPermissionArtifact(artifact.delegator, root, typedData, locale);
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
        throw new Error(m.signatureNotAccepted);
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
    locale: Locale = "en",
): Promise<void> {
    const m = MSG[locale];
    if (!isCanonicalSignature(root.signature)) {
        throw new Error(m.signatureNotCanonical);
    }
    let signer: Address;
    try {
        signer = await recoverTypedDataAddress({...typedData, signature: root.signature});
    } catch {
        throw new Error(m.signatureUnreadable);
    }
    const derived = await getCounterfactualAccountData({
        factory: getAddress(deployment.environment.SimpleFactory),
        implementations: deployment.environment.implementations,
        implementation: Implementation.Hybrid,
        deployParams: [getAddress(signer), [], [], []],
        deploySalt: OWNER_ACCOUNT_SALT,
    });
    if (getAddress(derived.address) !== getAddress(delegator)) {
        throw new Error(m.signatureWrongOwner);
    }
}

/**
 * The sponsor's reply body. A closed shape by design: it is mapped, never rendered, so a
 * new server-side field or reason can never become UI text nobody wrote.
 */
export interface BootstrapReply {
    status?: string;
    transaction?: string;
    fundingTransaction?: string;
    mintedBase?: string;
    targetBase?: string;
    reason?: string;
}

/**
 * One POST to the sponsor, shared by the deploy path and the testnet top-up.
 *
 * The body carries the signed permission context and nothing else — no owner address, no
 * salt, no bytecode. Everything the sponsor acts on is reconstructed from that signature,
 * so there is no field a caller can steer. `redirect: "error"` because that context is a
 * signed delegation, and a redirect would carry it to an origin nobody chose.
 */
export async function postBootstrap(
    endpoint: string,
    permissionContext: `0x${string}`,
    locale: Locale = "en",
): Promise<{ok: boolean; body: BootstrapReply}> {
    let response: Response;
    try {
        response = await fetch(`${endpoint}/bootstrap`, {
            method: "POST",
            redirect: "error",
            headers: {"content-type": "application/json"},
            body: JSON.stringify({permissionContext}),
            signal: AbortSignal.timeout(90_000),
        });
    } catch {
        throw new Error(MSG[locale].bootstrapUnreachable);
    }
    const body = (await response.json().catch(() => ({}))) as BootstrapReply;
    return {ok: response.ok, body};
}

/**
 * What one bootstrap attempt means for onboarding, given what the chain says afterwards.
 *
 * Chain state is the verdict; the sponsor's answer only explains a failure. Deployed code
 * ends the call successfully however the sponsor answered, because `/bootstrap` also serves
 * Studio's top-up button: an already-deployed account can be refused for reasons that are
 * about the faucet — a closed 24h window, an exhausted daily budget, a token balance the
 * sponsor could not read — and none of those unmake the deploy this call exists for.
 * Tolerating one named reason instead is what let `budget_exhausted` fail an onboarding
 * whose account was already live.
 *
 * @returns the message to fail with, or `undefined` when the account is deployed.
 */
export function judgeBootstrapOutcome(
    outcome: {ok: boolean; reason?: string; deployed: boolean},
    locale: Locale = "en",
): string | undefined {
    if (outcome.deployed) return undefined;
    if (!outcome.ok) return bootstrapRefusalMessage(outcome.reason, locale);
    return MSG[locale].bootstrapNotConfirmed;
}

/**
 * Ask the sponsor to deploy the payer account, then confirm on chain.
 *
 * The post-deploy `getCode` read is not decoration: a success response is the sponsor's
 * claim, and the account either has code or it does not. A read that itself fails is not a
 * deployment — "could not confirm" is the honest report, and it beats surfacing a raw RPC
 * error where a refusal message belongs.
 */
export async function requestSponsoredBootstrap(
    endpoint: string,
    artifact: PermissionArtifact,
    locale: Locale = "en",
): Promise<void> {
    const {ok, body} = await postBootstrap(endpoint, artifact.permissionContext, locale);
    const code = await publicClient
        .getCode({address: artifact.delegator})
        .catch(() => undefined);
    const failure = judgeBootstrapOutcome(
        {ok, reason: body.reason, deployed: code !== undefined && code !== "0x"},
        locale,
    );
    if (failure) throw new Error(failure);
}

function bootstrapRefusalMessage(reason: string | undefined, locale: Locale): string {
    const m = MSG[locale];
    switch (reason) {
        case "bootstrap_disabled":
            return m.bootstrapDisabled;
        case "budget_exhausted":
        case "sponsor_unfunded":
            return m.bootstrapBudgetExhausted;
        case "fee_too_high":
            return m.bootstrapFeeTooHigh;
        case "malformed_request":
        case "gas_estimate_rejected":
            return m.bootstrapPermissionRejected;
        default:
            return m.bootstrapFailed;
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

export function importedSessionGrant(
    permissionContext: `0x${string}`,
    locale: Locale = "en",
): SessionGrant {
    const m = MSG[locale];
    const links = decodeDelegations(permissionContext);
    const leaf = links[0];
    const root = links.at(-1);
    if (!leaf || !root) throw new Error(m.importedEmpty);
    const createdAt = Math.floor(Date.now() / 1000);
    return {
        id: `imported:${createdAt}:${permissionContext.slice(-18)}`,
        name: `${m.importedAgentPrefix} ${getAddress(leaf.delegate).slice(0, 8)}`,
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

/**
 * The payer smart account a wallet owns, derived rather than remembered.
 *
 * CREATE2 from `[owner, [], [], []]` at a fixed salt, which is the same derivation the
 * bootstrap sponsor performs — so a returning user always knows which account to ask the
 * chain about, with no storage and no server.
 */
export async function derivePayerAccount(owner: Address): Promise<Address> {
    const derived = await getCounterfactualAccountData({
        factory: getAddress(deployment.environment.SimpleFactory),
        implementations: deployment.environment.implementations,
        implementation: Implementation.Hybrid,
        deployParams: [getAddress(owner), [], [], []],
        deploySalt: OWNER_ACCOUNT_SALT,
    });
    return getAddress(derived.address);
}

/**
 * Rebuild this wallet's grants from settled payments on chain.
 *
 * Only covers grants that have settled at least once — an unused grant has no on-chain
 * footprint, which is exactly the gap the local store closes. Restored grants carry no
 * agent key: the chain never held one, and neither does the store.
 */
export async function recoverGrantsFromChain(params: {
    owner: Address;
    fromBlock: bigint;
    locale?: Locale;
}): Promise<SessionGrant[]> {
    const m = MSG[params.locale ?? "en"];
    const rootDelegator = await derivePayerAccount(params.owner);
    const roots = await readGrantsFromChain({
        publicClient,
        environment: deployment.environment,
        rootDelegator,
        fromBlock: params.fromBlock,
    });
    return roots.map((root) => {
        const permissionContext = encodeDelegations([root]);
        const createdAt = Math.floor(Date.now() / 1000);
        return {
            id: `chain:${getAddress(root.delegate)}:${permissionContext.slice(-18)}`,
            name: `${m.recoveredAgentPrefix} ${getAddress(root.delegate).slice(0, 8)}`,
            source: "imported",
            artifact: {
                frameworkVersion: DELEGATION_FRAMEWORK_VERSION,
                chainId: giwaSepolia.id,
                role: "imported",
                delegator: getAddress(root.delegator),
                delegate: getAddress(root.delegate),
                permissionContext,
                createdAt,
            },
        } satisfies SessionGrant;
    });
}
