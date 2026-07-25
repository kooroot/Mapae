import {describe, expect, test} from "bun:test";
import type {SmartAccountsEnvironment} from "@metamask/smart-accounts-kit";
import {getAddress, type Address} from "viem";
import {MOCK_USDC, toTokenAmount} from "@mapae/shared";
import {ENTRY_POINT_V07} from "./config.js";
import {buildD3Policies, preparePeriodDelegation} from "./policy.js";
import {
    decodePeriodTransferTerms,
    decodeTimestampTerms,
    findCaveatTerms,
    judgeValidity,
    readSettlementReceipts,
    resolveChainTime,
} from "./delegation-status.js";

const address = (suffix: number): Address =>
    getAddress(`0x${suffix.toString(16).padStart(40, "0")}`);
const DELEGATOR = getAddress("0x5000000000000000000000000000000000000001");
const DELEGATE = getAddress("0x6000000000000000000000000000000000000001");
const VENDOR = getAddress("0x2000000000000000000000000000000000000001");
const PERIOD_ENFORCER = address(5);
const TIMESTAMP_ENFORCER = address(8);

const environment: SmartAccountsEnvironment = {
    DelegationManager: address(1),
    EntryPoint: ENTRY_POINT_V07,
    SimpleFactory: address(2),
    implementations: {HybridDeleGatorImpl: address(3)},
    caveatEnforcers: {
        ValueLteEnforcer: address(4),
        ERC20PeriodTransferEnforcer: PERIOD_ENFORCER,
        ERC20TransferAmountEnforcer: address(6),
        AllowedCalldataEnforcer: address(7),
        TimestampEnforcer: TIMESTAMP_ENFORCER,
        RedeemerEnforcer: address(9),
    },
};

const START_DATE = 2_000_000_000;
const POLICY = buildD3Policies(VENDOR)["open-agent"];

/**
 * The caveat terms are built by the kit's own builder, so a successful round trip
 * proves the decoders match the real packing rather than a guessed layout.
 */
function delegation() {
    return preparePeriodDelegation({
        environment,
        delegator: DELEGATOR,
        delegate: DELEGATE,
        policy: POLICY,
        startDate: START_DATE,
    });
}

describe("caveat term decoding", () => {
    test("recovers the period cap the policy asked for", () => {
        const terms = findCaveatTerms(delegation(), PERIOD_ENFORCER);
        expect(terms).toBeDefined();

        const limit = decodePeriodTransferTerms(terms!);
        expect(limit.token).toBe(MOCK_USDC.address);
        expect(limit.periodAmount).toBe(POLICY.periodAmount);
        expect(limit.periodAmount).toBe(toTokenAmount("3"));
        expect(limit.periodDuration).toBe(BigInt(POLICY.periodDurationSeconds));
        expect(limit.startDate).toBe(BigInt(START_DATE));
    });

    test("recovers the validity window the policy asked for", () => {
        const terms = findCaveatTerms(delegation(), TIMESTAMP_ENFORCER);
        expect(terms).toBeDefined();

        const validity = decodeTimestampTerms(terms!);
        expect(validity.notBefore).toBe(BigInt(START_DATE));
        expect(validity.notAfter).toBe(BigInt(START_DATE + POLICY.expiresAfterSeconds));
    });

    test("returns undefined for an enforcer the policy does not use", () => {
        expect(findCaveatTerms(delegation(), address(0xdead))).toBeUndefined();
    });

    test("rejects terms of the wrong length instead of decoding garbage", () => {
        expect(() => decodePeriodTransferTerms("0x1234")).toThrow("116 bytes");
        expect(() => decodeTimestampTerms("0x1234")).toThrow("32 bytes");
    });
});

const PERIOD_DURATION = 60n;
const DELEGATION_HASH = `0x${"ab".repeat(32)}` as const;

/** One `TransferredInPeriod` log, `offset` seconds after the delegation start. */
function logAt(offset: bigint, cumulative: bigint) {
    return {
        args: {
            delegationHash: DELEGATION_HASH,
            redeemer: DELEGATE,
            token: MOCK_USDC.address,
            periodAmount: toTokenAmount("3"),
            periodDuration: PERIOD_DURATION,
            startDate: BigInt(START_DATE),
            transferredInCurrentPeriod: cumulative,
            transferTimestamp: BigInt(START_DATE) + offset,
        },
        transactionHash: `0x${offset.toString(16).padStart(64, "0")}`,
        blockNumber: offset,
    };
}

/**
 * `fromBlockTimestamp` left out means the window's opening block is unreadable, so
 * the first row cannot be resolved — the same shape as a pruned archive node.
 */
// biome-ignore lint/suspicious/noExplicitAny: a two-method stand-in for PublicClient
function clientReturning(logs: unknown[], fromBlockTimestamp?: bigint): any {
    return {
        getLogs: async () => logs,
        getBlock: async () => {
            if (fromBlockTimestamp === undefined) throw new Error("block unavailable");
            return {timestamp: fromBlockTimestamp};
        },
    };
}

