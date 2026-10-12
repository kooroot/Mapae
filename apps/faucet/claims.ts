/**
 * The faucet's decisions, separated from its wiring so a test can drive every branch
 * against a fake chain: `index.ts` reads the environment, builds viem clients and serves
 * Hono; everything that decides whether, what and how much to send lives here.
 *
 * A claim runs in this order, and every refusal that costs nothing comes first:
 *
 * 1. The kind is on, and the caller asserts every mission the kind requires.
 * 2. The ledger's admission check (in flight, cooldown, address and subnet buckets, the
 *    daily caps) — so a wallet on cooldown never costs a read on another chain.
 * 3. Verified missions and, for ETH, eligibility: at least one transaction on Ethereum's
 *    main chain, and no contract code at the wallet on GIWA. A read that fails refuses;
 *    a failed read never passes.
 * 4. `reserve`: the same checks again, in one SQLite transaction that also records the
 *    claim, so two concurrent requests cannot share the last slot.
 * 5. The recipient's balance. A recipient that already holds enough is `skipped`, which
 *    consumes no window.
 * 6. The faucet's own balance and the base fee.
 * 7. Under one mutex: nonce, sign, persist the signed bytes, broadcast.
 * 8. A bounded receipt wait. A timeout leaves the claim `sent` and answers `pending`; the
 *    reconciler finishes it.
 */
import {
    FAUCET_ETH_AMOUNT_WEI,
    FAUCET_ETH_WINDOW_MS,
    FAUCET_LIMITS,
    FAUCET_LIMIT_WINDOW_MS,
    FAUCET_MAINNET_MIN_NONCE,
    FAUCET_MISSIONS,
    FAUCET_MUSDC_MISSIONS,
    FAUCET_TARGET_BASE,
    FAUCET_WINDOW_MS,
    planTopUp,
    type FaucetAccount,
    type FaucetClaimView,
    type FaucetKind,
    type FaucetMissionId,
    type FaucetRefusal,
    type FaucetStatus,
} from "@mapae/delegation/faucet-policy";
import {MOCK_USDC, redactForLog} from "@mapae/shared";
import type {FaucetClaimRow, FaucetReserveLimits, FaucetStore} from "@mapae/store/faucet";
import {encodeFunctionData, getAddress, keccak256, parseAbi, type Address, type Hex} from "viem";

const MINT_ABI = parseAbi(["function mint(address to, uint256 value)"]);

/** Measured with the bootstrap sponsor: a MockUSDC mint, and a plain transfer. */
export const MINT_GAS = 100_000n;
export const TRANSFER_GAS = 21_000n;
/** ~50x GIWA's measured 1,000,266 wei/gas. A fee spike above this is the operator's call. */
export const MAX_FEE_PER_GAS = 50_000_000n;
/** Explicit, because viem's 1 gwei default is above the fee cap and the node refuses it. */
export const PRIORITY_FEE_PER_GAS = 1_000_000n;
export const RECEIPT_TIMEOUT_MS = 30_000;
/** A reserved claim older than this was never signed: its request died. */
export const STALE_RESERVATION_MS = 120_000;
/** How long a broadcast may go unseen before the reconciler sends the same bytes again. */
export const REBROADCAST_AFTER_MS = 120_000;
/** Finished claims older than every window are history nobody reads. */
export const LEDGER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** What the node said to a raw transaction. Ambiguous outcomes (a timeout, a dropped connection) throw. */
export type BroadcastResult = "accepted" | "rejected";
export type ReceiptStatus = "success" | "reverted";

/** Every chain read and write the faucet makes, injected so tests never touch a network. */
export interface FaucetChain {
    balance(address: Address): Promise<bigint>;
    tokenBalance(address: Address): Promise<bigint>;
    code(address: Address): Promise<Hex | undefined>;
    /** `null` when the node reports no base fee — a fee we cannot read is not zero. */
    baseFee(): Promise<bigint | null>;
    nonce(address: Address, tag: "pending" | "latest"): Promise<number>;
    sendRaw(raw: Hex): Promise<BroadcastResult>;
    /** The receipt if mined, `null` if not (yet). */
    receipt(hash: Hex): Promise<ReceiptStatus | null>;
    /** Waits up to `timeoutMs`; `null` on timeout. */
    waitForReceipt(hash: Hex, timeoutMs: number): Promise<ReceiptStatus | null>;
    /** Transactions the wallet has sent on Ethereum's main chain. */
    mainnetNonce(owner: Address): Promise<number>;
    /** The owner's payer smart account — local CREATE2, no network. */
    payer(owner: Address): Promise<Address>;
}

