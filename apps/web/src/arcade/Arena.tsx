import {useEffect, useRef, useState} from "react";
import {preload} from "react-dom";
import type {Locale} from "../lib/i18n";
import {GuardianAvatar} from "./GuardianAvatar";
import {guardianLayers} from "./guardian-layers";
import {Goblin} from "./Characters";
import {advance, advanceAgent, activateFever, setFeverMode, bossWindow, goldParade, stampWave, multiplier, newGame, ROUND_MS, FEVER_TARGET, FEVER_MS, BOSS_OPENINGS, stamp, type Game, type FeverMode} from "./game";
import {cellForKey, isControlTarget} from "./input";
import type {Character} from "./state";
import type {ArcadeSound} from "./sound";
import {StampChallenges} from "./StampChallenges";
import "./stamp.css";
import "./game-guide.css";
import "./stamp-scene.css";

const COPY = {
    en: {
        score: "SCORE", time: "SECONDS", combo: "COMBO", pause: "Pause", resume: "Keep playing",
        paused: "Taking a breather.", pauseNote: "The clock waits for you.", quit: "End round & see results",
        rules: "Stamp the goblins. Let the couriers pass.", keyboard: "Keys 1–9 or QWE / ASD / ZXC · F for fever · Esc to pause",
        touch: "Tap a window to stamp", ready: "GET READY", go: "GO!", goblin: "Goblin", courier: "Courier — do not stamp",
        empty: "Empty window", hit: "STAMPED", wrong: "FRIEND!", miss: "MISSED", playfield: "Nine windows. Stamp goblins, avoid couriers.",
        human: "YOU ARE PLAYING", friendly: "Don't stamp!", target: "Stamp!", stopped: "Finish with your current score",
    },
    ko: {
        score: "점수", time: "남은 시간", combo: "연속 도장", pause: "잠깐 쉬기", resume: "계속하기",
        paused: "잠깐 숨 고르기.", pauseNote: "시간도 같이 쉬고 있어요.", quit: "여기까지 하고 결과 보기",
        rules: "도깨비는 콕! 마패 배달부는 통과!", keyboard: "숫자 1–9 또는 QWE / ASD / ZXC · F 출두 · Esc 일시정지",
        touch: "창문을 톡 누르면 도장이 찍혀요", ready: "준비됐나요?", go: "시작!", goblin: "도깨비", courier: "마패 배달부 — 누르지 마세요",
        empty: "빈 창문", hit: "퇴치", wrong: "아야!", miss: "놓쳤다", playfield: "창문 9개. 도깨비를 누르고 마패 배달부는 통과시키세요.",
        human: "직접 플레이 중", friendly: "통과!", target: "찍어!", stopped: "지금까지의 점수로 결과를 확인해요",
    },
} satisfies Record<Locale, Record<string, string>>;

