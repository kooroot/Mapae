import {describe, expect, test} from "bun:test";
import {advance, newGame, stampEvents, newBossPractice, ROUND_MS, FEVER_TARGET, FEVER_MS, stamp, stampChallenges, stampWave, stampAdvice, STAMP_WAVES, activateFever, setFeverMode, advanceAgent, bossWindow, BOSS_CYCLE_MS, BOSS_GUARD_MS, BOSS_OPENINGS, BOSS_PERFECT_START_MS, BOSS_PERFECT_MS, BOSS_PERFECT_POINTS, BOSS_PRACTICE_MS, goldParade, GOLD_PARADES, GOLD_PARADE_MS, GOLD_WARNING_MS, stampHighlights, type Game} from "@mapae/arcade/stamp";
import {cellForKey} from "./input";
import {CHIEF_SEAL, FEVER_WARNING_MS, PERFECT_POP, SCORE_POP, SEAL_PEAK, SHARDS, chiefOpen, countdownCue, feverGauge, sealBoost, stampEndMs, stampMotions, stampSounds} from "./stamp-fx";

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
        expect(state).toMatchObject({score: 0, hits: 0, bossHits: 0, combo: 0, feverCharge: 0, guardedHits: 1});
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
        expect(state).toMatchObject({bossDefeated: 1, bossHits: 3, hits: 1, combo: 1, score: 1000});
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