export interface FaucetTransaction {
    to: Address;
    data?: Hex;
    value: bigint;
    gas: bigint;
    nonce: number;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
}
export interface FaucetSigner {
    address: Address;
    sign(transaction: FaucetTransaction): Promise<Hex>;
}

export type MissionVerifier = (owner: Address) => Promise<boolean>;

export interface FaucetConfig {
    /** The kill switch; off by default in `index.ts`. */
    enabled: boolean;
    /** The ETH tab's missions. Empty keeps the ETH tab off. */
    ethMissions: readonly FaucetMissionId[];
    /** Wei the ETH tab may commit per rolling day. */
    ethDailyWei: bigint;
    /** ETH the faucet keeps for stablecoin mint gas; the ETH tab never spends below it. */
    minBalanceWei: bigint;
    receiptTimeoutMs?: number;
    /** One per `verified` mission. None exist yet; X verification is one entry here. */
    verifiers?: Partial<Record<FaucetMissionId, MissionVerifier>>;
}

export interface ClaimRequest {
    kind: FaucetKind;
    owner: Address;
    /** HMAC digests of the client's address bucket and subnet, computed by the Worker. */
    ipKey: string;
    subnetKey: string;
    missions: readonly string[];
}

export type ClaimOutcome =
    | {ok: true; view: FaucetClaimView}
    | {ok: false; refusal: FaucetRefusal; status: 403 | 429 | 503; nextAt?: number};

const STATUS: Record<FaucetRefusal, 400 | 403 | 429 | 503> = {
    faucet_off: 503,
    login_required: 403,
    mission_incomplete: 403,
    turnstile_failed: 403,
    rate_limited: 429,
    cooldown: 429,
    not_eligible: 403,
    eligibility_unavailable: 503,
    budget_exhausted: 503,
    faucet_empty: 503,
    fee_too_high: 503,
    malformed_request: 400,
    unavailable: 503,
};

function refuse(refusal: Exclude<FaucetRefusal, "malformed_request">, nextAt?: number): ClaimOutcome {
    const status = STATUS[refusal] as 403 | 429 | 503;
    return nextAt === undefined ? {ok: false, refusal, status} : {ok: false, refusal, status, nextAt};
}

/** An EIP-7702 delegation designator: an ordinary wallet that delegated its code, not a contract. */
const DELEGATED_EOA = /^0xef0100[0-9a-fA-F]{40}$/;

/** Bounds the status read so a crowd on the page costs one balance read per interval. */
const STATUS_TTL_MS = 15_000;

