import {describe, expect, test} from "bun:test";
import {advance, newGame, ROUND_MS, FEVER_TARGET, FEVER_MS, stamp, stampChallenges, stampWave, stampAdvice, STAMP_WAVES, activateFever, setFeverMode, advanceAgent, bossWindow, BOSS_CYCLE_MS, BOSS_GUARD_MS, BOSS_OPENINGS, goldParade, GOLD_PARADES, GOLD_PARADE_MS, GOLD_WARNING_MS, stampHighlights, type Game} from "./game";
import {cellForKey} from "./input";

function withActor(game: Game, kind: "goblin" | "courier", index = 0): Game {
    return {...game, cells: game.cells.map((cell, i) => i === index ? {
        actor: {kind, bornAt: game.elapsed, expiresAt: game.elapsed + 1_000}, impact: null,
    } : cell)};
}


describe("Dokkaebi Stamp rules", () => {
    test("opens with a goblin after a short readable lead-in", () => {
        const initial = newGame();
        expect(advance(initial, 299).cells.every(c => !c.actor)).toBe(true);
        const game = advance(initial, 300);
        expect(game.cells.filter(c => c.actor?.kind === "goblin")).toHaveLength(1);
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
        for (let i = 0; i < 20; i++) game = stamp(withActor({...game, feverCharge: 0, feverUntil: 0}, "goblin"), 0);
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
        let game = newGame();
        for (let i = 0; i < 600; i++) game = advance(game, 50);
        expect(game).toEqual(advance(newGame(), 30_000));
    });
    test("round ends at 60 seconds and refuses subsequent input and ticks", () => {
        const done = advance(newGame(), 999_999);
        expect(done.elapsed).toBe(ROUND_MS);
        expect(done.finished).toBe(true);
        expect(done.cells.every(c => !c.actor)).toBe(true);
        expect(stamp(done, 0)).toBe(done);
        expect(advance(done, 500)).toBe(done);
    });
    test("no more than three targets are present, including late in a round", () => {
        let game = newGame();
        for (let i = 0; i < 600; i++) {
            game = advance(game, 100);
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


describe("Stamp festival", () => {
    test("eight consecutive hits charge fever once, with a bounded double-score window", () => {
        let game = newGame();
        for (let i = 0; i < FEVER_TARGET; i++) game = stamp(withActor(game, "goblin"), 0);
        expect(game.feverUntil).toBe(FEVER_MS);
        expect(game.feverCharge).toBe(0);
        const hit = stamp(withActor(game, "goblin"), 0);
        expect(hit.score - game.score).toBe(400);
        expect(hit.feverUntil).toBe(game.feverUntil);
        const expired = {...hit, elapsed: FEVER_MS, combo: 0};
        expect(stamp(withActor(expired, "goblin"), 0).score - expired.score).toBe(100);
    });
    test("mistakes and escaped targets reset charge and golden hits are counted only once", () => {
        const charged = {...newGame(), feverCharge: 6, nextSpawn: 9_000};
        expect(stamp(withActor(charged, "courier"), 0).feverCharge).toBe(0);
        expect(advance(withActor(charged, "goblin"), 1_000).feverCharge).toBe(0);
        const gold = withActor(newGame(), "goblin"); gold.cells[0]!.actor!.golden = true;
        const hit = stamp(gold, 0);
        expect(hit).toMatchObject({score: 250, goldHits: 1, hits: 1});
        expect(stamp(hit, 0)).toBe(hit);
    });
    test("late fever never extends the 60-second round and the festival remains frame-independent", () => {
        const game = stamp(withActor({...newGame(), elapsed: 59_000, feverCharge: 7}, "goblin"), 0);
        expect(game.feverUntil).toBe(ROUND_MS);
        expect(advance(game, 2_000).finished).toBe(true);
        let small = newGame();
        for (let i = 0; i < 1_200; i++) small = advance(small, 50);
        expect(small).toEqual(advance(newGame(), ROUND_MS));
    });
});

describe("Armored goblins and the chief", () => {
    test("armor requires two separate hits and only a defeat earns score, combo or fever", () => {
        const initial = withActor(newGame(), "goblin");
        initial.cells[0]!.actor = {...initial.cells[0]!.actor!, special: "armored", hp: 2};
        const cracked = stamp(initial, 0);
        expect(cracked).toMatchObject({score: 0, hits: 0, combo: 0, feverCharge: 0});
        expect(cracked.cells[0]!.actor!.hp).toBe(1);
        expect(initial.cells[0]!.actor!.hp).toBe(2);
        expect(stamp(cracked, 0)).toBe(cracked);
        const defeated = stamp(advance(cracked, 110), 0);
        expect(defeated).toMatchObject({score: 180, hits: 1, combo: 1, armorHits: 1, feverCharge: 1});
        expect(stamp(defeated, 0)).toBe(defeated);
    });
    test("exactly one chief appears after 45 seconds and can escape without extending the round", () => {
        let state = newGame(); const appearances = new Set<number>();
        for (let t = 0; t < ROUND_MS; t += 100) {
            state = advance(state, 100);
            for (const cell of state.cells) if (cell.actor?.special === "boss") {
                appearances.add(cell.actor.bornAt);
                expect(cell.actor.bornAt).toBeGreaterThanOrEqual(45_000);
            }
        }
        expect(appearances.size).toBe(1);
        expect(state.finished).toBe(true);
        expect(state.bossDefeated).toBe(0);
    });
    test("the chief blocks guarded hits and accepts only one stamp in each of three openings", () => {
        let state = withActor({...newGame(), nextSpawn: 20_000}, "goblin");
        state.cells[0]!.actor = {...state.cells[0]!.actor!, special: "boss", hp: BOSS_OPENINGS, expiresAt: BOSS_CYCLE_MS * BOSS_OPENINGS};
        const initial = state;
        state = stamp(advance(state, BOSS_GUARD_MS - 1), 0);
        expect(state.cells[0]!.actor!.hp).toBe(BOSS_OPENINGS);
        expect(state).toMatchObject({score: 0, hits: 0, combo: 0, feverCharge: 0, guardedHits: 1});
        expect(state.cells[0]!.impact!.kind).toBe("guard");
        // Guard feedback cannot swallow a correctly timed opening input one millisecond later.
        state = stamp(advance(state, 1), 0);
        expect(state.cells[0]!.actor!.hp).toBe(2);
        expect(bossWindow(state.cells[0]!.actor!, state.elapsed).phase).toBe("recover");
        const repeated = advance(state, 120);
        expect(stamp(repeated, 0)).toBe(repeated);
        for (let opening = 1; opening < BOSS_OPENINGS; opening++) {
            state = advance(state, BOSS_CYCLE_MS * opening + BOSS_GUARD_MS - state.elapsed);
            state = stamp(state, 0);
        }
        expect(state).toMatchObject({bossDefeated: 1, hits: 1, combo: 1, score: 1000});
        expect(stamp(state, 0)).toBe(state);
        expect(initial.cells[0]!.actor!.hp).toBe(BOSS_OPENINGS);
    });
    test("missing an opening prevents a chief defeat and expiry is never an extra opening", () => {
        let state = withActor({...newGame(), nextSpawn: 20_000}, "goblin");
        state.cells[0]!.actor = {...state.cells[0]!.actor!, special: "boss", hp: BOSS_OPENINGS, expiresAt: BOSS_CYCLE_MS * BOSS_OPENINGS};
        for (let opening = 1; opening < BOSS_OPENINGS; opening++) {
            state = advance(state, BOSS_CYCLE_MS * opening + BOSS_GUARD_MS - state.elapsed);
            state = stamp(state, 0);
        }
        expect(state.cells[0]!.actor!.hp).toBe(1);
        state = advance(state, BOSS_CYCLE_MS * BOSS_OPENINGS - state.elapsed);
        expect(state).toMatchObject({bossDefeated: 0, hits: 0, score: 0, missed: 1});
        expect(stamp(state, 0)).toBe(state);
    });
    test("a partly damaged goblin escaping counts as one miss and breaks the combo", () => {
        const initial = withActor({...newGame(), combo: 5, feverCharge: 5, nextSpawn: 5000}, "goblin");
        initial.cells[0]!.actor = {...initial.cells[0]!.actor!, special: "armored", hp: 2};
        const escaped = advance(stamp(initial, 0), 1100);
        expect(escaped).toMatchObject({hits: 0, missed: 1, combo: 0, feverCharge: 0, armorHits: 0});
    });
    test("challenge badges follow actual accomplishments and early exit cannot earn a perfect round", () => {
        expect(stampChallenges(newGame()).some(g => g.done)).toBe(false);
        const complete = {...newGame(), finished: true, elapsed: ROUND_MS, hits: 20, bossDefeated: 1};
        expect(stampChallenges(complete).every(g => g.done)).toBe(true);
        expect(stampChallenges(complete, true).find(g => g.id === "courier")!.done).toBe(false);
        expect(stampChallenges({...complete, mistakes: 1}).find(g => g.id === "courier")!.done).toBe(false);
    });
});


describe("Readable stamp waves", () => {
    test("five stages transition exactly at their announced boundaries", () => {
        for (const [index, wave] of STAMP_WAVES.entries()) {
            expect(stampWave(wave.at).index).toBe(index);
            if (index > 0) expect(stampWave(wave.at - 1).index).toBe(index - 1);
            expect(wave.life).toBeGreaterThanOrEqual(1300);
        }
        expect(stampWave(60000).next).toBeUndefined();
    });
    test("ring patrol follows its windows when they are clear and never replaces an actor", () => {
        let game = {...newGame(), elapsed: 12000, nextSpawn: 12000};
        const windows: number[] = [];
        for (let i = 0; i < 8; i++) {
            const bornAt = game.nextSpawn;
            game = advance(game, Math.max(1, bornAt - game.elapsed));
            const index = game.cells.findIndex(c => c.actor?.bornAt === bornAt);
            windows.push(index);
            game = {...game, cells: game.cells.map(c => ({...c, actor: null, impact: null}))};
        }
        expect(windows).toEqual([0, 1, 2, 5, 8, 7, 6, 3]);
        const busy = {...newGame(), elapsed: 45000, nextSpawn: 45000};
        busy.cells[4]!.actor = {kind: "courier", bornAt: 44999, expiresAt: 47000};
        const chief = advance(busy, 1);
        expect(chief.cells[4]!.actor?.kind).toBe("courier");
        expect(chief.cells.filter(c => c.actor?.special === "boss")).toHaveLength(1);
    });
    test("coaching prioritizes interrupted play, courier mistakes and missed targets", () => {
        expect(stampAdvice(newGame(), true, "ko")).toContain("45초");
        expect(stampAdvice({...newGame(), mistakes: 3}, false, "ko")).toContain("3번");
        expect(stampAdvice({...newGame(), hits: 4, missed: 10}, false, "en")).toContain("zigzag");
    });
});


describe("Chosen fever and announced gold", () => {
    test("manual charge can be held, caps at eight and can be activated only once", () => {
        let game = newGame(12, "manual");
        for (let i = 0; i < 12; i++) game = stamp(withActor(game, "goblin"), 0);
        expect(game).toMatchObject({feverCharge: FEVER_TARGET, feverUntil: 0, feverActivations: 0});
        const active = activateFever(game);
        expect(active).toMatchObject({feverCharge: 0, feverUntil: FEVER_MS, feverActivations: 1});
        expect(activateFever(active)).toBe(active);
        expect(game.feverCharge).toBe(FEVER_TARGET);
    });
    test("switching to auto spends a ready charge once; inactive charges never activate", () => {
        const initial = {...newGame(2, "manual"), feverCharge: FEVER_TARGET};
        const active = setFeverMode(initial, "auto");
        expect(active).toMatchObject({feverCharge: 0, feverActivations: 1, feverUntil: FEVER_MS});
        expect(setFeverMode(active, "auto")).toBe(active);
        expect(activateFever(newGame())).toMatchObject({feverUntil: 0, feverActivations: 0});
        const ended = {...initial, finished: true, elapsed: ROUND_MS};
        expect(activateFever(ended)).toBe(ended);
        expect(setFeverMode(ended, "auto")).toBe(ended);
    });
    test("waiting for gold changes the outcome without adding charge or altering base value", () => {
        let gold = withActor({...newGame(3, "manual"), feverCharge: FEVER_TARGET}, "goblin");
        gold.cells[0]!.actor!.golden = true;
        const plain = stamp(gold, 0);
        const boosted = stamp(activateFever(gold), 0);
        expect(plain.score).toBe(250);
        expect(boosted).toMatchObject({score: 500, feverBonus: 250, feverGoldHits: 1, feverCharge: 0});
        expect(plain).toMatchObject({feverBonus: 0, feverGoldHits: 0, feverCharge: FEVER_TARGET});
    });
    test("a mistake loses a held charge and manual fever cannot extend the round", () => {
        const ready = {...newGame(3, "manual"), feverCharge: FEVER_TARGET};
        expect(stamp(withActor(ready, "courier"), 0).feverCharge).toBe(0);
        expect(activateFever({...ready, elapsed: ROUND_MS - 1}).feverUntil).toBe(ROUND_MS);
        const atEnd = {...ready, elapsed: ROUND_MS};
        expect(activateFever(atEnd)).toBe(atEnd);
    });
    test("every golden parade is warned two seconds ahead and ends on its exact boundary", () => {
        for (const at of GOLD_PARADES) {
            expect(goldParade(at - GOLD_WARNING_MS - 1)).toBeNull();
            expect(goldParade(at - GOLD_WARNING_MS)).toMatchObject({phase: "soon", remaining: GOLD_WARNING_MS});
            expect(goldParade(at - 1)?.phase).toBe("soon");
            expect(goldParade(at)).toMatchObject({phase: "active", remaining: GOLD_PARADE_MS});
            expect(goldParade(at + GOLD_PARADE_MS)).toBeNull();
        }
    });
    test("gold announcements produce actual golden arrivals without converting existing couriers", () => {
        for (const at of GOLD_PARADES) {
            let game: Game = {...newGame(7), elapsed: at - 1, nextSpawn: at, bossSpawned: at >= 45_000};
            game.cells[8]!.actor = {kind: "courier", bornAt: at - 100, expiresAt: at + 1000};
            game = advance(game, 1);
            expect(game.cells[8]!.actor?.kind).toBe("courier");
            expect(game.cells.filter(c => c.actor?.golden)).toHaveLength(1);
            expect(game.cells.find(c => c.actor?.golden)?.actor?.special).toBeUndefined();
        }
    });
    test("highlights describe earned outcomes, stay bounded and omit unfinished achievements", () => {
        expect(stampHighlights(newGame())).toEqual([]);
        expect(stampHighlights({...newGame(), feverActivations: 1})).toEqual([]);
        const measured = {...newGame(), bossDefeated: 1, feverGoldHits: 3, feverBonus: 750, bestCombo: 12};
        expect(stampHighlights(measured)).toHaveLength(2);
        expect(stampHighlights(measured)[1]!.ko).toContain("3마리");
        expect(stampHighlights({...newGame(), feverBonus: 250})[0]!.en).toContain("250 bonus");
    });
});

describe("Repeatable stamp practice and legal agent motor", () => {
    test("seeds reproduce arrivals, differ across sessions and reject invalid input", () => {
        const first = advance(newGame(123), 10000);
        expect(advance(newGame(123), 10000)).toEqual(first);
        expect(advance(newGame(124), 10000).cells).not.toEqual(first.cells);
        for (const seed of [NaN, Infinity, .5, Number.MAX_SAFE_INTEGER + 1]) expect(() => newGame(seed)).toThrow("Invalid stamp seed");
    });
    test("both agent tempos have the same results across fine and coarse frame intervals", () => {
        for (const tempo of ["careful", "quick"] as const) {
            let fine = newGame(34);
            for (let i = 0; i < 1200; i++) fine = advanceAgent(fine, 50, tempo);
            const coarse = advanceAgent(newGame(34), ROUND_MS, tempo);
            expect(fine).toEqual(coarse);
            expect(coarse).toMatchObject({finished: true, elapsed: ROUND_MS, mistakes: 0, guardedHits: 0, bossDefeated: 1});
            expect(coarse.feverGoldHits).toBeGreaterThan(0);
            expect(coarse.score).toBeGreaterThan(0);
        }
    });
    test("motors never bypass boss windows, award repeated defeats or invent fever charge", () => {
        for (const tempo of ["careful", "quick"] as const) for (let seed = 0; seed < 20; seed++) {
            const game = advanceAgent(newGame(seed), ROUND_MS, tempo);
            expect(game.guardedHits).toBe(0);
            expect(game.bossDefeated).toBeLessThanOrEqual(1);
            expect(game.feverActivations * FEVER_TARGET).toBeLessThanOrEqual(game.hits);
            expect(game.feverGoldHits).toBeLessThanOrEqual(game.goldHits);
            expect(game.feverBonus).toBeLessThanOrEqual(game.score / 2);
            expect(advanceAgent(game, 3000, tempo)).toBe(game);
        }
    });
});