describe("Precise chief stamps and the ten-second drill", () => {
    function readyChief() {return advance(newBossPractice(19), 300);}
    function preciseRun() {
        let game = readyChief();
        const bornAt = game.cells[4]!.actor!.bornAt;
        for (let opening = 0; opening < BOSS_OPENINGS; opening++) {
            const at = bornAt + opening * BOSS_CYCLE_MS + BOSS_PERFECT_START_MS + BOSS_PERFECT_MS / 2;
            game = stamp(advance(game, at - game.elapsed), 4);
        }
        return advance(game, BOSS_PRACTICE_MS - game.elapsed);
    }

    test("the precise band has exact boundaries inside the unchanged broad success window", () => {
        const initial = readyChief();
        const bornAt = initial.cells[4]!.actor!.bornAt;
        for (const age of [BOSS_GUARD_MS, BOSS_PERFECT_START_MS - 1, BOSS_PERFECT_START_MS, BOSS_PERFECT_START_MS + BOSS_PERFECT_MS - 1, BOSS_PERFECT_START_MS + BOSS_PERFECT_MS, BOSS_CYCLE_MS - 1]) {
            const game = advance(initial, bornAt + age - initial.elapsed);
            const precise = age >= BOSS_PERFECT_START_MS && age < BOSS_PERFECT_START_MS + BOSS_PERFECT_MS;
            expect(bossWindow(game.cells[4]!.actor!, game.elapsed)).toMatchObject({phase: "open", perfect: precise, perfectBlocked: false});
            const hit = stamp(game, 4);
            expect(hit.cells[4]!.actor!.hp).toBe(2);
            expect(hit.perfectHits).toBe(precise ? 1 : 0);
            expect(hit.score).toBe(precise ? BOSS_PERFECT_POINTS : 0);
            expect(hit.hits).toBe(0);
        }
        expect(initial.cells[4]!.actor!.hp).toBe(3);
    });
    test("a precise hit scores once without adding damage, combo, defeat or fever", () => {
        const ready = advance(readyChief(), BOSS_PERFECT_START_MS);
        const hit = stamp(ready, 4);
        expect(hit).toMatchObject({score: BOSS_PERFECT_POINTS, perfectHits: 1, bossHits: 1, hits: 0, combo: 0, bossDefeated: 0, feverCharge: 0});
        expect(hit.cells[4]!.impact).toMatchObject({kind: "crack", perfect: true, points: BOSS_PERFECT_POINTS});
        expect(hit.cells[4]!.actor!.hp).toBe(2);
        expect(stamp(hit, 4)).toBe(hit);
        const repeated = advance(hit, 120);
        expect(stamp(repeated, 4)).toBe(repeated);
        expect(ready).toMatchObject({score: 0, perfectHits: 0});
        expect(ready.cells[4]!.actor!.lastOpeningHit).toBeUndefined();
    });
    test("an ordinary opening hit cannot be upgraded by tapping again during the precise band", () => {
        let game = stamp(advance(readyChief(), BOSS_GUARD_MS), 4);
        game = advance(game, BOSS_PERFECT_START_MS - BOSS_GUARD_MS);
        expect(stamp(game, 4)).toBe(game);
        expect(game).toMatchObject({score: 0, perfectHits: 0, bossHits: 1});
        expect(game.cells[4]!.actor!.hp).toBe(2);
    });
    test("a guarded tap spends only this cycle's precision chance and leaves ordinary damage legal", () => {
        const initial = readyChief();
        let game = stamp(advance(initial, BOSS_GUARD_MS - 1), 4);
        game = advance(game, BOSS_PERFECT_START_MS - BOSS_GUARD_MS + 1);
        expect(bossWindow(game.cells[4]!.actor!, game.elapsed)).toMatchObject({phase: "open", perfect: false, perfectBlocked: true});
        game = stamp(game, 4);
        expect(game).toMatchObject({score: 0, perfectHits: 0, guardedHits: 1});
        expect(game.cells[4]!.actor!.hp).toBe(2);
        game = stamp(advance(game, BOSS_CYCLE_MS), 4);
        expect(game).toMatchObject({score: BOSS_PERFECT_POINTS, perfectHits: 1});
        expect(game.cells[4]!.actor!.hp).toBe(1);
        expect(initial.cells[4]!.actor!.lastGuardedOpening).toBeUndefined();
    });
    test("deliberate single taps outscore fast mashing, which cannot farm precise bonuses", () => {
        const precise = preciseRun();
        expect(precise).toMatchObject({bossDefeated: 1, bossHits: 3, perfectHits: 3, score: 1000 + 3 * BOSS_PERFECT_POINTS});
        for (const interval of [10, 50, 110, 240]) {
            let mash = readyChief();
            while (!mash.finished) mash = stamp(advance(mash, interval), 4);
            expect(mash).toMatchObject({bossDefeated: 1, bossHits: 3, perfectHits: 0, score: 1000, hits: 1});
            expect(precise.score).toBeGreaterThan(mash.score);
        }
    });
    test("the drill contains exactly one chief, no regular arrivals, and ends at exactly ten seconds", () => {
        let game = newBossPractice(33);
        expect(game).toMatchObject({practice: "boss", durationMs: BOSS_PRACTICE_MS, perfectHits: 0, bossHits: 0});
        const births = new Set<number>();
        for (let at = 0; at < BOSS_PRACTICE_MS; at += 50) {
            game = advance(game, 50);
            for (const cell of game.cells) if (cell.actor) {
                expect(cell.actor.special).toBe("boss");
                births.add(cell.actor.bornAt);
            }
        }
        expect(births.size).toBe(1);
        expect(game).toMatchObject({elapsed: BOSS_PRACTICE_MS, finished: true, spawnCount: 1, missed: 1, score: 0});
        expect(game.cells.every(cell => !cell.actor)).toBe(true);
        expect(game).toEqual(advance(newBossPractice(33), 100_000));
        expect(stamp(game, 4)).toBe(game);
        expect(advance(game, 1)).toBe(game);
        expect(newGame(33)).toMatchObject({practice: "full", durationMs: ROUND_MS, bossSpawned: false});
        expect(() => newBossPractice(NaN)).toThrow("Invalid stamp seed");
    });
    test("a drill cannot activate fever or grant full-round challenge credit", () => {
        const charged = {...newBossPractice(1), feverCharge: FEVER_TARGET};
        expect(activateFever(charged)).toBe(charged);
        expect(setFeverMode(charged, "manual")).toBe(charged);
        const done = preciseRun();
        expect(done).toMatchObject({feverCharge: 0, feverActivations: 0, feverBonus: 0, goldHits: 0});
        expect(stampChallenges(done).map(goal => goal.id)).toEqual(["boss", "precision"]);
        expect(stampChallenges(done)[0]).toMatchObject({progress: 3, target: 3});
        expect(stampChallenges(done).every(goal => goal.done)).toBe(true);
        expect(stampHighlights(done)[0]!.en).toContain("600 timing bonus points");
        expect(stampAdvice(done, false, "en")).toContain("Three precise stamps");
    });
    test("both motors share legal scoring with people and remain deterministic across frame sizes in the drill", () => {
        const human = preciseRun();
        for (const tempo of ["careful", "quick"] as const) {
            const coarse = advanceAgent(newBossPractice(19), BOSS_PRACTICE_MS, tempo);
            for (const frame of [16, 33, 50, 1400]) {
                let fine = newBossPractice(19);
                while (!fine.finished) fine = advanceAgent(fine, frame, tempo);
                expect(fine).toEqual(coarse);
            }
            expect(coarse).toMatchObject({bossDefeated: 1, guardedHits: 0, feverActivations: 0, hits: 1});
            if (tempo === "careful") expect(coarse).toEqual(human);
            else expect(coarse).toMatchObject({perfectHits: 0, score: 1000});
        }
    });
    test("a narrow timing bonus does not multiply with fever or reward an expired opening", () => {
        const ready = {...advance(readyChief(), BOSS_PERFECT_START_MS), practice: "full" as const, feverUntil: 9000, combo: 14};
        expect(stamp(ready, 4)).toMatchObject({score: BOSS_PERFECT_POINTS, perfectHits: 1, combo: 14, feverBonus: 0});
        const expired = {...ready, elapsed: ready.cells[4]!.actor!.expiresAt};
        expect(bossWindow(expired.cells[4]!.actor!, expired.elapsed)).toMatchObject({phase: "recover", perfect: false});
        expect(stamp(expired, 4)).toBe(expired);
    });
});

