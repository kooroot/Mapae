import {Database} from "bun:sqlite";
import type {D1Database} from "@cloudflare/workers-types";
/** Real SQLite constraints and statements behind the small D1 surface used in tests. */
export function d1(db: Database): Pick<D1Database, "prepare" | "batch"> {
    function prepare(sql: string, args: unknown[] = []): unknown {
        return {
            bind: (...params: unknown[]) => prepare(sql, params),
            first: async () => db.query(sql).get(...args as (string | number | null)[]),
            run: async () => db.query(sql).run(...args as (string | number | null)[]),
        };
    }
    return {prepare, batch: async (items: {run: () => Promise<unknown>}[]) => Promise.all(items.map(i => i.run()))} as unknown as Pick<D1Database, "prepare" | "batch">;
}
