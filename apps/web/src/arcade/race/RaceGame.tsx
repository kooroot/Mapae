import {MOCK_USDC} from "@mapae/shared";
import {useEffect, useRef, useState} from "react";
import type {ActivityOutcome, AgentDecision} from "@mapae/arcade";
import {applyRaceRound, createRaceSeason, makeRaceCourse, raceFrameAt,
    RACE_ROUNDS, SEASON_TOKENS, seasonRanking, type RaceSimulation, type RaceStrategy, type RaceSeason} from "@mapae/arcade/race";
import type {AutonomousGameProps} from "../agent-contract";
import {GuardianAvatar} from "../GuardianAvatar";
import {GameArt} from "../Characters";
import {requestRaceDecision} from "./decision";
import {GAME_NAMES} from "../game-names";
import "./race.css";

const COPY = {
    ko: {
        title: "달려라 마패", subtitle: "감독님은 편하게 관전하세요. 에이전트가 출전과 작전을 정해요.",
        rules: "규칙 기반 봇", llm: "실제 LLM 에이전트", season: "3경기 시즌", ticket: "시즌 입장권에 3경기 포함 · 베팅·현금 상금 없음",
        fairness: "모두 같은 말 능력치와 참가 토큰 3개로 시작해요. 참가 1개, 건너뛰기 0개. 토큰은 게임 안에서만 사용돼요.",
        points: "순위별 5 / 3 / 2 / 1점 · 같은 기록은 공동 순위", start: "지금 바로 출발", starting: "에이전트가 곧 첫 경기를 준비해요.", back: "로비로 돌아가기",
        round: "경기", thinking: "코스와 예산을 살펴보고 있어요…", deciding: "출전과 전략을 결정하는 중", enter: "출전", skip: "이번엔 관전",
        entry: "참가 토큰", left: "남은 토큰", strategy: "작전", pause: "관전 잠깐 멈추기", resume: "계속 관전하기", fast: "경기 결과 바로 보기",
        held: "관전을 멈췄어요. 다음 경기 결정도 기다려요.", auto: "잠시 후 에이전트가 다음 경기를 준비해요.", next: "다음 경기로", result: "시즌 결과 보기",
        rankings: "시즌 순위", competitor: "출전자", score: "시즌 점수", spent: "사용 토큰", stamina: "체력", finish: "도착", standingsNote: "같은 조건의 시스템 상대와 비교한 이번 시즌 기록이에요.",
        clear: "맑음", rain: "비", wind: "맞바람", short: "짧은 코스", long: "긴 코스", burst: "초반 질주", conserve: "체력 보존", surge: "후반 추월",
        error: "결정을 받지 못했어요. 참가 토큰은 차감되지 않았어요.", errorDetail: "연결 상태와 모델 설정을 확인한 뒤 다시 시도해 주세요. 규칙 봇으로 바꾸지 않았어요.", retry: "같은 경기 결정 다시 받기",
        history: "감독 노트", noEntry: "에이전트가 이번 경기는 쉬기로 했어요. 다른 말들의 경기를 관전해요.", watching: "관전 중", source: "결정", local: "브라우저 규칙", your: "우리 팀",
        paused: "일시정지", settled: "경기 종료", budget: "공통 용돈", budgetNote: "입장 후 남은 용돈 · 경기 중 추가 결제 없음", exitNote: "지금 나가면 시즌 기록은 남지 않고 입장권은 사용된 채로 유지돼요.",
        reduce: "움직임 줄이기 적용 · 움직이는 대신 구간별 위치로 보여요.", sample: "내 에이전트", saved: "아낀 참가 토큰", wins: "우승", entries: "출전 수",
    },
    en: {
        title: "Small horses. Big race.", subtitle: "You're the coach. Your agent picks the races and the strategy.",
        rules: "Rules-based bot", llm: "Real LLM agent", season: "3-race season", ticket: "Season ticket includes 3 races · No betting or cash prizes",
        fairness: "Everyone starts with identical horses and 3 entry tokens. Entering costs 1; skipping costs 0. Tokens exist only inside this game.",
        points: "Places earn 5 / 3 / 2 / 1 points · Equal times share a place", start: "Start right now", starting: "Your agent will prepare the first race shortly.", back: "Back to the lobby",
        round: "RACE", thinking: "Studying the course and entry budget…", deciding: "Choosing entry and strategy", enter: "Enter", skip: "Watch this one",
        entry: "Entry tokens", left: "Tokens left", strategy: "Strategy", pause: "Pause watching", resume: "Keep watching", fast: "See race result now",
        held: "Watching is paused. The next decision waits too.", auto: "Your agent will prepare the next race shortly.", next: "Next race", result: "See season results",
        rankings: "Season standings", competitor: "Runner", score: "Season points", spent: "Tokens spent", stamina: "Stamina", finish: "Finished", standingsNote: "This season compares your agent with system rivals under equal conditions.",
        clear: "Clear", rain: "Rain", wind: "Headwind", short: "Short course", long: "Long course", burst: "Early burst", conserve: "Save stamina", surge: "Late surge",
        error: "The decision failed. No entry tokens were spent.", errorDetail: "Check the connection and model settings, then retry. We have not switched to a rules bot.", retry: "Retry this race decision",
        history: "Coach's notebook", noEntry: "Your agent is sitting this one out. Watch the other horses race.", watching: "WATCHING", source: "Decision", local: "Browser rules", your: "YOUR TEAM",
        paused: "Paused", settled: "Race finished", budget: "Shared allowance", budgetNote: "Remaining after admission · No extra payments during races", exitNote: "Leaving now discards this season's record. Its admission remains used.",
        reduce: "Reduced motion · Positions update in stages instead of continuous movement.", sample: "My agent", saved: "Entry tokens saved", wins: "Wins", entries: "Races entered",
    },
} as const;

