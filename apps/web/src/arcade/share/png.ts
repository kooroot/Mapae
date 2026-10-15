/**
 * The PNG codec the share card needs and nothing more: 8-bit RGB/RGBA, non-interlaced, zlib through the runtime's own
 * `DecompressionStream`/`CompressionStream` (Workers and bun both have them). Guardian layers are committed as PNG because the
 * Worker has no WebP decoder; the card itself is PNG because X, Discord and KakaoTalk render no SVG preview.
 */
export type Bitmap = {width: number; height: number; /** RGBA, row-major, straight (non-premultiplied) alpha. */ data: Uint8ClampedArray};

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const MAX_PIXELS = 2_000_000;
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

export function crc32(bytes: Uint8Array): number {
    let c = 0xffffffff;
    for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

async function pipe(bytes: Uint8Array, stream: {readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource>}): Promise<Uint8Array> {
    const writer = stream.writable.getWriter();
    const written = writer.write(bytes).then(() => writer.close());
    const out = new Uint8Array(await new Response(stream.readable).arrayBuffer());
    await written;
    return out;
}
const inflate = (bytes: Uint8Array) => pipe(bytes, new DecompressionStream("deflate"));
const deflate = (bytes: Uint8Array) => pipe(bytes, new CompressionStream("deflate"));

function paeth(a: number, b: number, c: number): number {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decodes a PNG the layer pipeline wrote: 8-bit RGB or RGBA, no interlace, no palette. Anything else, or a bad CRC, throws. */
export async function decodePng(bytes: Uint8Array): Promise<Bitmap> {
    if (bytes.length < 33 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error("Not a PNG");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8, width = 0, height = 0, channels = 0;
    const parts: Uint8Array[] = []; let total = 0;
    while (offset + 12 <= bytes.length) {
        const length = view.getUint32(offset), type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
        if (offset + 12 + length > bytes.length) throw new Error("Truncated PNG chunk");
        const data = bytes.subarray(offset + 8, offset + 8 + length);
        if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== view.getUint32(offset + 8 + length)) throw new Error("PNG chunk CRC mismatch");
        if (type === "IHDR") {
            width = view.getUint32(offset + 8); height = view.getUint32(offset + 12);
            const depth = data[8], color = data[9], interlace = data[12];
            if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0 || width < 1 || height < 1 || width * height > MAX_PIXELS) throw new Error("Unsupported PNG");
            channels = color === 6 ? 4 : 3;
        } else if (type === "IDAT") {parts.push(data); total += data.length;}
        else if (type === "IEND") break;
        offset += 12 + length;
    }
    if (!channels || !parts.length) throw new Error("PNG without image data");
    const compressed = new Uint8Array(total); let at = 0;
    for (const part of parts) {compressed.set(part, at); at += part.length;}
    const raw = await inflate(compressed), stride = width * channels;
    if (raw.length !== (stride + 1) * height) throw new Error("PNG size mismatch");
    const data = new Uint8ClampedArray(width * height * 4), line = new Uint8Array(stride), previous = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)]!, row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        for (let i = 0; i < stride; i++) {
            const a = i >= channels ? line[i - channels]! : 0, b = previous[i]!, c = i >= channels ? previous[i - channels]! : 0, x = row[i]!;
            line[i] = filter === 0 ? x : filter === 1 ? x + a : filter === 2 ? x + b : filter === 3 ? x + ((a + b) >> 1) : filter === 4 ? x + paeth(a, b, c) : NaN;
        }
        if (filter > 4) throw new Error("Unknown PNG filter");
        const out = y * width * 4;
        if (channels === 4) data.set(line, out);
        else for (let x = 0; x < width; x++) {data[out + x * 4] = line[x * 3]!; data[out + x * 4 + 1] = line[x * 3 + 1]!; data[out + x * 4 + 2] = line[x * 3 + 2]!; data[out + x * 4 + 3] = 255;}
        previous.set(line);
    }
    return {width, height, data};
}

function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}

/** Encodes an opaque RGB PNG (the card has no transparent pixel), Sub-filtered: flat colour runs deflate well and it costs one pass. */
export async function encodePng({width, height, data}: Bitmap): Promise<Uint8Array> {
    const stride = width * 3, raw = new Uint8Array((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        const at = y * (stride + 1), src = y * width * 4;
        raw[at] = 1;
        for (let x = 0; x < width; x++) {
            const i = src + x * 4, o = at + 1 + x * 3;
            raw[o] = data[i]! - (x ? data[i - 4]! : 0);
            raw[o + 1] = data[i + 1]! - (x ? data[i - 3]! : 0);
            raw[o + 2] = data[i + 2]! - (x ? data[i - 2]! : 0);
        }
    }
    const header = new Uint8Array(13), view = new DataView(header.buffer);
    view.setUint32(0, width); view.setUint32(4, height); header[8] = 8; header[9] = 2;
    const parts = [new Uint8Array(SIGNATURE), chunk("IHDR", header), chunk("IDAT", await deflate(raw)), chunk("IEND", new Uint8Array(0))];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0;
    for (const part of parts) {out.set(part, at); at += part.length;}
    return out;
}
