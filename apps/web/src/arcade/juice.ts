import type {MotionTier} from "./motion";

/**
 * Game feel on the Web Animations API. CSS `.arc-still` cannot stop WAAPI, so every scripted effect passes this gate:
 * `still` swaps motion for a short opacity cue unless the motion carries information (`essential`: the boss timing needle,
 * race positions); `light` (a watched agent) keeps feedback but drops shake, hit-stop and long ceremony; a hidden tab gets nothing.
 * Juice owns the `transform` property: games place and rest their sprites with individual `translate`/`scale`/`rotate`.
 */
export type MotionGate = ({tier: MotionTier} | {still: boolean}) & {essential?: boolean};
type Ease = "out" | "in" | "stamp" | "back" | "ink" | "shake";
type Duration = "tap" | "quick" | "base" | "slow" | "ceremony";
type Tokens = {ease: Record<Ease, string>; dur: Record<Duration, number>};
export type PlayOptions = Omit<KeyframeAnimationOptions, "duration" | "easing"> & {duration: number | Duration; easing?: Ease | "linear"};

const EASES: Ease[] = ["out", "in", "stamp", "back", "ink", "shake"];
const DURATIONS: Duration[] = ["tap", "quick", "base", "slow", "ceremony"];
/** Reduced motion keeps acknowledgement, never movement: opacity only, at most this long. */
const STILL_MS = 120;
/** Longest ceremony a watched agent run may show, so nothing outlasts its auto-advance beat. */
const LIGHT_MS = 300;
const SHAKE_MS = 180;
/** Past this the target a player is aiming at visibly jumps. */
const SHAKE_MAX_PX = 6;
const ACKNOWLEDGE: Keyframe[] = [{opacity: .6}, {opacity: 1}];

export function gateTier(gate: MotionGate): MotionTier {
    return "tier" in gate ? gate.tier : gate.still ? "still" : "full";
}