export function createFaucet(deps: {
    store: FaucetStore;
    chain: FaucetChain;
    signer: FaucetSigner;
    config: FaucetConfig;
    now?: () => number;
}) {
    const {store, chain, signer, config} = deps;
    const now = deps.now ?? Date.now;
    const receiptTimeoutMs = config.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS;
    for (const id of [...FAUCET_MUSDC_MISSIONS, ...config.ethMissions]) {
        if (FAUCET_MISSIONS[id].kind === "verified" && !config.verifiers?.[id]) {
            throw new Error(`mission ${id} is verified but has no verifier`);
        }
    }
    const kindOn = (kind: FaucetKind) => config.enabled && (kind === "musdc" || config.ethMissions.length > 0);
    const missionsOf = (kind: FaucetKind): readonly FaucetMissionId[] => (kind === "musdc" ? FAUCET_MUSDC_MISSIONS : config.ethMissions);
    const windowOf = (kind: FaucetKind) => (kind === "musdc" ? FAUCET_WINDOW_MS : FAUCET_ETH_WINDOW_MS);
    const limitsOf = (kind: FaucetKind): FaucetReserveLimits =>
        kind === "musdc"
            ? {windowMs: FAUCET_WINDOW_MS, dayMs: FAUCET_LIMIT_WINDOW_MS, ...FAUCET_LIMITS.musdc}
            : {windowMs: FAUCET_ETH_WINDOW_MS, dayMs: FAUCET_LIMIT_WINDOW_MS, ...FAUCET_LIMITS.eth, dailyAmount: config.ethDailyWei};
    /** What the faucet's own balance must cover for one claim of `kind`. */
    const need = (kind: FaucetKind) =>
        kind === "musdc" ? MINT_GAS * MAX_FEE_PER_GAS : config.minBalanceWei + FAUCET_ETH_AMOUNT_WEI + TRANSFER_GAS * MAX_FEE_PER_GAS;

    // One broadcast at a time: the nonce read, the signature, the ledger write and the send
    // are one critical section. The receipt wait is outside it, so a slow block holds no one.
    let queue: Promise<unknown> = Promise.resolve();
    function serial<T>(task: () => Promise<T>): Promise<T> {
        const run = queue.then(task, task);
        queue = run.catch(() => undefined);
        return run;
    }

    function view(row: FaucetClaimRow): FaucetClaimView {
        const at = now();
        const state: FaucetClaimView["state"] =
            row.state === "confirmed" ? "confirmed"
            : row.state === "failed" ? "failed"
            : row.state === "skipped" ? "already_enough"
            : "pending";
        const result: FaucetClaimView = {kind: row.kind, state, amount: row.amount, recipient: getAddress(row.recipient)};
        if (row.tx_hash) result.transaction = row.tx_hash as Hex;
        const nextAt = row.created_at + windowOf(row.kind);
        if ((state === "pending" || state === "confirmed") && nextAt > at) result.nextAt = nextAt;
        return result;
    }

    let statusCache: {at: number; balance: bigint | undefined} | undefined;
    async function faucetBalance(): Promise<bigint | undefined> {
        const at = now();
        if (statusCache && at - statusCache.at < STATUS_TTL_MS) return statusCache.balance;
        let balance: bigint | undefined;
        try {
            balance = await chain.balance(signer.address);
        } catch (error) {
            console.warn(`[faucet] balance read failed — ${redactForLog(error)}`);
        }
        statusCache = {at, balance};
        return balance;
    }

    async function status(): Promise<FaucetStatus> {
        const balance = await faucetBalance();
        // An unreadable balance does not close the tabs; a claim checks again and refuses itself.
        const funded = (kind: FaucetKind) => balance === undefined || balance >= need(kind);
        return {
            musdc: {
                enabled: kindOn("musdc") && funded("musdc"),
                targetBase: String(FAUCET_TARGET_BASE),
                windowMs: FAUCET_WINDOW_MS,
                missions: [...FAUCET_MUSDC_MISSIONS],
            },
            eth: {
                enabled: kindOn("eth") && funded("eth"),
                amountWei: String(FAUCET_ETH_AMOUNT_WEI),
                windowMs: FAUCET_ETH_WINDOW_MS,
                missions: [...config.ethMissions],
                minMainnetNonce: FAUCET_MAINNET_MIN_NONCE,
            },
        };
    }

    async function account(owner: Address): Promise<FaucetAccount> {
        const key = owner.toLowerCase();
        const musdc = store.latest("musdc", key), eth = store.latest("eth", key);
        return {
            owner: getAddress(owner),
            recipients: {musdc: await chain.payer(owner), eth: getAddress(owner)},
            musdc: musdc ? view(musdc) : null,
            eth: eth ? view(eth) : null,
        };
    }

    /** Verified missions and ETH eligibility: the reads that cost a network round trip. */
    async function eligibility(kind: FaucetKind, owner: Address): Promise<ClaimOutcome | undefined> {
        for (const id of missionsOf(kind)) {
            if (FAUCET_MISSIONS[id].kind !== "verified") continue;
            try {
                if (!(await config.verifiers![id]!(owner))) return refuse("mission_incomplete");
            } catch (error) {
                console.warn(`[faucet] mission ${id} check failed — ${redactForLog(error)}`);
                return refuse("eligibility_unavailable");
            }
        }
        if (kind !== "eth") return undefined;
        let sent: number, code: Hex | undefined;
        try {
            [sent, code] = await Promise.all([chain.mainnetNonce(owner), chain.code(owner)]);
        } catch (error) {
            console.warn(`[faucet] eligibility read failed — ${redactForLog(error)}`);
            return refuse("eligibility_unavailable");
        }
        if (sent < FAUCET_MAINNET_MIN_NONCE) return refuse("not_eligible");
        if (code && code !== "0x" && !DELEGATED_EOA.test(code)) return refuse("not_eligible");
        return undefined;
    }

    async function claim(request: ClaimRequest): Promise<ClaimOutcome> {
        const {kind} = request;
        if (!kindOn(kind)) return refuse("faucet_off");
        if (!missionsOf(kind).every((id) => request.missions.includes(id))) return refuse("mission_incomplete");

        const owner = getAddress(request.owner);
        const recipient = kind === "musdc" ? await chain.payer(owner) : owner;
        const input = {
            kind,
            owner: owner.toLowerCase(),
            recipient: recipient.toLowerCase(),
            ipKey: request.ipKey,
            subnetKey: request.subnetKey,
            amount: kind === "eth" ? FAUCET_ETH_AMOUNT_WEI : 0n,
        };
        const limits = limitsOf(kind);
        const early = store.admission(input, now(), limits);
        if (early?.kind === "inflight") return {ok: true, view: view(early.claim)};
        if (early) return admissionRefusal(early);

        const ineligible = await eligibility(kind, owner);
        if (ineligible) return ineligible;

        const reservation = store.reserve(input, now(), limits);
        if (!reservation.ok) return admissionRefusal(reservation.refusal);
        if (!reservation.created) return {ok: true, view: view(reservation.claim)};
        const id = reservation.claim.id;

        let hash: Hex | undefined;
        try {
            const amount = await plan(kind, recipient);
            if (amount === 0n) {
                store.markSkipped(id, now());
                return {ok: true, view: view(store.get(id)!)};
            }
            const blocked = await affordable(kind);
            if (blocked) {
                store.markFailed(id, now());
                return blocked;
            }
            hash = await broadcast(id, kind, recipient, amount);
            if (hash === undefined) return refuse("unavailable");
        } catch (error) {
            console.error(`[faucet] ${kind} claim not sent — ${redactForLog(error)}`);
            // Only an unsigned claim can be failed here; a signed one belongs to the reconciler.
            if (store.get(id)?.state === "reserved") store.markFailed(id, now());
            return store.get(id)?.state === "failed" ? refuse("unavailable") : {ok: true, view: view(store.get(id)!)};
        }

        try {
            const receipt = await chain.waitForReceipt(hash, receiptTimeoutMs);
            if (receipt === "success") store.markConfirmed(id, now());
            else if (receipt === "reverted") store.markFailed(id, now());
        } catch (error) {
            console.warn(`[faucet] receipt wait failed, reconciler will finish ${hash} — ${redactForLog(error)}`);
        }
        const row = store.get(id)!;
        console.log(`[faucet] ${kind} ${row.state} owner=${input.owner} amount=${row.amount} tx=${row.tx_hash ?? "-"}`);
        return {ok: true, view: view(row)};
    }

    function admissionRefusal(refusal: {kind: "cooldown"; nextAt: number} | {kind: "rate_limited"} | {kind: "budget_exhausted"}): ClaimOutcome {
        return refusal.kind === "cooldown" ? refuse("cooldown", refusal.nextAt) : refuse(refusal.kind);
    }

    /** How much to send: the stablecoin's shortfall to the target, or the ETH grant unless the wallet holds it already. */
    async function plan(kind: FaucetKind, recipient: Address): Promise<bigint> {
        if (kind === "musdc") return planTopUp({balance: await chain.tokenBalance(recipient), target: FAUCET_TARGET_BASE});
        return (await chain.balance(recipient)) >= FAUCET_ETH_AMOUNT_WEI ? 0n : FAUCET_ETH_AMOUNT_WEI;
    }

    async function affordable(kind: FaucetKind): Promise<ClaimOutcome | undefined> {
        const [balance, baseFee] = await Promise.all([chain.balance(signer.address), chain.baseFee()]);
        if (baseFee === null) return refuse("unavailable");
        if (baseFee > MAX_FEE_PER_GAS) return refuse("fee_too_high");
        if (balance < need(kind)) {
            statusCache = undefined;
            return refuse("faucet_empty");
        }
        return undefined;
    }

    /**
     * Sign, persist, then send — in that order, under the mutex.
     *
     * The nonce is the larger of the node's pending count and the ledger's own next nonce,
     * so a transaction signed but not yet seen by the node is never overwritten. The bytes
     * reach disk before the network: a crash after the write is recovered by sending the
     * same bytes, and a crash before it signed nothing anyone can see.
     *
     * A node that answers with an error did not take the transaction, so the claim fails
     * and its nonce is free again. A timeout or a dropped connection is ambiguous — the
     * node may hold it — so the claim stays `signed` and the reconciler decides.
     */
    function broadcast(id: string, kind: FaucetKind, recipient: Address, amount: bigint): Promise<Hex | undefined> {
        return serial(async () => {
            const nonce = Math.max(await chain.nonce(signer.address, "pending"), store.nextNonce());
            const raw = await signer.sign(
                kind === "musdc"
                    ? {
                          to: MOCK_USDC.address,
                          data: encodeFunctionData({abi: MINT_ABI, functionName: "mint", args: [recipient, amount]}),
                          value: 0n,
                          gas: MINT_GAS,
                          nonce,
                          maxFeePerGas: MAX_FEE_PER_GAS,
                          maxPriorityFeePerGas: PRIORITY_FEE_PER_GAS,
                      }
                    : {
                          to: recipient,
                          value: amount,
                          gas: TRANSFER_GAS,
                          nonce,
                          maxFeePerGas: MAX_FEE_PER_GAS,
                          maxPriorityFeePerGas: PRIORITY_FEE_PER_GAS,
                      },
            );
            const hash = keccak256(raw);
            // False when the reconciler already failed this reservation: nothing is sent.
            if (!store.markSigned(id, {amount, nonce, txHash: hash.toLowerCase(), rawTx: raw.toLowerCase()}, now())) return undefined;
            let result: BroadcastResult;
            try {
                result = await chain.sendRaw(raw);
            } catch (error) {
                console.warn(`[faucet] broadcast unconfirmed, reconciler will retry ${hash} — ${redactForLog(error)}`);
                return hash;
            }
            if (result === "rejected") {
                store.markFailed(id, now());
                throw new Error("the node rejected the transaction");
            }
            store.markSent(id, now());
            return hash;
        });
    }

    /**
     * Finish what a crash, a timeout or a slow block left open. Runs at boot and on an
     * interval; every step is idempotent, so overlapping runs are harmless.
     *
     * - `reserved` past {@link STALE_RESERVATION_MS}: nothing was signed — fail it.
     * - `signed`/`sent` with a receipt: record the outcome.
     * - no receipt, and the chain's mined nonce has passed ours: another transaction took
     *   the nonce, so ours can never land — fail it.
     * - otherwise, once {@link REBROADCAST_AFTER_MS} has passed since the last attempt, send
     *   the same bytes again. Same hash, so it can never pay twice. A node that rejects
     *   them is checked for a receipt once more before the claim is failed.
     */
    async function reconcile(): Promise<void> {
        const at = now();
        store.prune(at - LEDGER_RETENTION_MS);
        const rows = store.unsettled();
        if (rows.length === 0) return;
        let mined: number | undefined;
        for (const row of rows) {
            try {
                if (row.state === "reserved") {
                    if (at - row.created_at > STALE_RESERVATION_MS) store.markFailed(row.id, at);
                    continue;
                }
                const hash = row.tx_hash as Hex;
                const receipt = await chain.receipt(hash);
                if (receipt) {
                    if (receipt === "success") store.markConfirmed(row.id, now());
                    else store.markFailed(row.id, now());
                    continue;
                }
                mined ??= await chain.nonce(signer.address, "latest");
                if (mined > row.nonce!) {
                    store.markFailed(row.id, now());
                    continue;
                }
                if (at - row.updated_at < REBROADCAST_AFTER_MS) continue;
                const result = await chain.sendRaw(row.raw_tx as Hex);
                if (result === "accepted") {
                    store.markSent(row.id, now());
                    continue;
                }
                const late = await chain.receipt(hash);
                if (late === "success") store.markConfirmed(row.id, now());
                else store.markFailed(row.id, now());
            } catch (error) {
                console.warn(`[faucet] reconcile ${row.id} deferred — ${redactForLog(error)}`);
            }
        }
    }

    return {status, account, claim, reconcile};
}

