import type {AgentProfile, JsonValue} from "./contracts";

export const RACE_ROUNDS = 3;
export const SEASON_TOKENS = 3;
export const RACE_ENTRY_COST = 1;
export const RACE_STRATEGIES = ["burst", "conserve", "surge"] as const;
export const RACE_CHECKPOINTS = [12, 24] as const;
export const RACE_PACES = ["save", "steady", "push"] as const;
export type RacePace = typeof RACE_PACES[number];
export const RACE_ROUTES = ["shortcut", "wide"] as const;
export type RaceRoute = typeof RACE_ROUTES[number];
export type RaceTerrain = "mud" | "hill" | "meadow";
export type RaceCommand = {at: number; pace: RacePace; route: RaceRoute};
export const RACE_ROUTE_SECONDS = 8;
export const RACE_BURST_COST = 20;
export const RACE_BURST_SECONDS = 4;
export const RACE_BURST_SPEED = 1.7;
export type RaceBurst = {id: string; at: number; staminaBefore: number};
export type RaceCall = RaceCommand & {id: string};

export function raceTerrain(course: RaceCourse, checkpoint: number): RaceTerrain {
    return course.weather === "rain" && checkpoint === 0 ? "mud" : (course.round + checkpoint) % 2 === 0 ? "hill" : "meadow";
}

/** Public terrain trade-offs, not a random penalty applied after the choice. */
export function raceRouteEffect(terrain: RaceTerrain, route: RaceRoute, pace: RacePace, stamina: number) {
    if (route === "wide") return {speed: .97, drain: .6};
    if (terrain === "mud") return {speed: pace === "push" ? .72 : 1.12, drain: 1.3};
    if (terrain === "hill") return {speed: stamina < 25 ? .85 : 1.15, drain: 1.9};
    return {speed: 1.15, drain: 1.15};
}
export type RaceStrategy = typeof RACE_STRATEGIES[number];
export type RaceAction = {enter: boolean; strategy: RaceStrategy};
export type RaceCourse = {
    round: number; seed: number; weather: "clear" | "rain" | "wind";
    course: "short" | "long"; distance: number; gust: number;
};
export type Racer = {id: string; name: string; strategy: RaceStrategy};
export type RacePosition = {id: string; distance: number; stamina: number};
export type RaceFrame = {time: number; positions: RacePosition[]};
export type RaceFinish = {id: string; rank: number; seconds: number; stamina: number; points: number};
export type RaceSimulation = {course: RaceCourse; entrants: Racer[]; frames: RaceFrame[]; finish: RaceFinish[]; seconds: number; calls: RaceCall[]; bursts: RaceBurst[]};
export type SeasonRunner = {id: string; name: string; strategy: RaceStrategy; tokens: number; points: number; entries: number; wins: number};
export type RaceRound = {action: RaceAction; commands: RaceCommand[]; burstAt: number | null | undefined; simulation: RaceSimulation};
export type RaceSeason = {seed: number; round: number; runners: SeasonRunner[]; rounds: RaceRound[]; rivalId: string};

function hash(seed: number): number {
    let value = seed >>> 0;
    value = Math.imul(value ^ value >>> 16, 0x7feb352d);
    value = Math.imul(value ^ value >>> 15, 0x846ca68b);
    return (value ^ value >>> 16) >>> 0;
}

export function makeRaceCourse(seed: number, round: number): RaceCourse {
    if (!Number.isSafeInteger(seed) || !Number.isInteger(round) || round < 0 || round >= RACE_ROUNDS) throw new Error("Invalid race seed or round");
    const value = hash(seed + round * 2654435761);
    const weather = (["clear", "rain", "wind"] as const)[value % 3]!;
    const course = (value >>> 4) % 2 === 0 ? "short" : "long";
    return {seed, round, weather, course, distance: course === "short" ? 850 : 1_250, gust: (value >>> 8) % 100 / 100 * Math.PI * 2};
}

/** Model output cannot introduce a new fee, token balance, speed or per-frame action. */
export function parseRaceAction(value: unknown): RaceAction | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (Object.keys(item).some(key => key !== "enter" && key !== "strategy")) return null;
    if (typeof item.enter !== "boolean" || !RACE_STRATEGIES.some(strategy => strategy === item.strategy)) return null;
    return {enter: item.enter, strategy: item.strategy as RaceStrategy};
}