/** CSS time (`90ms`, `.42s`) in milliseconds; 0 when unset or unreadable. */
export function parseTime(value: string): number {
    const match = /^(-?[\d.]+)(ms|s)$/.exec(value.trim());
    const n = match ? Number(match[1]) * (match[2] === "s" ? 1000 : 1) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The opacity track of an effect, offsets resolved, so reduced motion keeps the fade and drops the movement. Null when it never fades. */
export function opacityOnly(keyframes: Keyframe[] | PropertyIndexedKeyframes): Keyframe[] | PropertyIndexedKeyframes | null {
    if (!Array.isArray(keyframes)) return keyframes.opacity === undefined ? null : keyframes.offset === undefined ? {opacity: keyframes.opacity} : {opacity: keyframes.opacity, offset: keyframes.offset};
    const offsets = keyframes.map((frame, i) => typeof frame.offset === "number" ? frame.offset : i === 0 ? 0 : i === keyframes.length - 1 ? 1 : null);
    // Spread unset offsets evenly between their nearest set neighbours, as WAAPI itself would.
    for (let i = 1; i < offsets.length; i++) {
        if (offsets[i] !== null) continue;
        let next = i;
        while (offsets[next] === null) next++;
        const from = offsets[i - 1]!, to = offsets[next]!;
        for (let k = i; k < next; k++) offsets[k] = from + (to - from) * (k - i + 1) / (next - i + 1);
    }
    const frames = keyframes.flatMap((frame, i) => frame.opacity === undefined ? [] : [{opacity: frame.opacity, offset: offsets[i]}]);
    return frames.length ? frames : null;
}

/** A damped back-and-forth, added onto whatever transform the element already wears. */
export function shakeFrames(px: number, axis: "x" | "y"): Keyframe[] {
    const reach = Math.min(Math.abs(px), SHAKE_MAX_PX);
    return [0, -1, .8, -.55, .3, 0].map(f => ({transform: `translate${axis === "x" ? "X" : "Y"}(${+(f * reach).toFixed(2)}px)`}));
}

/** Unfurl, hold, exit: the full ceremony for a player, the same beats compressed into LIGHT_MS for a watched agent. */
export function bannerBeats(tier: "full" | "light", dur: Record<Duration, number>) {
    return tier === "full" ? {unfurl: dur.base, hold: dur.ceremony, exit: dur.base} : {unfurl: dur.tap, hold: Math.max(LIGHT_MS - 2 * dur.tap, 0), exit: dur.tap};
}

let tokens: Tokens | undefined;
/** The motion tokens from arcade.css, read once: WAAPI cannot resolve `var()`, and the numbers must live in CSS only. */
function motionTokens(): Tokens {
    if (tokens) return tokens;
    const style = getComputedStyle(document.documentElement);
    const ease = Object.fromEntries(EASES.map(name => [name, style.getPropertyValue(`--arc-ease-${name}`).trim()])) as Record<Ease, string>;
    const dur = Object.fromEntries(DURATIONS.map(name => [name, parseTime(style.getPropertyValue(`--arc-dur-${name}`))])) as Record<Duration, number>;
    // Read before the stylesheet applied: degrade this one call instead of caching the miss.
    if (EASES.some(name => !ease[name]) || DURATIONS.some(name => !dur[name])) return {ease: Object.fromEntries(EASES.map(name => [name, ease[name] || "linear"])) as Record<Ease, string>, dur};
    return tokens = {ease, dur};
}

const running = new WeakMap<Element, Map<string, Animation>>();
const essentials = new WeakSet<Animation>();

/** Starts an effect, first cancelling the element's previous effect of the same id so rapid repeats replace rather than pile up. */
function run(el: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes, timing: KeyframeAnimationOptions, essential = false): Animation | null {
    if (document.hidden) return null;
    const id = timing.id;
    const byId = id ? running.get(el) ?? new Map<string, Animation>() : undefined;
    if (id && byId) {
        byId.get(id)?.cancel();
        running.set(el, byId);
    }
    const animation = el.animate(keyframes, timing);
    if (essential) essentials.add(animation);
    if (id && byId) {
        byId.set(id, animation);
        animation.finished.then(() => {if (byId.get(id) === animation) byId.delete(id);}, () => {});
    }
    return animation;
}

/** Any effect through the motion gate. Easing and duration name CSS tokens (or plain ms); a still, non-essential effect keeps only its fade. */
export function play(el: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes, options: PlayOptions, gate: MotionGate): Animation | null {
    if (document.hidden) return null;
    const {ease, dur} = motionTokens();
    const duration = typeof options.duration === "number" ? options.duration : dur[options.duration];
    const easing = !options.easing || options.easing === "linear" ? "linear" : ease[options.easing];
    if (gateTier(gate) !== "still" || gate.essential) return run(el, keyframes, {...options, duration, easing}, gate.essential);
    return run(el, opacityOnly(keyframes) ?? ACKNOWLEDGE, {...options, duration: Math.min(duration, STILL_MS), easing: "linear", iterations: 1, composite: "replace"});
}

/** A brief opacity pulse of a tint over the element. The element must be a containing block and carry `arc-flash-host`, whose `::after` is the tint. */
export function flash(el: HTMLElement, color: string, gate: MotionGate, ms = STILL_MS): Animation | null {
    if (document.hidden) return null;
    el.style.setProperty("--arc-flash", color);
    return play(el, [{opacity: 0}, {opacity: .45, offset: .25}, {opacity: 0}], {id: "arc-flash", duration: ms, pseudoElement: "::after"}, gate);
}

/** Impact recoil, ≤6px. A watched agent gets none; reduced motion gets a flash of `color` instead. */
export function shake(el: HTMLElement, gate: MotionGate, {px = SHAKE_MAX_PX, ms = SHAKE_MS, axis = "x", color = "currentColor"}: {px?: number; ms?: number; axis?: "x" | "y"; color?: string} = {}): Animation | null {
    const tier = gateTier(gate);
    if (tier === "light") return null;
    if (tier === "still" && !gate.essential) return flash(el, color, gate);
    return play(el, shakeFrames(px, axis), {id: "arc-shake", duration: ms, easing: "shake", composite: "add"}, gate);
}

/** A springy swell that lands back at rest; under reduced motion a quick fade-up acknowledges the same moment. */
export function pop(el: Element, gate: MotionGate, {scale = 1.14, ms}: {scale?: number; ms?: number} = {}): Animation | null {
    if (gateTier(gate) === "still" && !gate.essential) return play(el, ACKNOWLEDGE, {id: "arc-pop", duration: "tap"}, gate);
    return play(el, [{transform: "scale(1)"}, {transform: `scale(${scale})`}, {transform: "scale(1)"}], {id: "arc-pop", duration: ms ?? "quick", easing: "back", composite: "add"}, gate);
}

/**
 * A hanji banner: unfurls, holds, lifts away, and stays hidden after (`fill: both`); await `finished` before unmounting it.
 * Under reduced motion it simply shows for the hold and fades. Null (nothing to await) when the tab is hidden.
 */
export function banner(el: HTMLElement, gate: MotionGate): Animation | null {
    if (document.hidden) return null;
    const {ease, dur} = motionTokens();
    const tier = gateTier(gate);
    if (tier === "still") return run(el, [{opacity: 1}, {opacity: 1, offset: dur.ceremony / (dur.ceremony + STILL_MS)}, {opacity: 0}], {id: "arc-banner", duration: dur.ceremony + STILL_MS, fill: "both"});
    const {unfurl, hold, exit} = bannerBeats(tier, dur);
    const total = unfurl + hold + exit;
    return run(el, [
        {offset: 0, opacity: 1, transform: "translateY(0) scaleX(0)", easing: ease.ink},
        {offset: unfurl / total, opacity: 1, transform: "translateY(0) scaleX(1)"},
        {offset: (unfurl + hold) / total, opacity: 1, transform: "translateY(0) scaleX(1)", easing: ease.in},
        {offset: 1, opacity: 0, transform: "translateY(-12px) scaleX(1)"},
    ], {id: "arc-banner", duration: total, fill: "both"});
}

const counters = new WeakMap<Node, Animation>();
/**
 * Rolls a number up by writing `textContent` each frame (no React state). The node should be `aria-hidden`, with the final value
 * already in a visually hidden sibling, so screen readers hear one number. Still or hidden: writes the final value at once.
 */
export function countUp(node: Node, to: number, gate: MotionGate, {from = 0, ms, format = n => Math.round(n).toLocaleString()}: {from?: number; ms?: number; format?: (n: number) => string} = {}): Animation | null {
    counters.get(node)?.cancel();
    counters.delete(node);
    const write = (n: number) => {node.textContent = format(n);};
    const tier = gateTier(gate);
    if (document.hidden || (tier === "still" && !gate.essential)) {
        write(to);
        return null;
    }
    const {ease, dur} = motionTokens();
    // A target-less effect is the clock: its eased progress applies the CSS easing token without restating the curve here.
    const clock = new Animation(new KeyframeEffect(null, null, {duration: Math.min(ms ?? dur.ceremony, tier === "light" ? LIGHT_MS : Infinity), easing: ease.out, fill: "forwards"}));
    counters.set(node, clock);
    clock.play();
    const frame = () => {
        if (counters.get(node) !== clock) return;
        write(from + (to - from) * (clock.effect?.getComputedTiming().progress ?? 1));
        if (clock.playState === "finished") counters.delete(node);
        else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    return clock;
}

const stops = new WeakMap<Element, {timer: number; held: Animation[]}>();
/**
 * Freezes the picture for a beat on a big hit. Visual only: the engine clock keeps running, so judgement windows never move.
 * Scripted effects pause through the API (essential ones keep going); CSS animations pause through `.arc-hitstop`, because
 * calling `pause()` on a CSS animation would detach it from `animation-play-state` and break `[data-halted]` for good.
 */
export function hitStop(root: Element, ms: number, gate: MotionGate) {
    if (document.hidden || gateTier(gate) !== "full") return;
    const stop = stops.get(root) ?? {timer: 0, held: []};
    clearTimeout(stop.timer);
    for (const animation of root.getAnimations({subtree: true}))
        if (animation.playState === "running" && !essentials.has(animation) && !(animation instanceof CSSAnimation) && !(animation instanceof CSSTransition)) {
            animation.pause();
            stop.held.push(animation);
        }
    root.classList.add("arc-hitstop");
    stop.timer = window.setTimeout(() => {
        stops.delete(root);
        root.classList.remove("arc-hitstop");
        // A pause that began meanwhile owns the held effects now; its resume plays every paused one.
        if (root.closest("[data-halted]")) return;
        for (const animation of stop.held) if (animation.playState === "paused") animation.play();
    }, Math.min(ms, motionTokens().dur.quick));
    stops.set(root, stop);
}
