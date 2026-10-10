import {multiplier, type Game, type StampEvent} from "@mapae/arcade/stamp";
import type {ArcadeSound, SoundKind} from "./sound";
import type {MotionTier} from "./motion";
import {hitStop, play, shake, type MotionGate} from "./juice";

/** Where a Dokkaebi Stamp round sends its feedback: the speaker, how much motion it may spend, and the two surfaces it moves. */
export type StampFx = {sound: ArcadeSound; tier: MotionTier; field: HTMLElement | null; windows: HTMLElement | null};
/** A tap the engine judged: its window, and the pointer in client coordinates when a pointer made it. */
export type StampTap = {index: number; point?: {x: number; y: number}};

/**
 * One visual beat, already decided for the tier, so the tier rules are testable without a DOM. `seal` sets the combo boost
 * the CSS seal slam reads when React mounts the impact; the rest play on the window's persistent fx layer (see StampWindow),
 * which outlives the engine's impact, so a score float or a crack is never cut off when the impact expires.
 */
export type StampMotion =
    | {kind: "press" | "ink" | "rings" | "hitStop" | "shards" | "spark" | "strike" | "shake" | "pass"; index: number}
    | {kind: "seal"; index: number; boost: number}
    | {kind: "float"; index: number; text: string}
    | {kind: "ripple"; index: number; point?: StampTap["point"]}
    | {kind: "fieldShake"};

/** The peak scale of the shared `arc-seal-slam`; a combo multiplier adds a tenth to it, applied as a factor on top. */
export const SEAL_PEAK = 1.9;
export function sealBoost(combo: number): number {
    return 1 + .1 * (multiplier(combo) - 1) / SEAL_PEAK;
}

/** Six coin shards fanning out 24–40px in a fixed pattern, so every golden hit reads the same. */
export const SHARDS = [0, 1, 2, 3, 4, 5].map(i => {
    const angle = (i * 60 + (i % 2 ? 12 : -8)) * Math.PI / 180, reach = [32, 26, 40, 28, 36, 24][i]!;
    return {x: +(Math.cos(angle) * reach).toFixed(1), y: +(Math.sin(angle) * reach).toFixed(1), turn: (i % 2 ? 1 : -1) * (90 + i * 25)};
});

/**
 * What a step looks like at a tier. Full: everything. Light (a watched agent): the hit itself (seal, ink, score float, perfect
 * rings) without hit-stop, shake or shards. Still: the impact already stays on screen with its points, so the planned beats
 * are the short fades the motion gate turns them into, and nothing that only moves (press, float, shards, field shake).
 */
export function stampMotions(events: readonly StampEvent[], game: Game, tier: MotionTier, tap?: StampTap): StampMotion[] {
    const full = tier === "full", still = tier === "still";
    const motions: StampMotion[] = [];
    if (tap && full) motions.push({kind: "press", index: tap.index});
    for (const event of events) {
        if (event.type === "hit") {
            const {index} = event;
            motions.push({kind: "seal", index, boost: sealBoost(game.combo)}, {kind: "ink", index});
            if (!still) motions.push({kind: "float", index, text: `+${event.points}`});
            if (event.actor.golden && full) motions.push({kind: "shards", index});
        } else if (event.type === "crack") {
            const {index} = event, points = game.cells[index]?.impact?.points ?? 0;
            // A perfect crack wears the seal and its bonus; a plain one is the spark of armour giving.
            if (points <= 0) motions.push({kind: "spark", index});
            else {
                motions.push({kind: "seal", index, boost: sealBoost(game.combo)});
                if (!still) motions.push({kind: "float", index, text: `+${points}`});
            }
        } else if (event.type === "perfect") {
            motions.push({kind: "rings", index: event.index});
            if (full) motions.push({kind: "hitStop", index: event.index});
        } else if (event.type === "wrong") {
            motions.push({kind: "strike", index: event.index});
            if (tier !== "light") motions.push({kind: "shake", index: event.index});
            if (full) motions.push({kind: "fieldShake"});
        } else if (event.type === "pass") motions.push({kind: "pass", index: event.index});
        else if (event.type === "dud") motions.push({kind: "ripple", index: event.index, point: tap?.index === event.index ? tap.point : undefined});
    }
    return motions;
}

/** One cue per step, the most telling first, so a hit that also starts fever does not stack two chimes. */
function cue(events: readonly StampEvent[]): SoundKind | null {
    const has = (type: StampEvent["type"]) => events.some(event => event.type === type);
    if (has("perfect")) return "perfect";
    if (has("feverStart")) return "fever";
    const hit = events.find(event => event.type === "hit");
    if (hit) return hit.actor.golden ? "golden" : "hit";
    if (has("crack")) return "hit";
    if (has("guard")) return "guard";
    if (has("wrong")) return "wrong";
    return null;
}

