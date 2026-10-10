import {useLayoutEffect, type RefObject} from "react";
import {countUp, LIGHT_MS, motionTokens, play, riseIn, shake, staggerTiming, type Duration} from "./juice";
import type {MotionTier} from "./motion";
import type {ArcadeSound, SoundKind} from "./sound";

/**
 * The result ritual (motion plan C1). A result screen marks its parts with `data-ritual` and this plays them as one timeline:
 * `paper` prints in, `count` (carrying `data-count`) rolls up, `seal` slams down with its thump, the children of `stats` and
 * `points` rise in turn, and a new record's `record` label gets its brush underline. `focus` takes focus at once. A click or a key
 * finishes everything at once. It also rings the round's one closing bell, which the games leave to it.
 */
export type RitualBeat = {at: number; ms: number};
export type RitualCue = {kind: SoundKind; at: number};
export type RitualPlan = {
    paper: number; count: RitualBeat | null; seal: RitualBeat | null; shake: number | null;
    stats: {start: number; step: number}; points: {start: number; step: number}; record: RitualBeat | null; sounds: RitualCue[];
};

/** The player's ritual in ms from the result's first frame; the seal meets the paper 40% into its slam. */
const FULL = {paper: 360, countAt: 180, count: 900, sealAt: 1100, seal: 300, statStep: 60, pointStep: 80};
const IMPACT = .4;

/** What a result screen holds: the plan only times the parts it has, so a screen without a seal never waits for one. */
export type RitualParts = {record: boolean; seal: boolean; count: boolean; stats: number};

/**
 * The beats for a tier. Full: the whole ritual, about 1.4s with a count and a seal. Light (a watched agent): everything at once
 * inside LIGHT_MS, no shake. Still: no movement (the juice gate turns the paper and rows into fades); the bell alone marks the result.
 */
export function ritualPlan(tier: MotionTier, {record, seal, count, stats}: RitualParts, dur: Record<Duration, number>): RitualPlan {
    const bell: SoundKind = record ? "record" : "end";
    if (tier === "still") return {paper: dur.quick, count: null, seal: null, shake: null, stats: {start: 0, step: 0}, points: {start: 0, step: 0}, record: null, sounds: [{kind: bell, at: 0}]};
    if (tier === "light") return {paper: dur.quick, count: count ? {at: 0, ms: LIGHT_MS} : null, seal: seal ? {at: 0, ms: dur.base} : null, shake: null, stats: {start: 0, step: 0}, points: {start: 0, step: 0},
        record: record ? {at: 0, ms: LIGHT_MS} : null, sounds: [{kind: bell, at: 0}, ...seal ? [{kind: "seal" as const, at: Math.round(dur.base * IMPACT)}] : []]};
    // The seal caps the count; without one the rows follow whatever came last, the count or the paper.
    const impact = FULL.sealAt + Math.round(FULL.seal * IMPACT);
    const settled = seal ? impact : count ? FULL.countAt + FULL.count : FULL.paper;
    const landed = seal ? FULL.sealAt + FULL.seal : settled;
    return {
        paper: FULL.paper, count: count ? {at: FULL.countAt, ms: FULL.count} : null, seal: seal ? {at: FULL.sealAt, ms: FULL.seal} : null, shake: seal ? impact : null,
        stats: {start: settled, step: FULL.statStep}, points: {start: settled + stats * FULL.statStep, step: FULL.pointStep},
        record: record ? {at: landed, ms: dur.slow} : null,
        sounds: [{kind: "end", at: 0}, ...seal ? [{kind: "seal" as const, at: impact}] : [], ...record ? [{kind: "record" as const, at: landed}] : []],
    };
}

/** When the last beat settles, so the skip listeners go once nothing is left to skip. */
export function ritualEnd(plan: RitualPlan, tier: MotionTier, {stats, points}: {stats: number; points: number}, dur: Record<Duration, number>): number {
    const rows = (count: number, {start, step}: {start: number; step: number}) => {
        if (!count) return 0;
        const last = staggerTiming(tier, count - 1, step, start);
        return last.delay + dur[last.duration];
    };
    const end = (beat: RitualBeat | null) => beat ? beat.at + beat.ms : 0;
    return Math.max(plan.paper, end(plan.count), end(plan.seal), end(plan.record), plan.shake ?? 0, rows(stats, plan.stats), rows(points, plan.points), ...plan.sounds.map(cue => cue.at));
}

