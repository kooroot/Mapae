import {expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import type {SeasonMark as Mark} from "@mapae/arcade/hall";
import {GuardianAvatar} from "../GuardianAvatar";
import {SeasonMark, SeasonMarks, seasonMarkName, seasonMarkShortName, shownMarks} from "./SeasonMark";

const podium: Mark = {season: 1, kind: "podium", place: 2}, team: Mark = {season: 1, kind: "team", zodiac: "tiger"}, entrant: Mark = {season: 1, kind: "entrant"};

test("every mark is named in both languages and the name travels in the SVG title", () => {
    expect(seasonMarkName(podium, "ko")).toBe("시즌 1 시상대 2위 문양"); expect(seasonMarkName(podium, "en")).toBe("Season 1 podium #2");
    expect(seasonMarkName(team, "ko")).toBe("시즌 1 우승 호랑이팀 표식"); expect(seasonMarkName(team, "en")).toBe("Season 1 winning team · Tiger");
    expect(seasonMarkName(entrant, "ko")).toBe("시즌 1 참가 문양"); expect(seasonMarkName(entrant, "en")).toBe("Season 1 entrant mark");
    expect(seasonMarkShortName(podium, "ko")).toBe("시상대 2위 문양"); expect(seasonMarkShortName(team, "en")).toBe("winning team · Tiger");
    const html = renderToStaticMarkup(<SeasonMark mark={podium} locale="ko" />);
    expect(html).toContain('role="img"'); expect(html).toContain("<title"); expect(html).toContain("시즌 1 시상대 2위 문양"); expect(html).toContain('class="season-mark is-podium is-place-2"');
    expect(html).toContain('width="18" height="18"'); expect(html).toContain(">2</text>");
    const decorative = renderToStaticMarkup(<SeasonMark mark={entrant} locale="en" size={36} decorative />);
    expect(decorative).toContain('aria-hidden="true"'); expect(decorative).not.toContain("<title"); expect(decorative).toContain('width="36"'); expect(decorative).toContain(">1</text>");
});
test("the shapes draw from tokens only: jade ring, vermilion pennant on an ink pole, a medal plaque with its ribbon", () => {
    const stamp = renderToStaticMarkup(<SeasonMark mark={entrant} locale="ko" />), flag = renderToStaticMarkup(<SeasonMark mark={team} locale="ko" />), plaque = renderToStaticMarkup(<SeasonMark mark={podium} locale="ko" />);
    expect(stamp).toContain('stroke="var(--jade)"'); expect(stamp).toContain('r="9"');
    expect(flag).toContain('fill="var(--vermilion)"'); expect(flag).toContain('fill="var(--card-ink)"'); expect(flag).toContain('fill="#fff"');
    expect(plaque).toContain('stroke="var(--medal-rim)"'); expect(plaque).toContain('fill="var(--ribbon)"'); expect(plaque).toContain('class="season-mark-light"'); expect(plaque).toContain('fill="var(--medal-ink)"');
    for (const html of [stamp, flag, plaque]) expect(html.replace('fill="#fff"', "")).not.toMatch(/#[0-9a-f]{3,8}\b/i);
});
test("a row of marks keeps podium, team, entrant order and shows nothing for none", () => {
    expect(renderToStaticMarkup(<SeasonMarks marks={[]} locale="ko" />)).toBe("");
    const html = renderToStaticMarkup(<SeasonMarks marks={[podium, team, entrant]} locale="en" size={14} />);
    expect(html).toStartWith('<span class="season-marks">'); expect(html.indexOf("is-podium")).toBeLessThan(html.indexOf("is-team")); expect(html.indexOf("is-team")).toBeLessThan(html.indexOf("is-entrant"));
    expect(html.match(/width="14"/g)).toHaveLength(3);
    expect(shownMarks([podium, team, entrant])).toHaveLength(3);
});
test("a portrait wears its marks at the bottom right, three at most, as decoration inside the hidden avatar", () => {
    const html = renderToStaticMarkup(<GuardianAvatar portrait marks={[podium, team, entrant]} />);
    expect(html.match(/class="season-mark-glyph/g)).toHaveLength(3);
    expect(html).toContain('x="344" y="334" width="36" height="36"'); expect(html).toContain('x="304"'); expect(html).toContain('x="264"'); expect(html).not.toContain("<title");
    expect(renderToStaticMarkup(<GuardianAvatar marks={[entrant]} />)).not.toContain("season-mark-glyph");
    expect(renderToStaticMarkup(<GuardianAvatar portrait />)).not.toContain("season-mark-glyph");
});
