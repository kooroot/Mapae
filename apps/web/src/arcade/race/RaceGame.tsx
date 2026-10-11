import {raceOutcome} from "@mapae/arcade/simulation";
import {MOCK_USDC} from "@mapae/shared";
import {Fragment, useEffect, useLayoutEffect, useRef, useState} from "react";
import type {AgentDecision} from "@mapae/arcade";
import {applyRaceRound, createRaceSeason, makeRaceCourse, raceEndTime, raceNextCheckpoint, raceFrameAt,
    RACE_BURST_COST, RACE_HABITS, RACE_DRAFT_DISTANCE, raceTraffic, raceHighlights, RACE_CHECKPOINTS, RACE_PACES, RACE_ROUTES, raceTerrain, type RaceTerrain, type RaceRoute, type RaceCommand, type RacePace, RACE_ROUNDS, SEASON_TOKENS, seasonRanking, type RaceSimulation, type RaceStrategy, type RaceAction} from "@mapae/arcade/race";
import type {PlayableGameProps} from "../agent-contract";
import {motionTier, type MotionTier} from "../motion";
import {countUp, holdEffects, riseIn} from "../juice";
import type {ArcadeSound} from "../sound";
import {GuardianAvatar} from "../GuardianAvatar";
import {GameArt} from "../Characters";
import {requestRaceDecision} from "./decision";
import {GAME_NAMES} from "../game-names";
import {GameGuide} from "../GameGuide";
import {RaceTrack} from "./RaceTrack";
import {BEAT_MS, cueSeal, cueStartBeat, pressBurst, startSignal, START_BEATS} from "./race-fx";
import "./race.css";
import "./race-play.css";

const COPY = {
    ko: {
        title: "달려라 마패", subtitle: "감독님은 편하게 관전하세요. 에이전트가 상대를 보고 작전을 정해요.",
        rules: "규칙 기반 봇", llm: "실제 LLM 에이전트", season: "3경기 시즌", ticket: "시즌 입장권에 3경기 포함 · 베팅·현금 상금 없음",
        fairness: "모두 같은 말 능력치로 세 경기를 달려요. 세 번의 출전은 이미 포함돼 있어요. 관전은 0점이고 남은 출전권은 보상 없이 사라져요.",
        points: "순위별 5 / 3 / 2 / 1점 · 세 마리가 도착하면 경기 종료 · 같은 기록은 공동 순위", start: "지금 바로 출발", back: "경기에서 나가기",
        round: "경기", thinking: "코스와 상대를 살펴보고 있어요…", deciding: "출전과 전략을 결정하는 중", enter: "출전", skip: "이번엔 관전",
        entry: "출전권", left: "남은 출전권", strategy: "작전", pause: "관전 잠깐 멈추기", resume: "계속 관전하기", fast: "경기 결과 바로 보기",
        held: "관전을 멈췄어요. 다음 경기 결정도 기다려요.", auto: "잠시 후 에이전트가 다음 경기를 준비해요.", next: "다음 경기로", result: "시즌 결과 보기",
        rankings: "시즌 순위", competitor: "출전자", score: "시즌 점수", spent: "출전 수", stamina: "체력", standingsNote: "같은 조건의 시스템 상대와 비교한 이번 시즌 기록이에요.",
        clear: "맑음", rain: "비", wind: "맞바람", short: "짧은 코스", long: "긴 코스", burst: "초반 질주", conserve: "체력 보존", surge: "후반 추월",
        error: "결정을 받지 못했어요. 참가 토큰은 차감되지 않았어요.", errorDetail: "연결 상태와 모델 설정을 확인한 뒤 다시 시도해 주세요. 규칙 봇으로 바꾸지 않았어요.", retry: "같은 경기 결정 다시 받기",
        history: "감독 노트", noEntry: "에이전트가 이번 경기는 쉬기로 했어요. 다른 말들의 경기를 관전해요.", watching: "관전 중", source: "결정", local: "브라우저 규칙", your: "우리 팀",
        settled: "경기 종료", budget: "공통 용돈", budgetNote: "입장 후 남은 용돈 · 경기 중 추가 결제 없음", exitNote: "지금 나가면 시즌 기록은 남지 않고 입장권은 사용된 채로 유지돼요.",
        reduce: "움직임 줄이기 적용 · 움직이는 대신 구간별 위치로 보여요.", sample: "내 에이전트",
    },
    en: {
        title: "Small horses. Big race.", subtitle: "You're the coach. Your agent reads the field and picks a strategy.",
        rules: "Rules-based bot", llm: "Real LLM agent", season: "3-race season", ticket: "Season ticket includes 3 races · No betting or cash prizes",
        fairness: "Identical horses, three included entries. Watching earns zero points; unused entries expire without a reward.",
        points: "Places earn 5 / 3 / 2 / 1 points · Race ends at the third arrival · Equal times share a place", start: "Start right now", back: "Leave the race",
        round: "RACE", thinking: "Studying the course and rivals…", deciding: "Choosing entry and strategy", enter: "Enter", skip: "Watch this one",
        entry: "Entries", left: "Entries left", strategy: "Strategy", pause: "Pause watching", resume: "Keep watching", fast: "See race result now",
        held: "Watching is paused. The next decision waits too.", auto: "Your agent will prepare the next race shortly.", next: "Next race", result: "See season results",
        rankings: "Season standings", competitor: "Runner", score: "Season points", spent: "Races entered", stamina: "Stamina", standingsNote: "This season compares your agent with system rivals under equal conditions.",
        clear: "Clear", rain: "Rain", wind: "Headwind", short: "Short course", long: "Long course", burst: "Early burst", conserve: "Save stamina", surge: "Late surge",
        error: "The decision failed. No entry tokens were spent.", errorDetail: "Check the connection and model settings, then retry. We have not switched to a rules bot.", retry: "Retry this race decision",
        history: "Coach's notebook", noEntry: "Your agent is sitting this one out. Watch the other horses race.", watching: "WATCHING", source: "Decision", local: "Browser rules", your: "YOUR TEAM",
        settled: "Race finished", budget: "Shared allowance", budgetNote: "Remaining after admission · No extra payments during races", exitNote: "Leaving now discards this season's record. Its admission remains used.",
        reduce: "Reduced motion · Positions update in stages instead of continuous movement.", sample: "My agent",
    },
} as const;

