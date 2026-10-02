import {useEffect, useRef, useState} from "react";
import {preload} from "react-dom";
import type {Locale} from "../lib/i18n";
import {GuardianAvatar} from "./GuardianAvatar";
import {guardianLayers} from "./guardian-layers";
import {Goblin} from "./Characters";
import {advance, multiplier, newGame, ROUND_MS, stamp, type Game} from "./game";
import {cellForKey, isControlTarget} from "./input";
import type {Character} from "./state";
import type {ArcadeSound} from "./sound";

const COPY = {
    en: {
        score: "SCORE", time: "SECONDS", combo: "COMBO", pause: "Pause", resume: "Keep playing",
        paused: "Taking a breather.", pauseNote: "The clock waits for you.", quit: "End round & see results",
        rules: "Stamp the goblins. Let the couriers pass.", keyboard: "Keys 1–9 or QWE / ASD / ZXC · Esc to pause",
        touch: "Tap a window to stamp", ready: "GET READY", go: "GO!", goblin: "Goblin", courier: "Courier — do not stamp",
        empty: "Empty window", hit: "STAMPED", wrong: "FRIEND!", miss: "MISSED", playfield: "Nine windows. Stamp goblins, avoid couriers.",
        human: "YOU ARE PLAYING", friendly: "Don't stamp!", target: "Stamp!", stopped: "Finish with your current score",
    },
    ko: {
        score: "점수", time: "남은 시간", combo: "연속 도장", pause: "잠깐 쉬기", resume: "계속하기",
        paused: "잠깐 숨 고르기.", pauseNote: "시간도 같이 쉬고 있어요.", quit: "여기까지 하고 결과 보기",
        rules: "도깨비는 콕! 마패 배달부는 통과!", keyboard: "숫자 1–9 또는 QWE / ASD / ZXC · Esc 일시정지",
        touch: "창문을 톡 누르면 도장이 찍혀요", ready: "준비됐나요?", go: "시작!", goblin: "도깨비", courier: "마패 배달부 — 누르지 마세요",
        empty: "빈 창문", hit: "퇴치", wrong: "아야!", miss: "놓쳤다", playfield: "창문 9개. 도깨비를 누르고 마패 배달부는 통과시키세요.",
        human: "직접 플레이 중", friendly: "통과!", target: "찍어!", stopped: "지금까지의 점수로 결과를 확인해요",
    },
} satisfies Record<Locale, Record<string, string>>;

