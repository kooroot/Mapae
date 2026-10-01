import {describe, expect, test} from "bun:test";
import {openArcadeStore} from "./arcade.js";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
const intent = `0x${"ab".repeat(32)}`;
describe("arcade admission persistence", () => {
    test("one request binds one game, one intent and one run", () => {
        const store = openArcadeStore(":memory:");
        try {
            const request = crypto.randomUUID();
            const first = store.reserve(request, "stamp");
            expect(first.created).toBe(true);
            expect(store.reserve(request, "stamp").created).toBe(false);
            expect(() => store.reserve(request, "race")).toThrow("request_conflict");
            store.bindIntent(first.admission.id, intent);
            expect(() => store.bindIntent(first.admission.id, `0x${"cd".repeat(32)}`)).toThrow("intent_conflict");
            store.ready(first.admission.id, intent);
            const run = crypto.randomUUID();
            expect(store.consume(first.admission.id, run).status).toBe("consumed");
            expect(store.consume(first.admission.id, run).runId).toBe(run);
            expect(() => store.consume(first.admission.id, crypto.randomUUID())).toThrow("ticket_already_consumed");
            expect(store.ready(first.admission.id, intent).status).toBe("consumed");
        } finally {store.close();}
    });
    test("pending and unknown settlements forbid another charge or admission", () => {
        const store = openArcadeStore(":memory:");
        try {
            const first = store.reserve(crypto.randomUUID(), "race").admission;
            expect(() => store.reserve(crypto.randomUUID(), "shop")).toThrow("unresolved_payment");
            expect(() => store.consume(first.id, crypto.randomUUID())).toThrow("ticket_not_ready");
            store.fail(first.id, "unknown", "SETTLEMENT_UNKNOWN");
            expect(() => store.reserve(crypto.randomUUID(), "shop")).toThrow("unresolved_payment");
        } finally {store.close();}
    });
    test("definite refusal releases the gate", () => {
        const store = openArcadeStore(":memory:");
        try {
            const first = store.reserve(crypto.randomUUID(), "race").admission;
            store.fail(first.id, "rejected", "LIMIT_EXCEEDED");
            expect(store.reserve(crypto.randomUUID(), "shop").created).toBe(true);
        } finally {store.close();}
    });
    test("a run cannot consume two separately paid tickets", () => {
        const store = openArcadeStore(":memory:");
        try {
            const a = store.reserve(crypto.randomUUID(), "race").admission;
            store.bindIntent(a.id, intent); store.ready(a.id, intent);
            const run = crypto.randomUUID(); store.consume(a.id, run);
            const b = store.reserve(crypto.randomUUID(), "race").admission;
            const second = `0x${"cd".repeat(32)}`;
            store.bindIntent(b.id, second); store.ready(b.id, second);
            expect(() => store.consume(b.id, run)).toThrow("run_conflict");
            expect(store.get(b.id)?.status).toBe("ready");
        } finally {store.close();}
    });
    test("daily model calls stop atomically at the configured ceiling", () => {
        const store = openArcadeStore(":memory:");
        try {
            expect(store.reserveModelCall("2026-09-30", 2)).toBe(true);
            expect(store.reserveModelCall("2026-09-30", 2)).toBe(true);
            expect(store.reserveModelCall("2026-09-30", 2)).toBe(false);
            expect(store.modelCalls("2026-09-30")).toBe(2);
            expect(store.reserveModelCall("2026-10-01", 2)).toBe(true);
            expect(() => store.reserveModelCall("today", 2)).toThrow();
        } finally {store.close();}
    });
    test("external ids and game values are validated", () => {
        const store = openArcadeStore(":memory:");
        try {
            expect(() => store.reserve("invalid", "race")).toThrow("invalid_id");
            expect(() => store.reserve(crypto.randomUUID(), "bad" as "race")).toThrow("invalid_game");
        } finally {store.close();}
    });
    test("consumed tickets and model reservations survive closing and reopening SQLite", () => {
        const dir = mkdtempSync(join(tmpdir(), "mapae-arcade-store-"));
        const path = join(dir, "state.sqlite");
        const request = crypto.randomUUID(), run = crypto.randomUUID();
        let store = openArcadeStore(path);
        try {
            const a = store.reserve(request, "race").admission;
            store.bindIntent(a.id, intent); store.ready(a.id, intent); store.consume(a.id, run);
            store.reserveModelCall("2026-09-30", 1);
            store.close(); store = openArcadeStore(path);
            expect(store.reserve(request, "race").admission.runId).toBe(run);
            expect(() => store.consume(a.id, crypto.randomUUID())).toThrow("ticket_already_consumed");
            expect(store.reserveModelCall("2026-09-30", 1)).toBe(false);
        } finally {store.close(); rmSync(dir, {recursive: true, force: true});}
    });
});
