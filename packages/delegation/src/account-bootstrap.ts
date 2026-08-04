import {Implementation, type Delegation, type SmartAccountsEnvironment} from "@metamask/smart-accounts-kit";
import {
    decodeDelegations,
    getCounterfactualAccountData,
} from "@metamask/smart-accounts-kit/utils";
import {
    getAddress,
    hexToBigInt,
    isAddress,
    recoverTypedDataAddress,
    size,
    slice,
    zeroAddress,
    type Address,
    type Hex,
} from "viem";
import {giwaSepolia} from "@mapae/shared";
import {
    MAX_PERMISSION_CONTEXT_HEX_LENGTH,
    OWNER_ACCOUNT_SALT,
} from "./config.js";
import {buildRootDelegationTypedData} from "./signing.js";

/**
 * The operator's boundary on what the sponsor will put its own gas behind.
 *
 * `SimpleFactory.deploy` is permissionless and takes *arbitrary* initcode, so a service
 * that forwards what it is handed is a general-purpose contract-deployment service funded
 * by someone else's key. The narrowing here is different in kind from
 * {@link validateRevocationSubmission}: there is no client-supplied calldata to compare
 * against, because the request carries no calldata at all. The only input is a signed
 * permission context, and everything else — owner, salt, initcode, target — is
 * reconstructed from it plus the pinned deployment artifact.
 */
export interface AccountBootstrapPolicy {
    environment: SmartAccountsEnvironment;
    chainId: number;
    /**
     * The exact phrase the operator wrote into the service's environment. Checked at
     * boot, not per request; carried here so the validator and the service cannot drift
     * about what phrase authorises what.
     */
    approval: string;
}

export interface ValidatedAccountBootstrap {
    /** The counterfactual account the sponsor may deploy. Derived, never accepted. */
    account: Address;
    /** Recovered from the root signature — the only identity the request proves. */
    owner: Address;
    salt: Hex;
    /** `SimpleFactory` from the pinned artifact. */
    factoryTarget: Address;
    /** `deploy(bytes,bytes32)` calldata this repo built. Never client-supplied. */
    factoryData: Hex;
    delegation: Delegation;
}

export const SPONSORED_BOOTSTRAP_APPROVAL_PREFIX = "sponsored-bootstrap" as const;

/**
 * The approval phrase an operator must set to let the sponsor broadcast.
 *
 * Pinned to the composition rather than being a bare boolean for the same reason
 * `GIWA_DEPLOYMENT_APPROVAL` is: a framework redeploy changes which contracts the sponsor
 * would be paying to instantiate, and an approval that survives that change is an approval
 * for something the operator never read.
 */
export function buildSponsoredBootstrapApproval(compositionId: string): string {
    return `${SPONSORED_BOOTSTRAP_APPROVAL_PREFIX}-chain-${giwaSepolia.id}-${compositionId}`;
}

/** secp256k1 group order, halved — the EIP-2 malleability boundary, inclusive. */
const SECP256K1N_HALF =
    0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/**
 * Does this signature match the shape the deployed account will actually accept?
 *
 * Two separate facts, both measured rather than assumed:
 *
 * `HybridDeleGator._isValidSignature` selects its branch on length — exactly 65 bytes
 * takes the `ECDSA.recover(hash, sig) == owner()` path, anything longer is decoded as a
 * P256 signature. Every account this repo deploys uses `deployParams: [owner, [], [], []]`,
 * so `authorizedKeys` is empty and the P256 branch can only ever return
 * `SIG_VALIDATION_FAILED`. A 96-byte signature is therefore not "a different valid shape",
 * it is a signature that can never verify — and refusing it here is what stops the sponsor
 * paying to deploy an account whose grant is already dead.
 *
 * OpenZeppelin's `ECDSA.recover` reverts with `ECDSAInvalidSignatureS` on `s` above
 * half-order, and rejects `v` outside {27, 28}. viem's `recoverTypedDataAddress` accepts
 * both. Without this check a malleable signature recovers an owner offline, derives a
 * matching account, gets deployed on our gas, and then reverts forever on chain — the
 * worst failure mode available, because we pay and the user still cannot pay.
 */
