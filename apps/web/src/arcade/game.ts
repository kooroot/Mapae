export const ROUND_MS = 60_000;
export const CELL_COUNT = 9;

export type Actor = {kind: "goblin" | "courier"; expiresAt: number; bornAt: number};
export type Impact = {kind: "stamp" | "wrong" | "miss"; until: number; points: number};
export type Cell = {actor: Actor | null; impact: Impact | null};
export type Game = {
    elapsed: number;
    nextSpawn: number;
    cells: Cell[];
    score: number;
    combo: number;
    bestCombo: number;
    hits: number;
    mistakes: number;
    missed: number;
    finished: boolean;
};

export function newGame(): Game {
    return {
        elapsed: 0, nextSpawn: 300,
        cells: Array.from({length: CELL_COUNT}, () => ({actor: null, impact: null})),
        score: 0, combo: 0, bestCombo: 0, hits: 0, mistakes: 0, missed: 0,
        finished: false,
    };
}

function expire(game: Game, at: number) {
    for (const cell of game.cells) {
        if (cell.impact && cell.impact.until <= at) cell.impact = null;
        if (!cell.actor || cell.actor.expiresAt > at) continue;
        if (cell.actor.kind === "goblin") {
            game.combo = 0;
            game.missed++;
            const until = cell.actor.expiresAt + 300;
            cell.impact = until > at ? {kind: "miss", until, points: 0} : null;
        }
        cell.actor = null;
    }
}

/** Pure simulation. Spawn/expiry order stays the same at 20, 60 or 120 Hz. */
export function advance(game: Game, deltaMs: number, random: () => number = Math.random): Game {
    if (game.finished || !Number.isFinite(deltaMs) || deltaMs <= 0) return game;
    const next: Game = {...game, cells: game.cells.map(cell => ({...cell}))};
    const end = Math.min(ROUND_MS, game.elapsed + deltaMs);
    while (next.nextSpawn <= end && next.nextSpawn < ROUND_MS) {
        const at = next.nextSpawn;
        expire(next, at);
        const empty = next.cells.filter(cell => !cell.actor && !cell.impact);
        const active = next.cells.filter(cell => cell.actor).length;
        if (empty.length && active < 3) {
            const cell = empty[Math.min(empty.length - 1, Math.floor(random() * empty.length))]!;
            // The opening seconds teach the target before introducing a friendly face.
            cell.actor = {
                kind: at > 5_000 && random() < 0.22 ? "courier" : "goblin",
                bornAt: at,
                expiresAt: at + 1_850 - (at / ROUND_MS) * 650,
            };
        }
        next.nextSpawn += 950 - (at / ROUND_MS) * 470;
    }
    expire(next, end);
    next.elapsed = end;
    next.finished = end === ROUND_MS;
    if (next.finished) next.cells = next.cells.map(cell => ({...cell, actor: null}));
    return next;
}

export function stamp(game: Game, index: number): Game {
    if (game.finished || !Number.isInteger(index) || !game.cells[index]) return game;
    const actor = game.cells[index]!.actor;
    if (!actor) return game;
    const next = {...game, cells: game.cells.map(cell => ({...cell}))};
    const cell = next.cells[index]!;
    cell.actor = null;
    if (actor.kind === "courier") {
        const lost = Math.min(100, next.score);
        next.score -= lost;
        next.combo = 0;
        next.mistakes++;
        cell.impact = {kind: "wrong", until: game.elapsed + 420, points: -lost};
    } else {
        next.combo++;
        next.bestCombo = Math.max(next.bestCombo, next.combo);
        next.hits++;
        const points = 100 * multiplier(next.combo);
        next.score += points;
        cell.impact = {kind: "stamp", until: game.elapsed + 300, points};
    }
    return next;
}

export function multiplier(combo: number): number {
    return Math.min(4, 1 + Math.floor(combo / 5));
}