describe("Dokkaebi Stamp motion plan", () => {
    const golden = (game: Game): Game => ({...game, cells: game.cells.map((cell, i) => i === 0 ? {...cell, actor: {...cell.actor!, golden: true}} : cell)});
    const kinds = (motions: ReturnType<typeof stampMotions>) => motions.map(motion => motion.kind);
    test("a player's golden hit gets every layer, from the engine's own events", () => {
        const before = golden(withActor(newGame(), "goblin"));
        const after = stamp(before, 0);
        const motions = stampMotions(stampEvents(before, after, 0), after, "full", {index: 0, point: {x: 10, y: 20}});
        expect(kinds(motions)).toEqual(["press", "seal", "ink", "float", "shards", "charge", "score"]);
        expect(motions).toContainEqual({kind: "float", index: 0, text: "+250"});
    });
    test("a watched agent keeps the seal, ink and score float but drops shards, shake and hit-stop", () => {
        const hit = [{type: "hit", index: 2, actor: {kind: "goblin", golden: true}, points: 250}, {type: "perfect", index: 2}, {type: "wrong", index: 5, points: -100}] as const;
        expect(kinds(stampMotions(hit, newGame(), "light"))).toEqual(["seal", "ink", "float", "rings", "strike", "score"]);
        expect(kinds(stampMotions(hit, newGame(), "full"))).toEqual(["seal", "ink", "float", "shards", "rings", "hitStop", "strike", "shake", "fieldShake", "score"]);
    });
    test("reduced motion leaves the points on the impact and only acknowledges, with no press, float, shards or field shake", () => {
        const events = [{type: "hit", index: 1, actor: {kind: "goblin", golden: true}, points: 250}, {type: "wrong", index: 3, points: -100}, {type: "pass", index: 4}] as const;
        expect(kinds(stampMotions(events, newGame(), "still", {index: 1}))).toEqual(["seal", "ink", "strike", "shake", "pass", "score"]);
    });
    test("a dud ripples where the pointer landed, and from the centre for a key", () => {
        const dud = [{type: "dud", index: 7}] as const;
        expect(stampMotions(dud, newGame(), "full", {index: 7, point: {x: 3, y: 4}})).toEqual([{kind: "press", index: 7}, {kind: "ripple", index: 7, point: {x: 3, y: 4}}]);
        expect(stampMotions(dud, newGame(), "light")).toEqual([{kind: "ripple", index: 7, point: undefined}]);
    });
    test("a crack sparks, and a perfect crack wears the seal and floats its bonus instead", () => {
        const crack = [{type: "crack", index: 4, actor: {kind: "goblin", special: "boss"}}] as const;
        const game = newGame();
        expect(kinds(stampMotions(crack, game, "full"))).toEqual(["spark"]);
        const perfect = {...game, cells: game.cells.map((cell, i) => i === 4 ? {...cell, impact: {kind: "crack" as const, until: 650, points: BOSS_PERFECT_POINTS, actor: {kind: "goblin" as const, special: "boss" as const}, perfect: true}} : cell)};
        expect(stampMotions(crack, perfect, "full")).toContainEqual({kind: "float", index: 4, text: `+${BOSS_PERFECT_POINTS}`});
        expect(kinds(stampMotions(crack, perfect, "full"))).not.toContain("spark");
    });
    test("the seal peaks a tenth higher per combo multiplier, and shards stay within 24–40px", () => {
        expect(sealBoost(0)).toBe(1);
        expect(SEAL_PEAK * sealBoost(15)).toBeCloseTo(2.2);
        expect(SEAL_PEAK * sealBoost(99)).toBeCloseTo(2.2);
        expect(SHARDS).toHaveLength(6);
        for (const {x, y} of SHARDS) {
            expect(Math.hypot(x, y)).toBeGreaterThanOrEqual(23.9);
            expect(Math.hypot(x, y)).toBeLessThanOrEqual(40.1);
        }
    });
    test("the scoreboard swells once per scoring step, more for a perfect, and never for a plain crack or a miss", () => {
        const two = [{type: "hit", index: 0, actor: {kind: "goblin"}, points: 100}, {type: "hit", index: 1, actor: {kind: "goblin"}, points: 100}] as const;
        expect(stampMotions(two, newGame(), "full").filter(motion => motion.kind === "score")).toEqual([{kind: "score", scale: SCORE_POP}]);
        expect(stampMotions([...two, {type: "perfect", index: 1}], newGame(), "light")).toContainEqual({kind: "score", scale: PERFECT_POP});
        expect(kinds(stampMotions([{type: "crack", index: 4, actor: {kind: "goblin", special: "armored"}}, {type: "miss", index: 2, actor: {kind: "goblin"}}], newGame(), "full"))).not.toContain("score");
    });
    test("a rising multiplier floats its chip, shorter for a watched agent and not at all under reduced motion; a break shakes only for a player", () => {
        const up = [{type: "comboTier", multiplier: 3}] as const;
        expect(stampMotions(up, newGame(), "full")).toEqual([{kind: "comboUp", text: "×3!", ms: 600}]);
        expect(stampMotions(up, newGame(), "light")).toEqual([{kind: "comboUp", text: "×3!", ms: 300}]);
        expect(stampMotions(up, newGame(), "still")).toEqual([]);
        const broken = [{type: "comboBreak", from: 12}] as const;
        expect(stampMotions(broken, newGame(), "full")).toEqual([{kind: "comboBreak", shake: true}]);
        expect(stampMotions(broken, newGame(), "light")).toEqual([{kind: "comboBreak", shake: false}]);
        expect(stampMotions(broken, newGame(), "still")).toEqual([{kind: "comboBreak", shake: false}]);
    });
    test("a real round breaks the streak on a miss and lifts the multiplier on the engine's own events", () => {
        let game = withActor(newGame(), "goblin");
        const motions: ReturnType<typeof stampMotions> = [];
        for (let i = 0; i < 5; i++) {
            const next = stamp(withActor(game, "goblin"), 0);
            motions.push(...stampMotions(stampEvents(game, next, 0), next, "full"));
            game = next;
        }
        expect(motions.filter(motion => motion.kind === "score")).toHaveLength(5);
        expect(motions.filter(motion => motion.kind === "comboUp")).toEqual([{kind: "comboUp", text: "×2!", ms: 600}]);
        const missed = advance(withActor(game, "goblin"), 10_000);
        expect(stampMotions(stampEvents(withActor(game, "goblin"), missed), missed, "full")).toContainEqual({kind: "comboBreak", shake: true});
    });
    test("the countdown ticks and goes for a player, keeps the plain start for a watched agent, and the end seal holds 700 / 300 / 250ms", () => {
        expect([3, 2, 1, 0].map(n => countdownCue(n, "full"))).toEqual(["tick", "tick", "tick", "go"]);
        expect([3, 2, 1, 0].map(n => countdownCue(n, "still"))).toEqual(["tick", "tick", "tick", "go"]);
        expect([3, 2, 1, 0].map(n => countdownCue(n, "light"))).toEqual([null, null, null, "start"]);
        expect(stampEndMs("full")).toBe(700);
        expect(stampEndMs("light")).toBeLessThanOrEqual(300);
        expect(stampEndMs("still")).toBe(250);
    });
});