export function raceObservation(season: RaceSeason, profile: AgentProfile): Record<string, JsonValue> {
    if (season.round >= RACE_ROUNDS) throw new Error("Season already finished");
    const course = makeRaceCourse(season.seed, season.round);
    const owner = season.runners.find(runner => runner.id === "owner")!;
    return {
        round: season.round + 1, weather: course.weather, course: course.course,
        distance: course.distance, seasonTokens: owner.tokens, entryCost: RACE_ENTRY_COST,
        seasonPoints: owner.points, remainingRounds: RACE_ROUNDS - season.round,
        ownerGoal: profile.goal,
        rival: season.runners.find(runner => runner.id === season.rivalId)!.name,
        checkpoints: [...RACE_CHECKPOINTS], burstStaminaCost: RACE_BURST_COST, burstSeconds: RACE_BURST_SECONDS,
        standings: season.runners.map(runner => ({name: runner.name, points: runner.points, entries: runner.entries})),
        previousFinishes: season.rounds.map(round => round.simulation.finish.find(finish => finish.id === "owner")?.rank ?? null),
        rules: "Choose enter and strategy (burst, conserve, surge). 3 races; everyone starts with 3 game-only entry tokens. Entry costs 1; skipping costs 0 and scores 0. Places earn 5/3/2/1 season points; tied times earn equal points. All horses have identical base speed and stamina. Burst is fast early but tires; conserve saves stamina; surge attacks late. Rain drains stamina; long courses reward endurance. These tokens have no cash value and cannot change the owner's allowance. One decision before each race; the engine runs movement. Your chosen strategy also drives a deterministic motor at two forks (12 and 24 simulation seconds): it chooses legal pace/path using public terrain and current stamina. The same motor drives the opponents. Everyone may use one burst: 1.7x speed for 4 simulation seconds, costing 20 stamina immediately, only when at least 20 remains. Burst strategy triggers it at 22% distance; conserve at 78%; surge at 65%. No forced comeback or hidden stat advantage.",
    };
}

export function chooseRaceAction(profile: AgentProfile, course: RaceCourse, tokens: number): {
    action: RaceAction; explanation: {ko: string; en: string};
} {
    if (tokens < RACE_ENTRY_COST || (profile.goal === "save" && course.course === "long" && course.weather === "rain")) {
        return {action: {enter: false, strategy: "conserve"}, explanation: {
            ko: tokens < 1 ? "시즌 참가 토큰이 없어 이번 경기는 관전할게요." : "비 오는 장거리는 쉬고 참가 토큰을 아낄게요. 점수는 받지 못해요.",
            en: tokens < 1 ? "No season entry tokens remain; I'll watch this race." : "I'll save an entry token on this rainy long course. Skipping earns no points.",
        }};
    }
    const strategy: RaceStrategy = profile.goal === "explore" ? RACE_STRATEGIES[course.round]!
        : profile.goal === "save" || (course.course === "long" && course.weather === "rain") ? "conserve"
        : course.course === "short" && course.weather === "clear" ? "burst" : "surge";
    const reasons = {
        burst: {ko: "짧은 코스라 초반에 앞서 나갈게요. 뒤에서는 체력이 떨어질 수 있어요.", en: "A short course: take an early lead, accepting fatigue later."},
        conserve: {ko: "체력 소모가 큰 경기예요. 앞부분은 아끼고 끝까지 달릴게요.", en: "This course taxes stamina. I'll pace the opening and keep running to the line."},
        surge: {ko: "앞에서는 흐름을 따라가고, 남겨 둔 체력으로 마지막에 추월할게요.", en: "Follow the field early, then use the saved stamina for a late pass."},
    };
    return {action: {enter: true, strategy}, explanation: profile.goal === "explore" ? {
        ko: `새 전략을 시험해 볼게요. ${reasons[strategy].ko}`, en: `I'll try a different strategy. ${reasons[strategy].en}`,
    } : reasons[strategy]};
}

