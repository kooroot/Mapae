import type {Address, Hex} from "viem";

/**
 * The testnet faucet behind faucet.mapae.io, as a policy rather than a flag.
 *
 * The page, the Worker in front of it and the service that holds the faucet key all
 * import these numbers and parsers, so a limit or a field cannot drift on one side only.
 * The stablecoin is topped up to a target rather than granted by a fixed sum: a payer
 * that is short is brought back to the same balance every time, and a payer that already
 * holds enough is left alone.
 */

/** 1000 tUSDC in 6-decimal base units — the balance every testnet payer is topped up to. */
export const FAUCET_TARGET_BASE = 1_000_000_000n;

/** One stablecoin top-up per wallet per rolling 24 hours. */
export const FAUCET_WINDOW_MS = 86_400_000;

/**
 * How much to mint so `balance` reaches `target`: the shortfall, or `0n` when there is
 * none. Never negative — an account above the target is not asked to give anything back.
 */
export function planTopUp(params: {balance: bigint; target: bigint}): bigint {
    if (params.balance < 0n || params.target < 0n) {
        throw new Error("balance and target must be non-negative base amounts");
    }
    return params.balance < params.target ? params.target - params.balance : 0n;
}

/** What the faucet hands out: the test stablecoin to a payer account, or gas to a wallet. */
export type FaucetKind = "musdc" | "eth";
export const FAUCET_KINDS: readonly FaucetKind[] = ["musdc", "eth"];

/** 0.05 GIWA Sepolia ETH per claim — about two million transfers at GIWA's measured fees. */
export const FAUCET_ETH_AMOUNT_WEI = 50_000_000_000_000_000n;
/** One ETH claim per wallet per rolling week. */
export const FAUCET_ETH_WINDOW_MS = 7 * FAUCET_WINDOW_MS;
/**
 * Per-network claims in a rolling day, and the stablecoin's global daily count.
 *
 * The test stablecoin is permissionlessly mintable, so these bound only the faucet's mint
 * gas (1000 × ~1e11 wei a day). ETH is the asset worth farming: one per address bucket and
 * three per /24 or /48 slow a farm run from one machine, while the daily wei cap and the
 * wallet's floor stay the hard bounds.
 */
export const FAUCET_LIMITS = {
    musdc: {perIp: 5, perSubnet: 20, perDay: 1000},
    eth: {perIp: 1, perSubnet: 3},
} as const;
/** The day the network limits and the daily caps count over. */
export const FAUCET_LIMIT_WINDOW_MS = FAUCET_WINDOW_MS;
/**
 * Transactions an ETH claimant's wallet must already have sent on Ethereum's main chain.
 * One is enough to make every sybil wallet cost real gas, which is more than the testnet
 * ETH it would draw is worth.
 */
export const FAUCET_MAINNET_MIN_NONCE = 1;

/**
 * How the service treats a mission.
 *
 * `honour` is accepted as asserted: the page marks it done when the visitor opens the link.
 * `verified` asks a verifier the service registers for that id. Moving a mission from the
 * first to the second is the whole change real verification needs.
 */
export interface FaucetMission {
    kind: "honour" | "verified";
    href: string;
}
export type FaucetMissionId = "x_follow_mapae";
export const FAUCET_MISSIONS: Readonly<Record<FaucetMissionId, FaucetMission>> = {
    x_follow_mapae: {kind: "honour", href: "https://x.com/intent/follow?screen_name=mapae_io"},
};
/** The stablecoin tab's missions, fixed in code. The ETH tab's come from the service's configuration. */
export const FAUCET_MUSDC_MISSIONS: readonly FaucetMissionId[] = ["x_follow_mapae"];

export function isFaucetMissionId(value: unknown): value is FaucetMissionId {
    return typeof value === "string" && Object.hasOwn(FAUCET_MISSIONS, value);
}

/** A comma-separated list of registry ids. An unknown id throws, so a typo refuses boot instead of opening a tab. */
export function parseFaucetMissionList(raw: string | undefined): FaucetMissionId[] {
    const ids = (raw ?? "").split(",").map((id) => id.trim()).filter((id) => id !== "");
    for (const id of ids) {
        if (!isFaucetMissionId(id)) throw new Error(`unknown faucet mission: ${id}`);
    }
    return [...new Set(ids as FaucetMissionId[])];
}

/** Every refusal the faucet can answer with — the page maps each to a sentence, and nothing else is shown. */
export const FAUCET_REFUSALS = [
    "faucet_off",
    "login_required",
    "mission_incomplete",
    "turnstile_failed",
    "rate_limited",
    "cooldown",
    "not_eligible",
    "eligibility_unavailable",
    "budget_exhausted",
    "faucet_empty",
    "fee_too_high",
    "malformed_request",
    "unavailable",
] as const;
export type FaucetRefusal = (typeof FAUCET_REFUSALS)[number];

export interface FaucetStatus {
    musdc: {enabled: boolean; targetBase: string; windowMs: number; missions: FaucetMissionId[]};
    eth: {enabled: boolean; amountWei: string; windowMs: number; missions: FaucetMissionId[]; minMainnetNonce: number};
}

