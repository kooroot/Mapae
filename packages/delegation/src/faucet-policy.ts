import type {Address} from "viem";

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