type Phase = "brief" | "thinking" | "race" | "recap" | "error";
type Note = {round: number; decision: AgentDecision; enter: boolean; strategy: RaceStrategy};

export function raceOutcome(season: RaceSeason, notes: Note[], locale: "ko" | "en"): ActivityOutcome {
    const owner = season.runners.find(runner => runner.id === "owner")!;
    const rank = seasonRanking(season).find(runner => runner.id === "owner")!.rank;
    const t = COPY[locale];
    return {
        game: "race", score: owner.points,
        summary: {ko: `${RACE_ROUNDS}경기 시즌 ${rank}위 · ${owner.entries}회 출전 · ${owner.points}점`, en: `Place ${rank} over ${RACE_ROUNDS} races · ${owner.entries} entries · ${owner.points} points`},
        metrics: [
            {label: {ko: "출전 수", en: "Races entered"}, value: owner.entries},
            {label: {ko: "우승", en: "Wins"}, value: owner.wins},
            {label: {ko: "사용한 참가 토큰", en: "Entry tokens spent"}, value: SEASON_TOKENS - owner.tokens},
            {label: {ko: "아낀 참가 토큰", en: "Entry tokens saved"}, value: owner.tokens},
        ],
        transcript: notes.flatMap(note => {
            const result = season.rounds[note.round]?.simulation.finish.find(finish => finish.id === "owner");
            return [
                {speaker: `${owner.name} · ${note.decision.source === "llm" ? "LLM" : t.local}`, text: note.decision.explanation},
                {speaker: `${note.round + 1} / ${t.source}`, text: `${note.decision.model || t.local} · ${note.enter ? t.enter : t.skip} / ${t[note.strategy]}`},
                {speaker: GAME_NAMES[locale].race, text: locale === "ko" ? result ? `${result.rank}위 · ${result.seconds.toFixed(2)}초 · ${result.points}점 · 참가 토큰 1개 사용`
                    : "관전 · 0점 · 참가 토큰 0개 사용" : result ? `Place ${result.rank} · ${result.seconds.toFixed(2)}s · ${result.points} points · 1 entry token used`
                    : "Watched · 0 points · 0 entry tokens used"},
            ];
        }),
        ranking: seasonRanking(season).map(runner => ({name: runner.name, score: runner.points})),
    };
}

