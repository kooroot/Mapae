// Subpath import on purpose: the package barrel also pulls in the Bun-only agent
// runtime, which does not resolve in a browser bundle. The console's config.ts
// carries the same note for the same reason.
import {parseActiveDeploymentArtifactJson} from "@mapae/delegation/config";
import {explorerAddressUrl, explorerTxUrl, giwaSepolia} from "@mapae/shared";
import {createPublicClient, http, isAddress, type Address} from "viem";
import frameworkArtifact from "../../../../deployments/giwa-sepolia.framework.json";

export type SiteSurface = "combined" | "landing" | "app";

function readSiteSurface(raw: string | undefined): SiteSurface {
    const value = raw?.trim();
    if (!value) return "combined";
    if (value === "combined" || value === "landing" || value === "app") return value;
    return "combined";
}

/**
 * One codebase, two public products.
 *
 * Local development keeps both `/` and `/app`. Production builds select a
 * surface so `mapae.io/` is the landing and `app.mapae.io/` is the product
 * root. URLs stay configurable for previews without teaching components about
 * deployment environments.
 */
export const siteSurface = readSiteSurface(import.meta.env["VITE_SITE_SURFACE"]);
export const landingUrl =
    import.meta.env["VITE_LANDING_URL"]?.trim() ||
    (import.meta.env.DEV ? "/" : "https://mapae.io");
export const appUrl =
    import.meta.env["VITE_APP_URL"]?.trim() ||
    (import.meta.env.DEV ? "/app" : "https://app.mapae.io");
export const docsUrl =
    import.meta.env["VITE_DOCS_URL"]?.trim() || "https://gitbook.mapae.io";

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

/** Settled payments, each linkable. Amounts are what the seller charged. */
export const settlements = [
    {
        label: "에이전트 결제 · 1 mUSDC",
        labelEn: "Delegated payment · 1 mUSDC",
        hash: "0xe897fe55048b91c0f6728d0af313e30db2b425af8955ee89f7174a16c6aaa97d",
    },
    {
        label: "에이전트 결제 · 2.5 mUSDC",
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
        attempt: "정해진 한도를 넘겨 결제",
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
        // The recipient is pinned by the `allowedCalldata` caveat, so a swapped
        // payee dies in AllowedCalldataEnforcer — NOT in the amount enforcer.
        // This row shipped once with `ERC20TransferAmountEnforcer:
        // allowance-exceeded`, which is the amount-overrun revert and never
        // reads the recipient; the negative-path suite pins the correct pair
        // (recipient swap → `AllowedCalldataEnforcer:invalid-calldata`).
        // Every string here must match what the deployed enforcers actually
        // return, because these rows are quoted as evidence.
        attempt: "허락하지 않은 사람에게 송금",
        attemptEn: "Send to a payee that was never named",
        enforcer: "AllowedCalldataEnforcer",
        revert: "invalid-calldata",
    },
] as const;

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