const PRESS: Keyframe[] = [{transform: "scale(1)"}, {transform: "scale(.965)", offset: .35}, {transform: "scale(1)"}];
const INK: Keyframe[] = [{opacity: .35, transform: "scale(.4)"}, {opacity: 0, transform: "scale(1.15)"}];
const FLOAT: Keyframe[] = [{opacity: 1, transform: "translateY(0)"}, {opacity: 1, offset: .6}, {opacity: 0, transform: "translateY(-38%)"}];
const RING: Keyframe[] = [{opacity: .9, transform: "scale(.8)"}, {opacity: 0, transform: "scale(1.5)"}];
const SPARK: Keyframe[] = [{opacity: 1, transform: "scale(.5) rotate(-20deg)"}, {opacity: 0, transform: "scale(1.35) rotate(15deg)"}];
/** A red ink stroke drawn in the first 120ms of the wrong impact's 420ms, held, then lifted. */
const STRIKE: Keyframe[] = [{opacity: 1, transform: "scaleX(0)"}, {opacity: 1, transform: "scaleX(1)", offset: 120 / 420}, {opacity: 1, transform: "scaleX(1)", offset: .7}, {opacity: 0, transform: "scaleX(1)"}];
const RIPPLE: Keyframe[] = [{opacity: .35, transform: "scale(.3)"}, {opacity: 0, transform: "scale(1.2)"}];
const PASS: Keyframe[] = [{opacity: 0, transform: "translateY(30%) scale(.9)"}, {opacity: 1, transform: "translateY(0) scale(1)", offset: .25}, {opacity: 1, transform: "translateY(-10%)", offset: .7}, {opacity: 0, transform: "translateY(-40%)"}];
/** A perfect seal slams in --arc-dur-quick and meets the paper about 40% in: the freeze lands on that contact, not before it. */
const PERFECT_CONTACT_MS = 60;
const PERFECT_FREEZE_MS = 70;

function shardFrames({x, y, turn}: typeof SHARDS[number]): Keyframe[] {
    return [{opacity: 1, transform: "translate(0, 0) rotate(0deg) scale(.6)"}, {opacity: 1, offset: .55}, {opacity: 0, transform: `translate(${x}px, ${y}px) rotate(${turn}deg) scale(1)`}];
}

/** Plays one planned beat. Every target is already in the DOM, so effects start in the same frame as the sound. */
function render(motion: StampMotion, {field, windows}: StampFx, gate: MotionGate) {
    if (motion.kind === "fieldShake") {
        if (field) shake(field, gate, {px: 2});
        return;
    }
    const cell = windows?.children[motion.index];
    if (!(cell instanceof HTMLElement)) return;
    const part = (selector: string) => cell.querySelector<HTMLElement>(selector);
    const each = (selector: string) => [...cell.querySelectorAll<HTMLElement>(selector)];
    switch (motion.kind) {
    case "press": play(cell, PRESS, {id: "stamp-press", duration: 140, easing: "out", composite: "add"}, gate); break;
    case "seal": cell.style.setProperty("--seal-boost", String(motion.boost)); break;
    case "ink": {const ink = part(".stamp-ink"); if (ink) play(ink, INK, {id: "stamp-ink", duration: 320, easing: "out"}, gate); break;}
    case "float": {
        const float = part(".stamp-float");
        if (!float) break;
        float.textContent = motion.text;
        play(float, FLOAT, {id: "stamp-float", duration: 520, easing: "out"}, gate);
        break;
    }
    case "rings": each(".stamp-ring").forEach((ring, i) => play(ring, RING, {id: "stamp-ring", duration: 380, delay: i * 90, easing: "out"}, gate)); break;
    case "hitStop": window.setTimeout(() => hitStop(cell, PERFECT_FREEZE_MS, gate), PERFECT_CONTACT_MS); break;
    case "shards": each(".stamp-shard").forEach((shard, i) => play(shard, shardFrames(SHARDS[i]!), {id: "stamp-shard", duration: 420, easing: "out"}, gate)); break;
    case "spark": {const spark = part(".stamp-spark"); if (spark) play(spark, SPARK, {id: "stamp-spark", duration: 200, easing: "out"}, gate); break;}
    case "strike": each(".stamp-strike > i").forEach((stroke, i) => play(stroke, STRIKE, {id: "stamp-strike", duration: 420, delay: i * 60, easing: "out"}, gate)); break;
    case "shake": shake(cell, gate, {px: 5, color: "#ea6555"}); break;
    case "ripple": {
        const ripple = part(".stamp-ripple");
        if (!ripple) break;
        // A keyboard tap has no point: the ripple spreads from the window's centre.
        const box = motion.point ? cell.getBoundingClientRect() : null;
        ripple.style.left = box ? `${motion.point!.x - box.left}px` : "50%";
        ripple.style.top = box ? `${motion.point!.y - box.top}px` : "50%";
        play(ripple, RIPPLE, {id: "stamp-ripple", duration: 260, easing: "out"}, gate);
        break;
    }
    case "pass": {const chip = part(".stamp-pass"); if (chip) play(chip, PASS, {id: "stamp-pass", duration: 360, easing: "out"}, gate); break;}
    }
}

/** The one place a round's events become feedback, whether a person or an agent is playing. `game` is the state after them. */
export function stampFx(events: readonly StampEvent[], game: Game, fx: StampFx, tap?: StampTap) {
    const kind = cue(events);
    if (kind) fx.sound.play(kind, game.combo);
    if (events.some(event => event.type === "finished")) fx.sound.play("end");
    const gate = {tier: fx.tier};
    for (const motion of stampMotions(events, game, fx.tier, tap)) render(motion, fx, gate);
}

/** The countdown reaching zero. */
export function stampStartFx({sound}: Pick<StampFx, "sound">) {
    sound.play("start");
}

/**
 * Holds the round's scripted effects while it is halted (paused, suspended, counting down) and plays them on resume. CSS
 * animations stop through `[data-halted]` instead: pausing one through the API would detach it from `animation-play-state`.
 */
export function haltStampFx(root: Element, halted: boolean) {
    for (const animation of root.getAnimations({subtree: true})) {
        if (animation instanceof CSSAnimation || animation instanceof CSSTransition) continue;
        if (halted && animation.playState === "running") animation.pause();
        else if (!halted && animation.playState === "paused") animation.play();
    }
}
