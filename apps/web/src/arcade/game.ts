export const ROUND_MS = 60_000;
export const CELL_COUNT = 9;
export const FEVER_TARGET = 8;
export const FEVER_MS = 8_000;
export const GOLD_PARADES = [18_000, 32_000, 55_000] as const;
export const GOLD_PARADE_MS = 3_000;
export const GOLD_WARNING_MS = 2_000;
export const BOSS_GUARD_MS = 1_000;
export const BOSS_OPEN_MS = 1_400;
export const BOSS_CYCLE_MS = BOSS_GUARD_MS + BOSS_OPEN_MS;
export const BOSS_OPENINGS = 3;
export type FeverMode = "auto" | "manual";

export function goldParade(elapsed: number): {phase: "soon" | "active"; at: number; remaining: number} | null {
    for (const at of GOLD_PARADES) {
        if (elapsed >= at - GOLD_WARNING_MS && elapsed < at) return {phase: "soon", at, remaining: at - elapsed};
        if (elapsed >= at && elapsed < at + GOLD_PARADE_MS) return {phase: "active", at, remaining: at + GOLD_PARADE_MS - elapsed};
    }
    return null;
}

export const STAMP_WAVES = [
    {at: 0, interval: 900, life: 1850, limit: 2, ko: "몸풀기 · 도깨비만 콕!", en: "WARM UP · STAMP THE GOBLINS"},
    {at: 12_000, interval: 750, life: 1700, limit: 3, ko: "둘레 순찰 · 갑옷은 두 번!", en: "RING PATROL · ARMOR TAKES TWO HITS"},
    {at: 28_000, interval: 640, life: 1500, limit: 3, ko: "지그재그 잔치 · 금도깨비를 찾아라", en: "ZIGZAG PARADE · LOOK FOR GOLD"},
    {at: 45_000, interval: 950, life: 1900, limit: 2, ko: "대장 도전 · 방어가 풀릴 때 콕!", en: "CHIEF CHALLENGE · WAIT FOR OPEN!"},
    {at: 53_000, interval: 430, life: 1300, limit: 3, ko: "마지막 소동 · 콤보를 이어라!", en: "FINAL RUSH · KEEP YOUR COMBO"},
] as const;

export function stampWave(elapsed: number) {
    const index = Math.max(0, STAMP_WAVES.findLastIndex(w => elapsed >= w.at));
    return {index, current: STAMP_WAVES[index]!, next: STAMP_WAVES[index + 1]};
}

export type Actor = {kind: "goblin" | "courier"; expiresAt: number; bornAt: number; golden?: boolean; special?: "armored" | "boss"; hp?: number; lastHitAt?: number; lastOpeningHit?: number};
export type Impact = {kind: "stamp" | "wrong" | "miss" | "crack" | "guard"; until: number; points: number; golden?: boolean};
export type Cell = {actor: Actor | null; impact: Impact | null};
export type Game = {
    seed: number;
    feverMode: FeverMode;
    feverActivations: number;
    feverBonus: number;
    feverGoldHits: number;
    guardedHits: number;
    elapsed: number;
    nextSpawn: number;
    cells: Cell[];
    score: number;
    combo: number;
    bestCombo: number;
    hits: number;
    mistakes: number;
    missed: number;
    feverCharge: number;
    feverUntil: number;
    goldHits: number;
    spawnCount: number;
    bossSpawned: boolean;
    bossDefeated: number;
    armorHits: number;
    finished: boolean;
};

export function newGame(seed = 0, feverMode: FeverMode = "auto"): Game {
    if (!Number.isSafeInteger(seed)) throw new Error("Invalid stamp seed");
    return {
        seed, feverMode, feverActivations: 0, feverBonus: 0, feverGoldHits: 0, guardedHits: 0,
        elapsed: 0, nextSpawn: 300,
        cells: Array.from({length: CELL_COUNT}, () => ({actor: null, impact: null})),
        score: 0, combo: 0, bestCombo: 0, hits: 0, mistakes: 0, missed: 0,
        feverCharge: 0, feverUntil: 0, goldHits: 0, spawnCount: 0, bossSpawned: false, bossDefeated: 0, armorHits: 0,
        finished: false,
    };
}