export function isCanonicalSignature(signature: Hex): boolean {
    if (size(signature) !== 65) return false;
    const s = hexToBigInt(slice(signature, 32, 64));
    if (s === 0n || s > SECP256K1N_HALF) return false;
    const v = hexToBigInt(slice(signature, 64, 65));
    return v === 27n || v === 28n;
}

function readPermissionContext(value: unknown): Hex {
    if (typeof value !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(value)) {
        throw new Error("permissionContext must be 0x-prefixed hex of whole bytes");
    }
    if (value.length <= 2) throw new Error("permissionContext must not be empty");
    if (value.length > MAX_PERMISSION_CONTEXT_HEX_LENGTH) {
        throw new Error("permissionContext is too large");
    }
    return value as Hex;
}

/**
 * Refuse to boot when two funded roles resolve to the same account.
 *
 * Every service in this repo that broadcasts holds its own key, and until now each one
 * re-implemented that rule as an ad-hoc loop over the two or three siblings whose names its
 * author happened to remember. That is how the gap this function closes appeared: the
 * revocation submitter checked its sponsor against the deployer and the bootstrap sponsor,
 * and never against the facilitator's settlement signer — the one collision that would take
 * payments down.
 *
 * Two distinct hazards share this check, and separating them matters when deciding whether a
 * given pair may be merged:
 *
 * - **Across processes it is a nonce space.** viem's `nonceManager` serialises concurrent
 *   sends *within one process* — measured, including two `privateKeyToAccount` objects built
 *   from the same key, which land 8/8 where the unmanaged control lands 1/8. That is exactly
 *   why sharing a key with a *different* process is fatal: the facilitator is a separate Rust
 *   binary with no visibility into our counter, so both fill from
 *   `eth_getTransactionCount(pending)` and one of them loses.
 * - **Within one process it is a balance.** Merging two roles merges their funding, so
 *   exhausting one budget disarms the other. The revocation submitter keeps its sponsor and
 *   its relayer apart for this reason alone: an account that armed its own EntryPoint deposit
 *   needs no sponsor, and that path must keep working after a griefing run has spent the
 *   sponsored budget to zero.
 *
 * Roles with no configured address are skipped, so a caller can pass the whole cast and let
 * the operator's env decide which comparisons are live.
 */
export function assertFundedKeySeparation(roles: Record<string, Address | undefined>): void {
    const seen = new Map<string, string>();
    for (const [name, address] of Object.entries(roles)) {
        if (address === undefined) continue;
        const key = address.toLowerCase();
        const earlier = seen.get(key);
        if (earlier !== undefined) {
            throw new Error(
                `${earlier} and ${name} are the same account (${address}); ` +
                    "each funded role needs its own key",
            );
        }
        seen.set(key, name);
    }
}

/**
 * Which browser origins may drive the sponsor.
 *
 * Unlike {@link parseCorsAllowlist}, this one must accept a public HTTPS origin: the whole
 * point is that `app.mapae.io` can reach it. That makes the origin check weaker here than
 * it is for the submitter — a non-browser client omits `Origin` entirely and is never
 * policed by it — which is exactly why the origin list is *not* treated as access control
 * anywhere in this service. Authority comes from the signature inside the body; the budget
 * and the rate limiter bound the spend. This list only keeps a stray page in the operator's
 * browser from queueing work.
 *
 * `*` stays banned for the same reason as the submitter: this service fronts a funded key.
 */
export function parseBootstrapOrigins(
    value: string | undefined,
    fallback: string[],
    // The revocation submitter's public mode reuses this parser; the error messages must
    // name the env var the operator actually set, or a typo sends them to fix a variable
    // their service never reads.
    varName = "BOOTSTRAP_ALLOWED_ORIGINS",
): string[] {
    const raw = value?.trim();
    if (!raw) return fallback;
    const entries = raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    if (entries.length === 0) return fallback;

    return entries.map((entry) => {
        if (entry === "*") {
            throw new Error(`${varName} must not be '*' — this service fronts a funded key`);
        }
        let url: URL;
        try {
            url = new URL(entry);
        } catch {
            throw new Error(`${varName} entry is not a URL: ${entry}`);
        }
        if (!["http:", "https:"].includes(url.protocol)) {
            throw new Error(`${varName} entry must be HTTP(S): ${entry}`);
        }
        if (url.protocol === "http:" && !/^(127\.|localhost$|\[?::1\]?$)/.test(url.hostname)) {
            throw new Error(`${varName} entry must be HTTPS unless loopback: ${entry}`);
        }
        return url.origin;
    });
}