export type Faucet = ReturnType<typeof createFaucet>;

// ── Request boundary ────────────────────────────────────────────────────────────────

const KEY = /^[0-9a-f]{64}$/;
const MISSION = /^[a-z0-9_]{1,64}$/;

/** The claim body the Worker forwards, or `undefined` for anything else. Unknown fields are ignored. */
export function parseClaimRequest(input: unknown): ClaimRequest | undefined {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
    const body = input as Record<string, unknown>;
    if (body.kind !== "musdc" && body.kind !== "eth") return undefined;
    if (typeof body.owner !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(body.owner)) return undefined;
    if (typeof body.ipKey !== "string" || !KEY.test(body.ipKey) || typeof body.subnetKey !== "string" || !KEY.test(body.subnetKey)) return undefined;
    if (!Array.isArray(body.missions) || body.missions.length > 16 || !body.missions.every((m) => typeof m === "string" && MISSION.test(m))) return undefined;
    return {kind: body.kind, owner: getAddress(body.owner), ipKey: body.ipKey, subnetKey: body.subnetKey, missions: body.missions as string[]};
}

/**
 * The Worker's bearer, compared without leaking its length or prefix through timing:
 * both sides are hashed to the same width first, then compared in constant time.
 */
export async function bearerMatches(header: string | undefined, token: string): Promise<boolean> {
    if (header === undefined || !header.startsWith("Bearer ")) return false;
    const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
    const [given, expected] = await Promise.all([digest(header.slice("Bearer ".length)), digest(token)]);
    let difference = 0;
    for (let i = 0; i < expected.length; i += 1) difference |= given[i]! ^ expected[i]!;
    return difference === 0;
}
