import {ERC20PeriodTransferEnforcer} from "@metamask/smart-accounts-kit/contracts";
import {hashDelegation} from "@metamask/smart-accounts-kit/utils";
import type {Delegation, SmartAccountsEnvironment} from "@metamask/smart-accounts-kit";
import {getAddress, hexToBigInt, parseAbiItem, size, slice} from "viem";
import type {Address, Hex, PublicClient} from "viem";
import {isDelegationRevoked} from "./revocation.js";

/** `ERC20PeriodTransferEnforcer` terms — the spending cap the console displays. */
export interface PeriodLimit {
    token: Address;
    periodAmount: bigint;
    periodDuration: bigint;
    startDate: bigint;
}

/** `TimestampEnforcer` terms — when the delegation is usable at all. */
export interface ValidityWindow {
    notBefore: bigint;
    notAfter: bigint;
}

/**
 * Terms are packed, not ABI-encoded, so the offsets below are the contract's
 * layout rather than a guess: the round-trip tests build terms with the kit's own
 * caveat builder and assert these decoders recover the inputs.
 */
export function decodePeriodTransferTerms(terms: Hex): PeriodLimit {
    if (size(terms) !== 116) {
        throw new Error(`erc20PeriodTransfer terms must be 116 bytes, got ${size(terms)}`);
    }
    return {
        token: getAddress(slice(terms, 0, 20)),
        periodAmount: hexToBigInt(slice(terms, 20, 52)),
        periodDuration: hexToBigInt(slice(terms, 52, 84)),
        startDate: hexToBigInt(slice(terms, 84, 116)),
    };
}

export function decodeTimestampTerms(terms: Hex): ValidityWindow {
    if (size(terms) !== 32) {
        throw new Error(`timestamp terms must be 32 bytes, got ${size(terms)}`);
    }
    return {
        notBefore: hexToBigInt(slice(terms, 0, 16)),
        notAfter: hexToBigInt(slice(terms, 16, 32)),
    };
}

/** First caveat enforced by `enforcer`, or undefined when the policy omits it. */
export function findCaveatTerms(delegation: Delegation, enforcer: Address): Hex | undefined {
    const target = getAddress(enforcer);
    for (const caveat of delegation.caveats) {
        if (getAddress(caveat.enforcer) === target) return caveat.terms;
    }
    return undefined;
}

export interface DelegationStatus {
    delegationHash: Hex;
    delegator: Address;
    delegate: Address;
    /** Absent when the delegation carries no ERC-20 period cap. */
    limit?: PeriodLimit;
    /** Absent when the delegation carries no timestamp caveat. */
    validity?: ValidityWindow;
    /** Remaining spend in the current period, read from the enforcer. */
    remaining?: bigint;
    /** True when the period rolled over and the cap is fresh. */
    isNewPeriod?: boolean;
    currentPeriod?: bigint;
    revoked: boolean;
    expired: boolean;
    notYetActive: boolean;
}

/**
 * Everything the console's delegation screen shows, read from chain.
 *
 * The remaining balance comes from the enforcer itself rather than from a local
 * tally: the cap is enforced on-chain, so anything the UI computes off-chain would
 * be a second source of truth that can disagree with the one that matters.
 */
export async function readDelegationStatus(params: {
    publicClient: PublicClient;
    environment: SmartAccountsEnvironment;
    delegation: Delegation;
    /** Unix seconds used for expiry display; defaults to the client's clock. */
    now?: bigint;
}): Promise<DelegationStatus> {
    const {publicClient, environment, delegation} = params;
    const delegationHash = hashDelegation(delegation);
    const delegationManager = getAddress(environment.DelegationManager);
    const periodEnforcer = environment.caveatEnforcers.ERC20PeriodTransferEnforcer;
    const timestampEnforcer = environment.caveatEnforcers.TimestampEnforcer;

    const periodTerms = periodEnforcer
        ? findCaveatTerms(delegation, getAddress(periodEnforcer))
        : undefined;
    const timestampTerms = timestampEnforcer
        ? findCaveatTerms(delegation, getAddress(timestampEnforcer))
        : undefined;

    const [revoked, available, now] = await Promise.all([
        isDelegationRevoked({publicClient, delegationManager, delegation}),
        periodTerms && periodEnforcer
            ? ERC20PeriodTransferEnforcer.read.getAvailableAmount({
                  client: publicClient,
                  contractAddress: getAddress(periodEnforcer),
                  delegationHash,
                  delegationManager,
                  terms: periodTerms,
              })
            : Promise.resolve(undefined),
        resolveChainTime(publicClient, params.now),
    ]);

    const validity = timestampTerms ? decodeTimestampTerms(timestampTerms) : undefined;
    const {expired, notYetActive} = judgeValidity(validity, now);

    return {
        delegationHash,
        delegator: getAddress(delegation.delegator),
        delegate: getAddress(delegation.delegate),
        limit: periodTerms ? decodePeriodTransferTerms(periodTerms) : undefined,
        validity,
        remaining: available?.availableAmount,
        isNewPeriod: available?.isNewPeriod,
        currentPeriod: available?.currentPeriod,
        revoked,
        expired,
        notYetActive,
    };
}

