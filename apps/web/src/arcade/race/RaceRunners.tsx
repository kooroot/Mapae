import {useEffect, useLayoutEffect, useRef, useState, type RefObject} from "react";
import {raceEndTime, raceFrameAt, RACE_BURST_SECONDS, type RaceFrame, type RaceRoute, type RaceSimulation} from "@mapae/arcade/race";
import type {Color} from "../state";
import type {MotionTier} from "../motion";
import type {ArcadeSound} from "../sound";
import type {Locale} from "../../lib/i18n";
import {gallopRate, RaceCues, runnerVelocity, setGallop} from "./race-fx";

/** A path change glides between the inner and outer lane instead of jumping 17px. */
export const LANE_MS = 220;
const LANE_Y: Record<RaceRoute, number> = {wide: 12, shortcut: -5};
/** A dropped frame or a returning tab advances a lane glide by at most this much. */
const MAX_STEP_MS = 100;

/** Sprite margins around the pony: dust trails left, the "YOU" tag and burst glow rise above it. */
const SPRITE_LEFT = 24, SPRITE_TOP = 12;

export type Lane = {from: number; to: number; ms: number};
type Point = {x: number; y: number};

/** Where a lane glide stands after `lane.ms`, through `ease` (progress 0→1 to eased 0→1). */
export function laneY(lane: Lane, ease: (progress: number) => number): number {
    return lane.ms >= LANE_MS ? lane.to : lane.from + (lane.to - lane.from) * ease(Math.max(0, lane.ms) / LANE_MS);
}

/**
 * The next lane state. `step` is the wall time since the last frame while live, or null when placing a held picture:
 * a held picture keeps a glide where it froze (pause), and `settle` snaps everything to its lane (still, ended).
 */
export function nextLane(lane: Lane | undefined, target: number, step: number | null, settle: boolean, ease: (progress: number) => number): Lane {
    if (!lane || settle || (step === null && lane.to !== target)) return {from: target, to: target, ms: LANE_MS};
    if (lane.to !== target) return {from: laneY(lane, ease), to: target, ms: 0};
    return step ? {...lane, ms: Math.min(LANE_MS, lane.ms + Math.min(MAX_STEP_MS, step))} : lane;
}

/** Sprite geometry in CSS px; the scene SVG's viewBox is its own pixel size, so both layers share these coordinates. */
export function raceLayout(width: number, height: number) {
    const pony = width < 500 ? 60 : 76;
    return {pony, row: height * .14, startY: height * .36, run: Math.max(0, width - pony - 34)};
}

let laneCurve: Animation | undefined;
/** `--arc-ease-out` at `progress`: a paused, target-less effect evaluates the CSS token, so the curve is never restated here. */
function easeOut(progress: number): number {
    if (!laneCurve) {
        const easing = getComputedStyle(document.documentElement).getPropertyValue("--arc-ease-out").trim();
        // Stylesheet not applied yet: glide linearly this frame instead of caching the miss.
        if (!easing) return progress;
        laneCurve = new Animation(new KeyframeEffect(null, null, {duration: LANE_MS, easing, fill: "both"}));
    }
    laneCurve.currentTime = progress * LANE_MS;
    return laneCurve.effect?.getComputedTiming().progress ?? progress;
}

/**
 * The moving layer of the course. React renders what a runner looks like (labels, lane line, burst glow) at the HUD's pace;
 * a requestAnimationFrame loop reads the shared race clock and writes every position as translate3d, so horses move at the
 * display's frame rate without a React render. The sprite element's transform belongs to placement: effects animate inside it.
 */
