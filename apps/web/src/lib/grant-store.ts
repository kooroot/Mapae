import {getAddress} from "viem";
import {decodeDelegations} from "@metamask/smart-accounts-kit/utils";
import {DELEGATION_FRAMEWORK_VERSION} from "@mapae/delegation/config";
import {giwaSepolia} from "@mapae/shared";
import type {SessionGrant} from "./grant";
import {parsePermissionContext} from "./permission";

/**
 * The Studio grant list, kept across reloads.
 *
 * **Why this exists.** A root delegation is signed offline and never broadcast — the
 * `DelegationManager` stores nothing per delegation until it is disabled, and the
 * `RedeemedDelegation` log that carries the whole struct is only written at the first
 * payment. So a freshly created agent exists in exactly one place: this tab. Before this
 * module, a reload destroyed it permanently — not "lost from the list", but gone: the
 * permission context is the only copy of the Delegation struct, and `disableDelegation`
 * takes that struct, so the owner also lost the kill switch.
 *
 * **What is stored, and the reason for the line.** Four fields, never more. The permission
 * context is safe to keep because it is not a bearer spend instrument — `redeemDelegations`
 * requires `msg.sender` to be the named delegate, and `validateGrantDraft` structurally
 * refuses `ANY_DELEGATE` as a root delegate — so a stolen context buys disclosure of a
 * scope that the first settlement publishes on chain anyway.
 *
 * `agentKey` is the opposite and is excluded. It is a raw secp256k1 private key, the single
 * field whose theft converts into spend, and persisting it *beside* the context is worse
 * than leaking either alone: one read would yield a complete, immediately redeemable pair.
 * The browser also has no use for it after the bundle is copied — a durable secret with no
 * consumer is an unnecessary secret. The MCP bundle export remains its one exit.
 *
 * The projection is therefore an explicit allowlist, not `delete copy.agentKey`. An
 * allowlist fails closed: a field added to `SessionGrant` tomorrow is simply not written.
 * A blocklist fails open, and would persist it silently. `grant-store.test.ts` asserts a
 * known private key never appears in the output, so widening this shape fails a test.
 */
export const STORAGE_KEY = "mapae.grants.v1";

/**
 * Version lives in the key and there is no migration reader, ever. A shape change takes a
 * new key and abandons the old one, which is affordable because this is a local convenience
 * and not a system of record — the chain is.
 */
interface PersistedGrant {
    name: string;
    source: "signed" | "imported";
    createdAt: number;
    permissionContext: `0x${string}`;
}

/** The same bound `validateGrantDraft` puts on an agent name. */
const MAX_NAME = 40;

/** Enough for any plausible library; a corrupted or hostile document cannot grow unbounded. */
const MAX_GRANTS = 50;

export function serializeGrants(grants: SessionGrant[]): string {
    const records: PersistedGrant[] = grants.slice(0, MAX_GRANTS).map((grant) => ({
        name: grant.name,
        source: grant.source,
        createdAt: grant.artifact.createdAt,
        permissionContext: grant.artifact.permissionContext,
    }));
    return JSON.stringify(records);
}

/**
 * Validate, never cast. This value is script- and user-editable and flows into the revoke
 * path, so every field is checked and a bad record is dropped individually rather than
 * taking its siblings with it. A whole-document failure returns an empty list rather than
 * throwing: this runs during a React effect with no boundary above it.
 *
 * Deliberately *not* re-running `verifyPermissionArtifact` here. It was verified when the
 * grant entered the list, and re-verifying would cost an ERC-1271 call per grant on every
 * page load. A forged entry buys nothing — reading is harmless, revoking still needs the
 * owner's signature, and paying still needs the delegate's key. `readDelegationStatus` on
 * the detail screen remains the authority.
 */
export function parseStoredGrants(raw: string | null): SessionGrant[] {
    if (!raw) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];

    const grants: SessionGrant[] = [];
    for (const record of parsed.slice(0, MAX_GRANTS)) {
        const grant = restoreGrant(record);
        if (grant) grants.push(grant);
    }
    return grants;
}

function restoreGrant(record: unknown): SessionGrant | undefined {
    if (typeof record !== "object" || record === null) return undefined;
    const {name, source, createdAt, permissionContext} = record as Record<string, unknown>;

    if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME) return undefined;
    if (source !== "signed" && source !== "imported") return undefined;
    if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || createdAt < 0) {
        return undefined;
    }
    if (typeof permissionContext !== "string") return undefined;

    const parsed = parsePermissionContext(permissionContext);
    if (parsed.kind !== "ok") return undefined;

    const links = decodeDelegations(parsed.context);
    const leaf = links[0];
    if (!leaf) return undefined;

    return {
        // Recomputed with the same expression the other constructors use, so React keys
        // stay stable across a reload.
        id: `${createdAt}:${getAddress(leaf.delegate)}:${parsed.context.slice(-18)}`,
        name,
        source,
        artifact: {
            frameworkVersion: DELEGATION_FRAMEWORK_VERSION,
            chainId: giwaSepolia.id,
            role: source === "signed" ? "open-agent" : "imported",
            delegator: getAddress(parsed.root.delegator),
            delegate: getAddress(leaf.delegate),
            permissionContext: parsed.context,
            createdAt,
        },
        // The cap, period, expiry and recipient are packed inside the context and are read
        // from the chain on the detail screen. Storing a second copy would be a second
        // source of truth that can disagree with the one that matters — a card that lies
        // about the cap is worse than a card that says "read from chain".
    };
}

/**
 * Every mutation is a read-modify-write of the document rather than a whole-list overwrite,
 * so two open tabs cannot clobber each other's grants. Writes are guarded because Safari's
 * private mode throws `QuotaExceededError`, and a failed persist must never break the live
 * session — the in-memory list is still correct for this tab.
 */
function readDocument(): SessionGrant[] {
    try {
        return parseStoredGrants(window.localStorage.getItem(STORAGE_KEY));
    } catch {
        return [];
    }
}

function writeDocument(grants: SessionGrant[]): void {
    try {
        window.localStorage.setItem(STORAGE_KEY, serializeGrants(grants));
    } catch {
        // Storage is unavailable or full. The session continues from memory.
    }
}

export function loadGrants(): SessionGrant[] {
    return readDocument();
}

/** Newest first, deduped on the context — the same identity `addGrant` used in Studio. */
export function appendGrant(grant: SessionGrant): SessionGrant[] {
    const rest = readDocument().filter(
        (item) => item.artifact.permissionContext !== grant.artifact.permissionContext,
    );
    const next = [grant, ...rest];
    writeDocument(next);
    return next;
}

export function forgetGrant(permissionContext: `0x${string}`): SessionGrant[] {
    const next = readDocument().filter(
        (item) => item.artifact.permissionContext !== permissionContext,
    );
    writeDocument(next);
    return next;
}
