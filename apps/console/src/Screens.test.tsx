import {afterEach, describe, expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {WagmiProvider} from "wagmi";
import type {ReactElement} from "react";
import {buildD3Policies, preparePeriodDelegation} from "@mapae/delegation/policy";
import type {
    DelegationStatus,
    SettlementReceipt,
} from "@mapae/delegation/delegation-status";
import {decodeDelegations, encodeDelegations, hashDelegation} from "@metamask/smart-accounts-kit/utils";
import {getAddress, type Hex} from "viem";
import {DelegationScreen, ReceiptScreen, type RootDelegation} from "./App";
import {RECEIPT_LOOKBACK_BLOCKS, rpcUrl, deployment} from "./config";
import {wagmiConfig} from "./wagmi";

const OWNER = getAddress("0xA4e4d00E5860d3700aF2247fFa818Fb62BDDF382");
const AGENT = getAddress("0x0229346e91a07EA24A54704F094D293E43E9d302");
const VENDOR = getAddress("0x2000000000000000000000000000000000000001");
const TOKEN = getAddress("0xcfeb694719A09caeb80798e2011298F29CDa4e92");

/** A real settled payment, so the explorer link under test is one that resolves. */
const TX_A = "0xe897fe55a2a6a3b1f1a7dbb3f6cf7b2f4c2dc8f1e6a9b7c3d2e1f0a9b8c7d6a9" as Hex;
const TX_B = "0x71d714420e5b8b4c2c9e6f1a3d5b7c9e1f3a5c7e9b1d3f5a7c9e1b3d5f7a96ce" as Hex;

/**
 * Built through the kit's own encoder and decoder rather than as a literal, because the
 * screens key their queries on the *decoded* delegation. `decodeDelegations` returns
 * lowercase addresses while every constant here is checksummed, so a hand-built root
 * would produce a cache key the component never looks up and every test below would
 * silently render the loading state instead of the screen it names.
 */
function rootDelegation(chainLength = 1): RootDelegation {
    const prepared = preparePeriodDelegation({
        environment: deployment.environment,
        delegator: OWNER,
        delegate: AGENT,
        policy: buildD3Policies(VENDOR)["open-agent"],
        startDate: 2_000_000_000,
    });
    // `preparePeriodDelegation` leaves `signature` as `0x`, and a screen trivially cannot
    // leak `0x`. The bearer-secrecy test below is only worth anything against a delegation
    // that actually carries one, so a 65-byte stand-in goes on before encoding.
    const link = {...prepared, signature: `0x${"ab".repeat(65)}` as Hex};
    const context = encodeDelegations(Array.from({length: chainLength}, () => link));
    const chain = decodeDelegations(context);
    const root = chain.at(-1);
    if (!root) throw new Error("unreachable: encoded at least one link");
    return {root, chainLength: chain.length, context};
}

function status(overrides: Partial<DelegationStatus> = {}): DelegationStatus {
    return {
        delegationHash: hashDelegation(rootDelegation().root),
        delegator: OWNER,
        delegate: AGENT,
        limit: {
            token: TOKEN,
            periodAmount: 3_000_000n,
            periodDuration: 60n,
            startDate: 2_000_000_000n,
        },
        validity: {notBefore: 0n, notAfter: 2_000_000_060n},
        remaining: 1_000_000n,
        currentPeriod: 1n,
        revoked: false,
        expired: false,
        notYetActive: false,
        ...overrides,
    };
}

function receipt(overrides: Partial<SettlementReceipt> = {}): SettlementReceipt {
    return {
        delegationHash: hashDelegation(rootDelegation().root),
        redeemer: AGENT,
        token: TOKEN,
        transferredInCurrentPeriod: 1_000_000n,
        amount: 1_000_000n,
        period: 1n,
        transferTimestamp: 2_000_000_010n,
        transactionHash: TX_A,
        blockNumber: 31_634_935n,
        ...overrides,
    };
}

/**
 * Render a screen against a pre-populated cache.
 *
 * `prefetchQuery` rather than `setQueryData` because it is the only one of the two that
 * can seed a *rejection*: it awaits the function and swallows the throw, leaving the
 * cache in the error state the component branches on. Half the branches under test here
 * are failure branches, and a console that blanks instead of explaining is the specific
 * defect this file exists to catch.
 *
 * `retryOnMount: false` is what makes those failure branches reachable at all, and it is
 * not a preference. It defaults to true, and under it `QueryObserver` answers a mounting
 * observer with an *optimistic* pending result for any errored query — so a static render
 * of a screen whose read failed shows the loading panel, and every assertion about error
 * copy passes vacuously against "체인에서 읽는 중…". Measured, not assumed: the same seed
 * renders PENDING with the default and ERROR with this flag.
 */
async function render(
    element: ReactElement,
    seeds: {key: unknown[]; value: () => unknown}[],
): Promise<string> {
    const client = new QueryClient({
        defaultOptions: {queries: {retry: false, retryOnMount: false}},
    });
    for (const seed of seeds) {
        await client.prefetchQuery({queryKey: seed.key, queryFn: async () => seed.value()});
    }
    return renderToStaticMarkup(
        <WagmiProvider config={wagmiConfig}>
            <QueryClientProvider client={client}>{element}</QueryClientProvider>
        </WagmiProvider>,
    );
}

function delegationScreen(
    value: DelegationStatus | (() => never),
    delegation = rootDelegation(),
): Promise<string> {
    return render(<DelegationScreen delegation={delegation} />, [
        {
            key: ["status", delegation.root.delegate, rpcUrl],
            value: typeof value === "function" ? value : () => value,
        },
    ]);
}

function receiptScreen(value: SettlementReceipt[] | (() => never)): Promise<string> {
    const delegation = rootDelegation();
    return render(<ReceiptScreen delegation={delegation} />, [
        {
            key: ["receipts", delegation.root.delegate, rpcUrl],
            value: typeof value === "function" ? value : () => value,
        },
    ]);
}

const boom = () => {
    // Shaped like the viem error the console actually meets: a first actionable line
    // followed by ~700 characters of request body and docs URL.
    throw new Error(
        `The contract function "getTermsInfo" reverted.\nRequest body: {"method":"eth_call"}\nDocs: https://viem.sh/docs/contract/readContract\nVersion: viem@2.55.8`,
    );
};

afterEach(() => {
    delete process.env.VITE_REVOCATION_SUBMITTER_URL;
});

/**
 * The 위임·한도 screen, rendered.
 *
 * Until this file existed the screen had never been rendered by anything but a browser,
 * which is how a `만료 1970-01-01` row shipped beside a 유효 badge and stayed there.
 */
describe("delegation screen", () => {
    test("a live delegation reads 유효 and names both parties in full", async () => {
        const html = await delegationScreen(status());

        expect(html).toContain('data-tone="ok"');
        expect(html).toContain("유효");
        // Full addresses, not truncated: this is the screen an owner checks a session key
        // against, and `0x0229…d302` matches far more keys than it distinguishes.
        expect(html).toContain(OWNER);
        expect(html).toContain(AGENT);
    });

    /**
     * `TimestampEnforcer` tests each half with `> 0`, so zero means *unbounded*, not the
     * Unix epoch. The renderer once gated these rows on the caveat merely existing and
     * printed "만료 1970-01-01 00:00:00 UTC" next to a 유효 badge — a delegation with no
     * expiry, displayed as having expired 56 years ago.
     */
    test("an unbounded window prints neither 개시 nor 만료, and never 1970", async () => {
        const html = await delegationScreen(status({validity: {notBefore: 0n, notAfter: 0n}}));

        expect(html).not.toContain("1970");
        expect(html).not.toContain("<dt>만료</dt>");
        expect(html).not.toContain("<dt>개시</dt>");
        expect(html).toContain("유효");
    });

    test("a one-sided window prints only the half that is set", async () => {
        const html = await delegationScreen(
            status({validity: {notBefore: 0n, notAfter: 2_000_000_060n}}),
        );
        expect(html).toContain("<dt>만료</dt>");
        expect(html).not.toContain("<dt>개시</dt>");
        expect(html).toContain("2033-05-18 03:34:20 UTC");
    });

    /**
     * The state right after the kill switch fires. This is the screen's single most
     * consequential claim: an owner who revoked and still reads 유효 will believe the
     * session key can spend when it cannot, or reach for a second revocation that costs
     * another prefund.
     */
    test("a revoked delegation reads 회수됨 and locks the button", async () => {
        process.env.VITE_REVOCATION_SUBMITTER_URL = "http://127.0.0.1:8082";
        const html = await delegationScreen(status({revoked: true}));

        expect(html).toContain("회수됨");
        expect(html).toContain('data-tone="bad"');
        expect(html).not.toContain(">유효<");
        expect(html).toContain("이미 회수됨");
        expect(html).toContain("disabled");
    });

    /**
     * The one gate that must leave the button *live*. Connecting is not a precondition
     * the owner satisfies elsewhere — the button is the connector, so collapsing the
     * disabled test to `gate.kind !== "ready"` would make the kill switch permanently
     * unreachable while still rendering as a button that says "connect your wallet".
     */
    test("a disconnected owner still gets a live button, because it is the connect path", async () => {
        process.env.VITE_REVOCATION_SUBMITTER_URL = "http://127.0.0.1:8082";
        const html = await delegationScreen(status());

        expect(html).toContain("소유자 지갑 연결");
        expect(html).not.toContain("disabled");
    });

    test("an expired delegation reads 만료됨, not 유효", async () => {
        const html = await delegationScreen(status({expired: true}));
        expect(html).toContain("만료됨");
        expect(html).toContain('data-tone="bad"');
    });

    test("a not-yet-active delegation reads 미개시, not 유효", async () => {
        const html = await delegationScreen(status({notYetActive: true}));
        expect(html).toContain("미개시");
        expect(html).toContain('data-tone="bad"');
    });

    /**
     * A re-delegated chain shows the *root's* cap, which an intermediate link can be
     * tighter than. Without the warning the number on screen reads as the binding limit
     * when the binding limit is the narrowest link in the chain.
     */
    test("a re-delegated chain says the displayed cap may not be the binding one", async () => {
        const html = await delegationScreen(status(), rootDelegation(2));
        expect(html).toContain("재위임 2단 체인");
        expect(html).toContain("가장 좁은 링크");
    });

    test("a single-link chain does not warn about re-delegation", async () => {
        expect(await delegationScreen(status())).not.toContain("재위임");
    });

    /**
     * A failed read must produce a sentence, not a blank page — and only the first line
     * of it. viem puts the whole `eth_call` request body in `message`, which in a 390px
     * column became a twenty-line red paragraph that carried the request into any
     * screenshot taken of it.
     */
    test("an unreadable status explains itself in one line", async () => {
        const html = await delegationScreen(boom);

        expect(html).toContain("상태를 읽지 못했습니다");
        expect(html).toContain('class="panel fault"');
        expect(html).toContain("getTermsInfo");
        expect(html).not.toContain("Request body");
        expect(html).not.toContain("viem.sh");
    });

    test("a pending read says so rather than rendering an empty cap", async () => {
        const html = await render(<DelegationScreen delegation={rootDelegation()} />, []);
        expect(html).toContain("체인에서 읽는 중…");
        expect(html).not.toContain("각인");
    });

    /**
     * The permission context is a bearer authorization: anything holding it can present
     * the chain to `redeemDelegations`. The screen has it in hand — it forwards it to the
     * revoke button — so "it is never rendered" is a property of this component, not an
     * accident of what it happens to be given.
     */
    test("the signed permission context never reaches the DOM", async () => {
        const delegation = rootDelegation();
        const html = await delegationScreen(status(), delegation);

        expect(delegation.context.length).toBeGreaterThan(500);
        expect(html).not.toContain(delegation.context);
        expect(html).not.toContain(delegation.root.signature);
    });
});

/**
 * The 영수증 screen, rendered.
 *
 * Receipts are read straight from `TransferredInPeriod` — there is no ledger behind this
 * screen, so whatever it prints is the whole of what the demo can show for a settlement.
 */
describe("receipt screen", () => {
    test("an empty window says it is empty rather than rendering nothing", async () => {
        const html = await receiptScreen([]);

        expect(html).toContain("정산 기록이 없습니다");
        // The window has to be legible even when empty: "no receipts" and "no receipts
        // *in the last 50,000 blocks*" are different claims, and only one of them is true.
        expect(html).toContain(String(RECEIPT_LOOKBACK_BLOCKS));
    });

    test("settlements render newest first with resolvable explorer links", async () => {
        const html = await receiptScreen([
            receipt({transactionHash: TX_A, blockNumber: 31_634_900n}),
            receipt({transactionHash: TX_B, blockNumber: 31_634_935n}),
        ]);

        // `readSettlementReceipts` returns ascending block order; the screen reverses it.
        // Oldest-first would put the payment someone just made at the bottom of the list.
        expect(html.indexOf(TX_B)).toBeLessThan(html.indexOf(TX_A));
        expect(html).toContain(`https://sepolia-explorer.giwa.io/tx/${TX_A}`);
        // Opens a new tab, so the opener must be severed — the console holds a permission
        // context in memory and the explorer is a third-party origin.
        expect(html).toContain('rel="noreferrer noopener"');
        expect(html).toContain("1.0 mUSDC");
    });

    /**
     * The first receipt in a window has no predecessor to subtract, so its per-payment
     * amount is unknowable — an earlier settlement in the same period can sit before
     * `fromBlock`. Printing the running total as though it were the payment invents a
     * payment that never happened, which for a receipt is the worst available failure.
     */
    test("an underivable amount is labelled as a period total, not as a payment", async () => {
        const html = await receiptScreen([
            receipt({amount: undefined, transferredInCurrentPeriod: 2_500_000n}),
        ]);

        expect(html).toContain("주기 누적 2.5 mUSDC");
        expect(html).not.toContain(">2.5 mUSDC<");
    });

    test("an unreadable log query explains itself in one line", async () => {
        const html = await receiptScreen(boom);

        expect(html).toContain("영수증을 읽지 못했습니다");
        expect(html).toContain('class="panel fault"');
        expect(html).not.toContain("Request body");
    });

    test("a pending read says so rather than claiming an empty history", async () => {
        const html = await render(<ReceiptScreen delegation={rootDelegation()} />, []);
        expect(html).toContain("체인에서 읽는 중…");
        expect(html).not.toContain("정산 기록이 없습니다");
    });
});
