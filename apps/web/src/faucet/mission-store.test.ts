import {describe, expect, test} from "bun:test";
import {markMissions, MISSION_OWNER_LIMIT, MISSION_STORAGE_KEY, projectMissions, readMissions, type MissionStorage} from "./mission-store";

const OWNER = "0x00000000000000000000000000000000000000A1";

function memory(initial?: string): MissionStorage & {raw: () => string | null} {
    let value = initial ?? null;
    return {
        getItem: (key) => (key === MISSION_STORAGE_KEY ? value : null),
        setItem: (key, next) => {if (key === MISSION_STORAGE_KEY) value = next;},
        raw: () => value,
    };
}

describe("faucet mission store", () => {
    test("remembers a mission per wallet, case-insensitively", () => {
        const storage = memory();
        expect(readMissions(OWNER, storage)).toEqual([]);
        markMissions(OWNER, ["x_follow_mapae"], storage);
        expect(readMissions(OWNER.toLowerCase() as `0x${string}`, storage)).toEqual(["x_follow_mapae"]);
        expect(readMissions("0x00000000000000000000000000000000000000b2", storage)).toEqual([]);
    });

    test("persists only known mission ids under lowercase addresses", () => {
        const storage = memory(JSON.stringify({
            [OWNER.toLowerCase()]: ["x_follow_mapae", "x_follow_mapae", "free_eth"],
            "not-an-address": ["x_follow_mapae"],
            [OWNER]: ["x_follow_mapae"],
            "0x00000000000000000000000000000000000000c3": "x_follow_mapae",
        }));
        markMissions("0x00000000000000000000000000000000000000d4", ["x_follow_mapae"], storage);
        expect(JSON.parse(storage.raw()!)).toEqual({
            [OWNER.toLowerCase()]: ["x_follow_mapae"],
            "0x00000000000000000000000000000000000000d4": ["x_follow_mapae"],
        });
    });

    test("a corrupt document reads as nothing done", () => {
        expect(readMissions(OWNER, memory("{not json"))).toEqual([]);
        expect(projectMissions(["x_follow_mapae"])).toEqual({});
    });

    test("forgets the oldest wallets beyond the limit", () => {
        const storage = memory();
        const owners = Array.from({length: MISSION_OWNER_LIMIT + 3}, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as `0x${string}`);
        for (const owner of owners) markMissions(owner, ["x_follow_mapae"], storage);
        const kept = Object.keys(JSON.parse(storage.raw()!));
        expect(kept).toHaveLength(MISSION_OWNER_LIMIT);
        expect(kept).not.toContain(owners[0]);
        expect(kept.at(-1)).toBe(owners.at(-1)!);
    });

    test("a full quota keeps the click for this visit", () => {
        const storage: MissionStorage = {getItem: () => null, setItem: () => {throw new Error("QuotaExceededError");}};
        expect(markMissions(OWNER, ["x_follow_mapae"], storage)).toEqual(["x_follow_mapae"]);
    });
});
