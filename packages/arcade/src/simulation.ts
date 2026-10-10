import {ARCADE_RULESET_VERSION, type ActivityOutcome, type AgentDecision, type AgentProfile, type GameId} from "./contracts";
import {applyRaceRound, chooseRaceAction, createRaceSeason, makeRaceCourse, raceEndTime, raceHighlights, RACE_ROUNDS, seasonRanking, type RaceSeason, type RaceStrategy} from "./race";
import {applyBuyerAction, applySellerAction, createShop, DEFAULT_SHOP_CONFIG, nextShopCustomer, parseShopMemory, ruleBuyerAction, ruleSellerAction, shopBuyerObservation, shopOutcome, shopSellerObservation, type ShopMemory} from "./shop";
import {advanceAgent, newGame, ROUND_MS, stampHighlights, type Game} from "./stamp";
import {validGuardianAptitudes} from "./guardians";

type Locale = "ko" | "en";
export type RaceNote = {round: number; decision: Omit<AgentDecision, "source"> & {source: "human" | AgentDecision["source"]}; enter: boolean; strategy: RaceStrategy};
const raceLabels = {
    ko: {local: "규칙 기반 봇", source: "결정", enter: "출전", skip: "이번엔 관전", burst: "초반 질주", conserve: "체력 보존", surge: "후반 추월", shortcut: "안쪽 지름길", wide: "바깥 안전길", save: "힘 아끼기", steady: "리듬 유지", push: "속도 올리기", title: "달려라 마패"},
    en: {local: "Rule-based bot", source: "Decision", enter: "Enter", skip: "Watch this one", burst: "Early burst", conserve: "Save stamina", surge: "Late surge", shortcut: "Inside shortcut", wide: "Wide safe route", save: "Save energy", steady: "Hold pace", push: "Push harder", title: "Auto Race"},
} as const;

/** Browser and server summarize the same completed season and engine-observed turning points. */
export function raceOutcome(season: RaceSeason, notes: RaceNote[], locale: Locale): ActivityOutcome {
    const owner = season.runners.find(runner => runner.id === "owner")!;
    const rank = seasonRanking(season).find(runner => runner.id === "owner")!.rank;
    const t = raceLabels[locale];
    const human = notes.length > 0 && notes.every(note => note.decision.source === "human");
    const rival = season.runners.find(runner => runner.id === season.rivalId)!;
    const highlights = season.rounds.flatMap(round => raceHighlights(round.simulation)).slice(-1);
    if (owner.entries > 0) highlights.push({ko: `시즌 라이벌 ${rival.name}와 ${owner.points} 대 ${rival.points}점.`, en: `Season rival ${rival.name}: ${owner.points} to ${rival.points} points.`});
    return {
        game: "race", score: owner.points, highlights, achievement: {victory: rank === 1 && owner.entries > 0},
        replay: {seed: season.seed, version: ARCADE_RULESET_VERSION, ...(season.aptitudes ? {aptitudes: {...season.aptitudes}} : {})},
        summary: {ko: `${RACE_ROUNDS}경기 시즌 ${rank}위 · ${owner.entries}회 출전 · ${owner.points}점`, en: `Place ${rank} over ${RACE_ROUNDS} races · ${owner.entries} entries · ${owner.points} points`},
        metrics: [
            {label: {ko: "출전 수", en: "Races entered"}, value: owner.entries},
            {label: {ko: "우승", en: "Wins"}, value: owner.wins},
            ...human ? [] : [{label: {ko: "관전한 경기", en: "Races watched"}, value: RACE_ROUNDS - owner.entries}],
        ],
        transcript: notes.flatMap(note => {
            const race = season.rounds[note.round]!.simulation;
            const result = race.finish.find(finish => finish.id === "owner");
            const timeLabel = result && result.seconds <= raceEndTime(race) ? `${result.seconds.toFixed(2)}${locale === "ko" ? "초" : "s"}` : locale === "ko" ? "순위 확정" : "Place confirmed";
            return [
                {speaker: `${owner.name} · ${note.decision.source === "human" ? locale === "ko" ? "직접 선택" : "Human choice" : note.decision.source === "llm" ? "LLM" : t.local}`, text: note.decision.explanation},
                {speaker: `${note.round + 1} / ${t.source}`, text: `${note.decision.source === "human" ? (locale === "ko" ? "직접 선택" : "Human choice") : note.decision.model || t.local} · ${note.enter ? t.enter : t.skip} / ${t[note.strategy]}`},
                ...race.calls.filter(call => call.id === "owner").map((command, index) => ({speaker: locale === "ko" ? `구간 작전 ${index + 1}` : `Checkpoint ${index + 1}`, text: `${t[command.route]} · ${t[command.pace]}`})),
                {speaker: t.title, text: locale === "ko" ? result ? `${result.rank}위 · ${timeLabel} · ${result.points}점${human ? "" : " · 출전권 1회 사용"}`
                    : "관전 · 0점 · 보상 없음" : result ? `Place ${result.rank} · ${timeLabel} · ${result.points} points${human ? "" : " · 1 included entry used"}` : "Watched · 0 points · no reward"},
            ];
        }),
        ranking: seasonRanking(season).map(runner => ({name: runner.name, score: runner.points})),
    };
}