export const TRANSFERRED_IN_PERIOD_EVENT = parseAbiItem(
    "event TransferredInPeriod(address indexed sender, address indexed redeemer, bytes32 indexed delegationHash, address token, uint256 periodAmount, uint256 periodDuration, uint256 startDate, uint256 transferredInCurrentPeriod, uint256 transferTimestamp)",
);

export interface SettlementReceipt {
    delegationHash: Hex;
    redeemer: Address;
    token: Address;
    /** Running total spent in that period — deltas give the per-payment amount. */
    transferredInCurrentPeriod: bigint;
    /**
     * What this settlement actually moved, derived from the running total.
     *
     * `undefined` for the first receipt in the window: an earlier payment in the
     * same period may sit outside `fromBlock`, and presenting a cumulative figure
     * as a payment amount would invent a payment that never happened.
     */
    amount: bigint | undefined;
    /** Which cap period this settlement fell in, counted from the enforcer's start. */
    period: bigint;
    transferTimestamp: bigint;
    transactionHash: Hex;
    blockNumber: bigint;
}

/**
 * The moment a caveat check will actually be evaluated against.
 *
 * `TimestampEnforcer` compares with `block.timestamp`, so judging validity by the
 * caller's clock would report a permission as live that the next block refuses —
 * and on a fork the two can sit far apart. Wall clock is only the fallback for a
 * node that will not serve a head block.
 */
export async function resolveChainTime(
    publicClient: PublicClient,
    override?: bigint,
): Promise<bigint> {
    if (override !== undefined) return override;
    const head = await publicClient.getBlock().catch(() => undefined);
    return head?.timestamp ?? BigInt(Math.floor(Date.now() / 1000));
}

/**
 * Whether a validity window is open, mirroring `TimestampEnforcer` exactly.
 *
 * The enforcer uses strict comparisons in both directions and treats a zero
 * threshold as unbounded, so at exactly `notBefore` a redemption still reverts
 * `early-delegation`. Reporting that second as live would promise a payment the
 * chain refuses.
 */
export function judgeValidity(
    validity: ValidityWindow | undefined,
    now: bigint,
): {expired: boolean; notYetActive: boolean} {
    if (!validity) return {expired: false, notYetActive: false};
    return {
        expired: validity.notAfter > 0n && now >= validity.notAfter,
        notYetActive: validity.notBefore > 0n && now <= validity.notBefore,
    };
}

/** Which cap window a settlement fell in, counted from the enforcer's start date. */
function periodIndexOf(args: {
    startDate?: unknown;
    periodDuration?: unknown;
    transferTimestamp?: unknown;
}): bigint {
    const startDate = args.startDate as bigint;
    const periodDuration = args.periodDuration as bigint;
    const transferTimestamp = args.transferTimestamp as bigint;
    if (periodDuration <= 0n || transferTimestamp < startDate) return 0n;
    return (transferTimestamp - startDate) / periodDuration;
}

/**
 * Settlement history for one delegation, taken from the enforcer's own events.
 *
 * The receipts screen needs no database and no accounts: every settlement that
 * consumed the cap necessarily emitted this event, so the chain is the ledger.
 *
 * `fromBlock` is required on purpose. Public RPCs cap `eth_getLogs` ranges (GIWA
 * rejects spans over 100k blocks), so a convenient "earliest" default would either
 * fail outright or silently return a truncated history that reads like a complete
 * one. The caller knows which window it means — the delegation's start block, or a
 * recent page — and has to say so.
 */