/**
 * A fixed-window counter, keyed by whatever the caller decides identifies a requester.
 *
 * Deliberately the crudest thing that works. The repo has no rate limiter at all today,
 * and the alternative to a crude one is none — which is how a service whose only real
 * bound is a daily budget gets that budget drained in a minute rather than a day. A fixed
 * window lets a burst straddle the boundary at up to 2x the limit; that is acceptable
 * because it is bounded, and because the daily budget is the guarantee, not this.
 */
export class FixedWindowLimiter {
    readonly #hits = new Map<string, {count: number; resetAt: number}>();

    constructor(
        private readonly limit: number,
        private readonly windowMs: number,
    ) {
        if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
        if (!Number.isInteger(windowMs) || windowMs < 1) {
            throw new Error("windowMs must be a positive integer");
        }
    }

    /** True when the caller may proceed. Consumes one unit when it returns true. */
    tryConsume(key: string, now: number): boolean {
        const entry = this.#hits.get(key);
        if (!entry || now >= entry.resetAt) {
            this.#hits.set(key, {count: 1, resetAt: now + this.windowMs});
            return true;
        }
        if (entry.count >= this.limit) return false;
        entry.count += 1;
        return true;
    }

    /** Drop expired windows so a stream of distinct keys cannot grow the map forever. */
    sweep(now: number): void {
        for (const [key, entry] of this.#hits) {
            if (now >= entry.resetAt) this.#hits.delete(key);
        }
    }

    get size(): number {
        return this.#hits.size;
    }
}

/**
 * Read an OP-Stack receipt fee field that viem hands us untyped.
 *
 * `giwaSepolia` is a plain `defineChain` with no `viem/op-stack` formatter, and viem's
 * default `formatTransactionReceipt` BigInt-converts only the fields it knows about
 * (blockNumber, gasUsed, effectiveGasPrice, …) and spreads everything else through raw.
 * GIWA sends `l1Fee` on every receipt — measured `'0xe0e42b2c9'` on this repo's own D5
 * settlement — so the value arrives as a hex *string* on the live chain and is absent
 * entirely under anvil. That difference is why no fork test could have caught the cast
 * this replaces.
 *
 * Absent means zero. Unreadable does not: charging zero for a transaction that mined is
 * precisely how a spend cap stops binding, so the caller is made to decide.
 */
export function readReceiptFeeField(value: unknown): bigint {
    if (value === undefined || value === null) return 0n;
    if (typeof value === "bigint") {
        if (value < 0n) throw new Error(`unreadable l1Fee: ${value}`);
        return value;
    }
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error(`unreadable l1Fee: ${value}`);
        return BigInt(value);
    }
    if (typeof value === "string" && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value.trim())) {
        return BigInt(value.trim());
    }
    throw new Error(`unreadable l1Fee: ${typeof value}`);
}

/**
 * What a mined transaction cost, including the OP-Stack L1 data fee.
 *
 * `l1Fee` is absent from the EVM's own accounting and omitting it understates the
 * sponsor's real spend by roughly 15%. It arrives as a hex string on GIWA (see
 * {@link readReceiptFeeField}) and not at all under anvil. When it cannot be read, fall
 * back to the caller's reservation rather than to zero: the transaction mined, and the
 * one answer that is certainly wrong is "free". Shared by both sponsor services so the
 * fee-shape lesson is encoded once.
 */
export function costOfReceipt(
    receipt: {gasUsed: bigint; effectiveGasPrice: bigint},
    fallback: bigint,
): bigint {
    try {
        return (
            receipt.gasUsed * receipt.effectiveGasPrice +
            readReceiptFeeField((receipt as {l1Fee?: unknown}).l1Fee)
        );
    } catch {
        return fallback;
    }
}

