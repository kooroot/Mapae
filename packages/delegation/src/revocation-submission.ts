import {DeleGatorCore} from "@metamask/smart-accounts-kit/contracts";
import {decodeDelegations, hashDelegation} from "@metamask/smart-accounts-kit/utils";
import type {Delegation} from "@metamask/smart-accounts-kit";
import {getAddress, isAddress, slice, hexToBigInt, type Address, type Hex} from "viem";
import type {PackedUserOperation} from "viem/account-abstraction";
import {giwaSepolia} from "@mapae/shared";

export const SPONSORED_REVOCATION_APPROVAL_PREFIX = "sponsored-revocation" as const;

/**
 * The approval phrase an operator must set before the submitter's sponsor mode will boot.
 *
 * Same shape as `buildSponsoredBootstrapApproval`, deliberately not the same phrase: the
 * two services spend differently (a deploy vs. an EntryPoint deposit that partially
 * refunds into the requester's account), so approving one must never arm the other.
 * Pinned to the composition because a framework redeploy changes which EntryPoint the
 * sponsor would be depositing into.
 */
export function buildSponsoredRevocationApproval(compositionId: string): string {
    return `${SPONSORED_REVOCATION_APPROVAL_PREFIX}-chain-${giwaSepolia.id}-${compositionId}`;
}

/**
 * The operator's boundary on what a submitter will put its own gas behind.
 *
 * `handleOps` is permissionless and the relayer pays the transaction up front, so a
 * service that forwards whatever it is handed is a general-purpose UserOperation relay
 * funded by someone else's key. Every field here narrows it back to one operation on
 * one account.
 */
export interface RevocationSubmissionPolicy {
    /**
     * When set, the only `sender` this submitter acts for — the loopback single-payer
     * deployment. When absent, any account may submit a revocation *of its own grant*:
     * the root-delegator == sender check below still pins the operation to the sender's
     * own permission, and the account's ERC-1271 still decides who may sign it. The pin
     * is an operator's narrowing, not the security boundary.
     */
    payer?: Address;
    maxCallGasLimit: bigint;
    maxVerificationGasLimit: bigint;
    maxPreVerificationGas: bigint;
    maxFeePerGas: bigint;
    /**
     * The lowest `maxFeePerGas` this submitter will carry. Unset means no floor.
     *
     * A ceiling alone does not protect the relayer, and the base fee is not a floor.
     * The EntryPoint reimburses the beneficiary at `min(maxFeePerGas, tip + baseFee)` per
     * gas while the relayer's own transaction is priced at `baseFee + suggested tip` —
     * and on GIWA those differ by three orders of magnitude (measured: base fee 267 wei,
     * suggested tip 1,000,000 wei). An operation signed just above the base fee therefore
     * passes `fee_below_basefee` and reimburses a fraction of what the relayer paid.
     *
     * The daily budget does not catch it either: a low fee means a small `requiredPrefund`,
     * so the cheaper the attack the less the one bound that exists bounds it. That is why
     * the floor lives here, on the operation, rather than being left to the spend cap.
     *
     * Set for the sponsored public mode, left unset for the pinned loopback one — there
     * the only caller is the operator's own console, and the operator is the party who
     * would be under-reimbursing themselves.
     */
    minFeePerGas?: bigint;
}

export interface ValidatedRevocationSubmission {
    /** Exactly the struct that was signed, ready for `handleOps([packed], beneficiary)`. */
    packed: PackedUserOperation;
    sender: Address;
    /** The root permission — the only link whose delegator is the payer account. */
    delegation: Delegation;
    delegationHash: Hex;
    /** Unpacked back out of the two `bytes32` words, so the caller never re-derives them. */
    gas: {
        callGasLimit: bigint;
        verificationGasLimit: bigint;
        preVerificationGas: bigint;
        maxFeePerGas: bigint;
        maxPriorityFeePerGas: bigint;
    };
    /** `EntryPoint.sol` `_getRequiredPrefund`, recomputed from the submitted bytes. */
    requiredPrefund: bigint;
}