describe("Dokkaebi Stamp fever motion", () => {
    const kinds = (motions: ReturnType<typeof stampMotions>) => motions.map(motion => motion.kind);
    const chiefAt = (phaseTime: number): Game => {
        const game = {...newGame(), elapsed: 46_000};
        return {...game, cells: game.cells.map((cell, i) => i === 4 ? {impact: null, actor: {kind: "goblin" as const, special: "boss" as const, hp: BOSS_OPENINGS, bornAt: game.elapsed - phaseTime, expiresAt: game.elapsed - phaseTime + BOSS_CYCLE_MS * BOSS_OPENINGS}} : cell)};
    };
    test("fever arrives with its herald at every tier and bumps the playfield only for a player", () => {
        const start = [{type: "feverStart"}] as const;
        expect(kinds(stampMotions(start, newGame(), "full"))).toEqual(["banner", "fieldBounce"]);
        expect(stampMotions(start, newGame(), "light")).toEqual([{kind: "banner", name: "fever"}]);
        expect(stampMotions(start, newGame(), "still")).toEqual([{kind: "banner", name: "fever"}]);
    });
    test("an auto fever from the eighth stamp heralds itself and chimes once, not on top of the hit", () => {
        let game = newGame();
        for (let i = 0; i < FEVER_TARGET - 1; i++) game = stamp(withActor(game, "goblin"), 0);
        const before = withActor(game, "goblin"), after = stamp(before, 0);
        const events = stampEvents(before, after, 0);
        expect(kinds(stampMotions(events, after, "full"))).toContain("banner");
        expect(kinds(stampMotions(events, after, "full"))).not.toContain("charge");
        expect(stampSounds(events)).toEqual(["fever"]);
    });
    test("each charge thumps the gauge for a player and a watched agent, and stays still under reduced motion", () => {
        const before = withActor(newGame(), "goblin"), after = stamp(before, 0);
        const events = stampEvents(before, after, 0);
        expect(kinds(stampMotions(events, after, "full"))).toContain("charge");
        expect(kinds(stampMotions(events, after, "light"))).toContain("charge");
        expect(kinds(stampMotions(events, after, "still"))).not.toContain("charge");
    });
    test("fever leaves by fading its glow and ringing down, unless the final bell rings over it", () => {
        const running = {...newGame(), elapsed: 10_000, feverUntil: 10_050, nextSpawn: 20_000};
        const ended = advance(running, 100);
        const events = stampEvents(running, ended);
        expect(events).toContainEqual({type: "feverEnd"});
        for (const tier of ["full", "light", "still"] as const) expect(kinds(stampMotions(events, ended, tier))).toEqual(["glowOut"]);
        expect(stampSounds(events)).toEqual(["feverEnd"]);
        const last = {...newGame(), elapsed: ROUND_MS - 500, feverUntil: ROUND_MS, nextSpawn: ROUND_MS};
        expect(stampSounds(stampEvents(last, advance(last, 600)))).toEqual(["end"]);
    });
    test("the gauge reads charge, then the share of fever left, and wanes for the last two seconds", () => {
        expect(feverGauge({...newGame(), feverCharge: 2})).toEqual({fever: false, left: 0, ratio: 2 / FEVER_TARGET, waning: false});
        expect(feverGauge({...newGame(), elapsed: 1_000, feverUntil: 1_000 + FEVER_MS})).toEqual({fever: true, left: FEVER_MS, ratio: 1, waning: false});
        expect(feverGauge({...newGame(), elapsed: 1_000, feverUntil: 1_000 + FEVER_WARNING_MS}).waning).toBe(true);
        expect(feverGauge({...newGame(), elapsed: 1_000, feverUntil: 1_000 + FEVER_WARNING_MS + 1}).waning).toBe(false);
        expect(feverGauge({...newGame(), elapsed: 1_000, feverUntil: 1_000, feverCharge: 0})).toMatchObject({fever: false, ratio: 0});
    });
    test("nothing jolts the playfield while the chief is open: no fever bump and no field shake", () => {
        const open = chiefAt(BOSS_GUARD_MS + 100), guard = chiefAt(100);
        expect(chiefOpen(open)).toBe(true);
        expect(chiefOpen(guard)).toBe(false);
        const events = [{type: "feverStart"}, {type: "wrong", index: 0, points: -100}] as const;
        expect(kinds(stampMotions(events, open, "full"))).toEqual(["strike", "shake", "banner"]);
        expect(kinds(stampMotions(events, guard, "full"))).toEqual(["strike", "shake", "fieldShake", "banner", "fieldBounce"]);
    });
});

