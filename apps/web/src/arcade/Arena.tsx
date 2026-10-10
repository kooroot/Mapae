import {useCallback, useEffect, useId, useLayoutEffect, useRef, useState} from "react";
import {flushSync, preload} from "react-dom";
import type {Locale} from "../lib/i18n";
import {guardianLayers} from "./guardian-layers";
import {Goblin} from "./Characters";
import {advance, advanceAgent, activateFever, setFeverMode, bossWindow, goldParade, stampWave, multiplier, newGame, newBossPractice, FEVER_TARGET, FEVER_MS, BOSS_OPENINGS, stamp, stampEvents, type Game, type FeverMode} from "@mapae/arcade/stamp";
import {cellForKey, isControlTarget} from "./input";
import type {Character} from "./state";
import type {ArcadeSound} from "./sound";
import type {GuardianAptitudes} from "@mapae/arcade/guardians";
import {StampChallenges} from "./StampChallenges";
import {StampWindow} from "./StampWindow";
import {BossTimingCue} from "./BossTimingCue";
import {motionTier} from "./motion";
import {FINAL_SECONDS, GO_MS, haltStampFx, stampCountdownFx, stampEndMs, stampFx, type StampTap} from "./stamp-fx";
import "./stamp.css";
import "./game-guide.css";
import "./stamp-scene.css";

const COPY = {
    en: {
        score: "SCORE", time: "SECONDS", combo: "COMBO", pause: "Pause", resume: "Keep playing",
        paused: "Taking a breather.", pauseNote: "The clock waits for you.", quit: "End round & see results",
        rules: "Stamp the goblins. Let the couriers pass.", keyboard: "Keys 1–9 or QWE / ASD / ZXC · F for fever · Esc to pause",
        touch: "Tap a window to stamp", ready: "GET READY", go: "GO!", playfield: "Nine windows. Stamp goblins, avoid couriers.",
        human: "YOU ARE PLAYING", stopped: "Finish with your current score", end: "TIME!",
    },
    ko: {
        score: "점수", time: "남은 시간", combo: "연속 도장", pause: "잠깐 쉬기", resume: "계속하기",
        paused: "잠깐 숨 고르기.", pauseNote: "시간도 같이 쉬고 있어요.", quit: "여기까지 하고 결과 보기",
        rules: "도깨비는 콕! 마패 배달부는 통과!", keyboard: "숫자 1–9 또는 QWE / ASD / ZXC · F 출두 · Esc 일시정지",
        touch: "창문을 톡 누르면 도장이 찍혀요", ready: "준비됐나요?", go: "시작!", playfield: "창문 9개. 도깨비를 누르고 마패 배달부는 통과시키세요.",
        human: "직접 플레이 중", stopped: "지금까지의 점수로 결과를 확인해요", end: "끝!",
    },
} satisfies Record<Locale, Record<string, string>>;
const SPRITES = ["goblin", "goblin-armored", "goblin-chief", "stamp-impact", "stamp-window"].map(asset => `/arcade/${asset}-512.webp`);

