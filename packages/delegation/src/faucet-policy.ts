import type {Address, Hex} from "viem";

/**
 * The testnet faucet, as a policy rather than a flag.
 *
 * Three decisions live here so the bootstrap service can only apply them, never
 * reinterpret them, and so a unit test can pin each one without a chain:
 *
 * - **Top up to a target, not by a fixed grant.** A payer that is short is brought back
 *   to the same balance every time; a payer that already holds enough is left alone. The
 *   old rule minted a fixed 3.00 only at a balance of exactly zero, which meant a payer
 *   with 0.10 left was permanently stuck one payment short.
 * - **Once per account per rolling day.** The unit of griefing is the account the request
 *   proves it owns, not the IP it arrived from — keypairs are free and IPs are shared. The
 *   daily gas budget remains the flood bound; this gate only bounds how much testnet
 *   float one account can draw.
 * - **On by default.** The faucet exists so a freshly deployed account can pay; a
 *   deployment that forgets a variable should get the working product, not a silent
 *   account that fails its first payment. The one thing that turns it off is the string
 *   `"false"`, or a deployment artifact that is not the testnet.
 */

/** 1000 tUSDC in 6-decimal base units — the balance every testnet payer is topped up to. */
export const FAUCET_TARGET_BASE = 1_000_000_000n;

/** One top-up per account per rolling 24 hours. */
export const FAUCET_WINDOW_MS = 86_400_000;

export interface FaucetConfig {
    enabled: boolean;
    /** Base units. */
    target: bigint;
}

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

/**
 * Where the per-account windows are kept.
 *
 * The gate holds no state of its own: an in-process `Map` and a SQLite table are the same
 * four operations, so the service can persist windows without the gate growing a second
 * code path. Keys arrive already lowercased — see {@link FaucetGate}.
 */
export interface FaucetWindowStore {
    /** When `account` was last minted to, in epoch ms, or `undefined` if never. */
    lastMintedAt(account: string): number | undefined;
    /** Record a mint that landed. */
    record(account: string, at: number): void;
    /** Drop every window whose mint is at or before `before`. */
    sweep(before: number): void;
    /** How many windows are held. */
    count(): number;
}

/** The default store: windows live as long as the process does. */
export class InMemoryFaucetWindows implements FaucetWindowStore {
    readonly #mintedAt = new Map<string, number>();

    lastMintedAt(account: string): number | undefined {
        return this.#mintedAt.get(account);
    }

    record(account: string, at: number): void {
        this.#mintedAt.set(account, at);
    }

    sweep(before: number): void {
        for (const [key, at] of this.#mintedAt) {
            if (at <= before) this.#mintedAt.delete(key);
        }
    }

    count(): number {
        return this.#mintedAt.size;
    }
}

/**
 * One successful top-up per account per rolling window.
 *
 * Deliberately two calls, `allows` then `record`, rather than a single try-consume: the
 * window must open from a mint that *landed*, not from an attempt. A gate consumed at
 * request time would lock an account out for a day after a reverted or unobserved mint,
 * which is the one outcome worse than minting twice on a testnet. Refusing consumes
 * nothing, so a stream of refused requests neither extends the window nor grows the store.
 *
 * Keys are lowercased so the same account cannot draw twice by varying the checksum
 * casing of its address.
 *
 * The windows belong in a {@link FaucetWindowStore} rather than in this object, because a
 * bound that a restart clears is not a bound: an in-process map handed every account a
 * fresh day on every deploy, and the operator's own restart was the cheapest way to drain
 * the faucet. The default store keeps the old behaviour for callers that have no disk.
 */
export class FaucetGate {
    constructor(
        private readonly windowMs: number = FAUCET_WINDOW_MS,
        private readonly windows: FaucetWindowStore = new InMemoryFaucetWindows(),
    ) {
        if (!Number.isInteger(windowMs) || windowMs < 1) {
            throw new Error("windowMs must be a positive integer");
        }
    }

    /** True when `account` may be minted to at `now`. Never consumes. */
    allows(account: Address, now: number): boolean {
        const last = this.windows.lastMintedAt(keyOf(account));
        return last === undefined || now - last >= this.windowMs;
    }

    /** Open a new window for `account`, dated from the mint that succeeded at `now`. */
    record(account: Address, now: number): void {
        this.windows.record(keyOf(account), now);
    }

    /** Drop windows that have elapsed so a stream of distinct accounts cannot grow forever. */
    sweep(now: number): void {
        this.windows.sweep(now - this.windowMs);
    }

    get size(): number {
        return this.windows.count();
    }
}

function keyOf(account: Address): string {
    return account.toLowerCase();
}

/**
 * The faucet's two knobs, read from the environment with the defaults stated above.
 *
 * `BOOTSTRAP_FAUCET_ENABLED` accepts `"true"`, `"false"` or nothing; any other spelling is
 * refused at boot rather than guessed, because the safe reading of a typo is not obvious
 * for a switch whose default is on. `BOOTSTRAP_FAUCET_TARGET_BASE` is a positive integer in
 * base units and defaults to {@link FAUCET_TARGET_BASE}.
 */
export function readFaucetConfig(env: Record<string, string | undefined>): FaucetConfig {
    const enabledRaw = env["BOOTSTRAP_FAUCET_ENABLED"]?.trim().toLowerCase() ?? "";
    let enabled: boolean;
    if (enabledRaw === "" || enabledRaw === "true") enabled = true;
    else if (enabledRaw === "false") enabled = false;
    else throw new Error('BOOTSTRAP_FAUCET_ENABLED must be "true" or "false"');

    const targetRaw = env["BOOTSTRAP_FAUCET_TARGET_BASE"]?.trim() ?? "";
    let target = FAUCET_TARGET_BASE;
    if (targetRaw !== "") {
        if (!/^[1-9]\d*$/.test(targetRaw)) {
            throw new Error("BOOTSTRAP_FAUCET_TARGET_BASE must be a positive integer in base units");
        }
        target = BigInt(targetRaw);
    }
    return {enabled, target};
}

// ── faucet.mapae.io ─────────────────────────────────────────────────────────────────
//
// The contract between the faucet page, the Worker in front of it and the service that
// holds the faucet key. Browser-safe on purpose: the page and the Worker validate every
// reply with the same parsers the service's tests pin, so a field cannot drift on one
// side only.

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
