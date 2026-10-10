import {raceEvents, raceTerrain, RACE_BASE_SPEED, RACE_BURST_SECONDS, RACE_CHECKPOINTS, RACE_ROUTE_SECONDS, type RaceEvent, type RaceSimulation, type RaceTerrain} from "@mapae/arcade/race";
import {flash, parseTime, play, pop} from "../juice";
import type {MotionTier} from "../motion";
import type {ArcadeSound} from "../sound";

/** A clock jump longer than this many simulation seconds ("see the result now") skips the moments it crossed instead of firing them at once. */
export const MAX_CUE_JUMP = 1.5;
/** The engine's fixed step: `simulateRace` writes one frame per tenth of a simulation second. */
const TICK = .1;
/** Below this the stride change is invisible, so the animation is left alone. */
const RATE_STEP = .04;

/** The events the clock crossed going from `from` (exclusive) to `to` (inclusive); none when it stood still, went back or jumped. */
export function dueEvents(events: readonly RaceEvent[], from: number, to: number): RaceEvent[] {
    if (!(to > from) || to - from > MAX_CUE_JUMP) return [];
    return events.filter(event => event.time > from && event.time <= to);
}

/** Metres per simulation second over the engine step under `time`, for the entrant at `index`. */
export function runnerVelocity(race: RaceSimulation, time: number, index: number): number {
    const upper = Math.min(race.frames.length - 1, Math.max(1, Math.ceil(time / TICK)));
    const from = race.frames[upper - 1]!, to = race.frames[upper]!;
    return (to.positions[index]!.distance - from.positions[index]!.distance) / (to.time - from.time);
}

/** Stride rate of the gallop: the horse's own speed against base speed at the viewing speed, clamped to a believable stride, then heavier when tired. */
export function gallopRate(velocity: number, playback: number, stamina: number): number {
    return Math.min(2.2, Math.max(.6, playback * velocity / RACE_BASE_SPEED)) * (stamina < 25 ? .8 : 1);
}

/** The CSS animations a stride or a gust speeds up. */
export const GALLOP: ReadonlySet<string> = new Set(["race-gallop", "race-dust", "race-mud", "race-grass", "race-slip"]);
export const WIND: ReadonlySet<string> = new Set(["race-wind-streak", "race-wind-leaf", "race-leaf-spin"]);

const rates = new WeakMap<Element, {animations: Animation[]; rate: number; key: string | null}>();
/**
 * Sets the CSS animations named in `names` under `root` to `rate`. Rate is not play state, so `[data-halted]` still pauses them.
 * The animations are found again whenever CSS may have started or restarted some: the root's classes changed (a terrain's kick
 * comes and goes with one), or one went idle (a class toggle above the root cancels the old ones and starts new ones at 1×).
 */
export function setRate(root: Element, names: ReadonlySet<string>, rate: number) {
    const key = root.getAttribute("class");
    let found = rates.get(root);
    if (!found || found.key !== key || !found.animations.length || found.animations.some(animation => animation.playState === "idle")) {
        // NaN: a fresh set mixes kept and new animations, so the rate is written to all of them once.
        found = {animations: root.getAnimations({subtree: true}).filter(animation => animation instanceof CSSAnimation && names.has(animation.animationName)), rate: NaN, key};
        rates.set(root, found);
    }
    if (Math.abs(found.rate - rate) < RATE_STEP) return;
    found.rate = rate;
    // updatePlaybackRate keeps each animation's current pose, so a speed change never jumps the picture.
    for (const animation of found.animations) animation.updatePlaybackRate(rate);
}

/**
 * The fork's ground under a runner at `time`: the engine applies a terrain to the shortcut for RACE_ROUTE_SECONDS after the call,
 * and never to the outside path or an arrived horse. `slip` is a push through mud, where the engine cuts the speed.
 */
export function groundAt(race: RaceSimulation, time: number, id: string): {terrain: RaceTerrain; slip: boolean} | null {
    const call = race.calls.findLast(item => item.id === id && item.at <= time);
    const arrived = race.finish.find(item => item.id === id)?.seconds ?? Infinity;
    if (!call || call.route !== "shortcut" || time >= call.at + RACE_ROUTE_SECONDS || time >= arrived) return null;
    const terrain = raceTerrain(race.course, RACE_CHECKPOINTS.indexOf(call.at as typeof RACE_CHECKPOINTS[number]));
    return {terrain, slip: terrain === "mud" && call.pace === "push"};
}