/**
 * Ceiling on any single hex field.
 *
 * A permission context with the D3 caveat set is ~2 kB; `disableDelegation` calldata is
 * that plus a selector and offsets. 20,000 characters is roughly five times the largest
 * legitimate value and still small enough that a decode attempt is cheap.
 */
const MAX_HEX_CHARACTERS = 20_000;

const UINT_STRING = /^(0|[1-9]\d*)$/;

function readHex(value: unknown, field: string): Hex {
    if (typeof value !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(value)) {
        throw new Error(`${field} must be 0x-prefixed hex of whole bytes`);
    }
    if (value.length > MAX_HEX_CHARACTERS) throw new Error(`${field} is too large`);
    return value as Hex;
}

function readBytes32(value: unknown, field: string): Hex {
    const hex = readHex(value, field);
    if (hex.length !== 66) throw new Error(`${field} must be exactly 32 bytes`);
    return hex;
}

function readUint(value: unknown, field: string): bigint {
    if (typeof value !== "string" || !UINT_STRING.test(value)) {
        throw new Error(`${field} must be an unsigned integer string`);
    }
    return BigInt(value);
}

function cap(value: bigint, limit: bigint, field: string): void {
    if (value > limit) throw new Error(`${field} ${value} exceeds the configured cap ${limit}`);
}

/** The `POST /revoke` wire body. Integers are decimal strings — JSON has no bigint. */
export interface RevocationSubmissionBody {
    permissionContext: Hex;
    userOperation: {
        sender: Address;
        nonce: string;
        initCode: Hex;
        callData: Hex;
        accountGasLimits: Hex;
        preVerificationGas: string;
        gasFees: Hex;
        paymasterAndData: Hex;
        signature: Hex;
    };
}

/**
 * Serialise a signed revocation for the submitter.
 *
 * Lives beside {@link validateRevocationSubmission} on purpose: the encoder and the decoder
 * of a wire format drifting apart is exactly the failure this repo has already paid for
 * once with the EIP-712 domain. `revocation-submission.test.ts` asserts the round trip
 * reproduces the signed struct byte for byte, so a field renamed on one side fails a unit
 * test rather than becoming an `AA24` nobody can place.
 */
export function buildRevocationSubmissionBody(params: {
    permissionContext: Hex;
    packed: PackedUserOperation;
}): RevocationSubmissionBody {
    const {packed} = params;
    return {
        permissionContext: params.permissionContext,
        userOperation: {
            sender: getAddress(packed.sender),
            nonce: packed.nonce.toString(),
            initCode: packed.initCode,
            callData: packed.callData,
            accountGasLimits: packed.accountGasLimits,
            preVerificationGas: packed.preVerificationGas.toString(),
            gasFees: packed.gasFees,
            paymasterAndData: packed.paymasterAndData,
            signature: packed.signature,
        },
    };
}

/**
 * Why a submitter declined before spending anything.
 *
 * Each of these is knowable from two reads and would otherwise surface as an opaque
 * `AA21` or a silently unprofitable broadcast. The owner is trying to revoke — the one
 * operation where a useless error message is most expensive.
 */
export type RevocationSubmissionRefusal =
    | {reason: "prefund_short"; deposit: bigint; requiredPrefund: bigint; shortfall: bigint}
    | {reason: "base_fee_unreadable"; maxFeePerGas: bigint}
    | {reason: "fee_below_basefee"; maxFeePerGas: bigint; baseFeePerGas: bigint}
    | {reason: "relayer_unfunded"; relayerBalance: bigint; needed: bigint};

/**
 * Decide whether a validated submission can actually be carried, given live chain state.
 *
 * Separate from broadcasting so the three conditions are testable without a chain, and
 * ordered by what the owner is most likely to hit. `prefund_short` comes first because
 * the payer holds zero ETH by design: the deposit is the only thing that ever pays, and
 * an unarmed kill switch is the default state, not an anomaly.
 *
 * `fee_below_basefee` is not pedantry. The EntryPoint reimburses at
 * `min(maxFeePerGas, baseFee + maxPriorityFeePerGas)` while the relayer's own transaction
 * cannot be included below `baseFee`. When the signed `maxFeePerGas` sits under the
 * current base fee the relayer pays more than it can ever recover — a broadcast that
 * succeeds on chain and quietly drains the operator.
 *
 * `baseFeePerGas` is deliberately nullable here. viem types a block's base fee as
 * `bigint | null`, and the caller used to substitute `0n` for the missing case — which
 * turns `maxFeePerGas < baseFeePerGas` into `x < 0n`, false for every input, silently
 * disabling the very guard described above. A base fee we could not read is not a base fee
 * of zero; it is a question we cannot answer, and answering it "fine" is how the operator
 * gets drained by the check that was supposed to prevent it.
 */
