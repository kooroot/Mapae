import {useEffect, useLayoutEffect, useRef} from "react";
import type {Locale} from "../lib/i18n";
import {bossWindow, BOSS_OPENINGS, BOSS_CYCLE_MS, BOSS_GUARD_MS, BOSS_PERFECT_START_MS, BOSS_PERFECT_MS, BOSS_PERFECT_POINTS, type Game, type Actor} from "@mapae/arcade/stamp";
import type {MotionTier} from "./motion";
import {play} from "./juice";

const SWEEP: Keyframe[] = [{transform: "translateX(0)"}, {transform: "translateX(100%)"}];

export function BossTimingCue({actor, game, locale, hintId, tier, halted}: {actor: Actor | null; game: Game; locale: Locale; hintId: string; tier: MotionTier; halted: boolean}) {
    const ko = locale === "ko";
    const window = actor ? bossWindow(actor, game.elapsed) : null;
    let cue = ko ? "가운데 창문을 보세요" : "WATCH THE CENTER WINDOW";
    if (window?.perfect) cue = ko ? "◆ 정통! 지금 한 번" : "◆ PERFECT! STAMP ONCE";
    else if (window?.phase === "guard") cue = ko ? "방어 · 손을 떼고 기다려요" : "GUARD · WAIT WITHOUT TAPPING";
    else if (window?.phase === "recover") cue = ko ? "명중 · 다음 빈틈을 기다려요" : "HIT · WAIT FOR THE NEXT OPENING";
    else if (window?.phase === "open") cue = window.perfectBlocked || window.perfectPassed ? ko ? "빈틈! 일반 타격 가능" : "OPEN! NORMAL HIT AVAILABLE" : ko ? "빈틈! ◆ 띠를 노려요" : "OPEN! AIM FOR THE ◆ BAND";
    else if (game.bossSpawned) cue = game.bossDefeated ? ko ? "대장 퇴치!" : "CHIEF DEFEATED!" : ko ? "대장이 달아났어요" : "THE CHIEF ESCAPED";
    const slot = actor ? game.cells.findIndex(cell => cell.actor === actor) + 1 : 0;
    return <div className={`stamp-boss-timing ${window?.perfect ? "is-perfect" : ""}`} data-testid="boss-timing">
        <div className="stamp-boss-timing-heading"><strong role="status" aria-atomic="true">{cue}</strong><span>{ko ? "정통" : "PERFECT"} {game.perfectHits}/{BOSS_OPENINGS}</span></div>
        <div className="stamp-timing-track" aria-hidden="true">
            <svg>
                <rect className="stamp-timing-guard" width={`${BOSS_GUARD_MS / BOSS_CYCLE_MS * 100}%`} height="100%" />
                <text className="stamp-timing-guard-label" x={`${BOSS_GUARD_MS / BOSS_CYCLE_MS * 50}%`} y="50%" dominantBaseline="central" textAnchor="middle">{ko ? "방어" : "GUARD"}</text>
                <rect className="stamp-timing-band" x={`${BOSS_PERFECT_START_MS / BOSS_CYCLE_MS * 100}%`} width={`${BOSS_PERFECT_MS / BOSS_CYCLE_MS * 100}%`} height="100%" />
                <text className="stamp-timing-band-label" x={`${(BOSS_PERFECT_START_MS + BOSS_PERFECT_MS / 2) / BOSS_CYCLE_MS * 100}%`} y="50%" dominantBaseline="central" textAnchor="middle">◆</text>
            </svg>
            {window && <Needle progress={window.progress} tier={tier} halted={halted} />}
        </div>
        <p id={hintId}>{actor && <b>{ko ? `${slot}번 창문 · ` : `Window ${slot} · `}</b>}{window?.perfectBlocked ? ko ? "먼저 눌러 이번 정통 보너스는 사라졌어요. 빈틈 타격은 가능해요." : "An early tap spent this opening's bonus. You can still hit while OPEN." : ko ? `빈틈은 1.4초 · 밝은 띠에 선이 오면 한 번, 정통 +${BOSS_PERFECT_POINTS}점` : `OPEN lasts 1.4s · stamp once when the line enters the bright band: PERFECT +${BOSS_PERFECT_POINTS}`}</p>
    </div>;
}

/**
 * The needle sweeps one boss cycle on the compositor, and every commit snaps it to the engine clock, so it glides at frame rate
 * through the 300ms perfect band without drifting from the judgement. It tells the player when to stamp, so it is essential
 * motion that keeps moving under reduced motion; it stops with the engine while the game is paused, suspended or counting down.
 */
function Needle({progress, tier, halted}: {progress: number; tier: MotionTier; halted: boolean}) {
    const rail = useRef<HTMLSpanElement>(null);
    const sweep = useRef<Animation | null>(null);
    useLayoutEffect(() => {
        const el = rail.current!;
        if (!sweep.current || sweep.current.playState === "idle") sweep.current = play(el, SWEEP, {id: "stamp-needle", duration: BOSS_CYCLE_MS, iterations: Infinity}, {tier, essential: true});
        const animation = sweep.current;
        // A hidden tab starts no animation: hold the needle where the engine is until a later commit can start one.
        if (!animation) {
            el.style.transform = `translateX(${progress * 100}%)`;
            return;
        }
        animation.currentTime = progress * BOSS_CYCLE_MS;
        if (halted) animation.pause();
        else if (animation.playState !== "running") animation.play();
    }, [progress, tier, halted]);
    useEffect(() => () => sweep.current?.cancel(), []);
    return <span className="stamp-timing-rail" ref={rail}><i /></span>;
}
