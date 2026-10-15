import {expect, test} from "bun:test";
import {shareLinks, shareText} from "./links";

const run = {kind: "run", tokenId: "407", game: "race", day: "2026-10-14"} as const, standing = {score: 12_340, rank: 3, entrants: 41};
const season = {moves: true, prev: 3, points: 187, rank: 2, entrants: 212, days: 9, streak: 9, bonus: 10, today: 10};

test("the post names the guardian, the number and the account in the reader's language", () => {
    expect(shareText(run, standing, "ko")).toBe("내 전령 장난스러운 감돌이: 달려라 마패 12,340점, 오늘 3위/41명! @mapae_io 오락실에서 전령을 뽑아 겨뤄요 #Mapae #GIWA");
    expect(shareText(run, standing, "en")).toBe("My guardian Playful Gamdori: Auto Race 12,340 pts, #3 of 41 today on the @mapae_io arcade. #Mapae #GIWA");
    expect(shareText({kind: "season", tokenId: "407"}, season, "ko")).toBe("내 전령 장난스러운 감돌이: 시즌 1 187점, 2위/212명. @mapae_io 오락실 시즌 1 진행 중 #Mapae #GIWA");
    expect(shareText({kind: "season", tokenId: "407"}, season, "en")).toBe("Playful Gamdori: Season 1, 187 pts, #2 of 212 on the @mapae_io arcade. #Mapae #GIWA");
});
test("the intent carries the text and the localized page, the card is same-origin and the download is named", () => {
    const links = shareLinks(run, "hello #Mapae", "ko");
    expect(links.page).toEndWith("/ko/share/g/407/race/2026-10-14");
    expect(links.intent).toBe(`https://x.com/intent/post?text=hello%20%23Mapae&url=${encodeURIComponent(links.page)}`);
    expect(links.card).toBe("/api/arcade/share/g/407/race/2026-10-14/card.png");
    expect(links.download).toBe("mapae-407-race-2026-10-14.png");
    const s = shareLinks({kind: "season", tokenId: "12"}, "x", "en");
    expect(s.page).toEndWith("/share/s/12"); expect(s.page).not.toContain("/ko/"); expect(s.card).toBe("/api/arcade/share/s/12/card.png"); expect(s.download).toBe("mapae-12-season-1.png");
    expect(links.intent).not.toContain("ref="); expect(links.intent).not.toContain("utm_");
});
