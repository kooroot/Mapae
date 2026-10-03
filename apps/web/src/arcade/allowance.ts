import type {GameId} from "@mapae/arcade";

// Keep the existing reviewed per-permission cap; each friend gets their own permission.
export const MAX_ALLOWANCE_ADMISSIONS = 36;
export const validAllowance = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_ALLOWANCE_ADMISSIONS;
export type Outing = {characterId: string; choice: GameId | "auto"};
export type AllowanceView = {name: string; limit: number; remaining: number; expires: number};
export type Allowances = Record<string, AllowanceView>;

/** One turn per friend, then repeat. An unapproved friend never borrows another's budget. */
export function planOutings(ids: string[], allowances: Allowances, choice: Outing["choice"], now = Date.now() / 1000): Outing[] {
    const members = [...new Set(ids)].map(id => ({id, count: (allowances[id]?.expires ?? 0) > now ? allowances[id]!.remaining : 0}));
    const jobs: Outing[] = [];
    for (let round = 0; round < MAX_ALLOWANCE_ADMISSIONS; round++) {
        for (const {id, count} of members) if (round < count) jobs.push({characterId: id, choice});
    }
    return jobs;
}