export function judgeSubmissionReadiness(params: {
    deposit: bigint;
    requiredPrefund: bigint;
    baseFeePerGas: bigint | undefined;
    maxFeePerGas: bigint;
    relayerBalance: bigint;
}): {ok: true} | {ok: false; refusal: RevocationSubmissionRefusal} {
    if (params.deposit < params.requiredPrefund) {
        return {
            ok: false,
            refusal: {
                reason: "prefund_short",
                deposit: params.deposit,
                requiredPrefund: params.requiredPrefund,
                shortfall: params.requiredPrefund - params.deposit,
            },
        };
    }
    if (params.baseFeePerGas === undefined) {
        return {
            ok: false,
            refusal: {reason: "base_fee_unreadable", maxFeePerGas: params.maxFeePerGas},
        };
    }
    if (params.maxFeePerGas < params.baseFeePerGas) {
        return {
            ok: false,
            refusal: {
                reason: "fee_below_basefee",
                maxFeePerGas: params.maxFeePerGas,
                baseFeePerGas: params.baseFeePerGas,
            },
        };
    }
    if (params.relayerBalance < params.requiredPrefund) {
        return {
            ok: false,
            refusal: {
                reason: "relayer_unfunded",
                relayerBalance: params.relayerBalance,
                needed: params.requiredPrefund,
            },
        };
    }
    return {ok: true};
}

/**
 * Accept a signed UserOperation only if it is a revocation of the payer's own permission.
 *
 * The `callData` check is a re-encode equality, not a decode. Decoding would accept any
 * calldata whose prefix happens to parse — trailing bytes, a different overload, an
 * argument the ABI decoder tolerates — and the whole point of this function is that the
 * bytes the EntryPoint executes are byte-for-byte the ones this repo would have built.
 *
 * The *signature* is deliberately not checked here. The account is a `HybridDeleGator`
 * and validates through ERC-1271, so an offline check would either need a chain read or
 * would be an `ecrecover` that silently disagrees with the account. The EntryPoint's own
 * `AA24` is the authority, reached through simulation before anything is broadcast.
 */
