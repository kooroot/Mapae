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

    remaining(id: string, at: number): bigint {
        const delegation = this.#require(id);
        const key = this.#bucketKey(delegation, at);
        const spent = this.#spent.get(key) ?? 0n;
        return delegation.policy.periodAmount > spent
            ? delegation.policy.periodAmount - spent
            : 0n;
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
