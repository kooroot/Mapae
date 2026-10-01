import {Database} from "bun:sqlite";
import {mkdirSync} from "node:fs";
import {dirname} from "node:path";

export type ArcadeGame = "stamp" | "race" | "shop";
export type Admission = {
    id: string; requestId: string; game: ArcadeGame;
    status: "pending" | "unknown" | "rejected" | "ready" | "consumed";
    intent: string | null; runId: string | null; error: string | null; createdAt: number;
};
export class AdmissionError extends Error {
    constructor(readonly code: string) {super(code);}
}
const uuid = (value: string) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new AdmissionError("invalid_id");
    return value.toLowerCase();
};
const hash = (value: string) => {
    if (!/^0x[0-9a-f]{64}$/i.test(value)) throw new AdmissionError("invalid_intent");
    return value.toLowerCase();
};

/** Admission state is deliberately separate from the existing financial journal's schema. */
export function openArcadeStore(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), {recursive: true});
    const db = new Database(path, {create: true, strict: true});
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
    db.exec(`CREATE TABLE IF NOT EXISTS arcade_admissions (
        id TEXT PRIMARY KEY, requestId TEXT UNIQUE NOT NULL, game TEXT NOT NULL,
        status TEXT NOT NULL, intent TEXT UNIQUE, runId TEXT UNIQUE, error TEXT, createdAt INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS arcade_model_calls (day TEXT PRIMARY KEY, calls INTEGER NOT NULL)`);
    const byRequest = db.query<Admission, [string]>("SELECT * FROM arcade_admissions WHERE requestId=?");
    const byId = db.query<Admission, [string]>("SELECT * FROM arcade_admissions WHERE id=?");
    const reserve = db.transaction((requestId: string, game: ArcadeGame) => {
        uuid(requestId);
        if (!["stamp", "race", "shop"].includes(game)) throw new AdmissionError("invalid_game");
        const existing = byRequest.get(requestId);
        if (existing) {
            if (existing.game !== game) throw new AdmissionError("request_conflict");
            return {admission: existing, created: false};
        }
        if (db.query("SELECT id FROM arcade_admissions WHERE status IN ('pending','unknown') LIMIT 1").get()) {
            throw new AdmissionError("unresolved_payment");
        }
        const id = crypto.randomUUID();
        db.query("INSERT INTO arcade_admissions VALUES(?,?,?,'pending',NULL,NULL,NULL,?)")
            .run(id, requestId, game, Date.now());
        return {admission: byId.get(id)!, created: true};
    });
    const consume = db.transaction((id: string, runId: string) => {
        const ticket = byId.get(uuid(id));
        uuid(runId);
        if (!ticket) throw new AdmissionError("ticket_not_found");
        if (ticket.status === "consumed") {
            if (ticket.runId !== runId) throw new AdmissionError("ticket_already_consumed");
            return ticket;
        }
        if (ticket.status !== "ready") throw new AdmissionError("ticket_not_ready");
        if (db.query("SELECT id FROM arcade_admissions WHERE runId=?").get(runId)) throw new AdmissionError("run_conflict");
        db.query("UPDATE arcade_admissions SET status='consumed', runId=? WHERE id=?").run(runId, id);
        return byId.get(id)!;
    });
    return {
        reserve: (requestId: string, game: ArcadeGame) => reserve.immediate(uuid(requestId), game),
        get: (id: string) => byId.get(uuid(id)),
        bindIntent(id: string, intent: string) {
            const result = db.query("UPDATE arcade_admissions SET intent=? WHERE id=? AND status='pending' AND (intent IS NULL OR intent=?)")
                .run(hash(intent), uuid(id), hash(intent));
            if (result.changes !== 1) throw new AdmissionError("intent_conflict");
        },
        ready(id: string, intent: string) {
            const ticket = byId.get(uuid(id));
            if (!ticket || ticket.intent !== hash(intent)) throw new AdmissionError("intent_conflict");
            if (ticket.status === "ready" || ticket.status === "consumed") return ticket;
            if (!["pending", "unknown"].includes(ticket.status)) throw new AdmissionError("ticket_not_ready");
            db.query("UPDATE arcade_admissions SET status='ready',error=NULL WHERE id=?").run(id);
            return byId.get(id)!;
        },
        fail(id: string, status: "unknown" | "rejected", code: string) {
            if (!/^[A-Z_]{1,64}$/.test(code)) throw new AdmissionError("invalid_error_code");
            db.query("UPDATE arcade_admissions SET status=?,error=? WHERE id=? AND status IN ('pending','unknown')")
                .run(status, code, uuid(id));
        },
        consume: (id: string, runId: string) => consume.immediate(uuid(id), uuid(runId)),
        modelCalls(day: string): number {
            return db.query<{calls: number}, [string]>("SELECT calls FROM arcade_model_calls WHERE day=?").get(day)?.calls ?? 0;
        },
        reserveModelCall(day: string, limit: number): boolean {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("invalid call budget");
            return db.query(`INSERT INTO arcade_model_calls(day,calls) VALUES(?,1)
                ON CONFLICT(day) DO UPDATE SET calls=calls+1 WHERE calls < ?`).run(day, limit).changes === 1;
        },
        close() {db.close();},
    };
}
export type ArcadeStore = ReturnType<typeof openArcadeStore>;
