import {ARCADE_RULESET_VERSION, type GameId} from './contracts';

/** One public scenario per game and Korean calendar day, independent of wallet or locale. */
export function dailyChallenge(game: GameId, at = Date.now()) {
    if (!Number.isFinite(at)) throw new Error('Invalid challenge date');
    const day = new Date(at + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const key = `${ARCADE_RULESET_VERSION}:${day}:${game}`;
    let seed = 2166136261;
    for (const char of key) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
    return {day, seed, version: ARCADE_RULESET_VERSION};
}
