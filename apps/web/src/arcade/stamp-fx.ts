import {bossWindow, multiplier, FEVER_MS, FEVER_TARGET, type Game, type StampEvent} from "@mapae/arcade/stamp";
import type {ArcadeSound, SoundKind} from "./sound";
import type {MotionTier} from "./motion";
import {banner, hitStop, play, pop, shake, shakeFrames, type MotionGate} from "./juice";

/** Where a Dokkaebi Stamp round sends its feedback: the speaker, how much motion it may spend, and the surfaces it moves. */
export type StampFx = {sound: ArcadeSound; tier: MotionTier; field: HTMLElement | null; windows: HTMLElement | null; board: HTMLElement | null; gauge: HTMLElement | null};
/** A tap the engine judged: its window, and the pointer in client coordinates when a pointer made it. */
export type StampTap = {index: number; point?: {x: number; y: number}};

/**
 * One visual beat, already decided for the tier, so the tier rules are testable without a DOM. `seal` sets the combo boost
 * the CSS seal slam reads when React mounts the impact; the rest play on the window's persistent fx layer (see StampWindow),
 * which outlives the engine's impact, so a score float or a crack is never cut off when the impact expires.
 */
export type StampMotion =
    | {kind: "press" | "ink" | "rings" | "hitStop" | "shards" | "spark" | "strike" | "pass" | "deflect" | "bossArrive" | "chiefDown"; index: number}
    | {kind: "shake"; index: number; px: number; color: string}
    | {kind: "seal"; index: number; boost: number}
    | {kind: "float"; index: number; text: string}
    | {kind: "ripple"; index: number; point?: StampTap["point"]}
    | {kind: "fieldShake" | "fieldBounce" | "charge" | "glowOut" | "sweep"}
    | {kind: "banner"; name: HeraldName}
    | {kind: "score"; scale: number}
    | {kind: "comboUp"; text: string; ms: number}
    | {kind: "comboBreak"; shake: boolean};

/** The chief's herald stands mid-yard; the others share the top of the playfield, where only the newest is shown. */
export type HeraldName = "fever" | "chief" | "wave" | "parade";

/** The peak scale of the shared `arc-seal-slam`; a combo multiplier adds a tenth to it, applied as a factor on top. */
export const SEAL_PEAK = 1.9;
/** Felling the chief stamps a third harder than the streak alone would. */
export const CHIEF_SEAL = 1.3;
export function sealBoost(combo: number): number {
    return 1 + .1 * (multiplier(combo) - 1) / SEAL_PEAK;
}

/** Six coin shards fanning out 24–40px in a fixed pattern, so every golden hit reads the same. */
export const SHARDS = [0, 1, 2, 3, 4, 5].map(i => {
    const angle = (i * 60 + (i % 2 ? 12 : -8)) * Math.PI / 180, reach = [32, 26, 40, 28, 36, 24][i]!;
    return {x: +(Math.cos(angle) * reach).toFixed(1), y: +(Math.sin(angle) * reach).toFixed(1), turn: (i % 2 ? 1 : -1) * (90 + i * 25)};
});

/** The scoreboard swells once per scoring step, more for a perfect stamp. */
export const SCORE_POP = 1.12;
export const PERFECT_POP = 1.28;
/** From here the timer wears a red ring and ticks each second. */
export const FINAL_SECONDS = 3;
/** The last stretch of fever, when the lantern glow quickens and the gauge turns: time to cash in the double. */
export const FEVER_WARNING_MS = 2_000;

/** The fever gauge as one reading: charge toward the next fever, or the share of a running fever still left. */
export function feverGauge(game: Game): {fever: boolean; left: number; ratio: number; waning: boolean} {
    const left = Math.max(0, game.feverUntil - game.elapsed);
    return left > 0 ? {fever: true, left, ratio: left / FEVER_MS, waning: left <= FEVER_WARNING_MS} : {fever: false, left: 0, ratio: game.feverCharge / FEVER_TARGET, waning: false};
}