function effort(strategy: RaceStrategy, progress: number): number {
    if (strategy === "burst") return progress < .32 ? 1.42 : progress < .68 ? 1.04 : .98;
    if (strategy === "conserve") return progress < .62 ? .97 : 1.2;
    return progress < .58 ? 1.02 : progress < .8 ? 1.14 : 1.35;
}

/** Each strategy plans with public terrain and its own energy, never a rival's future finish. */
export function raceMotorCall(course: RaceCourse, strategy: RaceStrategy, checkpoint: number, stamina: number): RaceCommand {
    const at = RACE_CHECKPOINTS[checkpoint];
    if (at === undefined) throw new Error("Invalid race checkpoint");
    const pace: RacePace = stamina < 35 || (course.course === "long" && course.weather === "rain") ? "save"
        : strategy === "burst" ? (checkpoint === 0 ? "steady" : "save")
        : strategy === "conserve" ? "save" : checkpoint === 0 ? "save" : "steady";
    const terrain = raceTerrain(course, checkpoint);
    const route: RaceRoute = terrain === "hill" && stamina < 50 ? "wide" : "shortcut";
    return {at, pace, route};
}

/** Fixed steps keep replay, pause, frame rate and reduced motion irrelevant to results.
 * An omitted burst time uses the strategy motor; null reserves it for a human.
 * Owner overrides replace only future legal calls. Every opponent has the same bounds. */
export function simulateRace(course: RaceCourse, entrants: Racer[], commands: readonly RaceCommand[] = [], burstAt?: number | null): RaceSimulation {
    if (!Number.isFinite(course.distance) || course.distance < 1 || course.distance > 2_000 || !Number.isFinite(course.gust)
        || !["clear", "rain", "wind"].includes(course.weather)
        || entrants.length < 1 || entrants.length > 4 || new Set(entrants.map(runner => runner.id)).size !== entrants.length
        || entrants.some(runner => !RACE_STRATEGIES.includes(runner.strategy))) throw new Error("Invalid race entrants or course");
    if (commands.length > RACE_CHECKPOINTS.length || commands.some((command, index) =>
        command.at !== RACE_CHECKPOINTS[index] || !RACE_PACES.includes(command.pace) || !RACE_ROUTES.includes(command.route) || Object.keys(command).some(key => key !== "at" && key !== "pace" && key !== "route"))
        || (commands.length > 0 && !entrants.some(runner => runner.id === "owner"))) throw new Error("Invalid race checkpoint command");
    if (burstAt !== undefined && burstAt !== null && (!Number.isFinite(burstAt) || burstAt < 0 || burstAt > 200
        || Math.abs(burstAt * 10 - Math.round(burstAt * 10)) > 1e-7 || !entrants.some(runner => runner.id === "owner"))) throw new Error("Invalid race burst time");
    const positions: RacePosition[] = entrants.map(runner => ({id: runner.id, distance: 0, stamina: 100}));
    const frames: RaceFrame[] = [{time: 0, positions: positions.map(position => ({...position}))}];
    const times = new Map<string, number>();
    const calls: RaceCall[] = [], bursts: RaceBurst[] = [];
    const step = .1;
    let time = 0;
    for (let tick = 0; tick < 2_000 && times.size < entrants.length; tick++) {
        const now = tick / 10;
        time = (tick + 1) / 10;
        for (let index = 0; index < entrants.length; index++) {
            const runner = entrants[index]!;
            const position = positions[index]!;
            if (times.has(runner.id)) continue;
            const checkpoint = RACE_CHECKPOINTS.findIndex(at => at === now);
            if (checkpoint >= 0) {
                const command = (runner.id === "owner" ? commands[checkpoint] : undefined)
                    ?? raceMotorCall(course, runner.strategy, checkpoint, position.stamina);
                calls.push({...command, id: runner.id});
            }
            let burst = bursts.find(item => item.id === runner.id);
            const requested = runner.id === "owner" && burstAt !== undefined
                ? burstAt !== null && now === burstAt
                : position.distance / course.distance >= {burst: .22, conserve: .78, surge: .65}[runner.strategy];
            if (!burst && requested && position.stamina >= RACE_BURST_COST) {
                burst = {id: runner.id, at: now, staminaBefore: position.stamina};
                bursts.push(burst);
                position.stamina -= RACE_BURST_COST;
            }
            const command = calls.findLast(change => change.id === runner.id);
            // A fork affects its eight-second section; the chosen strategy resumes afterward.
            const activeCall = command && now < command.at + RACE_ROUTE_SECONDS ? command : undefined;
            const pace = activeCall ? {save: .88, steady: 1.12, push: 1.55}[activeCall.pace] : effort(runner.strategy, position.distance / course.distance);
            const weather = course.weather === "rain" ? .91 : course.weather === "wind" ? .96 + Math.sin(position.distance / 80 + course.gust) * .07 : 1;
            const fatigue = .4 + .6 * Math.min(1, position.stamina / 25);
            const route = activeCall ? raceRouteEffect(raceTerrain(course, RACE_CHECKPOINTS.indexOf(activeCall.at as typeof RACE_CHECKPOINTS[number])), activeCall.route, activeCall.pace, position.stamina) : {speed: 1, drain: 1};
            const burstSpeed = burst && now < burst.at + RACE_BURST_SECONDS ? RACE_BURST_SPEED : 1;
            const speed = 19 * pace * weather * fatigue * route.speed * burstSpeed;
            const efficiency = activeCall ? 1 : runner.strategy === "conserve" ? .65 : runner.strategy === "burst" ? 1.1 : .92;
            const drain = ((pace ** 3 * 1.55 - .8) + (course.weather === "rain" ? .48 : course.weather === "wind" ? .22 : 0)) * efficiency;
            const before = position.distance;
            position.distance = Math.min(course.distance, before + speed * step);
            position.stamina = Math.max(0, position.stamina - drain * route.drain * step);
            if (position.distance === course.distance) times.set(runner.id, time - step + (course.distance - before) / speed);
        }
        frames.push({time, positions: positions.map(position => ({...position}))});
    }
    if (times.size !== entrants.length) throw new Error("Race simulation exceeded its time bound");
    const finish = positions.map(position => {
        const seconds = times.get(position.id)!;
        const rank = 1 + [...times.values()].filter(other => other < seconds - 1e-7).length;
        return {id: position.id, seconds, rank, stamina: position.stamina, points: [5, 3, 2, 1][rank - 1]!};
    }).sort((a, b) => a.seconds - b.seconds || a.id.localeCompare(b.id));
    return {course: {...course}, entrants: entrants.map(runner => ({...runner})), frames, finish, seconds: time, calls, bursts};
}

