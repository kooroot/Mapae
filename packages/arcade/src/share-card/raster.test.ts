import {expect, test} from "bun:test";
import {GLYPHS, textWidth} from "./pixel-font";
import {createBitmap, drawImage, drawText, fillCircle, fillRoundRect, fitScale, insidePolygon, pixelAt, rgb, strokeRoundRect} from "./raster";

const black = rgb("#000000"), white = rgb("#ffffff"), gold = rgb("#f2c14e");

test("the font covers the card's alphabet, and text measures one advance per character", () => {
    for (const char of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#.,:·+-/@_!") expect(GLYPHS.has(char)).toBe(true);
    expect(textWidth("MAPAE", 3)).toBe((5 * 6 - 1) * 3); expect(textWidth("", 3)).toBe(0);
    expect(fitScale("12,340", 200, 10)).toBe(5); expect(fitScale("X", 1, 4)).toBe(1);
});
test("drawn glyphs put ink where the bitmap says, scale square blocks and align right", () => {
    const b = createBitmap(80, 20, black);
    expect(drawText(b, "i", 2, 2, 2, gold)).toBe(10);
    expect(pixelAt(b, 2, 2)).toEqual([...gold]); expect(pixelAt(b, 3, 3)).toEqual([...gold]); // top bar of I, 2×2 blocks
    expect(pixelAt(b, 2, 6)).toEqual([...black]); // the stem is centred, so the left column is empty below the bar
    expect(pixelAt(b, 6, 6)).toEqual([...gold]);
    drawText(b, "?", 30, 2, 2, gold); // unknown: a space
    expect(pixelAt(b, 30, 2)).toEqual([...black]);
    drawText(b, "A", 79, 2, 1, white, "right");
    expect(pixelAt(b, 79, 2)).toEqual([...black]); expect(pixelAt(b, 75, 2)).toEqual([...white]);
});
test("round rectangles, circles and strokes leave their corners and interiors alone as asked", () => {
    const b = createBitmap(60, 60, black);
    fillRoundRect(b, 10, 10, 40, 40, 12, white);
    expect(pixelAt(b, 30, 30)).toEqual([...white]); expect(pixelAt(b, 10, 10)).toEqual([...black]); expect(pixelAt(b, 5, 30)).toEqual([...black]);
    strokeRoundRect(b, 10, 10, 40, 40, 12, 3, gold);
    expect(pixelAt(b, 30, 11)).toEqual([...gold]); expect(pixelAt(b, 30, 30)).toEqual([...white]);
    fillCircle(b, 30, 30, 5, black);
    expect(pixelAt(b, 30, 30)).toEqual([...black]); expect(pixelAt(b, 37, 30)).toEqual([...white]);
});
test("images composite with alpha, scale bilinearly and stay inside a clip polygon", () => {
    const image = createBitmap(4, 4, white);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) image.data[(y * 4 + x) * 4 + 3] = 0; // top half transparent
    const b = createBitmap(20, 20, black);
    drawImage(b, image, 2, 2, 8, 8);
    expect(pixelAt(b, 3, 3)).toEqual([...black]); expect(pixelAt(b, 5, 8)).toEqual([...white]);
    expect(pixelAt(b, 5, 6)[0]).toBeGreaterThan(0); expect(pixelAt(b, 5, 6)[0]).toBeLessThan(255); // the soft edge between halves
    const clip = [{x: 0, y: 0}, {x: 20, y: 0}, {x: 20, y: 20}]; // upper-right triangle
    expect(insidePolygon(clip, 15, 5)).toBe(true); expect(insidePolygon(clip, 5, 15)).toBe(false);
    const c = createBitmap(20, 20, black);
    drawImage(c, createBitmap(2, 2, gold), 0, 0, 20, 20, clip);
    expect(pixelAt(c, 15, 5)).toEqual([...gold]); expect(pixelAt(c, 4, 15)).toEqual([...black]);
});