export function stampOutcome(game: Game, name: string, explanation: string): ActivityOutcome {
    return {
        game: "stamp", score: game.score, achievement: {victory: game.finished && game.bossDefeated > 0}, replay: {seed: game.seed, version: ARCADE_RULESET_VERSION, ...(game.aptitudes ? {aptitudes: {...game.aptitudes}} : {})},
        summary: {ko: `${game.hits}번 찍고 최대 ${game.bestCombo}콤보를 만들었어요.`, en: `${game.hits} stamps, best combo ${game.bestCombo}.`},
        metrics: [{label: {ko: "최대 콤보", en: "Best combo"}, value: game.bestCombo}, {label: {ko: "퇴치", en: "Hits"}, value: game.hits}, {label: {ko: "실수", en: "Mistakes"}, value: game.mistakes}, {label: {ko: "갑옷 도깨비", en: "Armored goblins"}, value: game.armorHits}, {label: {ko: "대장 퇴치", en: "Chief defeated"}, value: game.bossDefeated}, {label: {ko: "대장 정통", en: "Precise chief stamps"}, value: game.perfectHits}],
        highlights: stampHighlights(game), transcript: [{speaker: name, text: explanation}], ranking: [],
    };
}

/** Outing preference chooses a game; spending permission is checked separately before admission. */
export function chooseOutingGame(profile: AgentProfile, choice: GameId | "auto", visited: readonly GameId[]): GameId {
    if (choice === "stamp" || choice === "race" || choice === "shop") return choice;
    if (choice !== "auto") throw new Error("Invalid outing game");
    if (profile.goal === "score") return profile.aptitudes ? (["stamp", "race", "shop"] as const).reduce((best, game) => profile.aptitudes![game] > profile.aptitudes![best] ? game : best, "stamp") : "race";
    if (profile.goal === "save") return "shop";
    if (profile.goal !== "explore") throw new Error("Invalid outing goal");
    return (["race", "shop", "stamp"] as const).find(game => !visited.includes(game)) ?? "race";
}

export function stampStrategy(profile: AgentProfile, locale: Locale) {
    return {tempo: profile.temperament === "bold" ? "quick" as const : "careful" as const,
        explanation: locale === "ko" ? "도깨비만 확인하고 찍어요. 성향에 따라 반응 속도를 정했어요." : "I check for goblins before stamping; temperament sets my reaction speed."};
}

/** No clocks, network, private opponent state or score shortcuts: run the existing engines to completion. */
export function runArcadeSimulation({game, seed, profile, locale, shopMemory}: {
    game: GameId; seed: number; profile: AgentProfile; locale: Locale; shopMemory?: ShopMemory;
}): ActivityOutcome {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("Invalid arcade seed");
    if (locale !== "ko" && locale !== "en") throw new Error("Invalid arcade locale");
    if (!profile || typeof profile.name !== "string" || !profile.name.trim() || profile.name.length > 30 ||
        !["red", "jade", "ink"].includes(profile.color) || !["curious", "bold", "calm"].includes(profile.temperament) || !["score", "save", "explore"].includes(profile.goal)) throw new Error("Invalid arcade profile");
    if (profile.aptitudes !== undefined && !validGuardianAptitudes(profile.aptitudes)) throw new Error("Invalid guardian aptitudes");
    if (shopMemory !== undefined && parseShopMemory(shopMemory) === null) throw new Error("Invalid shop memory");
    if (game === "stamp") {
        const strategy = stampStrategy(profile, locale);
        const completed = advanceAgent(newGame(seed, "auto", profile.aptitudes), ROUND_MS, strategy.tempo);
        if (!completed.finished) throw new Error("Stamp did not finish");
        return stampOutcome(completed, profile.name, strategy.explanation);
    }
    if (game === "race") {
        let season = createRaceSeason(seed, profile.name, locale, profile.aptitudes);
        const notes: RaceNote[] = [];
        for (let round = 0; round < RACE_ROUNDS; round++) {
            const policy = chooseRaceAction(profile, makeRaceCourse(seed, season.round), season.runners.find(runner => runner.id === "owner")!.tokens);
            notes.push({round, enter: policy.action.enter, strategy: policy.action.strategy, decision: {source: "rules", action: policy.action, explanation: policy.explanation[locale]}});
            season = applyRaceRound(season, policy.action);
        }
        if (season.round !== RACE_ROUNDS) throw new Error("Race did not finish");
        return raceOutcome(season, notes, locale);
    }
    if (game === "shop") {
        const config = {...DEFAULT_SHOP_CONFIG, name: locale === "ko" ? `${profile.name.slice(0, 10)} 잡화점` : `${profile.name.slice(0, 10)}'s shop`};
        let state = createShop(seed, config, shopMemory, profile.aptitudes);
        // Same turn boundary and role-specific observations as ShopGame, with a finite guard.
        for (let turn = 0; turn < 64 && state.phase !== "finished"; turn++) {
            state = state.phase === "transition" ? nextShopCustomer(state) : state.phase === "seller"
                ? applySellerAction(state, ruleSellerAction(shopSellerObservation(state), locale))
                : applyBuyerAction(state, ruleBuyerAction(shopBuyerObservation(state)));
        }
        if (state.phase !== "finished") throw new Error("Shop did not finish");
        const outcome = shopOutcome(state, profile.name, locale);
        outcome.transcript.unshift({speaker: "MAPAE", text: locale === "ko" ? `${profile.name} · 판매 에이전트 · 규칙 기반 에이전트. 상대 · 시스템 규칙.` : `${profile.name} · Seller agent · Rule-based agent. Opponent · system rules.`});
        return outcome;
    }
    throw new Error("Invalid arcade game");
}
