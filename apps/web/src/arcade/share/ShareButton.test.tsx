import {expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {ShareActions} from "./ShareButton";

const target = {kind: "run", tokenId: "407", game: "race", day: "2026-10-14"} as const, standing = {score: 12_340, rank: 3, entrants: 41};

test("the full actions are an X intent in a new tab and a same-origin download; compact is the icon alone", () => {
    const html = renderToStaticMarkup(<ShareActions target={target} standing={standing} locale="ko" />);
    expect(html).toContain('class="share-actions"');
    expect(html).toContain('href="https://x.com/intent/post?text=');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('href="/api/arcade/share/g/407/race/2026-10-14/card.png" download="mapae-407-race-2026-10-14.png"');
    expect(html).toContain("X에 공유"); expect(html).toContain("카드 저장");
    const en = renderToStaticMarkup(<ShareActions target={{kind: "season", tokenId: "407"}} standing={{moves: false, prev: null, points: 187, rank: 2, entrants: 212, days: 9, streak: 9, bonus: 10, today: 1}} locale="en" />);
    expect(en).toContain("Share on X"); expect(en).toContain('download="mapae-407-season-1.png"');
    const compact = renderToStaticMarkup(<ShareActions target={target} standing={standing} locale="en" compact />);
    expect(compact).toStartWith('<a class="share-x"'); expect(compact).toContain('aria-label="Share on X"'); expect(compact).not.toContain("download=");
});
