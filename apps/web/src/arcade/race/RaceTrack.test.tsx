import {expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {makeRaceCourse, simulateRace, type RaceCommand} from "@mapae/arcade/race";
import {RaceTrack} from "./RaceTrack";

const course = {...makeRaceCourse(0, 0), weather: "clear" as const, course: "long" as const, distance: 1250};
const commands: RaceCommand[] = [{at: 12, pace: "save", route: "shortcut"}, {at: 24, pace: "steady", route: "wide"}];
const race = simulateRace(course, [{id: "owner", name: "Coach", strategy: "conserve"}, {id: "rival", name: "Rival", strategy: "burst"}], commands, null);
const render = (time: number, locale: "en" | "ko", reducedMotion = false) => renderToStaticMarkup(<RaceTrack race={race} commands={commands} rivalId="rival" progress={time / race.seconds} ended={false} locale={locale} color="jade" running reducedMotion={reducedMotion} />);

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
