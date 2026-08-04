import {
    ScopeType,
    createDelegation,
    type Delegation,
    type PermissionContext,
    type SmartAccountsEnvironment,
} from "@metamask/smart-accounts-kit";
import {createCaveatBuilder, encodeDelegations} from "@metamask/smart-accounts-kit/utils";
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
    periodAmount: bigint;
    periodDurationSeconds: number;
    expiresAfterSeconds: number;
    recipient?: Address;
}

const BASE_POLICY = {
    token: MOCK_USDC.address,
    periodDurationSeconds: 60,
    expiresAfterSeconds: 30 * 60,
} as const;

export function buildD3Policies(
    fixedVendor: Address,
): Readonly<Record<D3Role, PeriodPolicy>> {
    return {
        "open-agent": {
            ...BASE_POLICY,
            role: "open-agent",
            periodAmount: toTokenAmount("3"),
        },
        "vendor-agent": {
            ...BASE_POLICY,
            role: "vendor-agent",
            periodAmount: toTokenAmount("5"),
            recipient: getAddress(fixedVendor),
        },
        "team-manager": {
            ...BASE_POLICY,
            role: "team-manager",
            periodAmount: toTokenAmount("6"),
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
 * The period amount is enforced on-chain. Vendor policies additionally pin the
 * ERC-20 `transfer(address,uint256)` recipient at calldata byte offset 4.
 */
export function preparePeriodDelegation(params: PreparePeriodDelegationParams): Delegation {
    const {environment, delegator, delegate, policy, startDate} = params;
    assertPolicy(policy, startDate);

    let caveats = createCaveatBuilder(environment).addCaveat("timestamp", {
        afterThreshold: startDate,
        beforeThreshold: startDate + policy.expiresAfterSeconds,
    });
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

