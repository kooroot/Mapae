import {expect, test} from "bun:test";
import {LANE_MS, laneY, nextLane, raceLayout, type Lane} from "./RaceRunners";

const linear = (progress: number) => progress;
const settled = (y: number): Lane => ({from: y, to: y, ms: LANE_MS});

test("a path change glides from where the runner stands to its new lane over LANE_MS of live frames", () => {
    let lane = nextLane(undefined, -5, 16, false, linear);
    expect(laneY(lane, linear)).toBe(-5);
    lane = nextLane(lane, 12, 16, false, linear);
    expect(lane).toEqual({from: -5, to: 12, ms: 0});
    lane = nextLane(nextLane(lane, 12, LANE_MS / 4, false, linear), 12, LANE_MS / 4, false, linear);
    expect(laneY(lane, linear)).toBeCloseTo(3.5);
    // Reversing mid-glide starts from the current height, never from the old lane.
    lane = nextLane(lane, -5, 16, false, linear);
    expect(lane.from).toBeCloseTo(3.5);
    expect(laneY(lane, linear)).toBeCloseTo(3.5);
    for (let i = 0; i < 20; i++) lane = nextLane(lane, -5, 16, false, linear);
    expect(laneY(lane, linear)).toBe(-5);
});

test("a dropped frame advances a glide by at most 100ms, and a zero step only starts one", () => {
    const started = nextLane(settled(-5), 12, 0, false, linear);
    expect(nextLane(started, 12, 0, false, linear)).toBe(started);
    expect(nextLane(started, 12, 5_000, false, linear).ms).toBe(100);
});

test("a paused picture keeps a glide where it froze; reduced motion and a finished race snap to the lane", () => {
    const mid: Lane = {from: -5, to: 12, ms: 80};
    expect(nextLane(mid, 12, null, false, linear)).toBe(mid);
    expect(nextLane(mid, 12, null, true, linear)).toEqual(settled(12));
    expect(nextLane(settled(-5), 12, null, false, linear)).toEqual(settled(12));
    expect(nextLane(settled(-5), 12, 16, true, linear)).toEqual(settled(12));
});

test("sprite geometry scales the run to the scene and shrinks ponies on narrow screens", () => {
    expect(raceLayout(800, 440)).toEqual({pony: 76, row: 440 * .14, startY: 440 * .36, run: 800 - 76 - 34});
    expect(raceLayout(360, 360).pony).toBe(60);
    expect(raceLayout(50, 360).run).toBe(0);
});