export function validateRevocationSubmission(
    input: unknown,
    policy: RevocationSubmissionPolicy,
): ValidatedRevocationSubmission {
    if (!input || typeof input !== "object") throw new Error("request must be an object");
    const request = input as {permissionContext?: unknown; userOperation?: unknown};

    const permissionContext = readHex(request.permissionContext, "permissionContext");
    let chain: readonly Delegation[];
    try {
        chain = decodeDelegations(permissionContext);
    } catch (error) {
        throw new Error(
            `permissionContext is not a delegation chain: ${error instanceof Error ? error.message : "decode failed"}`,
        );
    }
    // Leaf-first, root-last. Only the root is delegated *by* the payer account, so it is
    // the only link the payer can disable — an intermediate link was delegated by the
    // agent and `DelegationManager` would reject the payer as its delegator.
    const delegation = chain.at(-1);
    if (!delegation) throw new Error("permissionContext contains no delegations");

    if (!request.userOperation || typeof request.userOperation !== "object") {
        throw new Error("userOperation must be an object");
    }
    const op = request.userOperation as Record<string, unknown>;

    if (typeof op["sender"] !== "string" || !isAddress(op["sender"])) {
        throw new Error("userOperation.sender must be an address");
    }
    const sender = getAddress(op["sender"]);
    if (policy.payer !== undefined && sender !== getAddress(policy.payer)) {
        throw new Error("userOperation.sender is not the account this submitter serves");
    }
    if (getAddress(delegation.delegator) !== sender) {
        throw new Error("the root permission was not granted by the sender account");
    }

    // A non-empty initCode would have our relayer pay to deploy an account; a paymaster
    // would route validation through a contract we did not choose. Neither has any part
    // in revoking a permission on an account that is already deployed.
    const initCode = readHex(op["initCode"], "userOperation.initCode");
    if (initCode !== "0x") throw new Error("userOperation.initCode must be empty");
    const paymasterAndData = readHex(op["paymasterAndData"], "userOperation.paymasterAndData");
    if (paymasterAndData !== "0x") throw new Error("userOperation.paymasterAndData must be empty");

    const callData = readHex(op["callData"], "userOperation.callData");
    const expected = DeleGatorCore.encode.disableDelegation({delegation});
    if (callData.toLowerCase() !== expected.toLowerCase()) {
        throw new Error("userOperation.callData is not disableDelegation for this permission");
    }

    const accountGasLimits = readBytes32(op["accountGasLimits"], "userOperation.accountGasLimits");
    const gasFees = readBytes32(op["gasFees"], "userOperation.gasFees");
    // Packing order is fixed by `toPackedUserOperation`: verification high / call low,
    // priority high / max low. `revocation.test.ts` pins it with unequal values so a
    // swap cannot pass unnoticed.
    const verificationGasLimit = hexToBigInt(slice(accountGasLimits, 0, 16));
    const callGasLimit = hexToBigInt(slice(accountGasLimits, 16, 32));
    const maxPriorityFeePerGas = hexToBigInt(slice(gasFees, 0, 16));
    const maxFeePerGas = hexToBigInt(slice(gasFees, 16, 32));
    const preVerificationGas = readUint(op["preVerificationGas"], "userOperation.preVerificationGas");

    cap(callGasLimit, policy.maxCallGasLimit, "callGasLimit");
    cap(verificationGasLimit, policy.maxVerificationGasLimit, "verificationGasLimit");
    cap(preVerificationGas, policy.maxPreVerificationGas, "preVerificationGas");
    cap(maxFeePerGas, policy.maxFeePerGas, "maxFeePerGas");
    if (maxPriorityFeePerGas > maxFeePerGas) {
        throw new Error("maxPriorityFeePerGas must not exceed maxFeePerGas");
    }
    // Mirrors `buildRevocationUserOperation`. A zero-fee operation has requiredPrefund 0,
    // which turns the EntryPoint's prefund check into dead code and lets an unfunded
    // account revoke on the relayer's gas with no reimbursement.
    if (maxFeePerGas === 0n) throw new Error("maxFeePerGas must be non-zero");
    // Non-zero is not the same as enough — see `minFeePerGas`.
    if (policy.minFeePerGas !== undefined && maxFeePerGas < policy.minFeePerGas) {
        throw new Error(
            `maxFeePerGas ${maxFeePerGas} is below the required ${policy.minFeePerGas}; ` +
                "the relayer cannot recover what it fronts at that price",
        );
    }

    const nonce = readUint(op["nonce"], "userOperation.nonce");
    const signature = readHex(op["signature"], "userOperation.signature");
    // "0x" is the unsigned sentinel `buildRevocationUserOperation` emits. Forwarding it
    // would burn a simulation to learn what is knowable here.
    if (signature === "0x") throw new Error("userOperation.signature is empty");

    return {
        packed: {
            sender,
            nonce,
            initCode,
            callData,
            accountGasLimits,
            preVerificationGas,
            gasFees,
            paymasterAndData,
            signature,
        },
        sender,
        delegation,
        delegationHash: hashDelegation(delegation),
        gas: {
            callGasLimit,
            verificationGasLimit,
            preVerificationGas,
            maxFeePerGas,
            maxPriorityFeePerGas,
        },
        requiredPrefund: (verificationGasLimit + callGasLimit + preVerificationGas) * maxFeePerGas,
    };
}