/** While the chief is open the player is timing a stamp, so nothing may jolt the playfield under the needle. */
export function chiefOpen(game: Game): boolean {
    return game.cells.some(cell => cell.actor?.special === "boss" && bossWindow(cell.actor, game.elapsed).phase === "open");
}

/** How long the "×3!" chip rises off the combo: a player gets the full beat, a watched agent a light one. */
const COMBO_CHIP_MS = {full: 600, light: 300} as const;

/**
 * What a step looks like at a tier. Full: everything. Light (a watched agent): the hit itself (seal, ink, score float, perfect
 * rings) without hit-stop, shake or shards. Still: the impact already stays on screen with its points, so the planned beats
 * are the short fades the motion gate turns them into, and nothing that only moves (press, float, shards, field shake, combo chip).
 * Heralds (fever, the chief felled, the gold parade, a new wave) show at every tier, one at the top of the yard per step:
 * fever outranks the parade, which outranks the wave. The parade's gold sweep is short enough for a watched agent too.
 * While the chief is open nothing jolts the playfield.
 * Scoreboard beats come after the windows' and once per step, however many stamps it held.
 */
export function stampMotions(events: readonly StampEvent[], game: Game, tier: MotionTier, tap?: StampTap): StampMotion[] {
    const full = tier === "full", still = tier === "still";
    const steady = full && !chiefOpen(game);
    const felled = events.some(event => event.type === "kill" && event.variant === "boss");
    const motions: StampMotion[] = [];
    if (tap && full) motions.push({kind: "press", index: tap.index});
    for (const event of events) {
        if (event.type === "hit") {
            const {index} = event, chief = event.actor.special === "boss";
            motions.push({kind: "seal", index, boost: sealBoost(game.combo) * (chief ? CHIEF_SEAL : 1)}, {kind: "ink", index});
            if (!still) motions.push({kind: "float", index, text: `+${event.points}`});
            if ((event.actor.golden || chief) && full) motions.push({kind: "shards", index});
            // The chief's last stamp freezes the yard, then drops it; its own freeze replaces the perfect's.
            if (chief && full) motions.push({kind: "chiefDown", index});
            if (chief) motions.push({kind: "banner", name: "chief"});
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
            if (full && !felled) motions.push({kind: "hitStop", index: event.index});
        } else if (event.type === "wrong") {
            motions.push({kind: "strike", index: event.index});
            if (tier !== "light") motions.push({kind: "shake", index: event.index, px: 5, color: "#ea6555"});
            if (steady) motions.push({kind: "fieldShake"});
        } else if (event.type === "guard") {
            // The seal glances off the guarding chief; the impact keeps saying why.
            if (!still) motions.push({kind: "deflect", index: event.index});
            if (tier !== "light") motions.push({kind: "shake", index: event.index, px: 3, color: "#bac5d9"});
        } else if (event.type === "bossSpawn") {if (full) motions.push({kind: "bossArrive", index: event.index});}
        else if (event.type === "pass") motions.push({kind: "pass", index: event.index});
        else if (event.type === "dud") motions.push({kind: "ripple", index: event.index, point: tap?.index === event.index ? tap.point : undefined});
    }
    // Fever arrives as a herald for everyone, with a bump of the playfield for a player; it leaves by fading its lantern glow.
    const parade = events.some(event => event.type === "parade" && event.phase === "active");
    if (events.some(event => event.type === "feverStart")) {
        motions.push({kind: "banner", name: "fever"});
        if (steady) motions.push({kind: "fieldBounce"});
    } else {
        if (parade) motions.push({kind: "banner", name: "parade"});
        else if (events.some(event => event.type === "wave")) motions.push({kind: "banner", name: "wave"});
        if (events.some(event => event.type === "feverEnd")) motions.push({kind: "glowOut"});
    }
    if (parade) motions.push({kind: "sweep"});
    if (!still && events.some(event => event.type === "feverCharge")) motions.push({kind: "charge"});
    const scored = events.some(event => event.type === "hit" || event.type === "crack" && (game.cells[event.index]?.impact?.points ?? 0) > 0);
    if (scored) motions.push({kind: "score", scale: events.some(event => event.type === "perfect") ? PERFECT_POP : SCORE_POP});
    const up = events.find(event => event.type === "comboTier");
    // A rising multiplier is the louder news; the slam on the multiplier itself is CSS, so still keeps the new number only.
    if (up) {if (!still) motions.push({kind: "comboUp", text: `×${up.multiplier}!`, ms: COMBO_CHIP_MS[full ? "full" : "light"]});}
    else if (events.some(event => event.type === "comboBreak")) motions.push({kind: "comboBreak", shake: full});
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
/** The chip lifts off the multiplier, holds to be read, and drifts away. */
const CHIP: Keyframe[] = [{opacity: 0, transform: "translateY(6px) scale(.8)"}, {opacity: 1, transform: "translateY(0) scale(1)", offset: .2}, {opacity: 1, transform: "translateY(-4px)", offset: .7}, {opacity: 0, transform: "translateY(-14px)"}];
/** A broken streak dims and comes back, so the reset reads even without the shake. */
const DIM: Keyframe[] = [{opacity: .45}, {opacity: 1}];
const PASS: Keyframe[] = [{opacity: 0, transform: "translateY(30%) scale(.9)"}, {opacity: 1, transform: "translateY(0) scale(1)", offset: .25}, {opacity: 1, transform: "translateY(-10%)", offset: .7}, {opacity: 0, transform: "translateY(-40%)"}];
/** Fever's mapae seal lands on its herald: in large and turned, down to its slight resting tilt. */
const HERALD_SEAL: Keyframe[] = [{opacity: 0, transform: "scale(2.2) rotate(-20deg)"}, {opacity: 1, transform: "scale(1) rotate(-6deg)"}];
/** The playfield's bump as fever arrives, and its lantern glow letting go as fever leaves. */
const FEVER_BOUNCE = 1.012;
const GLOW_OUT: Keyframe[] = [{opacity: .9}, {opacity: 0}];
/** Gold light crosses the yard once as the parade begins. */
const SWEEP: Keyframe[] = [{opacity: 1, transform: "translateX(-100%)"}, {opacity: 1, transform: "translateX(100%)"}];
const SWEEP_MS = 260;
/** Each charge thumps the gauge once. */
const CHARGE: Keyframe[] = [{transform: "scaleY(1)"}, {transform: "scaleY(1.6)", offset: .4}, {transform: "scaleY(1)"}];
/** A blocked seal glances up and away off the guarding chief. */
const DEFLECT: Keyframe[] = [{opacity: .9, transform: "translate(0, 0) rotate(-12deg) scale(1.1)"}, {opacity: .8, transform: "translate(14%, -22%) rotate(16deg) scale(.95)", offset: .45}, {opacity: 0, transform: "translate(26%, -40%) rotate(32deg) scale(.85)"}];
/** The chief's arrival: every other window dims while it drops (CHIEF_DROP_MS, then a 200ms landing) inside its first guard. */
const CHIEF_ARRIVAL_MS = 700;
const CHIEF_DROP_MS = 260;
const CHIEF_FREEZE_MS = 90;
const SHADE: Keyframe[] = [{opacity: 0}, {opacity: .35, offset: .2}, {opacity: .35, offset: .75}, {opacity: 0}];
const LAND: Keyframe[] = [{transform: "translateY(0)"}, {transform: "translateY(3px)", offset: .35}, {transform: "translateY(0)"}];
/** A perfect seal slams in --arc-dur-quick and meets the paper about 40% in: the freeze lands on that contact, not before it. */
const PERFECT_CONTACT_MS = 60;
const PERFECT_FREEZE_MS = 70;

function shardFrames({x, y, turn}: typeof SHARDS[number]): Keyframe[] {
    return [{opacity: 1, transform: "translate(0, 0) rotate(0deg) scale(.6)"}, {opacity: 1, offset: .55}, {opacity: 0, transform: `translate(${x}px, ${y}px) rotate(${turn}deg) scale(1)`}];
}

const scoreboard = (board: HTMLElement | null, name: string) => board?.querySelector<HTMLElement>(`[data-fx=${name}]`);

/** Plays one planned beat. Every target is already in the DOM, so effects start in the same frame as the sound. */
function render(motion: StampMotion, {field, windows, board, gauge}: StampFx, gate: MotionGate) {
    switch (motion.kind) {
    case "fieldShake": if (field) shake(field, gate, {px: 2}); return;
    case "fieldBounce": if (field) pop(field, gate, {scale: FEVER_BOUNCE, ms: 120}); return;
    case "glowOut": if (field) play(field, GLOW_OUT, {id: "stamp-glow-out", duration: "base", easing: "out", pseudoElement: "::before"}, gate); return;
    case "charge": if (gauge) play(gauge, CHARGE, {id: "stamp-charge", duration: 200, easing: "out"}, gate); return;
    case "sweep": {const band = field?.querySelector(".stamp-sweep > i"); if (band) play(band, SWEEP, {id: "stamp-sweep", duration: SWEEP_MS, easing: "ink"}, gate); return;}
    case "banner": {
        const herald = field?.querySelector<HTMLElement>(`[data-banner=${motion.name}]`);
        if (!herald) return;
        // The top of the yard holds one herald: the newest news takes it over from one still unfurled there.
        if (motion.name !== "chief") for (const other of field!.querySelectorAll(".stamp-herald:not([data-banner=chief])")) if (other !== herald) for (const animation of other.getAnimations({subtree: true})) animation.cancel();
        banner(herald, gate);
        const seal = herald.querySelector("i");
        if (seal) play(seal, HERALD_SEAL, {id: "stamp-herald-seal", duration: "base", easing: "stamp", fill: "both"}, gate);
        return;
    }
    case "score": {const score = scoreboard(board, "score"); if (score) pop(score, gate, {scale: motion.scale, ms: 180}); return;}
    case "comboUp": {
        const chip = scoreboard(board, "chip");
        if (!chip) return;
        chip.textContent = motion.text;
        play(chip, CHIP, {id: "stamp-chip", duration: motion.ms, easing: "out"}, gate);
        return;
    }
    case "comboBreak": {
        const combo = scoreboard(board, "combo");
        if (!combo) return;
        if (motion.shake) shake(combo, gate, {px: 3});
        play(combo, DIM, {id: "stamp-dim", duration: "base", easing: "out"}, gate);
        return;
    }
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
    case "shake": shake(cell, gate, {px: motion.px, color: motion.color}); break;
    case "deflect": {const seal = part(".stamp-deflect"); if (seal) play(seal, DEFLECT, {id: "stamp-deflect", duration: 300, easing: "out"}, gate); break;}
    case "bossArrive":
        // The yard holds its breath around the chief, and takes its weight as it lands.
        [...cell.parentElement?.children ?? []].forEach((other, i) => {
            const shade = i === motion.index ? null : other.querySelector(".stamp-shade");
            if (shade) play(shade, SHADE, {id: "stamp-shade", duration: CHIEF_ARRIVAL_MS, easing: "out"}, gate);
        });
        if (field) play(field, LAND, {id: "stamp-land", duration: 200, delay: CHIEF_DROP_MS, easing: "out", composite: "add"}, gate);
        break;
    case "chiefDown":
        if (!field) break;
        window.setTimeout(() => {
            // A pause inside the wait owns the moment; the freeze and drop would only play against a halted round.
            if (field.closest("[data-halted]")) return;
            hitStop(field, CHIEF_FREEZE_MS, gate);
            play(field, shakeFrames(5, "y"), {id: "arc-shake", duration: 240, delay: CHIEF_FREEZE_MS, easing: "shake", composite: "add"}, gate);
        }, PERFECT_CONTACT_MS);
        break;
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

/**
 * Everything a step sounds like: its one cue, then the state changes that ring on their own. The final bell outranks the
 * fever ending with it, and the last three seconds tick under whatever else the step played.
 */
export function stampSounds(events: readonly StampEvent[]): SoundKind[] {
    const has = (type: StampEvent["type"]) => events.some(event => event.type === type);
    const kind = cue(events);
    const sounds: SoundKind[] = kind ? [kind] : [];
    if (has("finished")) sounds.push("end");
    else if (has("feverEnd") && !has("feverStart")) sounds.push("feverEnd");
    if (events.some(event => event.type === "urgentSecond" && event.seconds <= FINAL_SECONDS)) sounds.push("tick");
    return sounds;
}

/** The one place a round's events become feedback, whether a person or an agent is playing. `game` is the state after them. */
export function stampFx(events: readonly StampEvent[], game: Game, fx: StampFx, tap?: StampTap) {
    for (const kind of stampSounds(events)) fx.sound.play(kind, game.combo);
    // A hidden tab schedules no motion at all, not even the timers that would start a freeze later.
    if (document.hidden) return;
    const gate = {tier: fx.tier};
    for (const motion of stampMotions(events, game, fx.tier, tap)) render(motion, fx, gate);
}

const tracks = new WeakMap<Element, Animation>();
/**
 * A gauge the engine clock drives (the chief's timing needle, the fever drain): one compositor animation that `start` creates
 * (essential, since both carry information and keep moving under reduced motion), snapped to the engine at `at` on every commit
 * so it glides at frame rate without drifting from the judgement, and held while the round is halted. `rest` is the same pose
 * as a plain transform: what a hidden tab shows (it starts no animation) until a later commit can start one, and what remains
 * when the track stops.
 */
export function syncTrack(el: HTMLElement, start: () => Animation | null, {at, rest, halted}: {at: number; rest: string; halted: boolean}) {
    el.style.transform = rest;
    let track = tracks.get(el);
    if (!track || track.playState === "idle") {
        const started = start();
        if (!started) return;
        tracks.set(el, track = started);
    }
    track.currentTime = at;
    if (halted) track.pause();
    else if (track.playState !== "running") track.play();
}

export function stopTrack(el: HTMLElement) {
    tracks.get(el)?.cancel();
    tracks.delete(el);
}

const DRAIN: Keyframe[] = [{transform: "scaleX(1)"}, {transform: "scaleX(0)"}];
/** Charge steps up as a plain pose; a running fever drains as one linear track over its full length, re-synced every commit. */
export function syncFeverGauge(fill: HTMLElement, game: Game, tier: MotionTier, halted: boolean) {
    const {fever, left, ratio} = feverGauge(game);
    if (!fever) {
        stopTrack(fill);
        fill.style.transform = `scaleX(${ratio})`;
        return;
    }
    syncTrack(fill, () => play(fill, DRAIN, {id: "stamp-drain", duration: FEVER_MS}, {tier, essential: true}), {at: FEVER_MS - left, rest: `scaleX(${ratio})`, halted});
}

/** "시작!" stays this long after the countdown; input is already open beneath it. */
export const GO_MS = 450;

/**
 * The countdown's sound as it shows `seconds` (0 is the start). A watched agent keeps the plain start it always had: no ticks,
 * no go, nothing that dresses up its run. Watching decides this, not the tier: reduced motion outranks light in the tier, but
 * never turns an agent's run back into a player's.
 */
export function countdownCue(seconds: number, watched: boolean): SoundKind | null {
    if (watched) return seconds === 0 ? "start" : null;
    return seconds === 0 ? "go" : "tick";
}

export function stampCountdownFx(sound: ArcadeSound, seconds: number, watched: boolean) {
    const kind = countdownCue(seconds, watched);
    if (kind) sound.play(kind);
}

/**
 * How long the "끝!" seal holds before the results: a full beat for a player, a glance under reduced motion, and none for a
 * watched agent, whose run no ceremony may lengthen (whatever its tier).
 */
export function stampEndMs({still, watched}: {still: boolean; watched: boolean}): number {
    return watched ? 0 : still ? 250 : 700;
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
