import {describe, expect, test} from "bun:test";
import type {SmartAccountsEnvironment} from "@metamask/smart-accounts-kit";
import {
    createPublicClient,
    custom,
    encodeAbiParameters,
    getAddress,
    type Address,
    type Hex,
} from "viem";
import {MOCK_USDC, toTokenAmount} from "@mapae/shared";
import {ENTRY_POINT_V07} from "./config.js";
import {buildD3Policies, preparePeriodDelegation} from "./policy.js";
import {
    decodePeriodTransferTerms,
    decodeTimestampTerms,
    findCaveatTerms,
    judgeValidity,
    readDelegationStatus,
    readSettlementReceipts,
    resolveChainTime,
    selectRootDelegations,
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

/**
 * A node scripted at the JSON-RPC seam rather than at `readContract`.
 *
 * That seam is forced, not chosen: the kit's contract helpers build the call themselves
 * and go straight to `client.request({method: "eth_call"})`, so a stub that intercepts
 * `readContract` is never consulted. Driving a real viem client through a `custom`
 * transport also means the ABI encode/decode path under test is the production one — a
 * hand-shaped return object would prove only that the test agrees with itself.
 */
function scriptedNode(script: {
    revoked?: boolean;
    available?: {amount: bigint; isNewPeriod: boolean; currentPeriod: bigint};
    blockTimestamp: bigint;
}) {
    const calls: Address[] = [];
    const client = createPublicClient({
        transport: custom({
            // biome-ignore lint/suspicious/noExplicitAny: raw JSON-RPC envelope
            request: async ({method, params}: any) => {
                if (method === "eth_call") {
                    const to = getAddress(params[0].to as Address);
                    calls.push(to);
                    if (to === getAddress(environment.DelegationManager)) {
                        return encodeAbiParameters([{type: "bool"}], [script.revoked ?? false]);
                    }
                    if (to === PERIOD_ENFORCER) {
                        if (!script.available) throw new Error("enforcer must not be called");
                        return encodeAbiParameters(
                            [{type: "uint256"}, {type: "bool"}, {type: "uint256"}],
                            [
                                script.available.amount,
                                script.available.isNewPeriod,
                                script.available.currentPeriod,
                            ],
                        );
                    }
                }
                if (method === "eth_getBlockByNumber") {
                    return {...EMPTY_BLOCK, timestamp: `0x${script.blockTimestamp.toString(16)}`};
                }
                throw new Error(`unexpected ${method}`);
            },
        }),
    });
    return {client, calls};
}

const EMPTY_BLOCK = {
    number: "0x1",
    hash: `0x${"11".repeat(32)}`,
    parentHash: `0x${"00".repeat(32)}`,
    nonce: "0x0",
    sha3Uncles: `0x${"00".repeat(32)}`,
    logsBloom: "0x",
    transactionsRoot: `0x${"00".repeat(32)}`,
    stateRoot: `0x${"00".repeat(32)}`,
    receiptsRoot: `0x${"00".repeat(32)}`,
    miner: address(0),
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: "0x",
    size: "0x0",
    gasLimit: "0x0",
    gasUsed: "0x0",
    transactions: [],
    uncles: [],
};

describe("readDelegationStatus", () => {
    test("reports the enforcer's own remaining balance, not a local tally", async () => {
        // Deliberately inconsistent with the 3 mUSDC cap in the terms. If this ever came
        // from decoding `periodAmount` and subtracting a local total, the number below
        // could not appear — that second source of truth is exactly what the on-chain
        // read exists to avoid.
        const {client} = scriptedNode({
            available: {amount: 999_999_999n, isNewPeriod: true, currentPeriod: 41n},
            blockTimestamp: BigInt(START_DATE) + 1n,
        });

        const status = await readDelegationStatus({
            publicClient: client,
            environment,
            delegation: delegation(),
        });

        expect(status.remaining).toBe(999_999_999n);
        expect(status.isNewPeriod).toBe(true);
        expect(status.currentPeriod).toBe(41n);
        // The terms still decode to the policy's cap, so the two really are separate.
        expect(status.limit?.periodAmount).toBe(toTokenAmount("3"));
    });

    test("expiry is judged against chain time, not the process clock", async () => {
        // The window closes at START_DATE + 30min, which is in 2033. Wall clock is 2026,
        // so an implementation reading `Date.now()` would call this live. The head block
        // says otherwise, and the head is what `TimestampEnforcer` compares against.
        const {client} = scriptedNode({
            available: {amount: toTokenAmount("3"), isNewPeriod: true, currentPeriod: 0n},
            blockTimestamp: BigInt(START_DATE) + BigInt(POLICY.expiresAfterSeconds),
        });

        const status = await readDelegationStatus({
            publicClient: client,
            environment,
            delegation: delegation(),
        });

        expect(status.expired).toBe(true);
        expect(status.notYetActive).toBe(false);
    });

    test("the activation second itself is reported as not yet active", async () => {
        const {client} = scriptedNode({
            available: {amount: toTokenAmount("3"), isNewPeriod: true, currentPeriod: 0n},
            blockTimestamp: BigInt(START_DATE),
        });

        const status = await readDelegationStatus({
            publicClient: client,
            environment,
            delegation: delegation(),
        });

        expect(status.notYetActive).toBe(true);
    });

    test("a revoked delegation is reported revoked", async () => {
        const {client} = scriptedNode({
            revoked: true,
            available: {amount: toTokenAmount("3"), isNewPeriod: true, currentPeriod: 0n},
            blockTimestamp: BigInt(START_DATE) + 1n,
        });

        const status = await readDelegationStatus({
            publicClient: client,
            environment,
            delegation: delegation(),
        });

        expect(status.revoked).toBe(true);
    });

    test("a delegation with no period caveat reports no cap and never calls the enforcer", async () => {
        // `remaining: undefined` has to mean "this link carries no cap", because
        // `judgePreflight` skips such links when picking the tightest. If a missing
        // caveat instead produced a zero, every payment on an uncapped policy would be
        // refused. The unscripted `available` makes an enforcer call throw.
        const capped = delegation();
        const uncapped = {
            ...capped,
            caveats: capped.caveats.filter(
                (caveat) => getAddress(caveat.enforcer) !== PERIOD_ENFORCER,
            ),
        };
        const {client, calls} = scriptedNode({blockTimestamp: BigInt(START_DATE) + 1n});

        const status = await readDelegationStatus({
            publicClient: client,
            environment,
            delegation: uncapped,
        });

        expect(status.remaining).toBeUndefined();
        expect(status.limit).toBeUndefined();
        expect(calls).not.toContain(PERIOD_ENFORCER);
    });
});

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

describe("selectRootDelegations", () => {
    const ROOT = `0x${"f".repeat(64)}` as Hex;
    const OWNER = "0x0000000000000000000000000000000000000a11" as Address;
    const AGENT = "0x0000000000000000000000000000000000000b22" as Address;

    function delegation(authority: Hex, delegate: Address, salt = 0n) {
        return {
            delegate,
            delegator: OWNER,
            authority,
            caveats: [],
            salt,
            signature: "0x" as Hex,
        };
    }

    test("keeps roots and drops the per-payment leaves minted under them", () => {
        // `RedeemedDelegation` fires once per link, so a single payment emits both the
        // leaf and the root. Only the root is the grant the owner signed and the Studio
        // manages; the leaf is ephemeral and re-minted for the next payment.
        const roots = selectRootDelegations([
            delegation(`0x${"11".repeat(32)}` as Hex, AGENT),
            delegation(ROOT, AGENT),
        ]);
        expect(roots).toHaveLength(1);
        expect(roots[0]?.authority).toBe(ROOT);
    });

    test("a root redeemed many times is returned once", () => {
        // Every settlement re-emits the same root. Without dedupe a busy agent would come
        // back as one card per payment.
        const roots = selectRootDelegations([
            delegation(ROOT, AGENT),
            delegation(ROOT, AGENT),
            delegation(ROOT, AGENT),
        ]);
        expect(roots).toHaveLength(1);
    });

    test("two distinct roots both survive", () => {
        const roots = selectRootDelegations([
            delegation(ROOT, AGENT, 1n),
            delegation(ROOT, AGENT, 2n),
        ]);
        expect(roots).toHaveLength(2);
    });

    test("no roots at all is an empty list, not a throw", () => {
        expect(selectRootDelegations([])).toEqual([]);
    });
});