describe("Dokkaebi Stamp chief motion", () => {
    const kinds = (motions: ReturnType<typeof stampMotions>) => motions.map(motion => motion.kind);
    /** A drill chief at `at` ms into its life, with `hp` openings still to land. */
    const drill = (at: number, hp = BOSS_OPENINGS): Game => {
        const game = advance(newBossPractice(), 300);
        const chief = game.cells[4]!.actor!;
        return advance({...game, cells: game.cells.map((cell, i) => i === 4 ? {...cell, actor: {...chief, hp}} : cell)}, at);
    };
    test("the chief drops in for a player only, inside its first guard", () => {
        const before = newBossPractice(), after = advance(before, 300);
        const events = stampEvents(before, after);
        expect(events).toContainEqual({type: "bossSpawn", index: 4});
        expect(stampMotions(events, after, "full")).toEqual([{kind: "bossArrive", index: 4}]);
        expect(stampMotions(events, after, "light")).toEqual([]);
        expect(stampMotions(events, after, "still")).toEqual([]);
    });
    test("a guarded tap glances off and shakes its window twice, with no shake for a watched agent and a flash under reduced motion", () => {
        const before = drill(100), after = stamp(before, 4);
        const events = stampEvents(before, after, 4);
        expect(events).toContainEqual({type: "guard", index: 4});
        expect(stampMotions(events, after, "full", {index: 4})).toEqual([{kind: "press", index: 4}, {kind: "deflect", index: 4}, {kind: "shake", index: 4, px: 3, color: "#bac5d9"}]);
        expect(stampMotions(events, after, "light")).toEqual([{kind: "deflect", index: 4}]);
        expect(stampMotions(events, after, "still")).toEqual([{kind: "shake", index: 4, px: 3, color: "#bac5d9"}]);
    });
    test("felling the chief stamps harder, scatters coins, freezes and drops the yard once, and heralds it at every tier", () => {
        const perfectAt = BOSS_PERFECT_START_MS + BOSS_PERFECT_MS / 2;
        const before = drill(perfectAt, 1), after = stamp(before, 4);
        const events = stampEvents(before, after, 4);
        expect(events).toContainEqual({type: "kill", index: 4, variant: "boss"});
        expect(events).toContainEqual({type: "perfect", index: 4});
        const full = stampMotions(events, after, "full");
        expect(full).toContainEqual({kind: "seal", index: 4, boost: sealBoost(after.combo) * CHIEF_SEAL});
        expect(kinds(full)).toEqual(expect.arrayContaining(["shards", "chiefDown", "banner", "rings"]));
        expect(kinds(full)).not.toContain("hitStop");
        expect(full).toContainEqual({kind: "banner", name: "chief"});
        const light = kinds(stampMotions(events, after, "light"));
        expect(light).toContain("banner");
        for (const kind of ["shards", "chiefDown", "hitStop"] as const) expect(light).not.toContain(kind);
        expect(stampMotions(events, after, "still")).toContainEqual({kind: "banner", name: "chief"});
    });
    test("a perfect stamp that leaves the chief standing keeps its own freeze", () => {
        const perfectAt = BOSS_PERFECT_START_MS + BOSS_PERFECT_MS / 2;
        const before = drill(perfectAt), after = stamp(before, 4);
        const motions = kinds(stampMotions(stampEvents(before, after, 4), after, "full"));
        expect(motions).toContain("hitStop");
        expect(motions).not.toContain("chiefDown");
        expect(motions).not.toContain("banner");
    });
});

