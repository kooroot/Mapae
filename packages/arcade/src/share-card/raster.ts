import type {Bitmap} from "./png";
import {CELL_HEIGHT, GLYPH_ADVANCE, GLYPH_HEIGHT, GLYPH_WIDTH, glyphOf, textWidth} from "./pixel-font";

/** A colour as `#rrggbb`. */
export type Rgb = readonly [number, number, number];
export type Point = {x: number; y: number};

export function rgb(hex: string): Rgb {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) throw new Error(`Not a colour: ${hex}`);
    const n = parseInt(m[1]!, 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
}
export function createBitmap(width: number, height: number, fill: Rgb): Bitmap {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {data[i] = fill[0]; data[i + 1] = fill[1]; data[i + 2] = fill[2]; data[i + 3] = 255;}
    return {width, height, data};
}
export function pixelAt(b: Bitmap, x: number, y: number): Rgb {
    const i = (y * b.width + x) * 4;
    return [b.data[i]!, b.data[i + 1]!, b.data[i + 2]!];
}
/** Blends `color` with coverage `alpha` (0–1) over the pixel at x,y; the bitmap stays opaque. */
function blend(b: Bitmap, x: number, y: number, color: Rgb, alpha: number): void {
    if (alpha <= 0 || x < 0 || y < 0 || x >= b.width || y >= b.height) return;
    const i = (y * b.width + x) * 4, d = b.data;
    if (alpha >= 1) {d[i] = color[0]; d[i + 1] = color[1]; d[i + 2] = color[2]; return;}
    d[i] = d[i]! + (color[0] - d[i]!) * alpha; d[i + 1] = d[i + 1]! + (color[1] - d[i + 1]!) * alpha; d[i + 2] = d[i + 2]! + (color[2] - d[i + 2]!) * alpha;
}

export function fillRect(b: Bitmap, x: number, y: number, w: number, h: number, color: Rgb, alpha = 1): void {
    for (let py = Math.max(0, y); py < Math.min(b.height, y + h); py++) for (let px = Math.max(0, x); px < Math.min(b.width, x + w); px++) blend(b, px, py, color, alpha);
}
/** Coverage of a pixel centre inside a rounded rectangle: 1 inside, 0 outside, a soft edge over the corner arcs. */
function roundRectCoverage(px: number, py: number, x: number, y: number, w: number, h: number, r: number): number {
    const cx = px + 0.5, cy = py + 0.5;
    if (cx < x || cy < y || cx > x + w || cy > y + h) return 0;
    const dx = Math.max(x + r - cx, 0, cx - (x + w - r)), dy = Math.max(y + r - cy, 0, cy - (y + h - r));
    return Math.min(1, Math.max(0, r + 0.5 - Math.hypot(dx, dy)));
}
export function fillRoundRect(b: Bitmap, x: number, y: number, w: number, h: number, r: number, color: Rgb, alpha = 1): void {
    for (let py = Math.max(0, Math.floor(y)); py < Math.min(b.height, Math.ceil(y + h)); py++) for (let px = Math.max(0, Math.floor(x)); px < Math.min(b.width, Math.ceil(x + w)); px++)
        blend(b, px, py, color, roundRectCoverage(px, py, x, y, w, h, r) * alpha);
}
/** A rounded rectangle's outline, `width` thick, drawn inward from the box edge. */
export function strokeRoundRect(b: Bitmap, x: number, y: number, w: number, h: number, r: number, width: number, color: Rgb, alpha = 1): void {
    for (let py = Math.max(0, Math.floor(y)); py < Math.min(b.height, Math.ceil(y + h)); py++) for (let px = Math.max(0, Math.floor(x)); px < Math.min(b.width, Math.ceil(x + w)); px++) {
        const outer = roundRectCoverage(px, py, x, y, w, h, r), inner = roundRectCoverage(px, py, x + width, y + width, w - 2 * width, h - 2 * width, Math.max(0, r - width));
        blend(b, px, py, color, Math.max(0, outer - inner) * alpha);
    }
}
export function fillCircle(b: Bitmap, cx: number, cy: number, r: number, color: Rgb): void {
    for (let py = Math.max(0, Math.floor(cy - r)); py < Math.min(b.height, Math.ceil(cy + r)); py++) for (let px = Math.max(0, Math.floor(cx - r)); px < Math.min(b.width, Math.ceil(cx + r)); px++)
        blend(b, px, py, color, Math.min(1, Math.max(0, r + 0.5 - Math.hypot(px + 0.5 - cx, py + 0.5 - cy))));
}

