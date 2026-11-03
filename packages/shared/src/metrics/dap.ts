/**
 * Daily Activated Payers (DAP): distinct owner EOAs with at least one settled ERC-7710 payment
 * on a Korean calendar day, after excluding the operator's own wallets and agent-farm clusters
 * (RES-1 §4). Pure: the caller fetches settlements and funding facts; this only counts.
 *
 * Every day reports the raw payer count and the excluded payers (with reasons) beside DAP, so
 * the exclusion can be audited rather than trusted.
 */
import {GIWA_SEPOLIA_CAIP2} from "../chain.js";

export type PaymentKind = "arcade" | "agent";

export type SettledPayment = {
    /** Owner EOA behind the delegator smart account. */
    owner: string;
    /** Settlement time, unix seconds (block timestamp). */
    settledAt: number;
    /** CAIP-2 chain id, e.g. `eip155:91342`. */
    chainId: string;
    kind: PaymentKind;
};

export type OwnerFunding = {
    owner: string;
    /** Address that sent the owner its first funds. */
    firstFunder: string;
    /** The owner's first transaction, unix seconds. */
    firstTxAt: number;
};

export type ExclusionReason = "operator" | "shared-funder" | "same-day-cluster";

export type DapOptions = {
    /** Operator wallets; never counted. */
    operatorAllowList?: readonly string[];
    /** Funders that serve the public (the faucet); the shared-funder rule ignores them. */
    publicFunders?: readonly string[];
    /** Exclude an owner whose first funder also funded at least this many other owners. Default 3. */
    sharedFunderMinOthers?: number;
    /** Exclude owners in a group of at least this many sharing a funder and a first-tx Korean day. Default 5. */
    sameDayClusterMin?: number;
    /** Only payments on this chain count. Default GIWA Sepolia. */
    chainId?: string;
};

export type ExcludedPayer = {owner: string; reasons: ExclusionReason[]};

export type DapDay = {
    /** Korean calendar day, `YYYY-MM-DD`. */
    day: string;
    raw: number;
    excluded: number;
    dap: number;
    arcadeDap: number;
    agentDap: number;
    excludedPayers: ExcludedPayer[];
};

export const DAP_DEFAULTS = {
    sharedFunderMinOthers: 3,
    sameDayClusterMin: 5,
    chainId: GIWA_SEPOLIA_CAIP2,
} as const;

const KST_OFFSET_SECONDS = 9 * 60 * 60;

/** The Korean calendar day (UTC+9, no DST) of a unix-seconds timestamp. */
export function koreanDay(unixSeconds: number): string {
    return new Date((unixSeconds + KST_OFFSET_SECONDS) * 1000).toISOString().slice(0, 10);
}

const norm = (address: string) => address.toLowerCase();

/** Exclusion reasons per owner, from the operator list and the funding graph. */
export function farmExclusions(funding: readonly OwnerFunding[], options: DapOptions = {}): Map<string, ExclusionReason[]> {
    const minOthers = options.sharedFunderMinOthers ?? DAP_DEFAULTS.sharedFunderMinOthers;
    const clusterMin = options.sameDayClusterMin ?? DAP_DEFAULTS.sameDayClusterMin;
    const publicFunders = new Set((options.publicFunders ?? []).map(norm));
    const reasons = new Map<string, ExclusionReason[]>();
    const add = (owner: string, reason: ExclusionReason) => {
        const list = reasons.get(owner) ?? [];
        if (!list.includes(reason)) list.push(reason);
        reasons.set(owner, list);
    };

    for (const owner of options.operatorAllowList ?? []) add(norm(owner), "operator");

    const byFunder = new Map<string, Set<string>>();
    const byFunderDay = new Map<string, Set<string>>();
    const seen = new Set<string>();
    for (const f of funding) {
        const owner = norm(f.owner);
        if (seen.has(owner)) continue;
        seen.add(owner);
        const funder = norm(f.firstFunder);
        if (!byFunder.has(funder)) byFunder.set(funder, new Set());
        byFunder.get(funder)!.add(owner);
        const key = `${funder}|${koreanDay(f.firstTxAt)}`;
        if (!byFunderDay.has(key)) byFunderDay.set(key, new Set());
        byFunderDay.get(key)!.add(owner);
    }
    for (const [funder, owners] of byFunder) {
        if (publicFunders.has(funder) || owners.size - 1 < minOthers) continue;
        for (const owner of owners) add(owner, "shared-funder");
    }
    for (const owners of byFunderDay.values()) {
        if (owners.size < clusterMin) continue;
        for (const owner of owners) add(owner, "same-day-cluster");
    }
    return reasons;
}

/** Per-Korean-day raw, excluded and activated payer counts, oldest day first. */
export function countDailyActivatedPayers(
    payments: readonly SettledPayment[],
    funding: readonly OwnerFunding[],
    options: DapOptions = {},
): DapDay[] {
    const chainId = options.chainId ?? DAP_DEFAULTS.chainId;
    const exclusions = farmExclusions(funding, options);
    const days = new Map<string, Map<string, Set<PaymentKind>>>();
    for (const p of payments) {
        if (p.chainId !== chainId) continue;
        const day = koreanDay(p.settledAt);
        if (!days.has(day)) days.set(day, new Map());
        const owners = days.get(day)!;
        const owner = norm(p.owner);
        if (!owners.has(owner)) owners.set(owner, new Set());
        owners.get(owner)!.add(p.kind);
    }

    return [...days.keys()].sort().map((day) => {
        const owners = days.get(day)!;
        const excludedPayers: ExcludedPayer[] = [];
        let arcadeDap = 0;
        let agentDap = 0;
        for (const [owner, kinds] of owners) {
            const reasons = exclusions.get(owner);
            if (reasons) {
                excludedPayers.push({owner, reasons: [...reasons]});
                continue;
            }
            if (kinds.has("arcade")) arcadeDap++;
            if (kinds.has("agent")) agentDap++;
        }
        excludedPayers.sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
        return {
            day,
            raw: owners.size,
            excluded: excludedPayers.length,
            dap: owners.size - excludedPayers.length,
            arcadeDap,
            agentDap,
            excludedPayers,
        };
    });
}