/** Highlights describe measured positions during a burst, not an invented causal story. */
export function raceHighlights(race: RaceSimulation): {ko: string; en: string}[] {
    const burst = race.bursts.find(item => item.id === "owner" && item.at < raceEndTime(race));
    if (!burst) return [];
    const before = raceFrameAt(race, burst.at / race.seconds);
    const after = raceFrameAt(race, Math.min(burst.at + RACE_BURST_SECONDS, raceEndTime(race)) / race.seconds);
    const gained = raceLiveRank(race, before, "owner") - raceLiveRank(race, after, "owner");
    const round = race.course.round + 1;
    return [gained > 0 ? {ko: `${round}경기 승부수 구간에서 ${gained}자리 추월했어요.`, en: `Race ${round}: gained ${gained} place${gained > 1 ? "s" : ""} during the burst.`}
        : {ko: `${round}경기 체력 ${Math.round(burst.staminaBefore)}%에서 승부수. 구간 끝 ${raceLiveRank(race, after, "owner")}위였어요.`, en: `Race ${round}: burst at ${Math.round(burst.staminaBefore)}% energy; place ${raceLiveRank(race, after, "owner")} at its end.`}];
}

/** Finished runners retain their actual finish order; equal distances share a rank. */
export function raceLiveRank(race: RaceSimulation, frame: RaceFrame, id: string): number {
    const position = frame.positions.find(p => p.id === id);
    if (!position) return 0;
    const finish = race.finish.find(p => p.id === id)!;
    return 1 + frame.positions.filter(p => p.id !== id && (p.distance > position.distance + 1e-7 ||
        (position.distance >= race.course.distance && p.distance >= race.course.distance && race.finish.find(f => f.id === p.id)!.seconds < finish.seconds - 1e-7))).length;
}