/** HUD text pace (~8Hz): positions move every frame without a React render. */
const HUD_MS = 120;
type Phase = "choose" | "brief" | "thinking" | "race" | "checkpoint" | "recap" | "error";
type Note = {round: number; decision: Omit<AgentDecision, "source"> & {source: "human" | AgentDecision["source"]}; enter: boolean; strategy: RaceStrategy};

export function RaceGame({appearance, profile, locale, mode, seed, budget, decide, reducedMotion, sound, suspended = false, autoAdvance = false, onComplete, onExit}: PlayableGameProps) {
    const human = mode === "human", ko = locale === "ko";
    const t = {...COPY[locale], ...(human ? {
        subtitle: ko ? "힘을 아낄까, 지금 치고 나갈까? 내가 부르는 작전, 말이 만드는 역전." : "Save your strength or make a move? Call the pace. Chase the finish.",
        fairness: ko ? "같은 능력치의 말로 세 경기를 달려요. 경기마다 두 갈림길에서 작전을 바꾸고, 한 번뿐인 승부수로 추월을 노려요." : "Three races with equally matched horses. Two forks, one burst: pick your moment to pass.",
        ticket: ko ? "직접 연습 · 무료 · 토큰 결제 없음" : "Human practice · Free · No token payments",
        noEntry: ko ? "이번 경기는 쉬기로 했어요. 다른 말들의 경기를 관전해요." : "You chose to sit out. Watch the other horses race.",
        exitNote: ko ? "지금 나가면 이번 시즌 점수는 저장되지 않아요." : "Leaving now discards this season's score.",
        watching: ko ? "달리는 중" : "RACING", local: ko ? "직접 선택" : "Human choice", pause: ko ? "잠깐 멈추기" : "Pause", resume: ko ? "계속 달리기" : "Keep racing", spent: ko ? "출전 수" : "Entries",
    } : {})};
    const [route, setRoute] = useState<RaceRoute>("shortcut");
    const [strategy, setStrategy] = useState<RaceStrategy>("burst");
    const [season, setSeason] = useState(() => createRaceSeason(seed, profile.name || t.sample, locale, profile.aptitudes));
    const [phase, setPhase] = useState<Phase>("brief");
    const [notes, setNotes] = useState<Note[]>([]);
    // The clock advances every frame for the runners; `raceTime` follows it at the HUD rate for everything React renders.
    const clock = useRef(0);
    const [raceTime, setRaceTime] = useState(0);
    const seek = (time: number) => {clock.current = time; setRaceTime(time);};
    const [commands, setCommands] = useState<RaceCommand[]>([]);
    const [burstAt, setBurstAt] = useState<number | null>(null);
    const [relaxed, setRelaxed] = useState(false);
    const roundStart = useRef(season);
    const checkpointButton = useRef<HTMLButtonElement>(null);
    const dock = useRef<HTMLDivElement>(null);
    const calls = useRef<HTMLParagraphElement>(null);
    /** The coach just chose at a fork, so its call lands with the seal's thump; a plan running on by itself lands silently. */
    const chose = useRef(false);
    const [paused, setPaused] = useState(false);
    const [speed, setSpeed] = useState(1);
    const blocked = paused || suspended;
    const root = useRef<HTMLElement>(null);
    // CSS motion holds through `data-halted`; every scripted effect in the game holds here, the result's rolling points included.
    useLayoutEffect(() => {if (root.current) holdEffects(root.current, blocked);}, [blocked]);
    // An agent run the owner watches gets feedback without ceremony, so motion never stretches its auto-advance beat.
    const tier = motionTier({still: reducedMotion, watched: autoAdvance});
    // "셋·둘·출발!" before a player's own race; the clock (never the simulation) waits through the first two beats.
    const [signal, setSignal] = useState<number | null>(null);
    const holding = signal !== null && signal < START_BEATS - 1;
    const burstButton = useRef<HTMLButtonElement>(null);
    const standings = useRef<HTMLTableSectionElement>(null);
    const [error, setError] = useState("");
    const busy = useRef(false);
    const finished = useRef(false);
    const alive = useRef(true);
    const request = useRef<AbortController | null>(null);
    const recapButton = useRef<HTMLButtonElement>(null);
    const current = season.rounds.at(-1);
    const endTime = current ? raceEndTime(current.simulation) : 0;
    const progress = current ? Math.min(1, raceTime / current.simulation.seconds) : 0;
    const nextCall = current ? raceNextCheckpoint(current.simulation, commands.length) : undefined;
    const plannedCall = current?.simulation.calls.find(call => call.id === "owner" && call.at === nextCall);
    const windowOpen = human && nextCall !== undefined && (phase === "checkpoint" || (phase === "race" && nextCall - raceTime <= 9));
    const liveFrame = current ? raceFrameAt(current.simulation, progress) : undefined;
    const ownerFrame = liveFrame?.positions.find(p => p.id === "owner");
    const traffic = liveFrame ? raceTraffic(liveFrame.positions.filter(position => position.distance < current!.simulation.course.distance), "owner") : undefined;
    const canBurst = human && phase === "race" && !blocked && !holding && burstAt === null && (ownerFrame?.stamina ?? 0) >= RACE_BURST_COST && (ownerFrame?.distance ?? 0) < (current?.simulation.course.distance ?? 0);
    const displayedRound = phase === "race" || phase === "checkpoint" || phase === "recap" ? season.round - 1 : season.round;
    const course = makeRaceCourse(seed, Math.min(RACE_ROUNDS - 1, displayedRound));

    useEffect(() => {
        alive.current = true;
        return () => {alive.current = false; request.current?.abort();};
    }, []);

    useEffect(() => {
        const pauseIfHidden = () => {if (document.hidden) setPaused(true);};
        const pauseOnBlur = () => setPaused(true);
        // An open settings popover or exit dialog owns Escape (it closes them), as in Stamp and Shop.
        const pauseOnEscape = (event: KeyboardEvent) => {
            if (!suspended && !event.defaultPrevented && event.key === "Escape") setPaused(value => !value);
        };
        document.addEventListener("visibilitychange", pauseIfHidden);
        window.addEventListener("blur", pauseOnBlur);
        window.addEventListener("keydown", pauseOnEscape);
        return () => {
            document.removeEventListener("visibilitychange", pauseIfHidden);
            window.removeEventListener("blur", pauseOnBlur);
            window.removeEventListener("keydown", pauseOnEscape);
        };
    }, [suspended]);

    function playRound(action: RaceAction, decision: Note["decision"]) {
        roundStart.current = season;
        setCommands([]); setBurstAt(null);
        const next = applyRaceRound(season, action, [], human ? null : undefined);
        setRoute(next.rounds.at(-1)!.simulation.calls.find(call => call.id === "owner")?.route ?? "wide");
        setNotes(previous => [...previous, {round: season.round, decision, ...action}]);
        setSeason(next); seek(0); setPaused(false); setPhase("race");
        setSignal(startSignal(human, tier) ? 0 : null);
    }
    function choose(enter: boolean) {
        if (phase !== "choose" || busy.current || suspended) return;
        busy.current = true;
        playRound({enter, strategy}, {source: "human", action: {enter, strategy}, explanation: enter ? `${t.strategy}: ${t[strategy]}` : t.skip});
    }
    const beginRound = async () => {
        if (human) {busy.current = false; setPaused(false); setPhase("choose"); return;}
        if (busy.current || season.round >= RACE_ROUNDS || finished.current) return;
        busy.current = true;
        setPhase("thinking");
        setError("");
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        try {
            const {decision, action} = await requestRaceDecision({profile, locale, mode, season, decide, signal: controller.signal});
            if (!alive.current || controller.signal.aborted) return;
            playRound(action, decision);
        } catch {
            if (alive.current && !controller.signal.aborted) {setError(t.errorDetail); setPhase("error");}
        } finally {
            busy.current = false;
        }
    };

    useEffect(() => {
        if (human || phase !== "brief" || !autoAdvance || blocked) return;
        const timer = window.setTimeout(() => void beginRound(), 5000);
        return () => window.clearTimeout(timer);
    }, [phase, autoAdvance, blocked]);

    useEffect(() => {
        if (signal === null) return;
        // A halt drops the rest of the signal, so resuming races at once instead of counting down again.
        if (blocked) {setSignal(null); return;}
        cueStartBeat(signal, sound);
        const timer = window.setTimeout(() => setSignal(beat => beat !== null && beat < START_BEATS - 1 ? beat + 1 : null), BEAT_MS);
        return () => window.clearTimeout(timer);
    }, [signal, blocked, sound]);

    useEffect(() => {
        if (phase !== "race" || blocked || holding || !current) return;
        let frame = 0;
        let last: number | null = null;
        let painted = 0;
        const checkpoint = human ? raceNextCheckpoint(current.simulation, commands.length) : undefined;
        const tick = (time: number) => {
            if (last !== null) clock.current = Math.min(endTime, clock.current + Math.min(200, time - last) / 1000 * 3 * speed);
            last = time;
            if (checkpoint !== undefined && clock.current >= checkpoint) {
                seek(checkpoint);
                if (relaxed) setPhase("checkpoint");
                else {
                    const call = current.simulation.calls.find(call => call.id === "owner" && call.at === checkpoint)!;
                    setCommands(previous => [...previous, {at: call.at, pace: call.pace, route: call.route}]);
                    setRoute(current.simulation.calls.find(call => call.id === "owner" && call.at > checkpoint)?.route ?? "wide");
                }
                return;
            }
            if (time - painted >= HUD_MS || clock.current >= endTime) {
                setRaceTime(clock.current); painted = time;
            }
            if (clock.current >= endTime) setPhase("recap");
            else frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        // A halt catches the text up to the exact moment the runners froze on.
        return () => {cancelAnimationFrame(frame); setRaceTime(clock.current);};
        // Absolute simulation time keeps previously seen positions stable after a new call.
    }, [phase, blocked, holding, speed, current, commands.length, human, endTime, relaxed]);

    function callPace(pace: RacePace) {
        const at = RACE_CHECKPOINTS[commands.length];
        if (!windowOpen || blocked || at === undefined || !current) return;
        const next = [...commands, {at, pace, route}];
        const nextSeason = applyRaceRound(roundStart.current, current.action, next, burstAt);
        setSeason(nextSeason);
        setRoute(nextSeason.rounds.at(-1)!.simulation.calls.find(call => call.id === "owner" && call.at > at)?.route ?? "wide");
        chose.current = true;
        setCommands(next); setPhase("race");
    }
    function triggerBurst() {
        if (!canBurst || !current) return;
        // The next simulation tick after the clock preserves every position already shown.
        const at = Math.ceil(clock.current * 10) / 10;
        const next = applyRaceRound(roundStart.current, current.action, commands, at);
        if (!next.rounds.at(-1)!.simulation.bursts.some(burst => burst.id === "owner" && burst.at === at)) return;
        setBurstAt(at); setSeason(next);
        pressBurst(burstButton.current, tier);
    }
    useEffect(() => {
        if (!human || (phase !== "race" && phase !== "checkpoint") || blocked) return;
        const keydown = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey
                || (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true]"))) return;
            const key = event.key.toLowerCase();
            if ((key === "a" || key === "d" || key === "arrowleft" || key === "arrowright") && windowOpen) {
                event.preventDefault(); setRoute(key === "a" || key === "arrowleft" ? "shortcut" : "wide");
            } else if (["1", "2", "3"].includes(key) && windowOpen) {
                event.preventDefault(); callPace(RACE_PACES[Number(key) - 1]!);
            } else if (key === "b" && canBurst) {event.preventDefault(); triggerBurst();}
        };
        window.addEventListener("keydown", keydown);
        return () => window.removeEventListener("keydown", keydown);
    }, [human, phase, blocked, windowOpen, canBurst, route, current, commands]);

    // A fork opening deals its choices in one after another; they take input at once, so the cascade never holds a call back.
    useLayoutEffect(() => {
        if (windowOpen && dock.current) riseIn(dock.current.querySelectorAll(".race-route-picker button, .race-pace-options button"), tier, 40);
        // Only the window opening deals the cards; a tier change while it is open leaves them in place.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [windowOpen]);

    // Each call is stamped into the dock's record as it lands (CSS); the coach's own choice also thumps on the stamp's impact.
    useLayoutEffect(() => {
        if (!chose.current) return;
        chose.current = false;
        cueSeal(calls.current?.lastElementChild ?? null, sound);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [commands.length]);

    useEffect(() => {
        if (phase !== "checkpoint") return;
        checkpointButton.current?.focus({preventScroll: true});
        checkpointButton.current?.closest(".race-command-dock")?.scrollIntoView({block: "center", behavior: reducedMotion ? "instant" : "smooth"});
    }, [phase, reducedMotion]);

    const advance = () => {
        if (phase !== "recap") return;
        if (season.round < RACE_ROUNDS) void beginRound();
        else if (!finished.current) {finished.current = true; onComplete(raceOutcome(season, notes, locale));}
    };

    useEffect(() => {
        if (human || phase !== "recap" || blocked || !autoAdvance) return;
        const timer = window.setTimeout(advance, 5_000);
        return () => window.clearTimeout(timer);
        // Only a settled round starts its next-stage clock; a paused clock restarts on resume.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [phase, blocked, autoAdvance, season.round]);

    // Standings rows rise in one after another once the result card has landed.
    useLayoutEffect(() => {
        if (phase === "recap" && standings.current) riseIn(standings.current.rows, tier, 50, 300);
        // A tier change mid-recap leaves rows where they are.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [phase, season.round]);

    useEffect(() => {
        if (phase !== "recap") return;
        recapButton.current?.focus({preventScroll: true});
        recapButton.current?.scrollIntoView({block: "center", behavior: reducedMotion ? "instant" : "smooth"});
    }, [phase, reducedMotion]);

    const latest = notes.at(-1);
    const owner = season.runners.find(runner => runner.id === "owner")!;
    const rival = season.runners.find(runner => runner.id === season.rivalId)!;

    // A halt pauses every CSS motion in the game (the dock's pulse, the result's stamps) until play resumes, with no delay.
    return <section ref={root} className="arc-race" aria-label={GAME_NAMES[locale].race} data-halted={blocked ? "" : undefined}>
        <header className="arc-race-title">
            <div><p className="arc-overline">{GAME_NAMES[locale].race} / {t.season}</p><h1>{t.title}</h1><p>{t.subtitle}</p></div>
            <GuardianAvatar appearance={appearance} color={profile.color} />
        </header>
        <div className="arc-race-mode"><strong>{human ? ko ? "내가 직접 감독" : "You are the coach" : mode === "llm" ? t.llm : t.rules}</strong><span>{t.ticket}</span></div>
        {phase === "brief" ? <div className="arc-race-brief">
            <p>{t.fairness}</p>
            <p className="race-rival-banner"><strong>{ko ? "이번 시즌 라이벌" : "YOUR SEASON RIVAL"} · {rival.name}</strong><span>{RACE_HABITS[rival.strategy][locale]}</span></p>
            {human && <GameGuide game="race" locale={locale} />}<p>{t.points}</p>
            <GameArt game="race" className="arc-race-cover" /><div className="arc-race-strategies">{(["burst", "conserve", "surge"] as const).map((strategy, index) =>
                <div key={strategy}><span aria-hidden="true">{["⚡", "◒", "↗"][index]}</span><strong>{t[strategy]}</strong></div>)}</div>
            {budget && <p className="arc-race-budget">{t.budget}: <strong>{budget.allowance} {MOCK_USDC.symbol}</strong> <small>{t.budgetNote}</small></p>}

            {autoAdvance && <p role="status">{ko ? "자동 진행 · 5초 뒤 출발해요. 위에서 자동 진행을 끌 수 있어요." : "Automatic play · Starts in 5 seconds. Turn it off above to wait."}</p>}
            <button type="button" className="arc-button" onClick={() => {setPaused(false); void beginRound();}}>{t.start} →</button>
        </div> : <>
            <div className="arc-race-scoreboard">
                <span>{t.round} <strong>{Math.min(RACE_ROUNDS, displayedRound + 1)} / {RACE_ROUNDS}</strong></span>
                <span>{t[course.weather]} · {t[course.course]} <strong>{course.distance} m</strong></span>
                <span>{human ? ko ? "시즌 점수" : "Season points" : t.left} <strong>{human ? (phase === "race" || phase === "checkpoint" ? roundStart.current.runners.find(r => r.id === "owner")!.points : owner.points) : `${owner.tokens} / ${SEASON_TOKENS}`}</strong></span>
            </div>
            {phase === "choose" && <div className="practice-race-choice">
                <h2>{ko ? "이번 경기, 어떤 작전으로 갈까요?" : "What's your plan for this race?"}</h2>
                <p className="race-rival-banner"><strong>{rival.name} · {ko ? "공개된 습관" : "PUBLIC HABIT"}</strong><span>{RACE_HABITS[rival.strategy][locale]}</span></p>
                <p className="race-course-scout">{ko ? "갈림길 미리 보기" : "Scout the route"}: {RACE_CHECKPOINTS.map((_, i) => TERRAIN_COPY[raceTerrain(course, i)][locale].name).join(" → ")}</p>
                <div className="practice-strategies" role="group" aria-label={t.strategy}>{(["burst", "conserve", "surge"] as const).map(value => <button key={value} type="button" aria-pressed={strategy === value} onClick={() => setStrategy(value)}>
                    <strong>{t[value]}</strong><span>{value === "burst" ? ko ? "처음부터 빠르게 · 짧은 코스" : "Fast from the start · Short courses" : value === "conserve" ? ko ? "체력을 아껴요 · 긴 코스와 비" : "Save energy · Long or rainy courses" : ko ? "마지막에 승부 · 후반 가속" : "A late push · Finish strong"}</span>
                </button>)}</div>
                <label className="race-relaxed-toggle"><input type="checkbox" checked={relaxed} onChange={event => setRelaxed(event.target.checked)} /><span><strong>{ko ? "천천히 작전 고르기" : "Take your time"}</strong><small>{ko ? "켜면 갈림길에서 기다려요. 기본은 선택하지 않아도 작전대로 달려요." : "Wait at forks when enabled. Otherwise, your plan continues without input."}</small></span></label>
                <p className="race-course-scout">{ko ? `승부수는 경기당 한 번 · 체력 ${RACE_BURST_COST}% 소비 · 추가 결제 없음` : `One burst per race · Costs ${RACE_BURST_COST}% energy · No extra payment`}</p>
                <div className="practice-turn-actions"><button className="arc-button" disabled={suspended || owner.tokens < 1} onClick={() => choose(true)}>{ko ? "이 작전으로 출전" : "Race with this strategy"} →</button></div>
            </div>}
            {phase === "thinking" && <div className="arc-race-thinking" role="status"><GuardianAvatar appearance={appearance} color={profile.color} /><strong>{t.thinking}</strong><p>{t.deciding}</p></div>}
            {phase === "error" && <div className="arc-race-error" role="alert"><h2>{t.error}</h2><p>{error}</p><button type="button" className="arc-button" onClick={() => void beginRound()}>{t.retry}</button></div>}
            {(phase === "race" || phase === "checkpoint" || phase === "recap") && current && latest && <>
                <div className="arc-race-decision" aria-live="polite">
                    <strong>{profile.name} → {latest.enter ? `${t.enter} · ${t[latest.strategy]}` : t.skip}</strong>
                    <p>{latest.decision.explanation}</p>
                    <small>{t.source}: {latest.decision.source === "llm" ? latest.decision.model || "LLM" : t.local}{!human && <> · {t.entry}: {latest.enter ? "−1" : "0"}</>}</small>
                </div>
                {!latest.enter && <p className="arc-race-sitout">{t.noEntry}</p>}
                <RaceTrack rivalId={season.rivalId} commands={current.simulation.calls.filter(call => call.id === "owner")} race={current.simulation} progress={progress} clock={clock} ended={phase === "recap"} locale={locale} color={profile.color} reducedMotion={reducedMotion} running={phase === "race" && !blocked} tier={tier} sound={sound} playback={speed} signal={phase === "race" ? signal : null} />
                {human && phase !== "recap" && <div ref={dock} className={`race-command-dock ${windowOpen ? "race-awaiting" : ""}`}>
                    <div><span className="arc-overline">{windowOpen ? ko ? `${commands.length + 1}번째 갈림길` : `FORK ${commands.length + 1}` : ko ? `작전 ${commands.length} / 2` : `CALLS ${commands.length} / 2`}</span>
                        <h2>{windowOpen ? phase === "checkpoint" ? ko ? "멈춘 사이, 작전을 골라요" : "Paused — pick your call" : ko ? `${Math.max(0, Math.ceil((nextCall! - raceTime) / (3 * speed)))}초 뒤 갈림길 · 바꿀까요?` : `Fork in ${Math.max(0, Math.ceil((nextCall! - raceTime) / (3 * speed)))}s · Change your plan?` : nextCall === undefined ? ko ? "남은 승부는 결승선에서!" : "All the way to the finish!" : ko ? "말이 작전대로 달리고 있어요" : "Your horse is following the plan"}</h2>
                        {windowOpen && <p>{phase === "checkpoint" ? ko ? "선택하면 출발 · " : "Choose to resume · " : plannedCall ? `${ko ? "기본" : "Default"}: ${ROUTE_LABELS[locale][plannedCall.route]} · ${PACE_LABELS[locale][plannedCall.pace]} · ` : ""}{t.stamina} <strong>{Math.round(ownerFrame?.stamina ?? 0)}%</strong></p>}</div>
                    {windowOpen && <p className="race-traffic-scout">{traffic?.aheadId ? `${current.simulation.entrants.find(runner => runner.id === traffic.aheadId)?.name} · ${Math.round(traffic.gap)}m ${ko ? "앞" : "ahead"}. ${traffic.gap <= RACE_DRAFT_DISTANCE ? ko ? "안쪽에서 따라가면 소모 −40%, 추월은 바깥에서." : "Follow inside for −40% drain; pass on the outside." : ko ? "아직 멀어서 따라가기 이득이 없어요." : "Too far away for a draft yet."}` : ko ? "안쪽 앞말이 없어요. 따라가기 이득 없이 자유롭게 달려요." : "No inner horse ahead: clear running, no draft bonus."}</p>}
                    {windowOpen && <RaceRoutePicker terrain={raceTerrain(course, commands.length)} route={route} onChange={setRoute} locale={locale} disabled={blocked} />}
                    {windowOpen && <div className="race-pace-options">{RACE_PACES.map((pace, i) => <button ref={i === 0 ? checkpointButton : undefined} key={pace} disabled={blocked} onClick={() => callPace(pace)}>
                        <span aria-hidden="true">{["◒", "→", "↗"][i]}</span><strong><kbd>{i + 1}</kbd> {PACE_LABELS[locale][pace]}</strong><small>{PACE_HINTS[locale][pace]}</small>
                    </button>)}</div>}
                    {commands.length > 0 && <p ref={calls} className="race-calls">{commands.map((command, index) => <Fragment key={index}>{index > 0 && " → "}<span>{`${index + 1}. ${ROUTE_LABELS[locale][command.route]} · ${PACE_LABELS[locale][command.pace]}`}</span></Fragment>)}</p>}
                </div>}
                {human && phase !== "recap" && <div className="race-burst-control">
                    <div><strong>{burstAt !== null ? ko ? "승부수를 썼어요" : "Burst used" : ko ? "한 번뿐인 추월 기회" : "One chance to make your move"}</strong><small>{ko ? `체력 ${RACE_BURST_COST}% · 짧고 강한 가속` : `${RACE_BURST_COST}% energy · A short, strong dash`}</small></div>
                    <button type="button" ref={burstButton} className={burstAt !== null ? "race-burst-used" : undefined} disabled={!canBurst} onClick={triggerBurst}>{burstAt !== null ? <span className="race-burst-stamp">{ko ? "사용 완료" : "Used"}</span> : (ownerFrame?.stamina ?? 0) < RACE_BURST_COST ? ko ? "체력 부족" : "Low energy" : ko ? "승부수! [B]" : "BURST! [B]"}</button>
                </div>}
                {phase === "recap" && <RaceRecap race={current.simulation} commands={current.simulation.calls.filter(call => call.id === "owner")} locale={locale} tier={tier} sound={sound} />}
                <div className="arc-race-playback">
                    {/* A blur can pause the result too, which holds its stamps (`data-halted`) and the auto-advance: resuming must stay reachable. */}
                    {(phase !== "recap" || paused) && <button type="button" className="arc-button arc-button-paper" onClick={() => setPaused(value => !value)}>{paused ? t.resume : t.pause}</button>}
                    {phase !== "recap" && <div className="mapae-speed" role="group" aria-label={ko ? "관전 속도" : "Playback speed"}>{[1, 2].map(value => <button key={value} type="button" aria-pressed={speed === value} onClick={() => setSpeed(value)}>{value}×</button>)}</div>}
                    {phase === "race" && !human ? <button type="button" className="arc-race-text-button" onClick={() => {seek(endTime); setPhase("recap");}}>{t.fast} →</button>
                        : phase === "recap" ? <button type="button" ref={recapButton} className="arc-button" onClick={advance}>{season.round < RACE_ROUNDS ? t.next : t.result} →</button> : null}
                </div>
                <p className="arc-race-status" role="status">{blocked ? t.held : phase === "checkpoint" ? ko ? "작전을 골라야 다시 달려요." : "Choose a pace to continue." : phase === "recap" ? autoAdvance && season.round < RACE_ROUNDS ? t.auto : t.settled : t.watching}</p>
                {reducedMotion && <p className="arc-race-status">{t.reduce}</p>}
            </>}
            {phase === "recap" && <div className="arc-race-standings">
                <h2>{t.rankings}</h2>
                <table><thead><tr><th>{t.competitor}</th><th>{t.score}</th><th>{t.spent}</th></tr></thead>
                    <tbody ref={standings}>{seasonRanking(season).map(runner => <tr key={runner.id} className={runner.id === "owner" ? "arc-race-owner" : ""}>
                        <th scope="row"><span>{runner.rank}</span> {runner.name} {runner.id === "owner" ? <small>{t.your}</small> : runner.id === season.rivalId ? <small>{ko ? "라이벌" : "RIVAL"}</small> : null}</th><td>{runner.points}</td><td>{human ? runner.entries : SEASON_TOKENS - runner.tokens} / {RACE_ROUNDS}</td>
                    </tr>)}</tbody></table><p>{t.standingsNote}</p>
            </div>}
            {notes.length > 0 && <details className="arc-race-notebook"><summary>{t.history} ({notes.length})</summary>
                <ol>{notes.map(note => <li key={note.round}><strong>{note.round + 1}. {note.enter ? t[note.strategy] : t.skip}</strong><p>{note.decision.explanation}</p><small>{note.decision.source === "llm" ? note.decision.model || "LLM" : t.local}</small></li>)}</ol>
            </details>}
        </>}
        <footer className="arc-race-exit"><button type="button" onClick={() => onExit()}>{t.back}</button>{phase !== "brief" && <small>{t.exitNote}</small>}</footer>
    </section>;
}

const PACE_LABELS = {ko: {save: "힘 아끼기", steady: "속도 유지", push: "치고 나가기"}, en: {save: "Save energy", steady: "Hold pace", push: "Make a move"}};
const PACE_HINTS = {ko: {save: "느리게 · 절약", steady: "균형 잡힌 속도", push: "빠르게 · 소모 큼"}, en: {save: "Slow · Save energy", steady: "Balanced effort", push: "Fast · High energy"}};
function RaceRecap({race, commands, locale, tier, sound}: {race: RaceSimulation; commands: RaceCommand[]; locale: "ko" | "en"; tier: MotionTier; sound: ArcadeSound}) {
    const ko = locale === "ko", owner = race.finish.find(r => r.id === "owner");
    const card = useRef<HTMLDivElement>(null);
    const place = useRef<HTMLSpanElement>(null);
    const score = useRef<HTMLSpanElement>(null);
    // Before paint: the card lands, its place is stamped (CSS), the points roll up and the highlights follow one by one.
    useLayoutEffect(() => {
        if (!owner) return;
        cueSeal(place.current, sound);
        if (card.current) riseIn(card.current.querySelectorAll(".race-result-highlight"), tier, 70, 360);
        if (!score.current) return;
        const roll = countUp(score.current, owner.points, {tier}, {ms: 500});
        return () => roll?.cancel();
        // One ceremony per result: the round's race, not later renders, starts it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [race]);
    if (!owner) return null;
    const arrived = owner.seconds <= raceEndTime(race);
    const stamina = raceFrameAt(race, raceEndTime(race) / race.seconds).positions.find(p => p.id === "owner")!.stamina;
    const behind = Math.max(0, owner.seconds - race.finish[0]!.seconds);
    return <div ref={card} className="race-photo-finish" role="status" data-tier={tier}>
        <span ref={place} className="race-place">{owner.rank}<small>{ko ? "위" : "PLACE"}</small></span>
        <div><span className="arc-overline">{ko ? "경기 결과" : "RACE RESULT"} / +<span ref={score} key={owner.points} aria-hidden="true">{owner.points}</span><span className="sr-only">{owner.points}</span> {ko ? "점" : "PTS"}</span><h2>{!arrived ? ko ? `${owner.rank}위로 경기 종료` : `Place ${owner.rank} confirmed` : owner.rank === 1 ? ko ? "결승선의 주인공!" : "First across the line!" : ko ? `선두와 ${behind.toFixed(2)}초 차이` : `${behind.toFixed(2)}s behind the leader`}</h2>
            <p>{arrived ? ko ? `도착 ${owner.seconds.toFixed(2)}초 · 남긴 체력 ${Math.round(stamina)}%` : `${owner.seconds.toFixed(2)}s · ${Math.round(stamina)}% stamina left` : ko ? "세 마리가 도착해 남은 순위가 확정됐어요." : "Three horses finished, so the remaining place is settled."}</p>
            <p>{stamina < 1 ? ko ? "막판에는 체력이 바닥났어요. 다음엔 앞 구간에서 힘을 아껴봐요." : "You ran out of stamina. Try saving more in the early section." : owner.rank !== 1 && stamina > 30 ? ko ? "여력이 남았어요. 다음엔 더 일찍 치고 나가 볼까요?" : "You had energy left. Try making your move earlier." : ko ? "코스와 작전을 기억해 두고, 다음 경기에 도전해요." : "Keep this course and your choices in mind for the next race."}</p>
            {raceHighlights(race).map((highlight, i) => <p className="race-result-highlight" key={i}>{highlight[locale]}</p>)}
            {commands.length > 0 && <small>{commands.map(c => `${ROUTE_LABELS[locale][c.route]} · ${PACE_LABELS[locale][c.pace]}`).join(" → ")}</small>}</div>
    </div>;
}

const ROUTE_LABELS = {ko: {shortcut: "안쪽 따라가기", wide: "바깥 추월"}, en: {shortcut: "Follow inside", wide: "Pass outside"}};
const TERRAIN_COPY: Record<RaceTerrain, Record<"ko" | "en", {name: string; hint: string}>> = {
    mud: {ko: {name: "진흙 갈림길", hint: "안쪽 진흙에서는 천천히! 질주하면 미끄러져요."}, en: {name: "Muddy fork", hint: "Take the inner mud slowly. Sprinting loses traction."}},
    hill: {ko: {name: "가파른 고개", hint: "지름길: 속도 +15%, 체력 소모 ×1.9. 체력 25% 미만이면 감속!"}, en: {name: "Steep hill", hint: "Shortcut: +15% speed, ×1.9 drain. Slows below 25% energy."}},
    meadow: {ko: {name: "탁 트인 들판", hint: "지름길은 15% 빠르게! 대신 체력을 더 써요."}, en: {name: "Open meadow", hint: "The shortcut is 15% faster, but uses more stamina."}},
};
function RaceRoutePicker({terrain, route, onChange, locale, disabled}: {terrain: RaceTerrain; route: RaceRoute; onChange: (route: RaceRoute) => void; locale: "ko" | "en"; disabled: boolean}) {
    const ko = locale === "ko", info = TERRAIN_COPY[terrain][locale];
    return <div className="race-route-picker">
        <div><strong>{info.name}</strong></div><p>{info.hint} {ko ? "지형·속도 작전은 8초, 진로는 다음 갈림길·결승선까지 유지돼요." : "Terrain and pace last 8s; your path lasts until the next fork or finish."}</p>
        <div role="group" aria-label={ko ? "달릴 길" : "Choose a path"}>{RACE_ROUTES.map(value => <button key={value} aria-pressed={route === value} disabled={disabled} onClick={() => onChange(value)}>
            <strong><kbd>{value === "wide" ? "D" : "A"}</kbd> {ROUTE_LABELS[locale][value]}</strong><small>{value === "wide" ? ko ? "속도 −6% · 막힘 없이 추월" : "Speed −6% · Free to pass" : ko ? "22m 앞말 뒤 소모 −40% · 추월 불가" : "Behind within 22m: −40% drain · Cannot pass"}</small>
        </button>)}</div>
    </div>;
}