export async function readSettlementReceipts(params: {
    publicClient: PublicClient;
    environment: SmartAccountsEnvironment;
    delegationHash: Hex;
    fromBlock: bigint;
    toBlock?: bigint | "latest";
}): Promise<SettlementReceipt[]> {
    const enforcer = params.environment.caveatEnforcers.ERC20PeriodTransferEnforcer;
    if (!enforcer) return [];
    const logs = await params.publicClient.getLogs({
        address: getAddress(enforcer),
        event: TRANSFERRED_IN_PERIOD_EVENT,
        args: {delegationHash: params.delegationHash},
        fromBlock: params.fromBlock,
        toBlock: params.toBlock ?? "latest",
    });
    if (logs.length === 0) return [];

    // Sorted rather than assumed: the delta below is only meaningful in chain order,
    // and an RPC that returned logs unordered would silently produce negative
    // "payments" instead of failing.
    const ordered = [...logs].sort((a, b) =>
        a.blockNumber === b.blockNumber
            ? (a.logIndex ?? 0) - (b.logIndex ?? 0)
            : a.blockNumber < b.blockNumber
              ? -1
              : 1,
    );

    // The first row has no predecessor to subtract, but it is still derivable when
    // the window provably opens before its period does: no earlier payment in that
    // period can be hiding outside the range. Without this the oldest row would
    // always fall back to a cumulative figure, even on a window that covers days.
    const first = ordered[0]!;
    const firstPeriod = periodIndexOf(first.args);
    const firstPeriodStart =
        (first.args.startDate as bigint) + firstPeriod * (first.args.periodDuration as bigint);
    let windowOpensBeforePeriod = false;
    try {
        const {timestamp} = await params.publicClient.getBlock({blockNumber: params.fromBlock});
        windowOpensBeforePeriod = timestamp <= firstPeriodStart;
    } catch {
        // A pruned or unavailable block only costs us the first row's precision.
    }

    let previous: {period: bigint; cumulative: bigint} | undefined;
    return ordered.map((log) => {
        const transferTimestamp = log.args.transferTimestamp as bigint;
        const cumulative = log.args.transferredInCurrentPeriod as bigint;

        // The enforcer zeroes the counter when a period rolls over, so within one
        // period the payment is the delta and the first payment of a period is the
        // counter itself.
        const period = periodIndexOf(log.args);
        const amount =
            previous === undefined
                ? windowOpensBeforePeriod
                    ? cumulative
                    : undefined
                : previous.period !== period
                  ? cumulative
                  : cumulative >= previous.cumulative
                    ? cumulative - previous.cumulative
                    : undefined; // contradictory ordering — say nothing rather than a negative
        previous = {period, cumulative};

        return {
            delegationHash: log.args.delegationHash as Hex,
            redeemer: getAddress(log.args.redeemer as Address),
            token: getAddress(log.args.token as Address),
            transferredInCurrentPeriod: cumulative,
            amount,
            period,
            transferTimestamp,
            transactionHash: log.transactionHash,
            blockNumber: log.blockNumber,
        };
    });
}

/**
 * The delegation the `DelegationManager` publishes when a payment settles.
 *
 * Emitted once per link, so a single payment writes both the leaf and the root, and the
 * struct is complete — delegate, delegator, authority, caveats, salt *and signature*. That
 * completeness is what makes recovery possible rather than approximate: `permissionContext`
 * is nothing but the ABI encoding of this same tuple array, so a context rebuilt from these
 * logs is byte-identical to the one the browser lost.
 */
export const REDEEMED_DELEGATION_EVENT = parseAbiItem([
    "event RedeemedDelegation(address indexed rootDelegator, address indexed redeemer, Delegation delegation)",
    "struct Delegation { address delegate; address delegator; bytes32 authority; Caveat[] caveats; uint256 salt; bytes signature; }",
    "struct Caveat { address enforcer; bytes terms; bytes args; }",
]);

/** `DelegationManager.ROOT_AUTHORITY` — the sentinel marking a link as a root. */
export const ROOT_AUTHORITY: Hex = `0x${"f".repeat(64)}`;

/**
 * Reduce a stream of redeemed links to the distinct roots among them.
 *
 * Two reductions, both load-bearing. Leaves are dropped because they are minted per payment
 * and bound to one settlement — restoring them as "agents" would list a user's payment
 * history as their grant library. And a root is deduped because every settlement re-emits
 * it, so a busy agent would otherwise return one card per payment.
 */
export function selectRootDelegations<T extends {authority: Hex; delegate: Address}>(
    links: readonly T[],
): T[] {
    const seen = new Set<string>();
    const roots: T[] = [];
    for (const link of links) {
        if (link.authority.toLowerCase() !== ROOT_AUTHORITY) continue;
        const key = hashDelegation(link as unknown as Delegation);
        if (seen.has(key)) continue;
        seen.add(key);
        roots.push(link);
    }
    return roots;
}

/**
 * Rebuild a payer account's grants from the chain.
 *
 * This exists because a grant's *only* copy used to be the browser's: a root delegation is
 * signed offline and the manager stores nothing per delegation until it is disabled. The
 * chain does hold it from the first settlement onward, indexed by `rootDelegator`, and that
 * index is free — the payer account is re-derived from the connected wallet on every load.
 *
 * **Scope, stated because the gap is the point.** This recovers grants that have settled at
 * least once. A grant created and never used has no on-chain footprint at all and cannot
 * appear here; that case is what local persistence covers. The two are complementary, not
 * alternatives.
 *
 * `fromBlock` is required for the same reason `readSettlementReceipts` requires it: an
 * unbounded range either fails outright or silently truncates, and a truncated grant list
 * reads exactly like a complete one.
 */
export async function readGrantsFromChain(params: {
    publicClient: PublicClient;
    environment: SmartAccountsEnvironment;
    rootDelegator: Address;
    fromBlock: bigint;
    toBlock?: bigint | "latest";
}): Promise<Delegation[]> {
    const logs = await params.publicClient.getLogs({
        address: getAddress(params.environment.DelegationManager),
        event: REDEEMED_DELEGATION_EVENT,
        args: {rootDelegator: getAddress(params.rootDelegator)},
        fromBlock: params.fromBlock,
        toBlock: params.toBlock ?? "latest",
    });
    const links = logs
        .map((log) => (log.args as {delegation?: Delegation}).delegation)
        .filter((delegation): delegation is Delegation => delegation !== undefined);
    return selectRootDelegations(links);
}
