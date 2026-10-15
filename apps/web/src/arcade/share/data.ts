import {isHash, type Hex} from "viem";
import type {GameId} from "@mapae/arcade";
import {GUARDIAN_MAX_SUPPLY} from "@mapae/arcade/guardians";
import type {RankedCard, SeasonCard} from "@mapae/arcade/ranking";
import type {Season} from "@mapae/arcade/season";
import {parseSeasonStatus, seasonStanding} from "../ranking/api";

const MAX_SCORE = 1_000_000_000;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const keys = (v: Record<string, unknown>, ...names: string[]) => Object.keys(v).length === names.length && names.every(name => name in v);

/**
 * The seller's answer for a ranked round, checked against the card that was asked for: the seed is a hash, the place fits the
 * entrant count, only the leader holds the leading score, and the round is final exactly when its day has passed.
 */
export function parseRankedCard(v: unknown, game: GameId, day: string, tokenId: string, today: string): RankedCard | null {
    if (!object(v) || !keys(v, "game", "day", "tokenId", "seed", "score", "rank", "entrants", "leader", "final", "season")) return null;
    if (v.game !== game || v.day !== day || v.tokenId !== tokenId || typeof v.seed !== "string" || !isHash(v.seed)) return null;
    if (!uint(v.score) || v.score > MAX_SCORE || !uint(v.rank) || v.rank < 1 || !uint(v.entrants) || v.entrants < v.rank || v.entrants > GUARDIAN_MAX_SUPPLY) return null;
    if (!uint(v.leader) || v.leader > MAX_SCORE || v.leader < v.score || (v.rank === 1) !== (v.leader === v.score) || v.final !== (day < today)) return null;
    const season = v.season === null ? null : seasonStanding(v.season);
    if (season === null && v.season !== null) return null;
    return {game, day, tokenId, seed: v.seed.toLowerCase() as Hex, score: v.score, rank: v.rank, entrants: v.entrants, leader: v.leader, final: v.final, season};
}
/** The seller's answer for a season standing: our season, in a phase that has a board, with a standing in it. */
export function parseSeasonCard(v: unknown, tokenId: string, season: Season): SeasonCard | null {
    if (!object(v) || !keys(v, "tokenId", "seed", "status", "season") || v.tokenId !== tokenId || typeof v.seed !== "string" || !isHash(v.seed)) return null;
    const status = parseSeasonStatus(v.status, season), standing = seasonStanding(v.season);
    if (!status || (status.phase !== "open" && status.phase !== "closed") || !standing || standing.entrants > GUARDIAN_MAX_SUPPLY) return null;
    return {tokenId, seed: v.seed.toLowerCase() as Hex, status, season: standing};
}