/**
 * Which browser origins may reach this submitter, and how the answer is spelled.
 *
 * The console talks to the submitter cross-origin — Vite serves `127.0.0.1:5173`, the
 * submitter listens on `127.0.0.1:8082`, and a different port is a different origin. The
 * revoke request sends `content-type: application/json`, which is not a CORS-safelisted
 * value, so the browser *must* send a preflight first. A submitter with no CORS answer
 * fails that preflight, the POST is never sent, and the owner's signature is discarded
 * before it reaches the network. The button looks alive and does nothing.
 *
 * This is why the policy is code rather than a middleware default: the two obvious
 * defaults are both wrong here.
 *
 * **Not `*`.** The submitter has no application authentication and fronts a funded
 * relayer key. A wildcard lets any page the operator happens to have open POST to it.
 * `validateRevocationSubmission` still refuses anything that is not an owner-signed
 * operation on the one account, so this is not a forgery route — but it is a free
 * replay-and-burn-gas route, and the origin check is the cheap place to close it.
 *
 * **Not credentialed.** No cookie or `Authorization` header is involved; authority
 * travels in the signature inside the body. `Access-Control-Allow-Credentials` is
 * therefore never set, which also keeps the wildcard ban from being load-bearing twice.
 */
export interface CorsPolicy {
    /** Exact origins, already normalised. Compared verbatim — no substring, no suffix. */
    allowedOrigins: string[];
}

export type CorsDecision =
    | {allowed: false}
    | {allowed: true; headers: Record<string, string>};

/**
 * Answer one request's `Origin`.
 *
 * A request with no `Origin` at all is allowed through without CORS headers: that is a
 * same-origin fetch or a non-browser client (curl, the e2e runner), neither of which the
 * browser will police. Returning `allowed: true` with no headers keeps those callers
 * working exactly as before this existed.
 *
 * `Vary: Origin` is not decoration. The response differs by origin, and without it any
 * cache in front of the submitter can serve one origin's allow header to another.
 */
export function judgeCorsRequest(
    origin: string | undefined,
    policy: CorsPolicy,
    preflight = false,
): CorsDecision {
    if (origin === undefined || origin === "") return {allowed: true, headers: {}};
    if (!policy.allowedOrigins.includes(origin)) return {allowed: false};

    const headers: Record<string, string> = {
        "Access-Control-Allow-Origin": origin,
        Vary: "Origin",
    };
    if (preflight) {
        headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
        headers["Access-Control-Allow-Headers"] = "content-type";
        // Ten minutes. Long enough that a retry loop does not re-preflight every attempt,
        // short enough that tightening the allowlist takes effect within one coffee.
        headers["Access-Control-Max-Age"] = "600";
    }
    return {allowed: true, headers};
}

/**
 * Parse the operator's allowlist, refusing anything that would widen the blast radius.
 *
 * Loopback-only, for the same reason `configuredSubmitterUrl` is loopback-only on the
 * console side: this service holds a funded key and has no authentication, so the answer
 * to "who may drive it from a browser" has to stay on the machine until a TLS reverse
 * proxy with real auth is in front of it.
 *
 * An origin is scheme + host + port and nothing else. `new URL().origin` normalises that
 * for us, which also means a value with a path or a trailing slash is accepted and
 * silently reduced to its origin — the comparison in `judgeCorsRequest` is verbatim, so
 * normalising here is what keeps a trailing slash from quietly disabling the allowlist.
 */
export function parseCorsAllowlist(
    value: string | undefined,
    isLoopback: (hostname: string) => boolean,
    fallback: string[],
): string[] {
    const raw = value?.trim();
    if (!raw) return fallback;
    const origins = raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    if (origins.length === 0) return fallback;

    return origins.map((entry) => {
        if (entry === "*") {
            throw new Error(
                "REVOCATION_CONSOLE_ORIGINS must not be '*' — this submitter fronts a funded relayer key",
            );
        }
        let url: URL;
        try {
            url = new URL(entry);
        } catch {
            throw new Error(`REVOCATION_CONSOLE_ORIGINS entry is not a URL: ${entry}`);
        }
        if (!["http:", "https:"].includes(url.protocol)) {
            throw new Error(`REVOCATION_CONSOLE_ORIGINS entry must be HTTP(S): ${entry}`);
        }
        if (!isLoopback(url.hostname)) {
            throw new Error(
                `REVOCATION_CONSOLE_ORIGINS must be loopback, got "${url.hostname}" — ` +
                    "put a TLS reverse proxy with real authentication in front before this is reachable remotely",
            );
        }
        return url.origin;
    });
}