export function Arena({locale, character, reducedMotion, sound, onFinish, autopilot, suspended = false, seed, practice, aptitudes}: {
    locale: Locale; character: Character; reducedMotion: boolean; sound: ArcadeSound;
    onFinish: (game: Game, early: boolean) => void;
    suspended?: boolean; seed?: number; practice?: "boss";
    autopilot?: "careful" | "quick";
    aptitudes?: GuardianAptitudes;
}) {
    const t = COPY[locale];
    const bossHintId = useId();
    const tier = motionTier({still: reducedMotion, watched: !!autopilot});
    const tierRef = useRef(tier); tierRef.current = tier;
    useEffect(() => {
        for (const src of [...SPRITES, ...character.appearance ? guardianLayers(character.appearance).map(layer => layer.src) : []]) preload(src, {as: "image"});
    }, [character.appearance]);
    const [view, setView] = useState<Game>(() => {
        const chosenSeed = seed ?? Math.floor(Math.random() * 2 ** 32);
        return practice === "boss" ? newBossPractice(chosenSeed) : newGame(chosenSeed, autopilot === "careful" ? "manual" : "auto", aptitudes);
    });
    const state = useRef(view);
    const [countdown, setCountdown] = useState(3);
    const countdownRef = useRef(3_000);
    // "시작!" after the countdown and the "끝!" seal before the results: display only, the clock and input never wait on them.
    const [go, setGo] = useState(false);
    const [ending, setEnding] = useState(false);
    const [paused, setPaused] = useState(false);
    const pauseRef = useRef(false);
    const suspendedRef = useRef(suspended); suspendedRef.current = suspended;
    useEffect(() => {last.current = null;}, [suspended]);
    const done = useRef(false);
    const last = useRef<number | null>(null);
    const root = useRef<HTMLElement>(null);
    const field = useRef<HTMLDivElement>(null);
    const windows = useRef<HTMLDivElement>(null);
    const board = useRef<HTMLDivElement>(null);
    const resumeButton = useRef<HTMLButtonElement>(null);
    const finishRef = useRef(onFinish);
    finishRef.current = onFinish;
    const soundRef = useRef(sound);
    soundRef.current = sound;

    /** Every state change passes through here, so a person and an agent get feedback from the same events. True when any occurred. */
    const commit = (next: Game, tap?: StampTap) => {
        const events = stampEvents(state.current, next, tap?.index);
        state.current = next;
        if (events.length) stampFx(events, next, {sound: soundRef.current, tier: tierRef.current, field: field.current, windows: windows.current, board: board.current}, tap);
        return events.length > 0;
    };

    const setPause = (value: boolean) => {
        if (done.current) return;
        pauseRef.current = value;
        last.current = null;
        setPaused(value);
        // A pause during "시작!" ends it rather than replaying it on resume.
        if (value) setGo(false);
    };

    useEffect(() => {
        if (paused) resumeButton.current?.focus();
        else field.current?.focus({preventScroll: true});
    }, [paused]);

    useEffect(() => {
        if (!go) return;
        const timer = window.setTimeout(() => setGo(false), GO_MS);
        return () => clearTimeout(timer);
    }, [go]);

    useEffect(() => {
        let frame = 0;
        let painted = 0;
        let shown = -1;
        let ended = 0;
        const tick = (time: number) => {
            if (done.current) return;
            if (!pauseRef.current && !suspendedRef.current) {
                const delta = last.current === null ? 0 : time - last.current;
                if (countdownRef.current > 0) {
                    countdownRef.current = Math.max(0, countdownRef.current - delta);
                    const seconds = Math.ceil(countdownRef.current / 1_000);
                    if (seconds !== shown) {
                        shown = seconds;
                        stampCountdownFx({sound: soundRef.current, tier: tierRef.current}, seconds);
                        // A watched agent keeps the plain countdown; a hidden tab schedules nothing.
                        if (seconds === 0 && tierRef.current !== "light" && !document.hidden) setGo(true);
                    }
                    setCountdown(seconds);
                } else {
                    // Detect events on every frame, before the paint throttle. An event frame renders synchronously, so the impact
                    // React mounts lands in the same frame as the sound and the fx started on the persistent layers.
                    const evented = commit(autopilot ? advanceAgent(state.current, delta, autopilot) : advance(state.current, delta));
                    if (evented || time - painted >= 40) {
                        if (evented) flushSync(() => setView(state.current));
                        else setView(state.current);
                        painted = time;
                    }
                    if (state.current.finished) {
                        // Input closes now; the "끝!" seal holds a beat (none in a hidden tab) before the results take over.
                        done.current = true;
                        const hold = document.hidden ? 0 : stampEndMs(tierRef.current);
                        if (!hold) {finishRef.current(state.current, false); return;}
                        setEnding(true);
                        ended = window.setTimeout(() => finishRef.current(state.current, false), hold);
                        return;
                    }
                }
                last.current = time;
            }
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        const suspend = () => setPause(true);
        const visibility = () => {if (document.hidden) suspend();};
        window.addEventListener("blur", suspend);
        document.addEventListener("visibilitychange", visibility);
        return () => {
            cancelAnimationFrame(frame);
            clearTimeout(ended);
            window.removeEventListener("blur", suspend);
            document.removeEventListener("visibilitychange", visibility);
        };
    }, []);

    function hit(index: number, point?: StampTap["point"]) {
        if (autopilot || pauseRef.current || suspendedRef.current || countdownRef.current > 0 || done.current) return;
        // Account for time since the last frame before accepting an input at expiry.
        flushInputTime();
        if (commit(stamp(state.current, index), {index, point})) setView(state.current);
    }
    function changeFeverMode(mode: FeverMode) {
        if (autopilot || pauseRef.current || suspendedRef.current || done.current) return;
        if (countdownRef.current <= 0) flushInputTime();
        commit(setFeverMode(state.current, mode));
        setView(state.current);
    }
    function flushInputTime() {
        const now = performance.now();
        if (last.current !== null) commit(advance(state.current, now - last.current));
        last.current = now;
    }
    function fireFever() {
        if (autopilot || pauseRef.current || suspendedRef.current || countdownRef.current > 0 || done.current || state.current.feverMode !== "manual") return;
        flushInputTime();
        commit(activateFever(state.current));
        setView(state.current);
    }
    const feverRef = useRef(fireFever); feverRef.current = fireFever;
    const hitRef = useRef(hit);
    hitRef.current = hit;
    // Stable across renders, so a memoized window re-renders for its own cell only.
    const hitWindow = useCallback((index: number, point?: StampTap["point"]) => hitRef.current(index, point), []);
    useEffect(() => {
        const key = (event: KeyboardEvent) => {
            if (suspendedRef.current || event.defaultPrevented || isControlTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
            if (event.code === "Escape") {
                event.preventDefault();
                setPause(!pauseRef.current);
                return;
            }
            if (event.code === "KeyF") {event.preventDefault(); feverRef.current(); return;}
            const index = cellForKey(event.code);
            if (index !== null) {event.preventDefault(); hitRef.current(index);}
        };
        window.addEventListener("keydown", key);
        return () => window.removeEventListener("keydown", key);
    }, []);

    const frozen = suspended || paused;
    const halted = frozen || countdown > 0;
    useLayoutEffect(() => {if (root.current) haltStampFx(root.current, halted);}, [halted]);
    const ko = locale === "ko";
    const drill = view.practice === "boss";
    const rules = drill ? ko ? "대장만 10초 · 빈틈마다 한 번!" : "Ten-second chief drill · one stamp per opening!" : t.rules;
    const chief = view.cells.find(cell => cell.actor?.special === "boss")?.actor;
    const fever = view.feverUntil > view.elapsed;
    const charged = view.feverCharge === FEVER_TARGET;
    const parade = goldParade(view.elapsed);
    const feverValue = fever ? (view.feverUntil - view.elapsed) / FEVER_MS * 100 : view.feverCharge / FEVER_TARGET * 100;
    const wave = stampWave(view.elapsed);
    const warning = wave.next && wave.next.at - view.elapsed <= 3000;
    const stage = warning ? `${ko ? "곧" : "NEXT"}: ${wave.next![locale]}` : wave.current[locale];
    const seconds = Math.ceil((view.durationMs - view.elapsed) / 1_000);
    // Each of the last ten seconds remounts the timer, which replays its heartbeat.
    const urgent = seconds > 0 && seconds <= 10;
    const tierUp = multiplier(view.combo);
    return (
        <section ref={root} className={`arc-arena${fever ? " stamp-fever" : ""}`} aria-label={t.playfield} data-halted={frozen ? "true" : countdown > 0 ? "countdown" : undefined}>
            <div className="arc-arena-heading"><span>{drill ? ko ? "대장 10초 연습" : "Ten-second chief drill" : ko ? "도깨비 도장찍기" : "Dokkaebi Stamp"}</span><button className="arc-text-button" onClick={() => setPause(true)}>{t.pause} Ⅱ</button></div>
            <div className="arc-scoreboard" ref={board}>
                <div><span>{t.score}</span><strong data-testid="score"><span className="stamp-pulse" data-fx="score">{view.score.toLocaleString()}</span></strong></div>
                <div className={seconds <= 10 ? "arc-time arc-urgent" : "arc-time"}><span>{t.time}</span><strong data-testid="timer"><span key={urgent ? seconds : "calm"} className={urgent ? `stamp-pulse stamp-beat${seconds <= FINAL_SECONDS ? " is-final" : ""}` : "stamp-pulse"}>{seconds}<small>s</small></span></strong></div>
                <div><span>{drill ? ko ? "정통" : "PERFECT" : t.combo}</span><strong data-testid={drill ? "perfect-hits" : "combo"}><span className="stamp-pulse" data-fx="combo">{drill ? view.perfectHits : view.combo}{drill ? <small>{` / ${BOSS_OPENINGS}`}</small> : <small key={tierUp} className={tierUp > 1 ? "stamp-mult is-up" : "stamp-mult"}>×{tierUp}</small>}</span></strong>{!drill && <i className="stamp-combo-chip" data-fx="chip" aria-hidden="true" />}</div>
            </div>
            {!drill && <div className="stamp-wave-steps" aria-label={ko ? "이번 판 진행 단계" : "Round stages"}>
                {[ko ? "몸풀기" : "Warm up", ko ? "순찰" : "Patrol", ko ? "잔치" : "Parade", ko ? "대장" : "Chief", ko ? "소동" : "Rush"].map((label, i) => <span key={i} aria-current={wave.index === i ? "step" : undefined} className={i <= wave.index ? "is-reached" : ""}>{label}</span>)}
            </div>}
            {!drill && <div className={`stamp-fever-strip ${charged ? "stamp-fever-ready" : ""}`}>
                <div><strong role="status">{fever ? ko ? "암행어사 출두! 점수 ×2" : "ROYAL INSPECTOR! SCORE ×2" : stage}</strong><span>{fever ? `${Math.ceil((view.feverUntil - view.elapsed) / 1000)}s` : `${view.feverCharge} / ${FEVER_TARGET}`}</span></div>
                <progress className="stamp-fever-meter" aria-label={ko ? "출두 게이지" : "Fever charge"} value={feverValue} max={100} />
                <div className="stamp-fever-controls">
                    {autopilot ? <span className="stamp-fever-strategy">{autopilot === "careful" ? ko ? "신중하게 · 대장 정통과 금도깨비 출두를 노려요" : "Careful · precise chief stamps and fever for gold" : ko ? "빠르게 · 첫 빈틈에 타격하고 바로 출두" : "Quick · hit the first opening and use fever immediately"}</span> : <>
                        <div className="stamp-fever-mode" role="group" aria-label={ko ? "출두 방식" : "Fever control"}>
                            <button type="button" aria-pressed={view.feverMode === "auto"} disabled={paused || suspended} onClick={() => changeFeverMode("auto")}>{ko ? "자동 출두" : "Auto fever"}</button>
                            <button type="button" aria-pressed={view.feverMode === "manual"} disabled={paused || suspended} onClick={() => changeFeverMode("manual")}>{ko ? "직접 출두" : "Manual fever"}</button>
                        </div>
                        {view.feverMode === "manual" && <button type="button" className="stamp-fever-trigger" data-testid="fever-trigger" disabled={!charged || fever || paused || suspended || countdown > 0} onClick={fireFever}>{charged ? ko ? "출두! ×2 · F" : "FEVER! ×2 · F" : fever ? ko ? "출두 중!" : "FEVER ACTIVE" : ko ? `${view.feverCharge}/8 충전 중` : `${view.feverCharge}/8 charging`}</button>}
                        {view.feverMode === "auto" && <small>{ko ? "8연속 퇴치하면 점수 두 배" : "8 in a row → double points"}</small>}
                    </>}
                </div>
                <p className={`stamp-parade-cue ${parade ? `is-${parade.phase}` : ""}`} role="status">{parade ? parade.phase === "soon" ? ko ? `★ 금도깨비 행렬 ${Math.ceil(parade.remaining / 1000)}초 전 · 출두를 준비해요` : `★ Gold parade in ${Math.ceil(parade.remaining / 1000)}s · ready your fever` : ko ? "★ 금도깨비 행렬! 출두로 두 배를 노려요" : "★ GOLD PARADE! Catch gold during fever" : charged && !fever ? ko ? "출두 준비 완료 · 지금 쓰거나 행렬을 기다려요" : "Fever ready · use it now or wait for gold" : ko ? "금도깨비 행렬은 2초 먼저 알려드려요" : "Watch for the two-second gold parade warning"}</p>
            </div>}
            <div className={`arc-playfield ${parade ? `stamp-parade-${parade.phase}` : ""}`} ref={field} tabIndex={-1}>
                {chief || drill ? <BossTimingCue actor={chief ?? null} game={view} locale={locale} hintId={bossHintId} tier={tier} halted={halted} /> : <div className="arc-field-caption"><span>{rules}</span><span>馬牌</span></div>}
                <div className="arc-windows" ref={windows} inert={halted || ending}>
                    {view.cells.map((cell, i) => {
                        const boss = cell.actor?.special === "boss" ? bossWindow(cell.actor, view.elapsed) : null;
                        return <StampWindow key={i} index={i} actor={cell.actor} impact={cell.impact && cell.impact.until > view.elapsed ? cell.impact : null} phase={boss?.phase} perfect={boss?.perfect ?? false}
                            locale={locale} hintId={bossHintId} agent={!!autopilot} appearance={character.appearance} color={character.color} onHit={hitWindow} />;
                    })}
                </div>
                {paused ? <div key="pause" className="arc-game-overlay stamp-pause" role="region" aria-label={t.paused}>
                    <span className="arc-overline">{t.pause}</span><h2>{t.paused}</h2><p>{t.pauseNote}</p>
                    <button ref={resumeButton} className="arc-button" onClick={() => setPause(false)}>{t.resume} →</button>
                    <button className="arc-text-button" onClick={() => {if (!done.current) {done.current = true; finishRef.current(state.current, true);}}}>{t.quit}</button>
                    <small>{drill ? ko ? "연습 점수는 기록에 남지 않아요" : "Drill scores do not change your records" : t.stopped}</small>
                </div> : countdown > 0 ? <div key="countdown" className="arc-game-overlay" role="status" aria-label={t.ready}>
                    <span>{t.ready}</span>
                    <span key={countdown} className={tier === "light" ? undefined : "stamp-count"}>{tier !== "light" && <i aria-hidden="true" />}<strong className="arc-countdown">{countdown}</strong></span>
                    <p>{rules}</p>
                </div> : go && <div key="go" className="arc-game-overlay stamp-go" aria-hidden="true"><b>{t.go}</b></div>}
                {ending && <div className="stamp-end" aria-hidden="true"><b>{t.end}</b></div>}
            </div>
            <div className="arc-play-footer"><span><i className="arc-live-dot" /> {character.name} · {autopilot ? locale === "ko" ? "에이전트 관전 중" : "WATCHING AGENT" : t.human}</span><span>{autopilot ? "AUTO" : t.touch}</span></div>
            <StampChallenges game={view} locale={locale} />
            {!drill && <div className="stamp-cast" aria-label={ko ? "오늘의 도깨비" : "Meet the goblins"}>
                <div><Goblin /><span><strong>{ko ? "장난꾸러기" : "Trickster"}</strong><small>{ko ? "한 번 콕!" : "One stamp"}</small></span></div>
                <div><Goblin variant="armored" /><span><strong>{ko ? "철갑 도깨비" : "Iron guard"}</strong><small>{ko ? "두 번 콕!" : "Two stamps"}</small></span></div>
                <div><Goblin variant="boss" /><span><strong>{ko ? "도깨비 대장" : "Goblin chief"}</strong><small>{ko ? "◆ 정통 +200점" : "◆ PERFECT +200"}</small></span></div>
            </div>}
            <p className="arc-keyboard-help">{autopilot ? locale === "ko" ? "에이전트가 조작하고 있어요 · Esc 일시정지" : "Your agent is playing · Esc to pause" : drill ? ko ? "가운데 창문 터치 또는 5 / S · Esc 일시정지" : "Tap the center window or press 5 / S · Esc to pause" : t.keyboard}</p>
        </section>
    );
}
