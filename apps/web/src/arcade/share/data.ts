import {isHash, type Hex} from "viem";
import type {GameId} from "@mapae/arcade";
import {GUARDIAN_MAX_SUPPLY, GUARDIAN_ZODIACS, type GuardianZodiac} from "@mapae/arcade/guardians";
import type {SeasonMark} from "@mapae/arcade/hall";
import type {RankedCard, SeasonCard} from "@mapae/arcade/ranking";
import type {Season} from "@mapae/arcade/season";
import {parseSeasonStatus, seasonStanding} from "../ranking/api";

const MAX_SCORE = 1_000_000_000;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const keys = (v: Record<string, unknown>, ...names: string[]) => Object.keys(v).length === names.length && names.every(name => name in v);

/**
 * The seller's answer for a ranked round, checked against the card that was asked for: the seed is a hash, the place fits the
 * entrant count, the leader holds the leading score, and the round is final exactly when its day has passed. A board breaks a
 * tie by who reached the score first, so a place below the first may hold the leading score too.
 */
export function parseRankedCard(v: unknown, game: GameId, day: string, tokenId: string, today: string): RankedCard | null {
    if (!object(v) || !keys(v, "game", "day", "tokenId", "seed", "score", "rank", "entrants", "leader", "final", "season")) return null;
    if (v.game !== game || v.day !== day || v.tokenId !== tokenId || typeof v.seed !== "string" || !isHash(v.seed)) return null;
    if (!uint(v.score) || v.score > MAX_SCORE || !uint(v.rank) || v.rank < 1 || !uint(v.entrants) || v.entrants < v.rank || v.entrants > GUARDIAN_MAX_SUPPLY) return null;
    if (!uint(v.leader) || v.leader > MAX_SCORE || v.leader < v.score || (v.rank === 1 && v.leader !== v.score) || v.final !== (day < today)) return null;
    const season = v.season === null ? null : seasonStanding(v.season);
    if (season === null && v.season !== null) return null;
    return {game, day, tokenId, seed: v.seed.toLowerCase() as Hex, score: v.score, rank: v.rank, entrants: v.entrants, leader: v.leader, final: v.final, season};
}
const MARK_KINDS = ["podium", "team", "entrant"] as const;
/**
 * A guardian's season marks as the seller sealed them: at most one of each kind, podium before team before entrant, every one
 * of this season, the entrant mark whenever there is any, and none at all while the season is open.
 */
export function parseSeasonMarks(v: unknown, season: number, closed: boolean): SeasonMark[] | null {
    if (!Array.isArray(v) || v.length > MARK_KINDS.length || (v.length && !closed)) return null;
    const marks: SeasonMark[] = [];
    for (const mark of v) {
        if (!object(mark) || mark.season !== season) return null;
        const kind = MARK_KINDS.indexOf(mark.kind as typeof MARK_KINDS[number]), last = marks.at(-1);
        if (kind < 0 || (last && MARK_KINDS.indexOf(last.kind) >= kind)) return null;
        if (mark.kind === "podium" && keys(mark, "season", "kind", "place") && (mark.place === 1 || mark.place === 2 || mark.place === 3)) marks.push({season, kind: "podium", place: mark.place});
        else if (mark.kind === "team" && keys(mark, "season", "kind", "zodiac") && GUARDIAN_ZODIACS.includes(mark.zodiac as GuardianZodiac)) marks.push({season, kind: "team", zodiac: mark.zodiac as GuardianZodiac});
        else if (mark.kind === "entrant" && keys(mark, "season", "kind")) marks.push({season, kind: "entrant"});
        else return null;
    }
    if (marks.length && marks.at(-1)!.kind !== "entrant") return null;
    return marks;
}
/** The seller's answer for a season standing: our season, in a phase that has a board, with a standing in it. */
export function parseSeasonCard(v: unknown, tokenId: string, season: Season): SeasonCard | null {
    if (!object(v) || !keys(v, "tokenId", "seed", "status", "season", "marks") || v.tokenId !== tokenId || typeof v.seed !== "string" || !isHash(v.seed)) return null;
    const status = parseSeasonStatus(v.status, season), standing = seasonStanding(v.season);
    if (!status || (status.phase !== "open" && status.phase !== "closed") || !standing || standing.entrants > GUARDIAN_MAX_SUPPLY) return null;
    const marks = parseSeasonMarks(v.marks, status.id, status.phase === "closed");
    if (!marks) return null;
    return {tokenId, seed: v.seed.toLowerCase() as Hex, status, season: standing, marks};
}
