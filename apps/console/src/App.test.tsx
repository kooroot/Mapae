import {afterEach, describe, expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {buildD3Policies, preparePeriodDelegation} from "@mapae/delegation/policy";
import {encodeDelegations} from "@metamask/smart-accounts-kit/utils";
import {getAddress, type Hex} from "viem";
import App, {resolveRootDelegation} from "./App";
import {configuredPermissionContext, deployment} from "./config";

const OWNER = getAddress("0xA4e4d00E5860d3700aF2247fFa818Fb62BDDF382");
const MANAGER = getAddress("0xA350522aE469DFA53a117aFD268a60C0e322a321");
const AGENT = getAddress("0x0229346e91a07EA24A54704F094D293E43E9d302");
const VENDOR = getAddress("0x2000000000000000000000000000000000000001");

/** Built with the kit's own encoder, so the decode under test faces a real context. */
function permissionContext(links: {from: string; to: string}[]): Hex {
    return encodeDelegations(
        links.map(({from, to}) =>
            preparePeriodDelegation({
                environment: deployment.environment,
                delegator: getAddress(from),
                delegate: getAddress(to),
                policy: buildD3Policies(VENDOR)["open-agent"],
                startDate: 2_000_000_000,
            }),
        ),
    );
}

afterEach(() => {
    delete process.env.VITE_PERMISSION_CONTEXT;
});

/**
 * The console's entry gate — which of the three first screens an operator lands on.
 *
 * Worth pinning because two of the three states are what a *new* reader sees, and the
 * difference between them is the difference between a correct instruction and a wild
 * goose chase.
 */
describe("resolveRootDelegation", () => {
    test("no context is 'unset', which is the committed first-run state", () => {
        // `.env.example` ships `VITE_PERMISSION_CONTEXT=0x`, which the config layer reads
        // as absent. So this branch is not an edge case — it is what anyone following the
        // README sees first, and it must ask them to set the variable rather than claim
        // their value failed to decode.
        expect(resolveRootDelegation(undefined)).toEqual({kind: "unset"});
    });

    test("'0x' reaches the gate as absent, not as a decode failure", () => {
        process.env.VITE_PERMISSION_CONTEXT = "0x";
        expect(configuredPermissionContext()).toBeUndefined();
        expect(resolveRootDelegation(configuredPermissionContext())).toEqual({kind: "unset"});
    });

    test("the root is the last link, not the first", () => {
        // `decodeDelegations` returns leaf-first. The leaf is the throwaway the agent
        // mints for one 402, so taking `[0]` would put a single payment's allowance on
        // screen as though it were the account's delegated cap.
        const state = resolveRootDelegation(
            permissionContext([
                {from: MANAGER, to: AGENT}, // leaf
                {from: OWNER, to: MANAGER}, // root
            ]),
        );

        expect(state.kind).toBe("ok");
        if (state.kind !== "ok") return;
        expect(getAddress(state.value.root.delegator)).toBe(OWNER);
        expect(getAddress(state.value.root.delegate)).toBe(MANAGER);
        expect(state.value.chainLength).toBe(2);
    });

    test("a single-link chain is its own root", () => {
        const state = resolveRootDelegation(permissionContext([{from: OWNER, to: AGENT}]));
        expect(state.kind).toBe("ok");
        if (state.kind !== "ok") return;
        expect(getAddress(state.value.root.delegator)).toBe(OWNER);
        expect(state.value.chainLength).toBe(1);
    });

    test("an undecodable context yields a reason instead of throwing", () => {
        // A throw here unmounts the page. This repo has paid for that twice — see the
        // note at `Revocation.tsx:151` — so the gate has to answer, not raise.
        const state = resolveRootDelegation("0xdeadbeef");
        expect(state.kind).toBe("invalid");
        if (state.kind !== "invalid") return;
        expect(state.reason.length).toBeGreaterThan(0);
    });

    test("a non-hex context is also answered, not raised", () => {
        expect(resolveRootDelegation("not-hex" as Hex).kind).toBe("invalid");
    });
});

/**
 * The first screen, rendered.
 *
 * `renderToStaticMarkup` reaches this branch with no providers because an unset context
 * never mounts the query-driven screens — which is exactly the property being checked:
 * the default first run must not depend on a reachable node.
 */
describe("App on first run", () => {
    test("renders the instruction panel and hides the tabs", () => {
        const html = renderToStaticMarkup(<App />);

        expect(html).toContain("VITE_PERMISSION_CONTEXT");
        // The tabs are deliberately withheld until there is something behind them: with
        // nothing configured they gave full active-state feedback over a panel that never
        // changed, so the very first interaction anyone tried read as a dead button.
        expect(html).not.toContain("위임 · 한도");
        expect(html).not.toContain("영수증");
        // Not the decode-failure copy — that would send a first-time reader looking for a
        // truncated value they never set.
        expect(html).not.toContain("해석하지 못했습니다");
    });

    test("still names the chain and endpoint it would read from", () => {
        // The footnote is outside the conditional on purpose: an operator who sees an
        // empty console needs to know which node it is pointed at before anything else.
        const html = renderToStaticMarkup(<App />);
        expect(html).toContain("read-only");
    });
});