export function Arena({locale, character, reducedMotion, sound, onFinish, autopilot, suspended = false, seed}: {
    locale: Locale; character: Character; reducedMotion: boolean; sound: ArcadeSound;
    onFinish: (game: Game, early: boolean) => void;
    suspended?: boolean; seed?: number;
    autopilot?: "careful" | "quick";
}) {
    const t = COPY[locale];
    if (character.appearance) for (const layer of guardianLayers(character.appearance)) preload(layer.src, {as: "image"});
    for (const asset of ["goblin", "goblin-armored", "goblin-chief", "stamp-impact", "stamp-window"]) preload(`/arcade/${asset}-512.webp`, {as: "image"});
    const [view, setView] = useState<Game>(() => newGame(seed ?? Math.floor(Math.random() * 2 ** 32), autopilot === "careful" ? "manual" : "auto"));
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
                    const previous = state.current;
                    state.current = autopilot ? advanceAgent(previous, delta, autopilot) : advance(previous, delta);
                    if (autopilot && state.current !== previous) {
                        if (state.current.feverActivations > previous.feverActivations) soundRef.current.play("fever");
                        else if (state.current.hits > previous.hits) soundRef.current.play(state.current.goldHits > previous.goldHits ? "golden" : "hit", state.current.combo);
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
        flushInputTime();
        const before = state.current;
        const after = stamp(before, index);
        if (after !== before) {
            soundRef.current.play(after.feverUntil > before.feverUntil ? "fever" : after.cells[index]?.impact?.kind === "guard" ? "guard" : after.cells[index]?.impact?.kind === "crack" ? "hit" : after.hits > before.hits ? before.cells[index]?.actor?.golden ? "golden" : "hit" : "wrong", after.combo);
            state.current = after;
            setView(after);
        }
    }
    function changeFeverMode(mode: FeverMode) {
        if (autopilot || pauseRef.current || suspendedRef.current || done.current) return;
        if (countdownRef.current <= 0) flushInputTime();
        const before = state.current;
        state.current = setFeverMode(before, mode);
        if (state.current.feverActivations > before.feverActivations) soundRef.current.play("fever");
        setView(state.current);
    }
    function flushInputTime() {
        const now = performance.now();
        if (last.current !== null) state.current = advance(state.current, now - last.current);
        last.current = now;
    }
    function fireFever() {
        if (autopilot || pauseRef.current || suspendedRef.current || countdownRef.current > 0 || done.current || state.current.feverMode !== "manual") return;
        flushInputTime();
        const before = state.current;
        state.current = activateFever(before);
        if (state.current !== before) soundRef.current.play("fever");
        setView(state.current);
    }
    const feverRef = useRef(fireFever); feverRef.current = fireFever;
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
            if (event.code === "KeyF") {event.preventDefault(); feverRef.current(); return;}
            const index = cellForKey(event.code);
            if (index !== null) {event.preventDefault(); hitRef.current(index);}
        };
        window.addEventListener("keydown", key);
        return () => window.removeEventListener("keydown", key);
    }, []);

    const ko = locale === "ko";
    const fever = view.feverUntil > view.elapsed;
    const charged = view.feverCharge === FEVER_TARGET;
    const parade = goldParade(view.elapsed);
    const feverValue = fever ? (view.feverUntil - view.elapsed) / FEVER_MS * 100 : view.feverCharge / FEVER_TARGET * 100;
    const wave = stampWave(view.elapsed);
    const warning = wave.next && wave.next.at - view.elapsed <= 3000;
    const stage = warning ? `${ko ? "곧" : "NEXT"}: ${wave.next![locale]}` : wave.current[locale];
    const seconds = Math.ceil((ROUND_MS - view.elapsed) / 1_000);
    return (
        <section className={`arc-arena ${reducedMotion ? "arc-still" : ""} ${fever ? "stamp-fever" : ""}`} aria-label={t.playfield}>
            <div className="arc-arena-heading"><span>{locale === "ko" ? "도깨비 도장찍기" : "Dokkaebi Stamp"}</span><button className="arc-text-button" onClick={() => setPause(true)}>{t.pause} Ⅱ</button></div>
            <div className="arc-scoreboard">
                <div><span>{t.score}</span><strong data-testid="score">{view.score.toLocaleString()}</strong></div>
                <div className={seconds <= 10 ? "arc-time arc-urgent" : "arc-time"}><span>{t.time}</span><strong data-testid="timer">{seconds}<small>s</small></strong></div>
                <div><span>{t.combo}</span><strong data-testid="combo">{view.combo}<small> ×{multiplier(view.combo)}</small></strong></div>
            </div>
            <div className="stamp-wave-steps" aria-label={ko ? "이번 판 진행 단계" : "Round stages"}>
                {[ko ? "몸풀기" : "Warm up", ko ? "순찰" : "Patrol", ko ? "잔치" : "Parade", ko ? "대장" : "Chief", ko ? "소동" : "Rush"].map((label, i) => <span key={i} aria-current={wave.index === i ? "step" : undefined} className={i <= wave.index ? "is-reached" : ""}>{label}</span>)}
            </div>
            <div className={`stamp-fever-strip ${charged ? "stamp-fever-ready" : ""}`}>
                <div><strong role="status">{fever ? ko ? "암행어사 출두! 점수 ×2" : "ROYAL INSPECTOR! SCORE ×2" : stage}</strong><span>{fever ? `${Math.ceil((view.feverUntil - view.elapsed) / 1000)}s` : `${view.feverCharge} / ${FEVER_TARGET}`}</span></div>
                <progress className="stamp-fever-meter" aria-label={ko ? "출두 게이지" : "Fever charge"} value={feverValue} max={100} />
                <div className="stamp-fever-controls">
                    {autopilot ? <span className="stamp-fever-strategy">{autopilot === "careful" ? ko ? "신중하게 · 행렬과 대장에 맞춰 출두" : "Careful · fever for gold and chief openings" : ko ? "빠르게 · 충전되면 바로 출두" : "Quick · fever as soon as charged"}</span> : <>
                        <div className="stamp-fever-mode" role="group" aria-label={ko ? "출두 방식" : "Fever control"}>
                            <button type="button" aria-pressed={view.feverMode === "auto"} disabled={paused || suspended} onClick={() => changeFeverMode("auto")}>{ko ? "자동 출두" : "Auto fever"}</button>
                            <button type="button" aria-pressed={view.feverMode === "manual"} disabled={paused || suspended} onClick={() => changeFeverMode("manual")}>{ko ? "직접 출두" : "Manual fever"}</button>
                        </div>
                        {view.feverMode === "manual" && <button type="button" className="stamp-fever-trigger" data-testid="fever-trigger" disabled={!charged || fever || paused || suspended || countdown > 0} onClick={fireFever}>{charged ? ko ? "출두! ×2 · F" : "FEVER! ×2 · F" : fever ? ko ? "출두 중!" : "FEVER ACTIVE" : ko ? `${view.feverCharge}/8 충전 중` : `${view.feverCharge}/8 charging`}</button>}
                        {view.feverMode === "auto" && <small>{ko ? "8연속 퇴치하면 점수 두 배" : "8 in a row → double points"}</small>}
                    </>}
                </div>
                <p className={`stamp-parade-cue ${parade ? `is-${parade.phase}` : ""}`} role="status">{parade ? parade.phase === "soon" ? ko ? `★ 금도깨비 행렬 ${Math.ceil(parade.remaining / 1000)}초 전 · 출두를 준비해요` : `★ Gold parade in ${Math.ceil(parade.remaining / 1000)}s · ready your fever` : ko ? "★ 금도깨비 행렬! 출두로 두 배를 노려요" : "★ GOLD PARADE! Catch gold during fever" : charged && !fever ? ko ? "출두 준비 완료 · 지금 쓰거나 행렬을 기다려요" : "Fever ready · use it now or wait for gold" : ko ? "금도깨비 행렬은 2초 먼저 알려드려요" : "Watch for the two-second gold parade warning"}</p>
            </div>
            <div className={`arc-playfield ${parade ? `stamp-parade-${parade.phase}` : ""}`} ref={field} tabIndex={-1}>
                <div className="arc-field-caption"><span>{t.rules}</span><span>馬牌</span></div>
                <div className="arc-windows" inert={suspended || paused || countdown > 0}>
                    {view.cells.map((cell, i) => {
                        const boss = cell.actor?.special === "boss" ? bossWindow(cell.actor, view.elapsed) : null;
                        const bossCue = boss?.phase === "open" ? ko ? `찍어! · ${cell.actor!.hp}` : `OPEN! · ${cell.actor!.hp}` : boss?.phase === "recover" ? ko ? "명중! 기다려" : "HIT! WAIT" : ko ? "방어 · 기다려" : "GUARD · WAIT";
                        const targetCue = boss ? bossCue : cell.actor?.special ? `${ko ? "갑옷" : "ARMOR"} · ${cell.actor.hp}` : cell.actor?.kind === "goblin" ? cell.actor.golden ? ko ? "★ 금도깨비" : "★ GOLD" : t.target : t.friendly;
                        return (
                        <button key={i} className={`arc-window ${cell.actor ? `arc-has-${cell.actor.kind}` : ""} ${cell.impact ? `arc-impact-${cell.impact.kind}` : ""} ${cell.actor?.golden ? "stamp-golden" : ""} ${cell.actor?.special ? `stamp-${cell.actor.special}` : ""} ${boss ? `stamp-boss-${boss.phase}` : ""}`}
                            data-testid={`cell-${i}`} data-actor={cell.actor?.kind ?? "empty"} data-special={cell.actor?.special ?? "normal"} data-boss-phase={boss?.phase} aria-disabled={!!autopilot}
                            aria-label={`${i + 1}: ${cell.actor ? cell.actor.special ? `${ko ? cell.actor.special === "boss" ? "대장 도깨비" : "갑옷 도깨비" : cell.actor.special === "boss" ? "Chief goblin" : "Armored goblin"} ${boss ? bossCue : ""} · ${cell.actor.hp} ${ko ? "번 남음" : "hits left"}` : cell.actor.golden ? ko ? "금도깨비 · 보너스" : "Golden goblin · bonus" : t[cell.actor.kind] : t.empty}`}
                            onPointerDown={event => {if (event.button === 0) {event.preventDefault(); hit(i);}}}
                            onClick={event => {if (event.detail === 0) hit(i);}}>
                            <span className="arc-window-number" aria-hidden="true">{i + 1}</span>
                            <span className="arc-window-floor" />
                            {cell.actor && <span className="arc-window-actor" key={cell.actor.bornAt}>
                                {cell.actor.kind === "goblin" ? <Goblin variant={cell.actor.special} className={cell.actor.golden ? "stamp-gold-art" : ""} /> : <GuardianAvatar appearance={character.appearance} color={character.color} />}
                                <span className="arc-target-label">{targetCue}</span>
                            </span>}
                            {cell.actor?.special && <progress className="stamp-enemy-hp" aria-label={ko ? "남은 타격" : "Hits remaining"} max={cell.actor.special === "boss" ? BOSS_OPENINGS : 2} value={cell.actor.hp} />}
                            {cell.impact && cell.impact.kind !== "crack" && cell.impact.until > view.elapsed && <span className="arc-impact" key={cell.impact.until}>
                                {cell.impact.kind === "stamp" && <Goblin className="stamp-squash" />}
                                {cell.impact.kind === "stamp" && <img className="arc-impact-art" src="/arcade/stamp-impact-512.webp" alt="" />}
                                <b>{cell.impact.kind === "stamp" ? t.hit : cell.impact.kind === "wrong" ? t.wrong : cell.impact.kind === "guard" ? ko ? "방어 중!" : "GUARDED!" : t.miss}</b>
                                {cell.impact.kind !== "miss" && cell.impact.kind !== "guard" && <em>{cell.impact.points > 0 ? "+" : ""}{cell.impact.points}</em>}
                            </span>}
                        </button>
                    );})}
                </div>
                {(countdown > 0 || paused) && <div className="arc-game-overlay" role={paused ? "region" : "status"} aria-label={paused ? t.paused : t.ready}>
                    {paused ? <><span className="arc-overline">{t.pause}</span><h2>{t.paused}</h2><p>{t.pauseNote}</p>
                        <button ref={resumeButton} className="arc-button" onClick={() => setPause(false)}>{t.resume} →</button>
                        <button className="arc-text-button" onClick={() => {if (!done.current) {done.current = true; finishRef.current(state.current, true);}}}>{t.quit}</button>
                        <small>{t.stopped}</small></> : <><span>{t.ready}</span><strong className="arc-countdown">{countdown}</strong><p>{t.rules}</p></>}
                </div>}
            </div>
            <div className="arc-play-footer"><span><i className="arc-live-dot" /> {character.name} · {autopilot ? locale === "ko" ? "에이전트 관전 중" : "WATCHING AGENT" : t.human}</span><span>{autopilot ? "AUTO" : t.touch}</span></div>
            <StampChallenges game={view} locale={locale} />
            <div className="stamp-cast" aria-label={ko ? "오늘의 도깨비" : "Meet the goblins"}>
                <div><Goblin /><span><strong>{ko ? "장난꾸러기" : "Trickster"}</strong><small>{ko ? "한 번 콕!" : "One stamp"}</small></span></div>
                <div><Goblin variant="armored" /><span><strong>{ko ? "철갑 도깨비" : "Iron guard"}</strong><small>{ko ? "두 번 콕!" : "Two stamps"}</small></span></div>
                <div><Goblin variant="boss" /><span><strong>{ko ? "도깨비 대장" : "Goblin chief"}</strong><small>{ko ? "빈틈마다 한 번!" : "One per opening"}</small></span></div>
            </div>
            <p className="arc-keyboard-help">{autopilot ? locale === "ko" ? "에이전트가 조작하고 있어요 · Esc 일시정지" : "Your agent is playing · Esc to pause" : t.keyboard}</p>
        </section>
    );
}