/** Wind scenery speed on the engine's own gust curve (`raceWeatherFactor`): 1× at the average headwind, faster as it bites, slower in a lull. */
export function windRate(factor: number): number {
    return Math.min(2, Math.max(.5, .5 + (1 - factor) * 12.5));
}

/** A first-to-second gap under this many simulation seconds is a photo finish: one flash at the line, then a banner drops. */
export const PHOTO_FINISH = .8;
/** The start signal: three beats ("셋·둘·출발!") this long; the clock holds through all but the last, which starts the race. */
export const START_BEATS = 3;
export const BEAT_MS = 400;
/** The longest ceremony a watched agent's race may show, so nothing reads as holding up its auto-advance. */
const LIGHT_MS = 300;
/** Hanji confetti in the five obangsaek: blue, red, yellow, white, black. */
const OBANG = ["#2f5d8a", "#b8432f", "#e2b23c", "#f6eedb", "#2b2723"] as const;
const CONFETTI = 14;
const PASS_TAG_MS = 900, FLINCH_MS = 180, KICK_MS = 560, FLAG_MS = 420, REIN_MS = 420, CONFETTI_MS = 900, PHOTO_MS = 240, PRESS_MS = 260;

/** Whether a race opens with the start signal: only a player's own race at full motion. A watched agent and reduced motion start at once. */
export function startSignal(human: boolean, tier: MotionTier): boolean {
    return human && tier === "full";
}

/** One beat of the start signal: two ticks, then the go. */
export function cueStartBeat(beat: number, sound: ArcadeSound) {
    if (!document.hidden) sound.play(beat < START_BEATS - 1 ? "tick" : "go");
}

/** A ceremony's length for the tier: a watched agent's is clipped to LIGHT_MS. */
export function ceremonyMs(tier: MotionTier, ms: number): number {
    return tier === "light" ? Math.min(ms, LIGHT_MS) : ms;
}

/** First and second crossed the line within PHOTO_FINISH of each other (a dead heat included). */
export function photoFinish(race: RaceSimulation): boolean {
    return race.finish.length > 1 && race.finish[1]!.seconds - race.finish[0]!.seconds < PHOTO_FINISH;
}

/** The arrival that makes a photo finish (the second across the line), or undefined when the finish was not close. */
export function photoFinishEvent(race: RaceSimulation, events: readonly RaceEvent[]): RaceEvent | undefined {
    return photoFinish(race) ? events.filter(event => event.type === "finish")[1] : undefined;
}

/** The burst glow's strength `elapsed` seconds into a burst: full, then fading out over the last 30% of it. */
export function burstGlow(elapsed: number): number {
    return Math.min(1, Math.max(0, (RACE_BURST_SECONDS - elapsed) / (RACE_BURST_SECONDS * .3)));
}

export type ConfettiPiece = {dx: number; dy: number; spin: number; color: string; delay: number};
/** A fan of pieces thrown up and out from the horse, spread evenly with a fixed jitter so every celebration looks alike. */
export function confettiPieces(count = CONFETTI): ConfettiPiece[] {
    return Array.from({length: count}, (_, i) => {
        const angle = -Math.PI * (.12 + .76 * i / Math.max(1, count - 1));
        const reach = 44 + (i * 3 % 5) * 9;
        return {dx: +(Math.cos(angle) * reach).toFixed(1), dy: +(Math.sin(angle) * reach).toFixed(1), spin: (i % 2 ? 1 : -1) * (140 + i * 29 % 160), color: OBANG[i % OBANG.length]!, delay: i * 7 % 4 * 25};
    });
}

/** Staggered entrance timing: the full cascade for a player, everything at once and short for a watched agent. */
export function staggerTiming(tier: MotionTier, index: number, step: number, start = 0): {delay: number; duration: number} {
    return tier === "light" ? {delay: 0, duration: 160} : {delay: start + index * step, duration: 240};
}

/** Milliseconds from mount to the impact frame of a CSS `arc-seal-slam` (40% through it), read from the element's own computed timing. */
export function sealDelay(style: {animationDelay: string; animationDuration: string}): number {
    return parseTime(style.animationDelay) + parseTime(style.animationDuration) * .4;
}

