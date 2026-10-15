import {expect, test} from "bun:test";
import {crc32, decodePng, encodePng} from "./png";
import {createBitmap, pixelAt, rgb} from "./raster";

const layer = (name: string) => Bun.file(new URL(`../../../public/arcade/share/${name}.png`, import.meta.url)).bytes();

test("encode then decode round-trips every pixel of an opaque bitmap", async () => {
    const bitmap = createBitmap(37, 11, rgb("#0e0c0a"));
    for (let i = 0; i < bitmap.data.length; i += 4) {bitmap.data[i] = i % 251; bitmap.data[i + 1] = (i * 7) % 253; bitmap.data[i + 2] = (i * 13) % 255;}
    const png = await encodePng(bitmap);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const back = await decodePng(png);
    expect(back.width).toBe(37); expect(back.height).toBe(11);
    expect(back.data).toEqual(bitmap.data);
});
test("a committed layer decodes as 8-bit RGBA with transparent margins and an opaque body", async () => {
    const head = await decodePng(await layer("head-dragon"));
    expect(head.width).toBe(320); expect(head.height).toBeGreaterThan(200); expect(head.height).toBeLessThanOrEqual(320);
    expect(head.data[3]).toBe(0);
    const centre = ((head.height >> 1) * head.width + (head.width >> 1)) * 4;
    expect(head.data[centre + 3]).toBeGreaterThan(240);
    const charm = await decodePng(await layer("charm-mapae"));
    expect(charm.width).toBe(320); expect(charm.height).toBe(320);
});
test("a damaged chunk, a foreign file and an unsupported layout are refused", async () => {
    const png = await encodePng(createBitmap(4, 4, rgb("#ffffff")));
    const damaged = png.slice(); damaged[40] ^= 0xff;
    await expect(decodePng(damaged)).rejects.toThrow("CRC");
    await expect(decodePng(new TextEncoder().encode("<svg/>"))).rejects.toThrow("Not a PNG");
    const indexed = png.slice(); indexed[25] = 3; // colour type: palette
    await expect(decodePng(indexed)).rejects.toThrow();
    expect(crc32(new TextEncoder().encode("IEND"))).toBe(0xae426082);
});
test("decoded colours survive the Sub filter on a gradient row", async () => {
    const bitmap = createBitmap(256, 2, rgb("#000000"));
    for (let x = 0; x < 256; x++) {bitmap.data[x * 4] = x; bitmap.data[(256 + x) * 4 + 2] = 255 - x;}
    const back = await decodePng(await encodePng(bitmap));
    expect(pixelAt(back, 200, 0)).toEqual([200, 0, 0]); expect(pixelAt(back, 5, 1)).toEqual([0, 0, 250]);
});