/**
 * The only bound that is a real guarantee rather than a speed bump.
 *
 * Per-account idempotency is not a budget: a counterfactual address is `CREATE2(owner)`
 * and an attacker mints owners offline for free, so "one deploy per account" permits
 * unlimited deploys. The daily wei ceiling is what makes the worst case a number the
 * operator chose, and `reserve`/`settle` exist as a pair so an in-flight broadcast counts
 * against the budget *before* it lands rather than after.
 */
export class SpendBudget {
    #spent = 0n;
    #reserved = 0n;
    #windowStart: number;

    constructor(
        private readonly dailyLimitWei: bigint,
        startedAt: number,
        private readonly windowMs = 86_400_000,
    ) {
        if (dailyLimitWei <= 0n) throw new Error("dailyLimitWei must be positive");
        this.#windowStart = startedAt;
    }

    #roll(now: number): void {
        if (now - this.#windowStart >= this.windowMs) {
            this.#windowStart = now;
            this.#spent = 0n;
        }
    }

    /** Hold `amount` against the budget, or refuse. Always paired with {@link settle}. */
    reserve(amount: bigint, now: number): boolean {
        this.#roll(now);
        if (this.#spent + this.#reserved + amount > this.dailyLimitWei) return false;
        this.#reserved += amount;
        return true;
    }

    /**
     * Release a reservation, charging what was actually spent.
     *
     * A failed broadcast charges `0n` only when nothing was mined. A *reverted*
     * transaction still cost gas and must be charged, or a griefer whose deploys always
     * revert pays nothing and spends everything.
     */
    settle(reserved: bigint, actual: bigint, now: number): void {
        // Validate, never cast — and here the cast was two files away. `charged` was built
        // from a receipt field typed as bigint that arrives as a hex string, and
        // `bigint + string` concatenates, so one settle turned `#spent` into a string.
        // After that `#spent + #reserved + amount > dailyLimitWei` compares a String
        // against a BigInt, StringToBigInt fails on the garbage, the comparison is always
        // false, and `reserve` accepts everything. The cap did not error; it just stopped
        // being a cap. This guard makes that failure loud at the one place the invariant
        // actually lives.
        if (typeof actual !== "bigint") {
            // Charge the reservation rather than nothing, release the hold so it is not
            // stranded for the rest of the window (`#roll` clears `#spent`, never
            // `#reserved`), and then be loud. A charge we cannot read is a charge we must
            // over-estimate, and a caller that produced one is a bug, not a request.
            this.#roll(now);
            this.#reserved -= reserved;
            if (this.#reserved < 0n) this.#reserved = 0n;
            this.#spent += reserved;
            throw new Error("settle requires a bigint charge");
        }
        this.#roll(now);
        this.#reserved -= reserved;
        if (this.#reserved < 0n) this.#reserved = 0n;
        this.#spent += actual;
    }

    spentToday(now: number): bigint {
        this.#roll(now);
        return this.#spent;
    }

    remaining(now: number): bigint {
        this.#roll(now);
        const left = this.dailyLimitWei - this.#spent - this.#reserved;
        return left > 0n ? left : 0n;
    }
}

/**
 * Accept a bootstrap request only if it proves the requester owns the account it asks us
 * to deploy.
 *
 * The load-bearing step is the fixed point at the end. The delegation hash covers
 * `delegator`; the owner is recovered *from* that hash; and the delegator is then required
 * to equal `CREATE2(recovered owner)`. An attacker who wants a free deployment must
 * produce a signature that recovers to an address whose counterfactual account is the
 * delegator they already committed to inside the signed message — which without the key is
 * a 2^160 search. Drop this comparison and any 65 random bytes recover *some* address, and
 * the service becomes a free deployment faucet.
 *
 * Note what is deliberately *not* checked. The policy shape — amount, period, expiry,
 * delegate — is the user's own choice made in the Studio form; pinning it here would mean
 * a user who wants a different limit cannot onboard. The sponsor is paying for an account
 * to exist, not underwriting the grant inside it, and the grant is bounded on chain by the
 * enforcers regardless.
 *
 * There is no signature check that can be skipped and deferred to simulation the way
 * {@link validateRevocationSubmission} defers to the EntryPoint's `AA24`. That function can
 * defer because the account is already deployed and ERC-1271 is reachable. Here the account
 * does not exist yet, so nothing on chain can answer the question — the offline recover is
 * not a convenience, it is the only authority available before we spend.
 */
export async function validateAccountBootstrap(
    input: unknown,
    policy: AccountBootstrapPolicy,
): Promise<ValidatedAccountBootstrap> {
    if (!input || typeof input !== "object") throw new Error("request must be an object");
    const request = input as {permissionContext?: unknown};

    const permissionContext = readPermissionContext(request.permissionContext);

    let chain: readonly Delegation[];
    try {
        chain = decodeDelegations(permissionContext);
    } catch (error) {
        throw new Error(
            `permissionContext is not a delegation chain: ${
                error instanceof Error ? error.message : "decode failed"
            }`,
        );
    }
    // Root only. A leaf carries `ANY_DELEGATE` and is bound to its redeemer by a single
    // enforcer, so it is close enough to a bearer value that this service has no business
    // receiving one — let alone logging it. Bootstrapping needs the root and nothing else.
    if (chain.length !== 1) {
        throw new Error("permissionContext must contain exactly one delegation (the root)");
    }
    const delegation = chain[0]!;

    if (!isAddress(delegation.delegate) || getAddress(delegation.delegate) === zeroAddress) {
        throw new Error("delegation delegate must be a non-zero address");
    }
    if (!isAddress(delegation.delegator)) {
        throw new Error("delegation delegator must be an address");
    }

    if (size(delegation.signature) !== 65) {
        throw new Error(
            "root signature must be a 65-byte ECDSA signature; this account has no authorized P256 keys",
        );
    }
    if (!isCanonicalSignature(delegation.signature)) {
        throw new Error(
            "root signature is not canonical (low-s, v in {27,28}); the account would reject it on chain",
        );
    }

    // Every caveat enforcer must belong to the deployment we pinned. An unknown enforcer
    // means the grant targets contracts outside our artifact, and paying to instantiate an
    // account for it is underwriting something we cannot reason about.
    const known = new Set(
        Object.values(policy.environment.caveatEnforcers).map((value) =>
            getAddress(value as Address),
        ),
    );
    for (const caveat of delegation.caveats) {
        if (!isAddress(caveat.enforcer) || !known.has(getAddress(caveat.enforcer))) {
            throw new Error(`caveat enforcer ${caveat.enforcer} is not part of this deployment`);
        }
    }

    // The domain pins `verifyingContract` to our DelegationManager, so a root signed for a
    // different manager recovers a different address here and fails the fixed point below.
    // That is why there is no separate "is this our manager" field to check.
    // Recovery itself can throw: `r`/`s` that pass the canonical range check may still not
    // describe a point on the curve, and viem surfaces that as "Point is not on curve".
    // Letting it escape would turn a garbage request into an internal error rather than a
    // refusal — and this service answers the public internet, where every response shape
    // has to be one the operator chose.
    let owner: Address;
    try {
        owner = await recoverTypedDataAddress({
            ...buildRootDelegationTypedData(policy.environment.DelegationManager, delegation),
            signature: delegation.signature,
        });
    } catch {
        throw new Error("root signature does not recover to any address");
    }

    const derived = await getCounterfactualAccountData({
        factory: getAddress(policy.environment.SimpleFactory),
        implementations: policy.environment.implementations,
        implementation: Implementation.Hybrid,
        // Literals, not request fields. Accepting `keyIds`/`x`/`y` would install a P256
        // co-signer on an account we paid for; accepting a salt would both break the link
        // to the signature and give one owner unlimited distinct accounts to fund.
        deployParams: [getAddress(owner), [], [], []],
        deploySalt: OWNER_ACCOUNT_SALT,
    });

    if (getAddress(derived.address) !== getAddress(delegation.delegator)) {
        throw new Error(
            "the root signer does not own the account named as delegator; refusing to sponsor",
        );
    }

    return {
        account: getAddress(derived.address),
        owner: getAddress(owner),
        salt: OWNER_ACCOUNT_SALT,
        factoryTarget: getAddress(policy.environment.SimpleFactory),
        factoryData: derived.factoryData,
        delegation,
    };
}