const eases = new Map<string, string>();
/** A CSS easing token for keyframe-level easing, which `play()` cannot resolve; linear until the stylesheet applies. */
function ease(name: "out" | "in" | "back"): string {
    const cached = eases.get(name);
    if (cached) return cached;
    const value = getComputedStyle(document.documentElement).getPropertyValue(`--arc-ease-${name}`).trim();
    if (value) eases.set(name, value);
    return value || "linear";
}

/** Rows rising into place one after another (results, standings). Reduced motion keeps the staggered fade. */
export function riseIn(elements: Iterable<Element>, tier: MotionTier, step: number, start = 0) {
    let index = 0;
    for (const el of elements) play(el, [{opacity: 0, transform: "translateY(8px)"}, {opacity: 1, transform: "translateY(0)"}], {id: "race-rise", ...staggerTiming(tier, index++, step, start), easing: "out", fill: "backwards"}, {tier});
}

/** The burst button gives under the press and springs back before it turns into its "used" stamp. */
export function pressBurst(button: Element | null, tier: MotionTier) {
    if (button) play(button, [{transform: "scale(1)"}, {transform: "scale(.92)", offset: .3}, {transform: "scale(1.06)", offset: .7}, {transform: "scale(1)"}], {id: "race-burst-press", duration: PRESS_MS, easing: "out"}, {tier});
}

/** Plays the result seal's thump on the stamp's impact frame. */
export function cueSeal(place: Element | null, sound: ArcadeSound) {
    if (place && !document.hidden) sound.play("seal", 0, sealDelay(getComputedStyle(place)));
}

export type RaceStage = {
    tier: MotionTier; sound: ArcadeSound;
    /** An entrant's sprite: its pony and its pass tag. */
    sprite: (id: string) => Element | undefined;
    /** The middle of an entrant's pony, in moment-layer pixels. */
    point: (id: string) => {x: number; y: number} | undefined;
    /** The overlay above the field: confetti and the photo-finish flash (`arc-flash-host`). */
    layer: HTMLElement | null;
    /** The finish-line flag. */
    flag: Element | null;
};

/**
 * Plays each race moment once, as the shared clock crosses it. A recomputed simulation (a call or a burst) keeps the mark,
 * because positions already shown never change; a new round starts from its own clock. A hidden tab advances silently.
 */
export class RaceCues {
    private race: RaceSimulation | null = null;
    private events: RaceEvent[] = [];
    /** The first horse to edge ahead off the gate takes no lead from anyone, so it is not a moment. */
    private opening: RaceEvent | undefined;
    private photo: RaceEvent | undefined;
    private round = -1;
    private mark = 0;

    fire(race: RaceSimulation, time: number, stage: RaceStage) {
        if (race !== this.race) {
            if (race.course.round !== this.round) {this.round = race.course.round; this.mark = time;}
            this.race = race;
            this.events = raceEvents(race);
            this.opening = this.events.find(event => event.type === "lead");
            this.photo = photoFinishEvent(race, this.events);
        }
        const due = dueEvents(this.events, this.mark, time);
        this.mark = Math.max(this.mark, time);
        if (!document.hidden) for (const event of due) if (event !== this.opening) cueRaceEvent(event, stage, event === this.photo);
    }
}

/** Throws the owner's confetti from its horse; pieces remove themselves when they land or are cancelled. Full motion only. */
function confetti(layer: HTMLElement, at: {x: number; y: number}) {
    for (const piece of confettiPieces()) {
        const el = layer.ownerDocument.createElement("i");
        el.className = "race-confetti";
        el.style.left = `${at.x}px`;
        el.style.top = `${at.y}px`;
        el.style.background = piece.color;
        layer.appendChild(el);
        const flight = play(el, [
            {opacity: 1, transform: "translate(0,0) rotate(0deg) scale(.4)", easing: ease("out")},
            {opacity: 1, transform: `translate(${piece.dx}px,${piece.dy}px) rotate(${piece.spin / 2}deg) scale(1)`, offset: .45, easing: ease("in")},
            {opacity: 0, transform: `translate(${+(piece.dx * 1.15).toFixed(1)}px,${piece.dy + 38}px) rotate(${piece.spin}deg) scale(.9)`},
        ], {duration: CONFETTI_MS - piece.delay, delay: piece.delay, fill: "backwards"}, {tier: "full"});
        if (flight) flight.finished.then(() => el.remove(), () => el.remove());
        else el.remove();
    }
}

