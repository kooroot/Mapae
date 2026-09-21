import {
    ScopeType,
    createDelegation,
    type Delegation,
    type PermissionContext,
    type SmartAccountsEnvironment,
} from "@metamask/smart-accounts-kit";
import {createCaveatBuilder} from "@metamask/smart-accounts-kit/utils";
import {getAddress, pad, type Address, type Hex} from "viem";
import {MOCK_USDC, toTokenAmount} from "@mapae/shared";

export type D3Role =
    | "open-agent"
    | "vendor-agent"
    | "team-manager"
    | "child-a"
    | "child-b";

export interface PeriodPolicy {
    role: D3Role;
    token: Address;
    /** 한 기간에 쓸 수 있는 금액. 기간이 넘어가면 다시 채워진다. */
    periodAmount: bigint;
    /**
     * 이 위임이 살아 있는 동안 쓸 수 있는 누적 총액(선택). 설정하면
     * `ERC20TransferAmountEnforcer` caveat이 하나 더 붙는다.
     *
     * `periodAmount`는 **속도**이지 예산이 아니다. 기간마다 다시 채워지므로 위임이
     * 만료되기 전까지 실제로 빠져나갈 수 있는 총액은 `periodAmount × (만료/기간)`이고,
     * 그 안의 개별 결제는 전부 합법이어서 체인이 막지 않는다. 운영자가 "이 세션 키에
     * 얼마까지 맡겼다"고 말할 때 뜻하는 숫자는 이쪽이다.
     *
     * 총액을 한 caveat으로 셀 수 있는 근거는 enforcer의 저장소다:
     * `spentMap(delegationManager, delegationHash)`는 누적만 하고 되돌아가지 않으므로,
     * 같은 위임 해시로 상환되는 동안 계속 같은 칸을 먹는다. 해시가 바뀌면(소유자가 새
     * salt로 다시 서명하면) 칸도 새로 열리는데, 그것이 바로 "한도를 다시 준다"의 뜻이다.
     *
     * **건당 상한은 여기 없다.** 리프(결제별 위임)가 이미 온체인에서 오퍼 금액에 묶여
     * 있다 — 키트의 x402 provider가 리프 scope를 `erc20TransferAmount`
     * (`maxAmount` = 오퍼 금액)로 만든다. 부모에 없던 것은 총액 쪽뿐이다.
     *
     * `agent-runtime.ts`의 호출당·세션 한도와는 층이 다르다. 그쪽은 프로세스가 사는
     * 동안만 유효한 운영자 쪽 장치이고, 이것은 재시작·키 교체·릴레이어 교체를 넘겨
     * 살아남는 체인의 한도다.
     */
    lifetimeTotalAmount?: bigint;
    periodDurationSeconds: number;
    expiresAfterSeconds: number;
    recipient?: Address;
}

const BASE_POLICY = {
    token: MOCK_USDC.address,
    periodDurationSeconds: 60,
    expiresAfterSeconds: 30 * 60,
} as const;

/**
 * 시연 역할의 총액은 기간 상한의 네 배로 둔다.
 *
 * 기간 60초·만료 30분이라는 이 역할들의 창에서는 기간이 30번 갱신되므로, 총액이 없으면
 * 한 번 서명한 root가 기간 상한의 30배까지 내보낼 수 있다. 네 배는 "기간 상한을 네 번
 * 채울 수 있다"는 한 문장으로 설명되고, 30배와 한 배(= 한 기간만 쓰고 죽는 위임) 사이에서
 * 시연이 실제로 쓰는 폭을 남긴다.
 */
const LIFETIME_PERIODS = 4n;

/**
 * 다섯 역할의 정책.
 *
 * 총액은 소유자가 직접 서명하는 세 root에만 붙인다 — 이 셋이 소유자의 잔액에서 돈이
 * 빠져나가는 입구이고, 소유자가 읽는 승인 화면에 적히는 숫자다. `child-a`·`child-b`는
 * 총액을 받지 않는다: 둘은 `team-manager` 아래에 다시 위임되므로 한 번의 상환이 자식과
 * 부모의 caveat을 모두 통과해야 하고, 부모의 총액이 이미 두 자식의 합을 덮는다. 자식마다
 * 총액을 또 두면 운영자가 맞춰야 하는 숫자만 늘고 실제 상한은 바뀌지 않는다.
 */
export function buildD3Policies(
    fixedVendor: Address,
): Readonly<Record<D3Role, PeriodPolicy>> {
    const openAgentPeriod = toTokenAmount("3");
    const vendorAgentPeriod = toTokenAmount("5");
    const teamManagerPeriod = toTokenAmount("6");
    return {
        "open-agent": {
            ...BASE_POLICY,
            role: "open-agent",
            periodAmount: openAgentPeriod,
            lifetimeTotalAmount: openAgentPeriod * LIFETIME_PERIODS,
        },
        "vendor-agent": {
            ...BASE_POLICY,
            role: "vendor-agent",
            periodAmount: vendorAgentPeriod,
            lifetimeTotalAmount: vendorAgentPeriod * LIFETIME_PERIODS,
            recipient: getAddress(fixedVendor),
        },
        "team-manager": {
            ...BASE_POLICY,
            role: "team-manager",
            periodAmount: teamManagerPeriod,
            lifetimeTotalAmount: teamManagerPeriod * LIFETIME_PERIODS,
        },
        "child-a": {
            ...BASE_POLICY,
            role: "child-a",
            periodAmount: toTokenAmount("4"),
        },
        "child-b": {
            ...BASE_POLICY,
            role: "child-b",
            periodAmount: toTokenAmount("4"),
        },
    };
}