export function Arena({locale, character, reducedMotion, sound, onFinish, autopilot, suspended = false}: {
    locale: Locale; character: Character; reducedMotion: boolean; sound: ArcadeSound;
    onFinish: (game: Game, early: boolean) => void;
    suspended?: boolean;
    autopilot?: "careful" | "quick";
}) {
    const t = COPY[locale];
    if (character.appearance) for (const layer of guardianLayers(character.appearance)) preload(layer.src, {as: "image"});
    for (const asset of ["goblin", "stamp-impact", "stamp-window"]) preload(`/arcade/${asset}-512.webp`, {as: "image"});
    const [view, setView] = useState<Game>(newGame);
    const state = useRef(view);
    const [countdown, setCountdown] = useState(3);
    const countdownRef = useRef(3_000);
    const [paused, setPaused] = useState(false);
    const pauseRef = useRef(false);
    const suspendedRef = useRef(suspended); suspendedRef.current = suspended;
    useEffect(() => {last.current = null;}, [suspended]);
    const done = useRef(false);
    const last = useRef<number | null>(null);
    const field = useRef<HTMLDivElement>(null);
    const resumeButton = useRef<HTMLButtonElement>(null);
    const finishRef = useRef(onFinish);
    finishRef.current = onFinish;
    const soundRef = useRef(sound);
    soundRef.current = sound;
    const lastAgentAction = useRef(0);

    const setPause = (value: boolean) => {
        if (done.current) return;
        pauseRef.current = value;
        last.current = null;
        setPaused(value);
    };

    useEffect(() => {
        if (paused) resumeButton.current?.focus();
        else field.current?.focus({preventScroll: true});
    }, [paused]);

    useEffect(() => {
        let frame = 0;
        let painted = 0;
        const tick = (time: number) => {
            if (done.current) return;
            if (!pauseRef.current && !suspendedRef.current) {
                const delta = last.current === null ? 0 : time - last.current;
                if (countdownRef.current > 0) {
                    countdownRef.current = Math.max(0, countdownRef.current - delta);
                    setCountdown(Math.ceil(countdownRef.current / 1_000));
                    if (countdownRef.current === 0) soundRef.current.play("start");
                } else {
                    state.current = advance(state.current, delta);
                    if (autopilot && state.current.elapsed - lastAgentAction.current >= (autopilot === "quick" ? 260 : 510)) {
                        const cell = state.current.cells.findIndex(c => c.actor?.kind === "goblin" && state.current.elapsed - c.actor.bornAt >= (autopilot === "quick" ? 180 : 390));
                        if (cell >= 0) {
                            state.current = stamp(state.current, cell);
                            soundRef.current.play("hit", state.current.combo);
                            lastAgentAction.current = state.current.elapsed;
                        }
                    }
                    if (time - painted >= 40 || state.current.finished) {
                        setView(state.current);
                        painted = time;
                    }
                    if (state.current.finished) {
                        done.current = true;
                        soundRef.current.play("end");
                        finishRef.current(state.current, false);
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
            window.removeEventListener("blur", suspend);
            document.removeEventListener("visibilitychange", visibility);
        };
    }, []);

    function hit(index: number) {
        if (autopilot || pauseRef.current || suspendedRef.current || countdownRef.current > 0 || done.current) return;
        // Account for time since the last frame before accepting an input at expiry.
        const now = performance.now();
        if (last.current !== null) state.current = advance(state.current, now - last.current);
        last.current = now;
        const before = state.current;
        const after = stamp(before, index);
        if (after !== before) {
            soundRef.current.play(after.hits > before.hits ? "hit" : "wrong", after.combo);
            state.current = after;
            setView(after);
        }
    }
    const hitRef = useRef(hit);
    hitRef.current = hit;
    useEffect(() => {
        const key = (event: KeyboardEvent) => {
            if (suspendedRef.current || event.defaultPrevented || isControlTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
            if (event.code === "Escape") {
                event.preventDefault();
                setPause(!pauseRef.current);
                return;
            }
            const index = cellForKey(event.code);
            if (index !== null) {event.preventDefault(); hitRef.current(index);}
        };
        window.addEventListener("keydown", key);
        return () => window.removeEventListener("keydown", key);
    }, []);

    const seconds = Math.ceil((ROUND_MS - view.elapsed) / 1_000);
    return (
        <section className={`arc-arena ${reducedMotion ? "arc-still" : ""}`} aria-label={t.playfield}>
            <div className="arc-arena-heading"><span>{locale === "ko" ? "도깨비 도장찍기" : "Dokkaebi Stamp"}</span><button className="arc-text-button" onClick={() => setPause(true)}>{t.pause} Ⅱ</button></div>
            <div className="arc-scoreboard">
                <div><span>{t.score}</span><strong data-testid="score">{view.score.toLocaleString()}</strong></div>
                <div className={seconds <= 10 ? "arc-time arc-urgent" : "arc-time"}><span>{t.time}</span><strong data-testid="timer">{seconds}<small>s</small></strong></div>
                <div><span>{t.combo}</span><strong data-testid="combo">{view.combo}<small> ×{multiplier(view.combo)}</small></strong></div>
            </div>
            <div className="arc-playfield" ref={field} tabIndex={-1}>
                <div className="arc-field-caption"><span>{t.rules}</span><span>馬牌</span></div>
                <div className="arc-windows" inert={suspended || paused || countdown > 0}>
                    {view.cells.map((cell, i) => (
                        <button key={i} className={`arc-window ${cell.actor ? `arc-has-${cell.actor.kind}` : ""} ${cell.impact ? `arc-impact-${cell.impact.kind}` : ""}`}
                            data-testid={`cell-${i}`} data-actor={cell.actor?.kind ?? "empty"} aria-disabled={!!autopilot}
                            aria-label={`${i + 1}: ${cell.actor ? t[cell.actor.kind] : t.empty}`}
                            onPointerDown={event => {if (event.button === 0) {event.preventDefault(); hit(i);}}}
                            onClick={event => {if (event.detail === 0) hit(i);}}>
                            <span className="arc-window-number" aria-hidden="true">{i + 1}</span>
                            <span className="arc-window-floor" />
                            {cell.actor && <span className="arc-window-actor" key={cell.actor.bornAt}>
                                {cell.actor.kind === "goblin" ? <Goblin /> : <GuardianAvatar appearance={character.appearance} color={character.color} />}
                                <span className="arc-target-label">{cell.actor.kind === "goblin" ? t.target : t.friendly}</span>
                            </span>}
                            {cell.impact && cell.impact.until > view.elapsed && <span className="arc-impact" key={cell.impact.until}>
                                {cell.impact.kind === "stamp" && <img className="arc-impact-art" src="/arcade/stamp-impact-512.webp" alt="" />}
                                <b>{cell.impact.kind === "stamp" ? t.hit : cell.impact.kind === "wrong" ? t.wrong : t.miss}</b>
                                {cell.impact.kind !== "miss" && <em>{cell.impact.points > 0 ? "+" : ""}{cell.impact.points}</em>}
                            </span>}
                        </button>
                    ))}
                </div>
                {(countdown > 0 || paused) && <div className="arc-game-overlay" role={paused ? "region" : "status"} aria-label={paused ? t.paused : t.ready}>
                    {paused ? <><span className="arc-overline">{t.pause}</span><h2>{t.paused}</h2><p>{t.pauseNote}</p>
                        <button ref={resumeButton} className="arc-button" onClick={() => setPause(false)}>{t.resume} →</button>
                        <button className="arc-text-button" onClick={() => {if (!done.current) {done.current = true; finishRef.current(state.current, true);}}}>{t.quit}</button>
                        <small>{t.stopped}</small></> : <><span>{t.ready}</span><strong className="arc-countdown">{countdown}</strong><p>{t.rules}</p></>}
                </div>}
            </div>
            <div className="arc-play-footer"><span><i className="arc-live-dot" /> {character.name} · {autopilot ? locale === "ko" ? "에이전트 관전 중" : "WATCHING AGENT" : t.human}</span><span>{autopilot ? "AUTO" : t.touch}</span></div>
            <p className="arc-keyboard-help">{autopilot ? locale === "ko" ? "에이전트가 조작하고 있어요 · Esc 일시정지" : "Your agent is playing · Esc to pause" : t.keyboard}</p>
        </section>
    );
}