/** One moment: the owner hears its own race, and the horses it concerns answer on screen. Labels and the draft link already show drafts. */
export function cueRaceEvent(event: RaceEvent, {tier, sound, sprite, point, layer, flag}: RaceStage, photo = false) {
    const own = event.id === "owner";
    const pony = sprite(event.id)?.querySelector(".race-pony-bounce");
    switch (event.type) {
        case "pass": {
            if (pony) pop(pony, {tier}, {scale: own ? 1.12 : 1.06});
            const against = event.otherId === "owner";
            // Only passes the owner is part of earn a tag: its own in full, a rival's over it smaller and muted (the sprite's own variant).
            const tag = own || against ? sprite(event.id)?.querySelector(".race-pass-tag") : null;
            if (tag) play(tag, [
                {opacity: 0, transform: "translateY(0) scale(.55)", easing: ease("out")},
                {opacity: 1, transform: "translateY(0) scale(1.12)", offset: .2, easing: ease("out")},
                {opacity: 1, transform: "translateY(0) scale(1)", offset: .32},
                {opacity: 1, transform: "translateY(0) scale(1)", offset: .62, easing: ease("in")},
                {opacity: 0, transform: "translateY(-18px) scale(1)"},
            ], {id: "race-pass-tag", duration: PASS_TAG_MS}, {tier});
            // The passed horse flinches; a watched agent's race keeps to feedback without recoil.
            const passed = tier === "full" && event.otherId ? sprite(event.otherId)?.querySelector(".race-pony-bounce") : null;
            if (passed) play(passed, [{transform: "translateX(0) rotate(0deg)"}, {transform: "translateX(-5px) rotate(3deg)", offset: .35}, {transform: "translateX(0) rotate(0deg)"}], {id: "race-flinch", duration: FLINCH_MS, easing: "shake", composite: "add"}, {tier});
            // Climbs with the place reached: a pass into the lead rings highest.
            if (own) sound.play("combo", 5 - (event.rank ?? 4));
            else if (against) sound.play("break");
            break;
        }
        case "lead":
            // Lands just after the pass that took it, so the two cues read as one phrase.
            if (own) sound.play("golden", 0, 180);
            break;
        case "burst-start":
            // Crouch, kick off, settle; the ink streaks and the glow belong to the sprite while the burst lasts.
            if (pony) play(pony, [
                {transform: "translate(0,0) skewX(0deg) scale(1,1)", easing: ease("out")},
                {transform: "translate(-3px,2px) skewX(0deg) scale(1.03,.92)", offset: .21, easing: ease("out")},
                {transform: "translate(10px,0) skewX(-6deg) scale(1,1)", offset: .54, easing: ease("back")},
                {transform: "translate(0,0) skewX(0deg) scale(1,1)"},
            ], {id: "race-kick", duration: KICK_MS, composite: "add"}, {tier});
            if (own) sound.play("fever");
            break;
        case "burst-end":
            if (own) sound.play("feverEnd");
            break;
        case "blocked":
            if (own) sound.play("guard");
            break;
        case "call":
            if (own) sound.play("tick");
            break;
        case "finish": {
            const ms = (base: number) => ceremonyMs(tier, base);
            // The flag waves for every arrival; the horse reins in rather than freezing, then breathes (CSS, on `race-arrived`).
            if (flag) play(flag, [{transform: "rotate(0deg) skewY(0deg)"}, {transform: "rotate(-8deg) skewY(6deg)", offset: .3}, {transform: "rotate(5deg) skewY(-4deg)", offset: .62}, {transform: "rotate(0deg) skewY(0deg)"}], {id: "race-flag", duration: ms(FLAG_MS), easing: "out"}, {tier});
            if (pony) play(pony, [{transform: "translateX(0) rotate(0deg)"}, {transform: "translateX(-4px) rotate(-7deg)", offset: .45}, {transform: "translateX(0) rotate(0deg)"}], {id: "race-rein", duration: ms(REIN_MS), easing: "out", composite: "add"}, {tier});
            if (photo && layer) flash(layer, "#fff6dc", {tier}, PHOTO_MS);
            if (!own) break;
            const at = point(event.id);
            if (tier === "full" && layer && at && (event.rank ?? 4) <= 3) confetti(layer, at);
            sound.play(event.rank === 1 ? "perfect" : "end");
            break;
        }
        case "draft-start":
        case "draft-end":
            break;
    }
}