/**
 * One claim as the page sees it.
 *
 * `pending` is broadcast or about to be; `already_enough` means the recipient held enough
 * and nothing was sent; `nextAt` (epoch ms) is when the owner may claim this kind again and
 * is present only while a counted claim holds the window.
 */
export interface FaucetClaimView {
    kind: FaucetKind;
    state: "pending" | "confirmed" | "failed" | "already_enough";
    /** Base units (stablecoin) or wei (ETH); `"0"` when nothing was sent. */
    amount: string;
    recipient: Address;
    transaction?: Hex;
    nextAt?: number;
}

/** A wallet's faucet standing: where each kind lands, and its latest claim of each. */
export interface FaucetAccount {
    owner: Address;
    recipients: {musdc: Address; eth: Address};
    musdc: FaucetClaimView | null;
    eth: FaucetClaimView | null;
}

/** A refusal body: the reason, and for `cooldown` when the window opens. */
export interface FaucetRefusalBody {
    reason: FaucetRefusal;
    nextAt?: number;
}

const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
const decimal = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9]\d{0,77})$/.test(value);
const instant = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
const windowLength = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const address = (value: unknown): value is Address => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
const txHash = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);

function missionList(value: unknown): FaucetMissionId[] {
    if (!Array.isArray(value) || value.length > 16 || !value.every(isFaucetMissionId)) {
        throw new Error("faucet missions must be known mission ids");
    }
    return [...value];
}

/** Validate, never cast: a field the page renders has to be the shape it was promised. */
export function parseFaucetStatus(input: unknown): FaucetStatus {
    if (!record(input) || !record(input.musdc) || !record(input.eth)) throw new Error("faucet status is malformed");
    const {musdc, eth} = input;
    if (typeof musdc.enabled !== "boolean" || !decimal(musdc.targetBase) || !windowLength(musdc.windowMs)) {
        throw new Error("faucet status is malformed");
    }
    if (
        typeof eth.enabled !== "boolean" || !decimal(eth.amountWei) || !windowLength(eth.windowMs) ||
        typeof eth.minMainnetNonce !== "number" || !Number.isSafeInteger(eth.minMainnetNonce) || eth.minMainnetNonce < 0
    ) {
        throw new Error("faucet status is malformed");
    }
    return {
        musdc: {enabled: musdc.enabled, targetBase: musdc.targetBase, windowMs: musdc.windowMs, missions: missionList(musdc.missions)},
        eth: {
            enabled: eth.enabled,
            amountWei: eth.amountWei,
            windowMs: eth.windowMs,
            missions: missionList(eth.missions),
            minMainnetNonce: eth.minMainnetNonce,
        },
    };
}

const CLAIM_STATES: readonly FaucetClaimView["state"][] = ["pending", "confirmed", "failed", "already_enough"];

export function parseFaucetClaimView(input: unknown, kind?: FaucetKind): FaucetClaimView {
    if (
        !record(input) || !FAUCET_KINDS.includes(input.kind as FaucetKind) || (kind !== undefined && input.kind !== kind) ||
        !CLAIM_STATES.includes(input.state as FaucetClaimView["state"]) || !decimal(input.amount) || !address(input.recipient) ||
        (input.transaction !== undefined && !txHash(input.transaction)) || (input.nextAt !== undefined && !instant(input.nextAt))
    ) {
        throw new Error("faucet claim is malformed");
    }
    const view: FaucetClaimView = {
        kind: input.kind as FaucetKind,
        state: input.state as FaucetClaimView["state"],
        amount: input.amount,
        recipient: input.recipient,
    };
    if (input.transaction !== undefined) view.transaction = input.transaction as Hex;
    if (input.nextAt !== undefined) view.nextAt = input.nextAt as number;
    return view;
}

export function parseFaucetAccount(input: unknown): FaucetAccount {
    if (!record(input) || !address(input.owner) || !record(input.recipients)) throw new Error("faucet account is malformed");
    const {musdc, eth} = input.recipients;
    if (!address(musdc) || !address(eth) || eth.toLowerCase() !== input.owner.toLowerCase()) {
        throw new Error("faucet account is malformed");
    }
    return {
        owner: input.owner,
        recipients: {musdc, eth},
        musdc: input.musdc === null ? null : parseFaucetClaimView(input.musdc, "musdc"),
        eth: input.eth === null ? null : parseFaucetClaimView(input.eth, "eth"),
    };
}

/** A refusal body, or `undefined` when the value is not one this contract defines. */
export function parseFaucetRefusal(input: unknown): FaucetRefusalBody | undefined {
    if (!record(input) || !FAUCET_REFUSALS.includes(input.reason as FaucetRefusal)) return undefined;
    if (input.nextAt !== undefined && !instant(input.nextAt)) return undefined;
    return input.nextAt === undefined
        ? {reason: input.reason as FaucetRefusal}
        : {reason: input.reason as FaucetRefusal, nextAt: input.nextAt};
}
