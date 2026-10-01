import {describe, expect, test} from "bun:test";
import {advance, newGame, ROUND_MS, stamp, type Game} from "./game";
import {cellForKey} from "./input";

function withActor(game: Game, kind: "goblin" | "courier", index = 0): Game {
    return {...game, cells: game.cells.map((cell, i) => i === index ? {
        actor: {kind, bornAt: game.elapsed, expiresAt: game.elapsed + 1_000}, impact: null,
    } : cell)};
}
function seeded() {
    let state = 123;
    return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe("Dokkaebi Stamp rules", () => {
    test("opens with a goblin after a short readable lead-in", () => {
        const initial = newGame();
        expect(advance(initial, 299).cells.every(c => !c.actor)).toBe(true);
        const game = advance(initial, 300, () => 0);
        expect(game.cells[0]?.actor?.kind).toBe("goblin");
        expect(initial.cells[0]?.actor).toBeNull();
    });
    test("one target awards points once even when pointer and keyboard arrive together", () => {
        const initial = withActor(newGame(), "goblin");
        const hit = stamp(initial, 0);
        expect(hit).toMatchObject({score: 100, hits: 1, combo: 1, bestCombo: 1});
        expect(stamp(hit, 0)).toBe(hit);
        expect(initial.score).toBe(0);
    });
    test("five consecutive stamps advance the multiplier, capped at four", () => {
        let game = newGame();
        for (let i = 0; i < 20; i++) game = stamp(withActor(game, "goblin"), 0);
        expect(game.score).toBe(5300);
        expect(game.bestCombo).toBe(20);
        const next = stamp(withActor(game, "goblin"), 0);
        expect(next.score - game.score).toBe(400);
    });
    test("a courier costs 100 and breaks combo, without producing a negative score", () => {
        let game = stamp(withActor(newGame(), "goblin"), 0);
        game = stamp(withActor(game, "courier"), 0);
        expect(game).toMatchObject({score: 0, combo: 0, bestCombo: 1, mistakes: 1});
        game = stamp(withActor(game, "courier"), 0);
        expect(game.score).toBe(0);
        expect(game.mistakes).toBe(2);
    });
    test("only an escaped goblin breaks a combo", () => {
        const scored = {...newGame(), combo: 4, bestCombo: 4, nextSpawn: 5_000};
        const missed = advance(withActor(scored, "goblin"), 1_000);
        const spared = advance(withActor(scored, "courier"), 1_000);
        expect(missed).toMatchObject({combo: 0, missed: 1});
        expect(spared).toMatchObject({combo: 4, missed: 0, mistakes: 0});
    });
    test("expiry is inclusive and expired targets cannot be stamped", () => {
        const game = {...withActor(newGame(), "goblin"), nextSpawn: 5_000};
        const expired = advance(game, 1_000);
        expect(stamp(expired, 0).score).toBe(0);
    });
    test("small frames and a large elapsed interval produce the same simulation", () => {
        const random = seeded();
        let game = newGame();
        for (let i = 0; i < 600; i++) game = advance(game, 50, random);
        expect(game).toEqual(advance(newGame(), 30_000, seeded()));
    });
    test("round ends at 60 seconds and refuses subsequent input and ticks", () => {
        const done = advance(newGame(), 999_999, seeded());
        expect(done.elapsed).toBe(ROUND_MS);
        expect(done.finished).toBe(true);
        expect(done.cells.every(c => !c.actor)).toBe(true);
        expect(stamp(done, 0)).toBe(done);
        expect(advance(done, 500)).toBe(done);
    });
    test("no more than three targets are present, including late in a round", () => {
        let game = newGame();
        const random = seeded();
        for (let i = 0; i < 600; i++) {
            game = advance(game, 100, random);
            expect(game.cells.filter(c => c.actor).length).toBeLessThanOrEqual(3);
        }
    });
    test("invalid deltas and out-of-bounds inputs leave state intact", () => {
        const game = newGame();
        for (const delta of [-1, NaN, Infinity, 0]) expect(advance(game, delta)).toBe(game);
        for (const cell of [-1, 9, NaN, 1.2]) expect(stamp(game, cell)).toBe(game);
    });
    test("number row, letters and physical numpad positions address the same windows", () => {
        expect(cellForKey("Digit1")).toBe(0);
        expect(cellForKey("Digit9")).toBe(8);
        expect(cellForKey("KeyQ")).toBe(0);
        expect(cellForKey("KeyS")).toBe(4);
        expect(cellForKey("KeyC")).toBe(8);
        expect(cellForKey("Numpad7")).toBe(0);
        expect(cellForKey("Numpad1")).toBe(6);
        expect(cellForKey("Space")).toBeNull();
        expect(cellForKey("Digit0")).toBeNull();
    });
});
