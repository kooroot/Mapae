/**
 * The admin-state decision of the operational verifier, on its own. The verifier itself
 * cannot run without the pinned runtime bytecode behind a live RPC, so the one decision
 * that has a consumer reading its wording — the facilitator's `/health` classifier —
 * is a pure function proven here.
 */
import {describe, expect, test} from "bun:test";
import {getAddress} from "viem";
import {assertFrameworkAdminActive} from "./live-verifier.js";

const ADMIN = getAddress("0x1000000000000000000000000000000000000001");
const STRANGER = getAddress("0x1000000000000000000000000000000000000002");
const ACTIVE = {owner: ADMIN, pendingOwner: null, paused: false};

describe("assertFrameworkAdminActive", () => {
    test("the expected owner, nothing pending, not paused is active", () => {
        expect(() => assertFrameworkAdminActive(ACTIVE, ADMIN)).not.toThrow();
    });

    test("each condition fails with its own wording, so /health can name it", () => {
        expect(() => assertFrameworkAdminActive({...ACTIVE, paused: true}, ADMIN)).toThrow(
            "DelegationManager is paused",
        );
        expect(() => assertFrameworkAdminActive({...ACTIVE, owner: STRANGER}, ADMIN)).toThrow(
            "DelegationManager owner mismatch",
        );
        expect(() => assertFrameworkAdminActive({...ACTIVE, pendingOwner: STRANGER}, ADMIN)).toThrow(
            "DelegationManager pending owner mismatch",
        );
    });

    test("a pause is reported before the owner, and the owner before a pending one", () => {
        // The pause is the switch an operator pulled on purpose; it must not be hidden
        // behind an ownership handover that happens to be in flight at the same time.
        expect(() =>
            assertFrameworkAdminActive({owner: STRANGER, pendingOwner: STRANGER, paused: true}, ADMIN),
        ).toThrow("DelegationManager is paused");
        expect(() =>
            assertFrameworkAdminActive({owner: STRANGER, pendingOwner: STRANGER, paused: false}, ADMIN),
        ).toThrow("DelegationManager owner mismatch");
    });

    test("the single message the three used to share is gone", () => {
        for (const live of [
            {...ACTIVE, paused: true},
            {...ACTIVE, owner: STRANGER},
            {...ACTIVE, pendingOwner: STRANGER},
        ]) {
            expect(() => assertFrameworkAdminActive(live, ADMIN)).not.toThrow("not operationally active");
        }
    });
});