export interface PreparePeriodDelegationParams {
    environment: SmartAccountsEnvironment;
    delegator: Address;
    delegate: Address;
    policy: PeriodPolicy;
    startDate: number;
    salt?: Hex;
    parentPermissionContext?: PermissionContext;
}

function assertPolicy(policy: PeriodPolicy, startDate: number): void {
    if (policy.periodAmount <= 0n) throw new Error("periodAmount must be positive");
    if (policy.lifetimeTotalAmount !== undefined) {
        if (policy.lifetimeTotalAmount <= 0n) {
            throw new Error("lifetimeTotalAmount must be positive");
        }
        // 총액이 기간 상한보다 작으면 거절한다. 허용해도 온체인 결과는 안전한 쪽
        // (총액이 먼저 문다)이지만, 그 위임은 기간 상한이 한 번도 닿지 못하는 숫자가 된
        // 위임이다. 승인 화면·`permission plan` 출력·콘솔 다이얼은 전부 `periodAmount`를
        // 그 위임의 한도로 적으므로, 운영자는 자기가 정한 적 없는 한도를 읽게 된다.
        // 기간보다 작은 총액을 원한다면 `periodAmount`를 그 숫자로 내리는 것이 같은 상한을
        // 거짓말 없이 표현한다. 같을 때는 거절하지 않는다 — "한 기간치를 딱 한 번"은
        // 스스로 성립하는 정책이다.
        if (policy.lifetimeTotalAmount < policy.periodAmount) {
            throw new Error(
                "lifetimeTotalAmount must not be smaller than periodAmount; " +
                    "lower periodAmount instead of hiding it behind a smaller total",
            );
        }
    }
    if (!Number.isSafeInteger(policy.periodDurationSeconds) || policy.periodDurationSeconds <= 0) {
        throw new Error("periodDurationSeconds must be a positive safe integer");
    }
    if (!Number.isSafeInteger(policy.expiresAfterSeconds) || policy.expiresAfterSeconds <= 0) {
        throw new Error("expiresAfterSeconds must be a positive safe integer");
    }
    if (!Number.isSafeInteger(startDate) || startDate < 0) {
        throw new Error("startDate must be a non-negative Unix timestamp");
    }
}

/**
 * Construct an unsigned MetaMask Delegation Framework v1.3 delegation.
 *
 * The period amount is enforced on-chain. A policy with `lifetimeTotalAmount` adds a
 * second on-chain bound on the same token: the period cap limits the rate, the total
 * limits what this delegation can ever move. Vendor policies additionally pin the
 * ERC-20 `transfer(address,uint256)` recipient at calldata byte offset 4.
 */
export function preparePeriodDelegation(params: PreparePeriodDelegationParams): Delegation {
    const {environment, delegator, delegate, policy, startDate} = params;
    assertPolicy(policy, startDate);

    let caveats = createCaveatBuilder(environment).addCaveat("timestamp", {
        afterThreshold: startDate,
        beforeThreshold: startDate + policy.expiresAfterSeconds,
    });
    if (policy.lifetimeTotalAmount !== undefined) {
        // 두 caveat 모두 `policy.token` 하나를 읽는다. 토큰이 갈리면 각자 다른 지출을
        // 세게 되고, 총액 쪽은 이 위임으로는 일어나지 않는 전송을 세느라 상한이 아니게 된다.
        caveats = caveats.addCaveat("erc20TransferAmount", {
            tokenAddress: policy.token,
            maxAmount: policy.lifetimeTotalAmount,
        });
    }
    if (policy.recipient) {
        caveats = caveats.addCaveat("allowedCalldata", {
            startIndex: 4,
            value: pad(policy.recipient, {size: 32}),
        });
    }

    const base = {
        environment,
        from: delegator,
        to: delegate,
        salt: params.salt,
        caveats,
        scope: {
            type: ScopeType.Erc20PeriodTransfer,
            tokenAddress: policy.token,
            periodAmount: policy.periodAmount,
            periodDuration: policy.periodDurationSeconds,
            startDate,
        },
    } as const;

    return params.parentPermissionContext
        ? createDelegation({
              ...base,
              parentPermissionContext: params.parentPermissionContext,
          })
        : createDelegation(base);
}

export function withDelegationSignature(
    delegation: Delegation,
    signature: Hex,
): Delegation {
    if (signature === "0x") throw new Error("delegation signature must not be empty");
    return {...delegation, signature};
}

