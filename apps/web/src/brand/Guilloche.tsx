/*
 * Guilloché — the engine-turned rosette that has been engraved onto banknotes,
 * bonds and passports since the rose engine lathe of the 1700s.
 *
 * This is the one visual device this product has more claim to than anyone else
 * in its category. A 마패 was a credential whose authority rested on being
 * impossible to forge convincingly, and guilloché exists for exactly that reason:
 * it is a curve no hand can redraw and no photocopier can hold. Every competing
 * site reaches for a gradient mesh or a wireframe globe. This is the pattern the
 * *document* would actually carry.
 *
 * It is a hypotrochoid, drawn rather than imported — one path, closed form, no
 * raster and no external asset, which is what lets it sit under a strict CSP and
 * stay crisp at any size.
 *
 *      x = (R − r)·cos t + d·cos(((R − r)/r)·t)
 *      y = (R − r)·sin t − d·sin(((R − r)/r)·t)
 *
 * PICKING R AND r IS THE WHOLE JOB, and getting it wrong does not look like a
 * bug — it looks like a dirty smudge, which is how the first version shipped.
 * With g = gcd(R, r), the curve closes after r/g revolutions and draws R/g
 * lobes. Those two numbers pull in opposite directions:
 *
 *   - r/g is how many times the pen crosses its own annulus. Above roughly a
 *     dozen the strokes stop resolving and the band fills to solid grey. The
 *     first version used R=190, r=53 — coprime, so 53 traversals, and at a
 *     320px seal that is 50 strokes to a pixel column. It rendered as a thumb
 *     smudge and read as a rendering fault.
 *   - R/g is the lobe count, and the lobes ARE the pattern. Fewer than ~20 and
 *     it stops reading as engine-turning and starts reading as a flower.
 *
 * So: keep r SMALL (3–7) and R LARGE and coprime to it. r=5, R=47 gives 5
 * traversals and 47 lobes — a real guilloché band. The assertion below encodes
 * that as a rule rather than as folklore, because the failure is silent.
 */

function gcd(a: number, b: number): number {
    return b === 0 ? a : gcd(b, a % b);
}

/**
 * One closed hypotrochoid, scaled so its widest excursion lands on `radius`.
 *
 * Sampling is per-lobe rather than per-turn: lobe count is what sets how fast
 * the curve changes direction, so tying resolution to it keeps the line quality
 * even whatever parameters come in.
 */
function rosette(R: number, r: number, d: number, radius: number, perLobe = 90): string {
    const g = gcd(R, r);
    const turns = r / g;
    const lobes = R / g;
    if (turns > 14) {
        // Loud, because the symptom (a grey disc) does not look like a maths error.
        throw new Error(
            `guilloche: R=${R} r=${r} winds ${turns} times; the band will fill solid. Use a smaller r coprime to R.`,
        );
    }
    // Sampling is per-lobe, and the lobe is what sets how fast the pen turns.
    // Too coarse and the scallops flatten into a star polygon — the same drawing,
    // faceted, which reads as a cheap SVG rather than as an engraving. The
    // underprint can afford a coarser setting than the seal because it renders at
    // a tenth the opacity, where a two-pixel facet is not perceptible.
    const samples = Math.min(Math.max(lobes * perLobe, 900), 9000);
    const scale = radius / (R - r + d);
    const points: string[] = [];
    for (let i = 0; i <= samples; i += 1) {
        const t = (i / samples) * turns * 2 * Math.PI;
        const x = ((R - r) * Math.cos(t) + d * Math.cos(((R - r) / r) * t)) * scale;
        const y = ((R - r) * Math.sin(t) - d * Math.sin(((R - r) / r) * t)) * scale;
        // One decimal: at these radii the second one is sub-pixel, and it is
        // several kilobytes of path data per band in a prerendered document.
        points.push(`${x.toFixed(1)} ${y.toFixed(1)}`);
    }
    return `M ${points.join(" L ")} Z`;
}

/** Each entry is [R, r, depth, radius fraction, opacity]. */
type Band = [number, number, number, number, number];

/*
 * `d` is kept near a tenth of (R − r) on purpose. It sets how deep each lobe
 * dips, and therefore how wide an annulus the curve sweeps. A deep lobe sends
 * the pen through the middle on every pass, and the result is a spirograph
 * doodle — which is what a child's toy draws and what a banknote never does.
 * Real engine-turning keeps the pen in a narrow band and lets the lobe COUNT
 * carry the pattern.
 */
const FIELD_BANDS: Band[] = [
    [47, 5, 4.6, 0.98, 0.5],
    [43, 4, 4.0, 0.82, 0.42],
    [37, 3, 3.6, 0.66, 0.34],
    [29, 4, 3.0, 0.5, 0.26],
];

/**
 * A field of nested rosettes.
 *
 * `seed` rotates the whole field rather than perturbing R and r. Perturbing the
 * parameters was the earlier approach and it is a trap: a one-step change to r
 * can take the winding number from 5 to 53, so "make the second one slightly
 * different" silently turns one of the two fields into a smudge. Rotation varies
 * the drawing without touching the maths that has to hold.
 */
export function Guilloche({
    size = 900,
    rings = 4,
    seed = 0,
    className,
}: {
    size?: number;
    rings?: number;
    seed?: number;
    className?: string;
}) {
    const half = size / 2;
    const bands = FIELD_BANDS.slice(0, Math.max(1, Math.min(rings, FIELD_BANDS.length)));

    return (
        <svg
            className={className}
            viewBox={`0 0 ${size} ${size}`}
            width={size}
            height={size}
            aria-hidden="true"
            focusable="false"
        >
            <g
                transform={`translate(${half} ${half}) rotate(${seed * 11})`}
                fill="none"
                stroke="currentColor"
            >
                {bands.map(([R, r, d, frac, opacity], index) => (
                    <path
                        key={index}
                        d={rosette(R, r, d, half * 0.94 * frac, 34)}
                        strokeWidth={0.5}
                        opacity={opacity}
                        vectorEffect="non-scaling-stroke"
                    />
                ))}
            </g>
        </svg>
    );
}

/**
 * A single fine rosette band, sized for a seal rather than a field.
 *
 * Used behind the medallion, where it does the job a security print's underprint
 * does: it says the surface itself is engraved, so the number sitting on it
 * reads as struck into the object rather than typeset over a picture of one.
 *
 * ONE band, not a nested pair. The pair was tried and it is wrong here: the
 * caller sizes this so the band lands in the empty annulus between the amount
 * track and the second ring, and a second band at 0.8 falls straight across the
 * track it is supposed to sit behind. An underprint that collides with the
 * reading is no longer an underprint.
 */
export function GuillocheSeal({size = 320, className}: {size?: number; className?: string}) {
    const half = size / 2;
    return (
        <svg
            className={className}
            viewBox={`0 0 ${size} ${size}`}
            width={size}
            height={size}
            aria-hidden="true"
            focusable="false"
        >
            <g transform={`translate(${half} ${half})`} fill="none" stroke="currentColor">
                <path
                    d={rosette(47, 5, 4.4, half * 0.97, 120)}
                    strokeWidth="0.6"
                    opacity="0.7"
                    vectorEffect="non-scaling-stroke"
                />
            </g>
        </svg>
    );
}
