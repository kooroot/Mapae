import {ARCADE_RULESET_VERSION, type GameId} from './contracts';
import {fnv1a, kstDay} from './ranking';

/** One public scenario per game and Korean calendar day, independent of wallet or locale. */
export function dailyChallenge(game: GameId, at = Date.now()) {
    if (!Number.isFinite(at)) throw new Error('Invalid challenge date');
    const day = kstDay(at);
    return {day, seed: fnv1a(`${ARCADE_RULESET_VERSION}:${day}:${game}`), version: ARCADE_RULESET_VERSION};
}