/** Even-odd point-in-polygon on pixel centres, the clip the hat's front edge uses. */
export function insidePolygon(points: readonly Point[], x: number, y: number): boolean {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[i]!, b = points[j]!;
        if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
}

/**
 * Draws `image` scaled into the box at dx,dy (dw×dh), bilinear on premultiplied samples so edges carry no dark fringe, composited
 * over the opaque bitmap; `clip` keeps the drawing inside a polygon in bitmap coordinates.
 */
export function drawImage(b: Bitmap, image: Bitmap, dx: number, dy: number, dw: number, dh: number, clip?: readonly Point[]): void {
    const sx = image.width / dw, sy = image.height / dh, src = image.data, dst = b.data, iw = image.width, ih = image.height;
    const x0 = Math.max(0, Math.floor(dx)), y0 = Math.max(0, Math.floor(dy)), x1 = Math.min(b.width, Math.ceil(dx + dw)), y1 = Math.min(b.height, Math.ceil(dy + dh));
    for (let py = y0; py < y1; py++) {
        const v = (py + 0.5 - dy) * sy - 0.5, vy = Math.min(ih - 1, Math.max(0, Math.floor(v))), vy1 = Math.min(ih - 1, vy + 1), fy = Math.min(1, Math.max(0, v - vy));
        for (let px = x0; px < x1; px++) {
            if (clip && !insidePolygon(clip, px + 0.5, py + 0.5)) continue;
            const u = (px + 0.5 - dx) * sx - 0.5, ux = Math.min(iw - 1, Math.max(0, Math.floor(u))), ux1 = Math.min(iw - 1, ux + 1), fx = Math.min(1, Math.max(0, u - ux));
            const i00 = (vy * iw + ux) * 4, i10 = (vy * iw + ux1) * 4, i01 = (vy1 * iw + ux) * 4, i11 = (vy1 * iw + ux1) * 4;
            const w00 = src[i00 + 3]! * (1 - fx) * (1 - fy), w10 = src[i10 + 3]! * fx * (1 - fy), w01 = src[i01 + 3]! * (1 - fx) * fy, w11 = src[i11 + 3]! * fx * fy;
            const a = (w00 + w10 + w01 + w11) / 255;
            if (a <= 0) continue;
            const r = (src[i00]! * w00 + src[i10]! * w10 + src[i01]! * w01 + src[i11]! * w11) / 255;
            const g = (src[i00 + 1]! * w00 + src[i10 + 1]! * w10 + src[i01 + 1]! * w01 + src[i11 + 1]! * w11) / 255;
            const bl = (src[i00 + 2]! * w00 + src[i10 + 2]! * w10 + src[i01 + 2]! * w01 + src[i11 + 2]! * w11) / 255;
            const o = (py * b.width + px) * 4;
            dst[o] = r + dst[o]! * (1 - a); dst[o + 1] = g + dst[o + 1]! * (1 - a); dst[o + 2] = bl + dst[o + 2]! * (1 - a);
        }
    }
}

/** Draws `text` in the pixel font with its cell's top-left at x,y (or right-aligned to x when `align` is "right"); returns the width drawn. */
export function drawText(b: Bitmap, text: string, x: number, y: number, scale: number, color: Rgb, align: "left" | "right" = "left"): number {
    const width = textWidth(text, scale);
    let cx = align === "right" ? x - width : x;
    for (const char of text) {
        const glyph = glyphOf(char);
        if (glyph) for (let row = 0; row < GLYPH_HEIGHT; row++) for (let col = 0; col < GLYPH_WIDTH; col++) {
            if (glyph[row]! & (1 << (GLYPH_WIDTH - 1 - col))) fillRect(b, cx + col * scale, y + row * scale, scale, scale, color);
        }
        cx += GLYPH_ADVANCE * scale;
    }
    return width;
}
/** The largest scale, down from `preferred`, at which `text` fits `maxWidth`; never below 1. */
export function fitScale(text: string, maxWidth: number, preferred: number): number {
    let scale = preferred;
    while (scale > 1 && textWidth(text, scale) > maxWidth) scale--;
    return scale;
}
export const TEXT_HEIGHT = (scale: number) => CELL_HEIGHT * scale;