export function RaceRunners({race, frame, rivalId, color, locale, clock, follow, live, meter, tier, sound, playback}: {
    race: RaceSimulation; frame: RaceFrame; rivalId: string; color: Color; locale: Locale; tier: MotionTier; sound: ArcadeSound;
    /** Viewing speed (1× or 2×): strides quicken with it, as the clock does. */
    playback: number;
    /** Simulation seconds, advanced by RaceGame every frame. */
    clock: RefObject<number>;
    /** Positions track the clock; false when still or ended, where `frame` is the picture. */
    follow: boolean;
    /** The clock is advancing, so the loop runs. */
    live: boolean;
    meter: RefObject<HTMLSpanElement | null>;
}) {
    const ko = locale === "ko";
    const scene = useRef<SVGSVGElement>(null);
    const links = useRef<SVGGElement>(null);
    const field = useRef<HTMLDivElement>(null);
    const lanes = useRef({round: -1, byId: new Map<string, Lane>()});
    const draw = useRef<(time: number, step: number | null) => void>(() => {});
    const [cues] = useState(() => new RaceCues());
    const [size, setSize] = useState({width: 800, height: 440});
    // Measured before the first paint: sprites sit at absolute pixels, so a guessed size would show them off the course.
    useLayoutEffect(() => {
        const measure = (box: {width: number; height: number}) => {
            if (box.width > 0 && box.height > 0) setSize(size => size.width === box.width && size.height === box.height ? size : {width: box.width, height: box.height});
        };
        if (!scene.current) return;
        measure(scene.current.getBoundingClientRect());
        const observer = new ResizeObserver(entries => {if (entries[0]) measure(entries[0].contentRect);});
        observer.observe(scene.current);
        return () => observer.disconnect();
    }, []);
    const {pony, row, startY, run} = raceLayout(size.width, size.height);

    useLayoutEffect(() => {
        const endTime = raceEndTime(race);
        draw.current = (time, step) => {
            const sprites = field.current?.children;
            if (!sprites) return;
            if (lanes.current.round !== race.course.round) lanes.current = {round: race.course.round, byId: new Map()};
            const now = raceFrameAt(race, time / race.seconds);
            const points = new Map<string, Point>();
            race.entrants.forEach((runner, index) => {
                const position = now.positions.find(item => item.id === runner.id)!;
                const lane = nextLane(lanes.current.byId.get(runner.id), LANE_Y[position.path], step, !follow, easeOut);
                lanes.current.byId.set(runner.id, lane);
                const point = {x: 8 + position.distance / race.course.distance * run, y: startY + index * row + laneY(lane, easeOut)};
                points.set(runner.id, point);
                const sprite = sprites[index] as HTMLElement | undefined;
                // The sprite box starts above and left of the runner's ground point (no style attribute: the CSP allows none).
                if (sprite) sprite.style.transform = `translate3d(${point.x - SPRITE_LEFT}px,${point.y - pony - SPRITE_TOP}px,0)`;
                // Strides follow the horse's own speed; only a live race gallops, and an arrived horse has stopped.
                if (sprite && step !== null && position.distance < race.course.distance) setGallop(sprite, gallopRate(runnerVelocity(race, time, index), playback, position.stamina));
            });
            for (const link of links.current?.children ?? []) {
                const from = points.get((link as SVGElement).dataset.from!), to = points.get((link as SVGElement).dataset.to!);
                if (from && to) link.setAttribute("d", `M${from.x + pony * .8} ${from.y - 18} Q${Math.max(from.x, to.x) + pony} ${(from.y + to.y) / 2} ${to.x + pony * .45} ${to.y - 6}`);
            }
            if (meter.current) meter.current.style.transform = `scaleX(${Math.min(1, time / endTime)})`;
            // Moments follow the clock itself, so reduced motion (a held two-second picture) still hears and sees them on time.
            cues.fire(race, clock.current, {tier, sound, sprite: id => sprites[race.entrants.findIndex(runner => runner.id === id)]});
        };
        // Every render places too: new sprites and links never paint a frame at the origin, and a held race shows its exact moment.
        draw.current(follow ? clock.current : frame.time, live ? 0 : null);
    });

    useEffect(() => {
        if (!live) return;
        let id = 0, last: number | null = null;
        const loop = (stamp: number) => {
            draw.current(clock.current, last === null ? 0 : stamp - last);
            last = stamp;
            id = requestAnimationFrame(loop);
        };
        id = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(id);
    }, [live, clock]);

    return <>
        <svg ref={scene} className="race-world-runners" viewBox={`0 0 ${size.width} ${size.height}`} role="img" aria-label={ko ? `한 코스에서 달리는 ${race.entrants.length}마리 말. 아래에서 순위와 체력을 확인하세요.` : `${race.entrants.length} horses on one course. Positions and stamina are listed below.`}>
            <g className="race-finish-post" transform={`translate(${size.width - 28} ${startY - 48})`}>
                <path d={`M0 0V${row * 4 + 36}`} stroke="#ffefc8" strokeWidth="7" strokeDasharray="7 7" />
                <path d="M-14 -12h28v25h-28z" fill="#2e4938" stroke="#f4d592" strokeWidth="2" />
                <path d="M-10 -8h8v8h-8zm16 0h5v8H6zM-2 0h8v8h-8z" fill="#fceaca" />
            </g>
            <g ref={links} aria-hidden="true">{frame.positions.filter(position => position.draftingId).map(position =>
                <path key={`draft-${position.id}`} className="race-draft-link" data-from={position.id} data-to={position.draftingId} fill="none" stroke={position.blockedBy ? "#ffb573" : "#d5f7b2"} strokeWidth="3" strokeDasharray="5 4" />)}</g>
        </svg>
        <div ref={field} className="race-field" aria-hidden="true">{race.entrants.map((runner, index) => {
            const position = frame.positions.find(item => item.id === runner.id)!;
            const arrived = position.distance >= race.course.distance;
            const owner = runner.id === "owner";
            const tone = owner ? color : (["jade", "ink", "red"] as const)[index % 3]!;
            const bursting = race.bursts.some(burst => burst.id === runner.id && frame.time >= burst.at && frame.time < burst.at + RACE_BURST_SECONDS);
            const rival = runner.id === rivalId;
            return <div key={runner.id} className={`race-sprite ${owner ? "race-our-runner" : "race-other-runner"} ${arrived ? "race-arrived" : ""} ${bursting ? "race-runner-bursting" : ""}`}>
                <svg viewBox={`${-SPRITE_LEFT} ${-pony - SPRITE_TOP} ${pony + 2 * SPRITE_LEFT} ${pony + SPRITE_TOP + 40}`} width={pony + 2 * SPRITE_LEFT} height={pony + SPRITE_TOP + 40}>
                    <path d={`M-4 22H${pony + 6}`} stroke={position.path === "wide" ? "#ffd39d" : "#cce8a8"} strokeWidth="3" strokeDasharray={position.path === "wide" ? "8 4" : undefined} opacity=".9" />
                    <text className="race-path-label" x={pony / 2} y="34" textAnchor="middle" fill="#fff4d9" fontSize="9" fontWeight="800">{position.blockedBy ? ko ? "막힘" : "BLOCKED" : position.draftingId ? ko ? "따라가기 −40%" : "DRAFT −40%" : position.path === "wide" ? ko ? "바깥 추월" : "OUTSIDE" : ko ? "안쪽" : "INSIDE"}</text>
                    <ellipse cx={pony * .52} cy="16" rx={pony * .38} ry="6" fill="#54301b" opacity=".25" />
                    <g className="race-dust" fill="#fff0bd"><circle cx="8" cy="8" r="7" /><circle cx="0" cy="13" r="4" /><circle cx="-8" cy="7" r="3" /></g>
                    {bursting && <ellipse cx={pony * .5} cy={-pony * .32} rx={pony * .5} ry={pony * .4} fill="#ffd274" opacity=".35" />}
                    <g className="race-pony-bounce"><image href={`/arcade/race-pony-${tone}-512.webp`} x="0" y={-pony + 18} width={pony} height={pony} /></g>
                    <g transform={`translate(${owner ? pony / 2 : pony - 2} ${owner ? -pony + 10 : 2})`}><rect x="-19" y="-17" width="38" height="18" rx="9" fill={owner ? "#2a523d" : "#362a20"} stroke={owner ? "#ffe29a" : "#d3b17c"} /><text textAnchor="middle" y="-5" fill="#fff0c8" fontSize="10" fontWeight="800">{owner ? ko ? "내 말" : "YOU" : rival ? ko ? "맞수" : "RIVAL" : index + 1}</text></g>
                </svg>
            </div>;
        })}</div>
    </>;
}