export function createRaceSeason(seed: number, name: string, locale: "ko" | "en"): RaceSeason {
    makeRaceCourse(seed, 0);
    const labels = locale === "ko" ? ["번개", "느긋", "막판"] : ["Flash", "Steady", "Closer"];
    const runners: Racer[] = [
        {id: "owner", name, strategy: "conserve"},
        ...RACE_STRATEGIES.map((strategy, index) => ({id: strategy, name: labels[index]!, strategy})),
    ];
    return {seed, round: 0, rounds: [], rivalId: RACE_STRATEGIES[hash(seed) % RACE_STRATEGIES.length]!, runners: runners.map(runner => ({...runner, tokens: SEASON_TOKENS, points: 0, entries: 0, wins: 0}))};
}

export function applyRaceRound(season: RaceSeason, input: RaceAction, commands: readonly RaceCommand[] = [], burstAt?: number | null): RaceSeason {
    const action = parseRaceAction(input);
    if (!action || season.round < 0 || season.round >= RACE_ROUNDS) throw new Error("Invalid race action or finished season");
    if (action.enter && season.runners.find(runner => runner.id === "owner")!.tokens < RACE_ENTRY_COST) throw new Error("Season entry token limit exceeded");
    const entrants = season.runners.filter(runner => runner.tokens >= 1 && (runner.id !== "owner" || action.enter))
        .map(runner => ({id: runner.id, name: runner.name, strategy: runner.id === "owner" ? action.strategy : runner.strategy}));
    const simulation = simulateRace(makeRaceCourse(season.seed, season.round), entrants, commands, burstAt);
    const runners = season.runners.map(runner => {
        const result = simulation.finish.find(finish => finish.id === runner.id);
        return result ? {...runner, strategy: runner.id === "owner" ? action.strategy : runner.strategy,
            tokens: runner.tokens - RACE_ENTRY_COST, points: runner.points + result.points,
            entries: runner.entries + 1, wins: runner.wins + (result.rank === 1 ? 1 : 0)} : {...runner};
    });
    return {...season, round: season.round + 1, runners, rounds: [...season.rounds, {action, commands: commands.map(command => ({...command})), burstAt, simulation}]};
}

export function seasonRanking(season: RaceSeason): (SeasonRunner & {rank: number})[] {
    return season.runners.map(runner => ({...runner, rank: 1 + season.runners.filter(other => other.points > runner.points).length}))
        .sort((a, b) => b.points - a.points || a.id.localeCompare(b.id));
}

/** Three arrivals settle a four-runner race; the remaining runner cannot change place. */
export function raceEndTime(race: RaceSimulation): number {
    return race.finish[Math.min(2, race.finish.length - 1)]!.seconds;
}

export function raceNextCheckpoint(race: RaceSimulation, calls: number): number | undefined {
    const next = RACE_CHECKPOINTS[calls];
    const ownerFinish = race.finish.find(runner => runner.id === "owner")?.seconds ?? 0;
    return next !== undefined && next < Math.min(ownerFinish, raceEndTime(race)) ? next : undefined;
}

export function raceFrameAt(race: RaceSimulation, progress: number): RaceFrame {
    const time = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0)) * race.seconds;
    const upperIndex = Math.min(race.frames.length - 1, Math.ceil(time / .1));
    const upper = race.frames[upperIndex]!;
    const lower = race.frames[Math.max(0, upperIndex - 1)]!;
    const weight = upper.time === lower.time ? 1 : Math.max(0, Math.min(1, (time - lower.time) / (upper.time - lower.time)));
    return {time, positions: lower.positions.map((position, index) => ({id: position.id,
        distance: time >= race.finish.find(finish => finish.id === position.id)!.seconds - 1e-7 ? race.course.distance
            : position.distance + (upper.positions[index]!.distance - position.distance) * weight,
        stamina: position.stamina + (upper.positions[index]!.stamina - position.stamina) * weight,
    }))};
}
