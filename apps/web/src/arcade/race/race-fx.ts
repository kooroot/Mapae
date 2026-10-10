import {raceEvents, RACE_BASE_SPEED, type RaceEvent, type RaceSimulation} from "@mapae/arcade/race";
import {play, pop} from "../juice";
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

const strides = new WeakMap<Element, {animations: Animation[]; rate: number}>();
/**
 * Sets the sprite's CSS gallop and dust to `rate`. Rate is not play state, so `[data-halted]` still pauses them.
 * The animations are found once and found again when CSS restarted them (a class toggle cancels the old ones).
 */
export function setGallop(sprite: Element, rate: number) {
    let stride = strides.get(sprite);
    if (!stride || !stride.animations.length || stride.animations.some(animation => animation.playState === "idle")) {
        stride = {animations: sprite.getAnimations({subtree: true}).filter(animation => animation instanceof CSSAnimation
            && (animation.animationName === "race-gallop" || animation.animationName === "race-dust")), rate: 1};
        strides.set(sprite, stride);
    }
    if (Math.abs(stride.rate - rate) < RATE_STEP) return;
    stride.rate = rate;
    // updatePlaybackRate keeps each stride's current pose, so a speed change never jumps the pony.
    for (const animation of stride.animations) animation.updatePlaybackRate(rate);
}

export type RaceStage = {tier: MotionTier; sound: ArcadeSound; sprite: (id: string) => Element | undefined};

/**
 * Plays each race moment once, as the shared clock crosses it. A recomputed simulation (a call or a burst) keeps the mark,
 * because positions already shown never change; a new round starts from its own clock. A hidden tab advances silently.
 */
export class RaceCues {
    private race: RaceSimulation | null = null;
    private events: RaceEvent[] = [];
    /** The first horse to edge ahead off the gate takes no lead from anyone, so it is not a moment. */
    private opening: RaceEvent | undefined;
    private round = -1;
    private mark = 0;

    fire(race: RaceSimulation, time: number, stage: RaceStage) {
        if (race !== this.race) {
            if (race.course.round !== this.round) {this.round = race.course.round; this.mark = time;}
            this.race = race;
            this.events = raceEvents(race);
            this.opening = this.events.find(event => event.type === "lead");
        }
        const due = dueEvents(this.events, this.mark, time);
        this.mark = Math.max(this.mark, time);
        if (!document.hidden) for (const event of due) if (event !== this.opening) cueRaceEvent(event, stage);
    }
}

/** One moment: the owner hears its own race, and the horse it concerns answers on screen. Labels and the draft link already show drafts. */
export function cueRaceEvent(event: RaceEvent, {tier, sound, sprite}: RaceStage) {
    const own = event.id === "owner";
    const pony = sprite(event.id)?.querySelector(".race-pony-bounce");
    switch (event.type) {
        case "pass":
            if (pony) pop(pony, {tier}, {scale: own ? 1.12 : 1.06});
            // Climbs with the place reached: a pass into the lead rings highest.
            if (own) sound.play("combo", 5 - (event.rank ?? 4));
            else if (event.otherId === "owner") sound.play("break");
            break;
        case "lead":
            // Lands just after the pass that took it, so the two cues read as one phrase.
            if (own) sound.play("golden", 0, 180);
            break;
        case "burst-start":
            if (pony) pop(pony, {tier}, {scale: 1.1});
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
        case "finish":
            if (!own) break;
            // A watched agent's run keeps the beat short, so nothing outlasts its auto-advance.
            if (pony) play(pony, [{transform: "scale(1)"}, {transform: "scale(1.18)"}, {transform: "scale(1)"}], {id: "race-finish", duration: tier === "light" ? "quick" : "slow", easing: "back", composite: "add"}, {tier});
            sound.play(event.rank === 1 ? "perfect" : "end");
            break;
        case "draft-start":
        case "draft-end":
            break;
    }
}