/** The cue a skip still owes: the latest one not yet heard, so jumping to the end lands with its sound but never a pile of them. */
export function owedCue(sounds: RitualCue[], elapsed: number): SoundKind | null {
    return sounds.filter(cue => cue.at > elapsed).at(-1)?.kind ?? null;
}

/** Plays the ritual on a mounted result. Returns its cleanup. A hidden tab gets the focus only. */
export function resultRitual(root: HTMLElement, tier: MotionTier, sound: ArcadeSound, record: boolean): () => void {
    const part = (name: string) => root.querySelector<HTMLElement>(`[data-ritual="${name}"]`);
    part("focus")?.focus({preventScroll: true});
    if (document.hidden) return () => {};
    const {dur} = motionTokens();
    const stats = Array.from(part("stats")?.children ?? []), points = Array.from(part("points")?.children ?? []);
    const seal = part("seal"), mark = part("record"), count = part("count");
    const plan = ritualPlan(tier, {record: record && !!mark, seal: !!seal, count: !!count, stats: stats.length}, dur);
    const paper = part("paper") ?? root;
    play(paper, [{opacity: 0, transform: "translateY(-14px)"}, {opacity: 1, transform: "translateY(0)"}], {id: "arc-ritual-paper", duration: plan.paper, easing: "out"}, {tier});
    // Still has no beat for it: countUp writes the final value at once.
    const roll = count ? countUp(count, Number(count.dataset.count), {tier}, {delay: plan.count?.at ?? 0, ms: plan.count?.ms}) : null;
    // The seal and the underline are CSS (`arc-seal-slam`, `arc-unfurl`); the attributes React never writes start them on this timeline.
    if (plan.seal) {
        root.style.setProperty("--ritual-seal-at", `${plan.seal.at}ms`);
        root.style.setProperty("--ritual-seal-ms", `${plan.seal.ms}ms`);
        seal?.setAttribute("data-slam", "");
    }
    if (plan.record) {
        root.style.setProperty("--ritual-record-at", `${plan.record.at}ms`);
        root.style.setProperty("--ritual-record-ms", `${plan.record.ms}ms`);
        mark?.setAttribute("data-slam", "");
        seal?.setAttribute("data-burst", "");
    }
    riseIn(stats, tier, plan.stats.step, plan.stats.start);
    riseIn(points, tier, plan.points.step, plan.points.start);
    // Sounds go on timers rather than the audio clock so a skip can take back the ones not yet heard.
    const timers: number[] = [];
    for (const cue of plan.sounds) if (cue.at) timers.push(window.setTimeout(() => sound.play(cue.kind), cue.at)); else sound.play(cue.kind);
    if (plan.shake !== null) timers.push(window.setTimeout(() => shake(paper, {tier}, {px: 2, axis: "y"}), plan.shake));
    const started = performance.now();
    const settle = () => {
        for (const timer of timers) clearTimeout(timer);
        removeEventListener("pointerdown", skip, true);
        removeEventListener("keydown", skip, true);
    };
    function skip(event: Event) {
        // A held key's repeats (a player still mashing the round's keys) are not a request to skip.
        if (event instanceof KeyboardEvent && event.repeat) return;
        settle();
        const owed = owedCue(plan.sounds, performance.now() - started);
        if (owed) sound.play(owed);
        roll?.finish();
        // CSS beats included; an endless animation elsewhere on the screen cannot be finished and is left alone.
        for (const animation of root.getAnimations({subtree: true})) if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish();
    }
    addEventListener("pointerdown", skip, true);
    addEventListener("keydown", skip, true);
    timers.push(window.setTimeout(settle, ritualEnd(plan, tier, {stats: stats.length, points: points.length}, dur)));
    return () => {
        settle();
        roll?.cancel();
    };
}

/** Runs the ritual once per result: `key` names it, and null (no result showing) runs nothing. */
export function useResultRitual(root: RefObject<HTMLElement | null>, key: string | number | null, {tier, sound, record = false}: {tier: MotionTier; sound: ArcadeSound; record?: boolean}) {
    // Layout effect: the paper and the rolling number take their first frame before the result paints at rest.
    useLayoutEffect(() => {
        if (key === null || !root.current) return;
        return resultRitual(root.current, tier, sound, record);
        // One ritual per result: a later render (or a tier change mid-ritual) must not replay it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
}
