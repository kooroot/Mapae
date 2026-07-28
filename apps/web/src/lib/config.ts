// Subpath import on purpose: the package barrel also pulls in the Bun-only agent
// runtime, which does not resolve in a browser bundle. The console's config.ts
// carries the same note for the same reason.
import {parseActiveDeploymentArtifactJson} from "@mapae/delegation/config";
import {explorerAddressUrl, explorerTxUrl, giwaSepolia} from "@mapae/shared";
import {createPublicClient, http, isAddress, type Address} from "viem";
import frameworkArtifact from "../../../../deployments/giwa-sepolia.framework.json";

/**
 * The committed deployment artifact is the source of truth for enforcer and
 * manager addresses. `docs/deployed-contracts.md` mirrors it for humans; code
 * reads the JSON so the two cannot drift apart silently.
 */
export const deployment = parseActiveDeploymentArtifactJson(JSON.stringify(frameworkArtifact));

/**
 * What this page is allowed to say, and what it reads live.
 *
 * Two rules govern this file.
 *
 * **Nothing here is a claim the reader cannot check.** Every value below is
 * either read from the chain at render time or is a committed address or hash
 * that resolves on Blockscout. There is no number on this site that exists only
 * because we typed it.
 *
 * **This build is public.** It carries no operational detail — no internal
 * milestone labels, no suite totals, no readiness language. Those belong to the
 * repository and its operators, not to a visitor, and a marketing surface that
 * quotes them is one that goes stale in public.
 */

/** Public endpoint only. `vite.config.ts` refuses to build with anything else. */
export const rpcUrl = import.meta.env["VITE_RPC_URL"]?.trim() || giwaSepolia.rpcUrls.default.http[0];

export const chain = giwaSepolia;

export const publicClient = createPublicClient({chain: giwaSepolia, transport: http(rpcUrl)});

export {explorerAddressUrl, explorerTxUrl};

/**
 * The demo identities, as deployed.
 *
 * `payer` is the one that carries the argument: it is an ERC-4337 smart account
 * that holds the funds and, deliberately, no gas at all. The page reads its
 * native balance live for exactly that reason — a zero you fetch is evidence,
 * and a zero you hardcode is a slogan.
 */
export const accounts = {
    payer: "0xA4e4d00E5860d3700aF2247fFa818Fb62BDDF382" as Address,
    token: "0xcfeb694719A09caeb80798e2011298F29CDa4e92" as Address,
} as const;

/** Settled payments, each linkable. Amounts are what the seller charged. */
export const settlements = [
    {
        label: "위임 결제 · 1 mUSDC",
        labelEn: "Delegated payment · 1 mUSDC",
        hash: "0xe897fe55048b91c0f6728d0af313e30db2b425af8955ee89f7174a16c6aaa97d",
    },
    {
        label: "위임 결제 · 2.5 mUSDC",
        labelEn: "Delegated payment · 2.5 mUSDC",
        hash: "0x71d7144213a04ae7b463f1c0e2b021c672938f10c7d92d5d4fe367e532f46ce4",
    },
    {
        label: "에이전트 단독 결제 · 사람 개입 없음",
        labelEn: "Agent-initiated · no human step",
        hash: "0x533c5cb2945b89c7a56abf681ef049124deb4daf141e1a52b280385cefd9964c",
    },
] as const;

/**
 * The refusals, and why none of them has a link.
 *
 * A refused payment produces no transaction. The facilitator simulates the
 * redemption and only broadcasts if that simulation succeeds, so an over-cap or
 * expired permission dies off-chain: nothing is mined, no gas is spent, and the
 * payer's balance is not touched. There is no hash to link because there is no
 * transaction — which is a stronger claim than a reverted one would be, and the
 * reason this band says so out loud instead of showing an empty column.
 */
export const refusals = [
    {
        attempt: "주기 한도를 넘겨 결제",
        attemptEn: "Pay past the period cap",
        enforcer: "ERC20PeriodTransferEnforcer",
        revert: "transfer-amount-exceeded",
    },
    {
        attempt: "만료된 권한으로 결제",
        attemptEn: "Pay with an expired permission",
        enforcer: "TimestampEnforcer",
        revert: "expired-delegation",
    },
    {
        attempt: "지정되지 않은 수취인에게 송금",
        attemptEn: "Send to a payee that was never named",
        enforcer: "ERC20TransferAmountEnforcer",
        revert: "allowance-exceeded",
    },
] as const;

/**
 * The permission this page illustrates: 3 mUSDC per 60 seconds.
 *
 * These are the caveat's own terms, in the units the enforcer stores them in.
 * The dial derives everything it draws from these three numbers rather than from
 * anything laid out by hand, so a change here moves the ticks, the sweep and the
 * countdown together — the drawing cannot disagree with the policy it depicts.
 */
export const shownPolicy = {
    periodAmount: 3_000_000n, // 3 mUSDC, 6 decimals
    periodDurationSeconds: 60n,
    asset: "mUSDC",
} as const;

/**
 * Whether a revocation submitter is reachable at all.
 *
 * The submitter holds a funded relayer key and refuses any non-loopback bind, so
 * a build served from Cloudflare has none — and the app says that rather than
 * rendering a button that cannot work. `vite.config.ts` already refuses a remote
 * value; this is what the UI does with the resulting absence.
 */
export function submitterAvailability():
    | {kind: "absent"}
    | {kind: "configured"; url: string}
    | {kind: "refused"; reason: string} {
    const raw = import.meta.env["VITE_REVOCATION_SUBMITTER_URL"]?.trim();
    if (!raw) return {kind: "absent"};
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return {kind: "refused", reason: "주소를 해석할 수 없습니다"};
    }
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
        // Names the host, never the whole URL.
        return {kind: "refused", reason: `loopback이 아닙니다 (${url.hostname})`};
    }
    return {kind: "configured", url: url.toString().replace(/\/$/, "")};
}

/** Guard for anything an operator may paste in. Validate, never cast. */
export function parseAddress(value: string): Address | undefined {
    const trimmed = value.trim();
    return isAddress(trimmed) ? (trimmed as Address) : undefined;
}
