import {expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {makeRaceCourse, simulateRace, type RaceCommand} from "@mapae/arcade/race";
import {ArcadeSound} from "../sound";
import {RaceTrack} from "./RaceTrack";

const course = {...makeRaceCourse(0, 0), weather: "clear" as const, course: "long" as const, distance: 1250};
const commands: RaceCommand[] = [{at: 12, pace: "save", route: "shortcut"}, {at: 24, pace: "steady", route: "wide"}];
const race = simulateRace(course, [{id: "owner", name: "Coach", strategy: "conserve"}, {id: "rival", name: "Rival", strategy: "burst"}], commands, null);
const render = (time: number, locale: "en" | "ko", reducedMotion = false) => renderToStaticMarkup(<RaceTrack race={race} commands={commands} rivalId="rival" progress={time / race.seconds} clock={{current: time}} ended={false} locale={locale} color="jade" running reducedMotion={reducedMotion} tier={reducedMotion ? "still" : "full"} sound={new ArcadeSound()} playback={1} />);

test("track labels and visual draft links use observed traffic rather than predicted finishing order", () => {
    const drafting = race.frames.find(frame => frame.positions[0]!.draftingId)!;
    const markup = render(drafting.time, "en");
    expect(markup).toContain("race-draft-link");
    expect(markup).toContain("Drafting Rival");
    expect(markup).toContain("DRAFT −40%");
    expect(markup).not.toContain("Passed Rival on the outside!");
    const passed = race.frames.find(frame => frame.positions[0]!.overtakingId)!;
    expect(render(passed.time, "en")).toContain("Passed Rival on the outside!");
    expect(render(passed.time, "ko")).toContain("바깥으로 Rival 추월!");
});

test("reduced-motion track keeps path feedback and public rival habits without animated movement", () => {
    const markup = render(30, "en", true);
    expect(markup).not.toContain("race-world-moving");
    expect(markup).toContain("OUTSIDE");
    expect(markup).toContain("Speed −6%");
    expect(markup).toContain("Takes the outside at either fork when close behind");
});

test("a halted race keeps its stride classes and freezes in pose instead of snapping to rest", () => {
    const track = (running: boolean, ended: boolean) => renderToStaticMarkup(<RaceTrack race={race} commands={commands} rivalId="rival" progress={30 / race.seconds} clock={{current: 30}} ended={ended} locale="en" color="jade" running={running} reducedMotion={false} tier="full" sound={new ArcadeSound()} playback={1} />);
    expect(render(30, "en")).not.toContain("data-halted");
    expect(track(false, false)).toContain("race-world-moving");
    expect(track(false, false)).toContain("data-halted=\"\"");
    expect(track(false, true)).not.toContain("data-halted");
    expect(track(false, true)).not.toContain("race-world-moving");
    expect(track(false, false)).toContain("<div class=\"race-field\" aria-hidden=\"true\">");
});

test("the start signal holds the horses at the gate on its first beats, and they run on the go", () => {
    const track = (signal: number | null, locale: "en" | "ko" = "en") => renderToStaticMarkup(<RaceTrack race={race} commands={commands} rivalId="rival" progress={0} clock={{current: 0}} ended={false} locale={locale} color="jade" running reducedMotion={false} tier="full" sound={new ArcadeSound()} playback={1} signal={signal} />);
    expect(track(0, "ko")).toContain(">셋</span>");
    expect(track(0)).not.toContain("race-world-moving");
    expect(track(0)).not.toContain("data-halted");
    expect(track(2)).toContain(">GO!</span>");
    expect(track(2)).toContain("race-world-moving");
    expect(track(null)).not.toContain("race-start-signal");
});

test("every horse carries a pass tag, a rival's in the smaller muted variant", () => {
    const markup = render(10, "ko");
    expect(markup).toContain("<span class=\"race-pass-tag \">추월!</span>");
    expect(markup).toContain("<span class=\"race-pass-tag race-pass-tag-against\">추월!</span>");
    expect(markup).toContain("race-moment-layer arc-flash-host");
    expect(markup).toContain("data-tier=\"full\"");
});