describe("validity mirrors TimestampEnforcer", () => {
    const window = {notBefore: 1_000n, notAfter: 2_000n};

    test("the notBefore second itself is not yet active", () => {
        // The enforcer requires block.timestamp strictly greater than the
        // threshold, so the boundary second still reverts early-delegation.
        expect(judgeValidity(window, 1_000n).notYetActive).toBe(true);
        expect(judgeValidity(window, 1_001n).notYetActive).toBe(false);
    });

    test("the notAfter second is already expired", () => {
        expect(judgeValidity(window, 1_999n).expired).toBe(false);
        expect(judgeValidity(window, 2_000n).expired).toBe(true);
    });

    test("a zero threshold means unbounded, not 1970", () => {
        const open = {notBefore: 0n, notAfter: 0n};
        expect(judgeValidity(open, 1n)).toEqual({expired: false, notYetActive: false});
        expect(judgeValidity(undefined, 1n)).toEqual({expired: false, notYetActive: false});
    });
});

describe("chain time sourcing", () => {
    test("reads the head block rather than the caller's clock", async () => {
        // A wall-clock reading would return ~2026; the head says 2033.
        const client = {getBlock: async () => ({timestamp: BigInt(START_DATE)})};
        // biome-ignore lint/suspicious/noExplicitAny: one-method stand-in
        expect(await resolveChainTime(client as any)).toBe(BigInt(START_DATE));
    });

    test("an explicit override wins and asks the node for nothing", async () => {
        const client = {
            getBlock: async () => {
                throw new Error("must not be called");
            },
        };
        // biome-ignore lint/suspicious/noExplicitAny: one-method stand-in
        expect(await resolveChainTime(client as any, 7n)).toBe(7n);
    });

    test("falls back to wall clock when the node will not serve a head", async () => {
        const client = {
            getBlock: async () => {
                throw new Error("no head");
            },
        };
        // biome-ignore lint/suspicious/noExplicitAny: one-method stand-in
        const now = await resolveChainTime(client as any);
        expect(now).toBeGreaterThan(1_700_000_000n);
    });
});

describe("settlement receipt amounts", () => {
    test("derives the payment from the running total rather than reporting it", async () => {
        const receipts = await readSettlementReceipts({
            publicClient: clientReturning([
                logAt(0n, toTokenAmount("1")),
                logAt(10n, toTokenAmount("3")),
                logAt(20n, toTokenAmount("6")),
            ]),
            environment,
            delegationHash: DELEGATION_HASH,
            fromBlock: 0n,
        });

        // The enforcer emits a cumulative counter. Showing it as the payment would
        // invent a 3 mUSDC and a 6 mUSDC payment that never happened. The first row
        // stays undefined because an earlier payment could sit outside the window.
        expect(receipts.map((receipt) => receipt.amount)).toEqual([
            undefined,
            toTokenAmount("2"),
            toTokenAmount("3"),
        ]);
        expect(receipts.every((receipt) => receipt.period === 0n)).toBe(true);
    });

    test("resolves the first row when the window provably opens before its period", async () => {
        const receipts = await readSettlementReceipts({
            publicClient: clientReturning(
                [logAt(5n, toTokenAmount("1")), logAt(15n, toTokenAmount("3"))],
                // The window opens exactly at the period start, so no earlier payment
                // in that period can be hiding outside it.
                BigInt(START_DATE),
            ),
            environment,
            delegationHash: DELEGATION_HASH,
            fromBlock: 0n,
        });

        expect(receipts.map((receipt) => receipt.amount)).toEqual([
            toTokenAmount("1"),
            toTokenAmount("2"),
        ]);
    });

    test("orders logs before differencing rather than trusting the RPC", async () => {
        const receipts = await readSettlementReceipts({
            publicClient: clientReturning(
                [logAt(20n, toTokenAmount("6")), logAt(0n, toTokenAmount("1")), logAt(10n, toTokenAmount("3"))],
                BigInt(START_DATE),
            ),
            environment,
            delegationHash: DELEGATION_HASH,
            fromBlock: 0n,
        });

        // Out of order in, chain order out — otherwise the deltas would go negative.
        expect(receipts.map((receipt) => receipt.blockNumber)).toEqual([0n, 10n, 20n]);
        expect(receipts.map((receipt) => receipt.amount)).toEqual([
            toTokenAmount("1"),
            toTokenAmount("2"),
            toTokenAmount("3"),
        ]);
    });

    test("a period rollover restarts the counter, so the total is the payment", async () => {
        const receipts = await readSettlementReceipts({
            publicClient: clientReturning([
                logAt(0n, toTokenAmount("1")),
                logAt(30n, toTokenAmount("3")),
                logAt(65n, toTokenAmount("2")),
            ]),
            environment,
            delegationHash: DELEGATION_HASH,
            fromBlock: 0n,
        });

        expect(receipts.map((receipt) => receipt.period)).toEqual([0n, 0n, 1n]);
        expect(receipts[2]?.amount).toBe(toTokenAmount("2"));
    });
});