export function RaceGame({appearance, profile, locale, mode, seed, budget, decide, reducedMotion, suspended = false, autoAdvance = false, onComplete, onExit}: AutonomousGameProps) {
    const t = COPY[locale];
    const [season, setSeason] = useState(() => createRaceSeason(seed, profile.name || t.sample, locale));
    const [phase, setPhase] = useState<Phase>("brief");
    const [notes, setNotes] = useState<Note[]>([]);
    const [progress, setProgress] = useState(0);
    const [paused, setPaused] = useState(false);
    const [speed, setSpeed] = useState(1);
    const blocked = paused || suspended;
    const [error, setError] = useState("");
    const busy = useRef(false);
    const finished = useRef(false);
    const alive = useRef(true);
    const request = useRef<AbortController | null>(null);
    const recapButton = useRef<HTMLButtonElement>(null);
    const current = season.rounds.at(-1);
    const displayedRound = phase === "race" || phase === "recap" ? season.round - 1 : season.round;
    const course = makeRaceCourse(seed, Math.min(RACE_ROUNDS - 1, displayedRound));

    useEffect(() => {
        alive.current = true;
        return () => {alive.current = false; request.current?.abort();};
    }, []);

    useEffect(() => {
        const pauseIfHidden = () => {if (document.hidden) setPaused(true);};
        const pauseOnBlur = () => setPaused(true);
        const pauseOnEscape = (event: KeyboardEvent) => {
            if (!event.defaultPrevented && event.key === "Escape") setPaused(value => !value);
        };
        document.addEventListener("visibilitychange", pauseIfHidden);
        window.addEventListener("blur", pauseOnBlur);
        window.addEventListener("keydown", pauseOnEscape);
        return () => {
            document.removeEventListener("visibilitychange", pauseIfHidden);
            window.removeEventListener("blur", pauseOnBlur);
            window.removeEventListener("keydown", pauseOnEscape);
        };
    }, []);

    const beginRound = async () => {
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
            const next = applyRaceRound(season, action);
            setNotes(previous => [...previous, {round: season.round, decision, ...action}]);
            setSeason(next);
            setProgress(0);
            setPhase("race");
        } catch {
            if (alive.current && !controller.signal.aborted) {setError(t.errorDetail); setPhase("error");}
        } finally {
            busy.current = false;
        }
    };

    useEffect(() => {
        if (phase !== "brief" || !autoAdvance || blocked) return;
        const timer = window.setTimeout(() => void beginRound(), 5000);
        return () => window.clearTimeout(timer);
    }, [phase, autoAdvance, blocked]);

    useEffect(() => {
        if (phase !== "race" || blocked) return;
        let frame = 0;
        let last: number | null = null;
        let painted = 0;
        let elapsed = progress * 14_000;
        const tick = (time: number) => {
            if (last !== null) elapsed += Math.min(200, time - last) * speed;
            last = time;
            if (time - painted >= 40 || elapsed >= 14_000) {setProgress(Math.min(1, elapsed / 14_000)); painted = time;}
            if (elapsed >= 14_000) setPhase("recap");
            else frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
        // The current progress is captured only when starting or resuming this animation.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [phase, blocked, speed]);

    const advance = () => {
        if (phase !== "recap") return;
        if (season.round < RACE_ROUNDS) void beginRound();
        else if (!finished.current) {finished.current = true; onComplete(raceOutcome(season, notes, locale));}
    };

    useEffect(() => {
        if (phase !== "recap" || blocked || !autoAdvance) return;
        const timer = window.setTimeout(advance, 5_000);
        return () => window.clearTimeout(timer);
        // Only a settled round starts its next-stage clock; a paused clock restarts on resume.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [phase, blocked, autoAdvance, season.round]);

    useEffect(() => {if (phase === "recap") recapButton.current?.focus({preventScroll: true});}, [phase]);

    const exit = () => onExit();
    const latest = notes.at(-1);
    const owner = season.runners.find(runner => runner.id === "owner")!;

    return <section className={`arc-race ${reducedMotion ? "arc-race-still" : ""}`} aria-label={GAME_NAMES[locale].race}>
        <header className="arc-race-title">
            <div><p className="arc-overline">{GAME_NAMES[locale].race} / {t.season}</p><h1>{t.title}</h1><p>{t.subtitle}</p></div>
            <GuardianAvatar appearance={appearance} color={profile.color} />
        </header>
        <div className="arc-race-mode"><strong>{mode === "llm" ? t.llm : t.rules}</strong><span>{t.ticket}</span></div>
        {phase === "brief" ? <div className="arc-race-brief">
            <p>{t.fairness}</p><p>{t.points}</p>
            <GameArt game="race" className="arc-race-cover" /><div className="arc-race-strategies">{(["burst", "conserve", "surge"] as const).map((strategy, index) =>
                <div key={strategy}><span aria-hidden="true">{["⚡", "◒", "↗"][index]}</span><strong>{t[strategy]}</strong></div>)}</div>
            <p className="arc-race-budget">{t.budget}: <strong>{budget.allowance} {MOCK_USDC.symbol}</strong> <small>{t.budgetNote}</small></p>

            {autoAdvance && <p role="status">{locale === "ko" ? "자동 진행 · 5초 뒤 출발해요. 위에서 자동 진행을 끌 수 있어요." : "Automatic play · Starts in 5 seconds. Turn it off above to wait."}</p>}
            <button type="button" className="arc-button" onClick={() => {setPaused(false); void beginRound();}}>{t.start} →</button>
        </div> : <>
            <div className="arc-race-scoreboard">
                <span>{t.round} <strong>{Math.min(RACE_ROUNDS, displayedRound + 1)} / {RACE_ROUNDS}</strong></span>
                <span>{t[course.weather]} · {t[course.course]} <strong>{course.distance} m</strong></span>
                <span>{t.left} <strong>{owner.tokens} / {SEASON_TOKENS}</strong></span>
            </div>
            {phase === "thinking" && <div className="arc-race-thinking" role="status"><GuardianAvatar appearance={appearance} color={profile.color} /><strong>{t.thinking}</strong><p>{t.deciding}</p></div>}
            {phase === "error" && <div className="arc-race-error" role="alert"><h2>{t.error}</h2><p>{error}</p><button type="button" className="arc-button" onClick={() => void beginRound()}>{t.retry}</button></div>}
            {(phase === "race" || phase === "recap") && current && latest && <>
                <div className="arc-race-decision" aria-live="polite">
                    <strong>{profile.name} → {latest.enter ? `${t.enter} · ${t[latest.strategy]}` : t.skip}</strong>
                    <p>{latest.decision.explanation}</p>
                    <small>{t.source}: {latest.decision.source === "llm" ? latest.decision.model || "LLM" : t.local} · {t.entry}: {latest.enter ? "−1" : "0"}</small>
                </div>
                {!latest.enter && <p className="arc-race-sitout">{t.noEntry}</p>}
                <RaceTrack race={current.simulation} progress={phase === "recap" ? 1 : progress} locale={locale} color={profile.color} reducedMotion={reducedMotion} running={phase === "race" && !blocked} />
                <div className="arc-race-playback">
                    <button type="button" className="arc-button arc-button-plain" onClick={() => setPaused(value => !value)}>{paused ? t.resume : t.pause}</button>
                    <div className="mapae-speed" role="group" aria-label={locale === "ko" ? "관전 속도" : "Playback speed"}>{[1, 2].map(value => <button key={value} type="button" aria-pressed={speed === value} onClick={() => setSpeed(value)}>{value}×</button>)}</div>
                    {phase === "race" ? <button type="button" className="arc-race-text-button" onClick={() => {setProgress(1); setPhase("recap");}}>{t.fast} →</button>
                        : <button type="button" ref={recapButton} className="arc-button" onClick={advance}>{season.round < RACE_ROUNDS ? t.next : t.result} →</button>}
                </div>
                <p className="arc-race-status" role="status">{blocked ? t.held : phase === "recap" ? autoAdvance && season.round < RACE_ROUNDS ? t.auto : t.settled : t.watching}</p>
                {reducedMotion && <p className="arc-race-status">{t.reduce}</p>}
            </>}
            {phase === "recap" && <div className="arc-race-standings">
                <h2>{t.rankings}</h2>
                <table><thead><tr><th>{t.competitor}</th><th>{t.score}</th><th>{t.spent}</th></tr></thead>
                    <tbody>{seasonRanking(season).map(runner => <tr key={runner.id} className={runner.id === "owner" ? "arc-race-owner" : ""}>
                        <th scope="row"><span>{runner.rank}</span> {runner.name} {runner.id === "owner" && <small>{t.your}</small>}</th><td>{runner.points}</td><td>{SEASON_TOKENS - runner.tokens} / {SEASON_TOKENS}</td>
                    </tr>)}</tbody></table><p>{t.standingsNote}</p>
            </div>}
            {notes.length > 0 && <details className="arc-race-notebook"><summary>{t.history} ({notes.length})</summary>
                <ol>{notes.map(note => <li key={note.round}><strong>{note.round + 1}. {note.enter ? t[note.strategy] : t.skip}</strong><p>{note.decision.explanation}</p><small>{note.decision.source === "llm" ? note.decision.model || "LLM" : t.local}</small></li>)}</ol>
            </details>}
        </>}
        <footer className="arc-race-exit"><button type="button" onClick={exit}>{t.back}</button>{phase !== "brief" && <small>{t.exitNote}</small>}</footer>
    </section>;
}

function RaceTrack({race, progress, locale, color, reducedMotion, running}: {
    race: RaceSimulation; progress: number; locale: "ko" | "en"; color: AutonomousGameProps["profile"]["color"]; reducedMotion: boolean; running: boolean;
}) {
    const t = COPY[locale];
    const track = useRef<HTMLDivElement>(null);
    const lane = useRef<SVGSVGElement>(null);
    const [size, setSize] = useState({width: 800, height: 68});
    useEffect(() => {track.current?.scrollIntoView({block: "center", behavior: "instant"});}, [race]);
    useEffect(() => {
        const observer = new ResizeObserver(entries => {
            const box = entries[0]?.contentRect;
            if (box && box.width > 0 && box.height > 0) setSize({width: box.width, height: box.height});
        });
        if (lane.current) observer.observe(lane.current);
        return () => observer.disconnect();
    }, []);
    const frame = raceFrameAt(race, reducedMotion ? Math.floor(progress * 4) / 4 : progress);
    return <div ref={track} className={`arc-race-track arc-race-weather-${race.course.weather} ${running ? "arc-race-running" : ""}`}>
        <GameArt game="race" className="arc-race-panorama" /><div className="arc-race-track-label"><span>{locale === "ko" ? "출발" : "START"}</span><strong>{Math.min(100, Math.round(progress * 100))}%</strong><span>{locale === "ko" ? "도착" : "FINISH"}</span></div>
        {race.entrants.map((runner, index) => {
            const position = frame.positions.find(item => item.id === runner.id)!;
            const finish = race.finish.find(item => item.id === runner.id)!;
            const arrived = position.distance >= race.course.distance;
            const runnerColor = runner.id === "owner" ? color : (["jade", "ink", "red"] as const)[index % 3]!;
            return <div className={`arc-race-lane ${runner.id === "owner" ? "arc-race-owner" : ""}`} key={runner.id}>
                <div className="arc-race-runner-name"><strong>{runner.name} {runner.id === "owner" && <small>{t.your}</small>}</strong><span>{t[runner.strategy]}</span>
                    <label>{t.stamina} <meter min={0} max={100} value={position.stamina}>{Math.round(position.stamina)}%</meter></label></div>
                <svg ref={index === 0 ? lane : undefined} viewBox={`0 0 ${size.width} ${size.height}`} className="arc-race-lane-svg" aria-label={`${runner.name}: ${Math.round(position.distance)} / ${race.course.distance} m, ${t.stamina} ${Math.round(position.stamina)}%`} role="img">
                    <path d={`M5 ${size.height - 5}H${size.width - 5}`} stroke="#697c61" strokeWidth="2" strokeDasharray="8 6" />
                    <path d={`M${size.width - 27} 4v${size.height - 10}m-7-${size.height - 16}h14m-14 9h14m-14 9h14m-14 9h14m-14 9h14`} stroke="#59604f" strokeWidth="2" />
                    <g transform={`translate(${position.distance / race.course.distance * Math.max(0, size.width - size.height)} 0)`}>
                        <g className={`arc-race-gallop arc-rider-${runnerColor}`}><image href={`/arcade/race-pony-${runnerColor}-512.webp`} x="0" y="0" width={size.height} height={size.height - 4} preserveAspectRatio="xMidYMax meet" /></g>
                    </g>
                    {arrived && <text x={size.width - size.height - 10} y="34" textAnchor="end" fill="#282b25" fontSize="25" fontWeight="800">#{finish.rank}</text>}
                </svg>
                {progress === 1 && <p className="arc-race-finish-time">{t.finish} {finish.seconds.toFixed(2)}s · +{finish.points}</p>}
            </div>;
        })}
    </div>;
}
