import {getAddress, type Address} from "viem";
import type {PeriodPolicy} from "./policy.js";

export type PolicyViolationCode =
    | "UNKNOWN_DELEGATION"
    | "INVALID_AMOUNT"
    | "NOT_STARTED"
    | "EXPIRED"
    | "REVOKED"
    | "RECIPIENT_DENIED"
    | "REDEEMER_DENIED"
    | "LIMIT_EXCEEDED"
    | "REPLAY";

export class PolicyViolation extends Error {
    constructor(
        readonly code: PolicyViolationCode,
        message: string,
    ) {
        super(message);
        this.name = "PolicyViolation";
    }
}

export interface OracleDelegation {
    id: string;
    policy: PeriodPolicy;
    delegate: Address;
    startDate: number;
    parentId?: string;
    redeemers?: Address[];
}

interface StoredDelegation extends OracleDelegation {
    revoked: boolean;
}

export interface OracleSettlement {
    settlementId: string;
    delegationId: string;
    amount: bigint;
    payTo: Address;
    redeemer: Address;
    at: number;
}

/**
 * Deterministic policy oracle for D3 scenario tests.
 *
 * It mirrors the intended conjunction semantics of a delegation chain: every
 * ancestor and the leaf must permit a settlement, and a successful settlement
 * consumes each node's period bucket. It is deliberately not presented as a
 * replacement for on-chain framework tests.
 */
export class DelegationPolicyOracle {
    readonly #delegations = new Map<string, StoredDelegation>();
    readonly #spent = new Map<string, bigint>();
    /**
     * 위임별 누적 총액. `#spent`와 달리 기간 키가 없다 —
     * `ERC20TransferAmountEnforcer`의 `spentMap`이 위임 해시 하나당 한 칸이고 되돌아가지
     * 않기 때문이다. 기간 버킷과 이 칸을 한 맵에 섞으면 기간 갱신이 총액까지 되살린다.
     */
    readonly #lifetimeSpent = new Map<string, bigint>();
    readonly #settled = new Set<string>();

    register(input: OracleDelegation): void {
        if (!input.id.trim()) throw new Error("delegation id is required");
        if (this.#delegations.has(input.id)) throw new Error(`duplicate delegation ${input.id}`);
        if (input.parentId && !this.#delegations.has(input.parentId)) {
            throw new Error(`unknown parent delegation ${input.parentId}`);
        }
        if (!Number.isSafeInteger(input.startDate) || input.startDate < 0) {
            throw new Error("startDate must be a non-negative Unix timestamp");
        }
        this.#delegations.set(input.id, {
            ...input,
            delegate: getAddress(input.delegate),
            redeemers: input.redeemers?.map(getAddress),
            revoked: false,
        });
    }

    revoke(id: string): void {
        const delegation = this.#require(id);
        delegation.revoked = true;
    }

    rotate(oldId: string, replacement: OracleDelegation): void {
        this.revoke(oldId);
        this.register(replacement);
    }

    /**
     * 지금 이 위임으로 더 쓸 수 있는 금액 — 기간 잔량과 평생 총액 잔량 중 작은 쪽.
     *
     * 총액을 든 정책에서 기간 잔량만 답하면, 기간이 갱신될 때마다 이 오라클은 체인이
     * 거절할 결제를 허용한다. 두 caveat은 하나의 상환에 함께 걸리므로 답도 하나여야 한다.
     */
    remaining(id: string, at: number): bigint {
        const delegation = this.#require(id);
        const key = this.#bucketKey(delegation, at);
        const spent = this.#spent.get(key) ?? 0n;
        const periodRemaining =
            delegation.policy.periodAmount > spent
                ? delegation.policy.periodAmount - spent
                : 0n;
        const total = delegation.policy.lifetimeTotalAmount;
        if (total === undefined) return periodRemaining;
        const lifetimeSpent = this.#lifetimeSpent.get(delegation.id) ?? 0n;
        const lifetimeRemaining = total > lifetimeSpent ? total - lifetimeSpent : 0n;
        return lifetimeRemaining < periodRemaining ? lifetimeRemaining : periodRemaining;
    }

    settle(input: OracleSettlement): void {
        if (input.amount <= 0n) {
            throw new PolicyViolation("INVALID_AMOUNT", "amount must be positive");
        }
        if (this.#settled.has(input.settlementId)) {
            throw new PolicyViolation("REPLAY", `settlement ${input.settlementId} already consumed`);
        }

        const lineage = this.#lineage(input.delegationId);
        const payTo = getAddress(input.payTo);
        const redeemer = getAddress(input.redeemer);

        for (const delegation of lineage) {
            if (delegation.revoked) {
                throw new PolicyViolation("REVOKED", `delegation ${delegation.id} is revoked`);
            }
            if (input.at < delegation.startDate) {
                throw new PolicyViolation("NOT_STARTED", `delegation ${delegation.id} is not active`);
            }
            if (input.at >= delegation.startDate + delegation.policy.expiresAfterSeconds) {
                throw new PolicyViolation("EXPIRED", `delegation ${delegation.id} expired`);
            }
            if (
                delegation.policy.recipient &&
                getAddress(delegation.policy.recipient) !== payTo
            ) {
                throw new PolicyViolation(
                    "RECIPIENT_DENIED",
                    `delegation ${delegation.id} forbids recipient ${payTo}`,
                );
            }
            if (
                delegation.redeemers &&
                !delegation.redeemers.some((address) => address === redeemer)
            ) {
                throw new PolicyViolation(
                    "REDEEMER_DENIED",
                    `delegation ${delegation.id} forbids redeemer ${redeemer}`,
                );
            }

            const available = this.remaining(delegation.id, input.at);
            if (input.amount > available) {
                throw new PolicyViolation(
                    "LIMIT_EXCEEDED",
                    `delegation ${delegation.id} has ${available} remaining`,
                );
            }
        }

        // Commit only after every constraint passes, matching EVM transaction atomicity.
        for (const delegation of lineage) {
            const key = this.#bucketKey(delegation, input.at);
            this.#spent.set(key, (this.#spent.get(key) ?? 0n) + input.amount);
            this.#lifetimeSpent.set(
                delegation.id,
                (this.#lifetimeSpent.get(delegation.id) ?? 0n) + input.amount,
            );
        }
        this.#settled.add(input.settlementId);
    }

    #lineage(id: string): StoredDelegation[] {
        const result: StoredDelegation[] = [];
        const visited = new Set<string>();
        let current: StoredDelegation | undefined = this.#require(id);
        while (current) {
            if (visited.has(current.id)) throw new Error("delegation hierarchy contains a cycle");
            visited.add(current.id);
            result.push(current);
            current = current.parentId ? this.#require(current.parentId) : undefined;
        }
        return result;
    }

    #bucketKey(delegation: StoredDelegation, at: number): string {
        const elapsed = Math.max(0, at - delegation.startDate);
        const period = Math.floor(elapsed / delegation.policy.periodDurationSeconds);
        return `${delegation.id}:${period}`;
    }

    #require(id: string): StoredDelegation {
        const delegation = this.#delegations.get(id);
        if (!delegation) {
            throw new PolicyViolation("UNKNOWN_DELEGATION", `unknown delegation ${id}`);
        }
        return delegation;
    }
}