function expire(game: Game, at: number) {
    for (const cell of game.cells) {
        if (cell.impact && (cell.impact.until <= at || cell.impact.kind === "guard" && cell.actor?.special === "boss" && bossWindow(cell.actor, at).phase === "open")) cell.impact = null;
        if (!cell.actor || cell.actor.expiresAt > at) continue;
        if (cell.actor.kind === "goblin") {
            game.combo = 0;
            game.feverCharge = 0;
            game.missed++;
            const until = cell.actor.expiresAt + 300;
            cell.impact = until > at ? {kind: "miss", until, points: 0} : null;
        }
        cell.actor = null;
    }
}

/** Randomness is tied to each scheduled arrival, so frame rate and skipped windows cannot consume another event's roll. */
function spawnRandom(seed: number, at: number, sample: number): number {
    let value = (seed ^ Math.imul(at, 2654435761) ^ Math.imul(sample, 2246822519)) >>> 0;
    value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
    value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
    return ((value ^ (value >>> 15)) >>> 0) / 2 ** 32;
}

/** Pure simulation. Spawn/expiry order stays the same at 20, 60 or 120 Hz. */
export function advance(game: Game, deltaMs: number): Game {
    if (game.finished || !Number.isFinite(deltaMs) || deltaMs <= 0) return game;
    const next: Game = {...game, cells: game.cells.map(cell => ({...cell}))};
    const end = Math.min(ROUND_MS, game.elapsed + deltaMs);
    while (next.nextSpawn <= end && next.nextSpawn < ROUND_MS) {
        const at = next.nextSpawn;
        expire(next, at);
        const wave = stampWave(at);
        const empty = next.cells.map((cell, index) => ({cell, index})).filter(({cell}) => !cell.actor && !cell.impact);
        const active = next.cells.filter(cell => cell.actor).length;
        if (empty.length && active < wave.current.limit) {
            // Follow a readable ring or zigzag; occupied windows are never overwritten.
            const path = wave.index === 1 ? [0, 1, 2, 5, 8, 7, 6, 3] : wave.index === 2 ? [0, 1, 2, 5, 4, 3, 6, 7, 8] : null;
            const preferred = at >= 45_000 && !next.bossSpawned ? 4 : path?.[next.spawnCount % path.length];
            const {cell} = empty.find(item => item.index === preferred) ?? empty[Math.min(empty.length - 1, Math.floor(spawnRandom(next.seed, at, 0) * empty.length))]!;
            // The opening seconds teach the target before introducing a friendly face.
            cell.actor = {
                kind: goldParade(at)?.phase !== "active" && at > 5_000 && spawnRandom(next.seed, at, 1) < 0.22 ? "courier" : "goblin",
                bornAt: at,
                expiresAt: at + wave.current.life,
            };
            next.spawnCount++;
            if (at >= 45_000 && !next.bossSpawned) {
                cell.actor = {kind: "goblin", special: "boss", hp: BOSS_OPENINGS, bornAt: at, expiresAt: Math.min(ROUND_MS, at + BOSS_CYCLE_MS * BOSS_OPENINGS)};
                next.bossSpawned = true;
            } else if (cell.actor.kind === "goblin" && goldParade(at)?.phase !== "active" && at >= 12_000 && next.spawnCount % 5 === 0) {
                cell.actor = {...cell.actor, special: "armored", hp: 2, expiresAt: at + 2_200};
            }
            cell.actor.golden = !cell.actor.special && cell.actor.kind === "goblin" && (goldParade(at)?.phase === "active" || at >= 20_000 && next.spawnCount % 7 === 0);
        }
        next.nextSpawn += wave.current.interval;
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
    if (!actor || actor.expiresAt <= game.elapsed || game.elapsed >= ROUND_MS || (actor.lastHitAt !== undefined && game.elapsed - actor.lastHitAt < 110)) return game;
    const next = {...game, cells: game.cells.map(cell => ({...cell}))};
    const cell = next.cells[index]!;
    if (actor.special === "boss") {
        const window = bossWindow(actor, game.elapsed);
        if (window.phase === "recover") return game;
        if (window.phase === "guard") {
            if (cell.impact?.kind === "guard" && cell.impact.until > game.elapsed) return game;
            cell.impact = {kind: "guard", until: game.elapsed + 240, points: 0};
            next.guardedHits++;
            return next;
        }
        cell.actor = {...actor, lastOpeningHit: window.opening, lastHitAt: game.elapsed};
    }
    if (actor.kind === "goblin" && (actor.hp ?? 1) > 1) {
        cell.actor = {...cell.actor!, hp: actor.hp! - 1, lastHitAt: game.elapsed};
        cell.impact = {kind: "crack", until: game.elapsed + 100, points: 0};
        return next;
    }
    cell.actor = null;
    if (actor.kind === "courier") {
        const lost = Math.min(100, next.score);
        next.score -= lost;
        next.combo = 0;
        next.feverCharge = 0;
        next.mistakes++;
        cell.impact = {kind: "wrong", until: game.elapsed + 420, points: -lost};
    } else {
        next.combo++;
        next.bestCombo = Math.max(next.bestCombo, next.combo);
        next.hits++;
        const fever = game.feverUntil > game.elapsed;
        const basePoints = (actor.special === "boss" ? 1000 : actor.special === "armored" ? 180 : actor.golden ? 250 : 100) * multiplier(next.combo);
        const points = basePoints * (fever ? 2 : 1);
        if (fever) {next.feverBonus += basePoints; if (actor.golden) next.feverGoldHits++;}
        if (actor.golden) next.goldHits++;
        if (actor.special === "boss") next.bossDefeated++;
        if (actor.special === "armored") next.armorHits++;
        if (!fever) {
            next.feverCharge = Math.min(FEVER_TARGET, next.feverCharge + 1);
            if (next.feverMode === "auto" && next.feverCharge === FEVER_TARGET) {
                next.feverUntil = Math.min(ROUND_MS, game.elapsed + FEVER_MS);
                next.feverCharge = 0;
                next.feverActivations++;
            }
        }
        next.score += points;
        cell.impact = {kind: "stamp", until: game.elapsed + 380, points, golden: actor.golden};
    }
    return next;
}

/** A chief exposes one opening per cycle. A successful stamp closes that opening for everyone. */
export function bossWindow(actor: Actor, elapsed: number) {
    const age = Math.max(0, elapsed - actor.bornAt);
    const opening = Math.floor(age / BOSS_CYCLE_MS);
    const phaseTime = age % BOSS_CYCLE_MS;
    const phase = elapsed >= actor.expiresAt || opening >= BOSS_OPENINGS || actor.lastOpeningHit === opening ? "recover" : phaseTime < BOSS_GUARD_MS ? "guard" : "open";
    return {phase, opening, remaining: phase === "guard" ? BOSS_GUARD_MS - phaseTime : BOSS_CYCLE_MS - phaseTime} as const;
}

export function activateFever(game: Game): Game {
    if (game.finished || game.elapsed >= ROUND_MS || game.feverUntil > game.elapsed || game.feverCharge < FEVER_TARGET) return game;
    return {...game, feverCharge: 0, feverUntil: Math.min(ROUND_MS, game.elapsed + FEVER_MS), feverActivations: game.feverActivations + 1};
}

export function setFeverMode(game: Game, mode: FeverMode): Game {
    if (game.finished || mode === game.feverMode) return game;
    const next = {...game, feverMode: mode};
    return mode === "auto" ? activateFever(next) : next;
}

/** Both agent strategies use the same hit function as a person; there is no privileged boss damage or extra fever. */
export function advanceAgent(game: Game, deltaMs: number, tempo: "careful" | "quick"): Game {
    if (game.finished || !Number.isFinite(deltaMs) || deltaMs <= 0) return game;
    const interval = tempo === "quick" ? 260 : 510;
    const end = Math.min(ROUND_MS, game.elapsed + deltaMs);
    let next = setFeverMode(game, tempo === "quick" ? "auto" : "manual");
    for (let at = (Math.floor(game.elapsed / interval) + 1) * interval; at <= end; at += interval) {
        next = advance(next, at - next.elapsed);
        if (next.finished) break;
        if (tempo === "careful" && (goldParade(at)?.phase === "active" || at >= ROUND_MS - FEVER_MS || next.cells.some(c => c.actor?.special === "boss" && bossWindow(c.actor, at).phase === "open"))) next = activateFever(next);
        const targets = next.cells.map((cell, index) => ({actor: cell.actor, index})).filter(({actor}) => actor?.kind === "goblin" && at - actor.bornAt >= (tempo === "quick" ? 180 : 390) && (actor.special !== "boss" || bossWindow(actor, at).phase === "open"));
        targets.sort((a, b) => Number(b.actor!.special === "boss") - Number(a.actor!.special === "boss") || Number(!!b.actor!.golden) - Number(!!a.actor!.golden) || a.actor!.expiresAt - b.actor!.expiresAt);
        if (targets[0]) next = stamp(next, targets[0].index);
    }
    return advance(next, end - next.elapsed);
}

/** Only measured outcomes become highlights; unused fever and unfinished bosses never become invented successes. */
export function stampHighlights(game: Game): {ko: string; en: string}[] {
    const highlights: {ko: string; en: string}[] = [];
    if (game.bossDefeated) highlights.push({ko: "대장의 세 번의 빈틈을 모두 잡아 퇴치했어요.", en: "You caught all three chief openings and defeated it."});
    if (game.feverGoldHits) highlights.push({ko: `출두 시간에 금도깨비 ${game.feverGoldHits}마리를 잡았어요.`, en: `You stamped ${game.feverGoldHits} golden goblins during fever.`});
    else if (game.feverBonus) highlights.push({ko: `출두로 ${game.feverBonus.toLocaleString("en-US")}점을 더 얻었어요.`, en: `Fever added ${game.feverBonus.toLocaleString("en-US")} bonus points.`});
    if (highlights.length < 2 && game.bestCombo >= 5) highlights.push({ko: `${game.bestCombo}연속 도장으로 배수를 높였어요.`, en: `${game.bestCombo} consecutive stamps raised your multiplier.`});
    return highlights.slice(0, 2);
}

export function multiplier(combo: number): number {
    return Math.min(4, 1 + Math.floor(combo / 5));
}

export function stampAdvice(game: Game, early: boolean, locale: "ko" | "en"): string {
    const ko = locale === "ko";
    if (early) return ko ? "다음 판에는 45초 뒤 등장하는 대장까지 도전해 보세요." : "Next round, stay for the chief arriving after 45 seconds.";
    if (game.mistakes > 0) return ko ? `배달부를 ${game.mistakes}번 찍었어요. 초록색 ‘통과!’ 표시는 건너뛰면 콤보를 지킬 수 있어요.` : `You stamped ${game.mistakes} couriers. Skip the green PASS signs to protect your combo.`;
    if (game.missed > game.hits / 2) return ko ? "놓친 도깨비가 많았어요. 둘레 → 지그재그 순서로 눈을 움직여 보세요." : "Many goblins escaped. Follow the ring, then the zigzag pattern.";
    if (!game.bossDefeated) return ko ? "대장의 ‘찍어!’ 표시를 기다려 한 번씩 찍어 보세요. 세 번의 빈틈을 잡으면 퇴치할 수 있어요." : "Wait for the chief's OPEN sign, then stamp once. Catch all three openings to defeat it.";
    if (!game.feverGoldHits) return ko ? "대장까지 퇴치했어요! 직접 출두를 켜고 금도깨비 행렬에 맞춰 발동해 보세요." : "Chief defeated! Try manual fever and time it for a golden parade.";
    return ko ? `출두 중 금도깨비 ${game.feverGoldHits}마리를 잡았어요. 다음엔 실수 없이 기록을 높여 보세요.` : `You caught ${game.feverGoldHits} golden goblins during fever. Try a clean round for a new best.`;
}

/** Round objectives are earned by play, never by an extra payment or a profile perk. */
export function stampChallenges(game: Game, early = false) {
    return [
        {id: "hunter", done: game.hits >= 20, progress: Math.min(20, game.hits), target: 20, ko: "도깨비 20마리", en: "Stamp 20 goblins"},
        {id: "boss", done: game.bossDefeated > 0, progress: game.bossDefeated, target: 1, ko: "대장 도깨비 퇴치", en: "Defeat the chief"},
        {id: "courier", done: game.finished && !early && game.mistakes === 0, progress: game.mistakes === 0 ? 1 : 0, target: 1, ko: "배달부 무사 통과", en: "Protect every courier"},
    ];
}
