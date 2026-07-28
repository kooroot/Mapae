/*
 * The brand marks, drawn rather than imported.
 *
 * Everything here is geometry — no raster, no external file, no font dependency.
 * That is a deployment constraint before it is a taste one: the published CSP is
 * `img-src 'self' data:` and `font-src 'self'`, and a mark built from paths keeps
 * working at a favicon's 16px and at the hero's 480px from the same source.
 */

/**
 * The horse's head in profile, facing left, with the mane carried as three
 * streaks behind it.
 *
 * The brand sheet draws the full galloping horse for the primary emblem and the
 * head alone for the badge marks. The head is what is used here at every size:
 * a full horse at 24px in the nav collapses into an unreadable smudge, and a
 * mark that has to be swapped for a different drawing below some breakpoint is
 * two marks.
 *
 * The streaks are the only red in the emblem. They read as motion at the hero's
 * size and as a signal accent at the nav's, which is the same job the red does
 * everywhere else in this system.
 */
export function HorseHead({
    size = 48,
    ink = "currentColor",
    accent = "var(--red)",
    streaks = true,
}: {
    size?: number;
    ink?: string;
    accent?: string;
    streaks?: boolean;
}) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 100 100"
            fill="none"
            aria-hidden="true"
            focusable="false"
        >
            <path
                d="M58 6 L66 21 C74 28 79 34 82 44 C86 58 90 76 92 96 L48 96 C46 84 44 76 39 68 C36 63 34 61 30 60 C24 59 16 63 10 66 C6 68 4 63 6 59 C8 55 10 53 14 50 C22 44 30 38 38 29 C43 23 48 16 52 9 Z"
                fill={ink}
            />
            {streaks && (
                <g fill={accent}>
                    <rect x="62" y="40" width="34" height="7" rx="3.5" />
                    <rect x="68" y="55" width="30" height="7" rx="3.5" />
                    <rect x="74" y="70" width="24" height="7" rx="3.5" />
                </g>
            )}
        </svg>
    );
}

/**
 * The emblem: the head inside the pass, with the suspension loop the physical
 * tally hung from.
 *
 * The loop is not ornament. A 마패 was carried on a cord because it had to be
 * produced on demand — it is the detail that says "credential" rather than
 * "coin", and dropping it makes the mark read as a token.
 */
export function PassEmblem({size = 40, ink = "var(--ink)"}: {size?: number; ink?: string}) {
    return (
        <svg
            width={size}
            height={size * 1.18}
            viewBox="0 0 100 118"
            fill="none"
            role="img"
            aria-label="마패"
        >
            {/* suspension loop */}
            <circle cx="50" cy="9" r="7.5" stroke={ink} strokeWidth="4" />
            <circle cx="50" cy="9" r="2.6" fill="var(--red)" />
            {/* the two engraved rims */}
            <circle cx="50" cy="66" r="45" stroke={ink} strokeWidth="4" />
            <circle cx="50" cy="66" r="37" stroke={ink} strokeWidth="2" />
            <g transform="translate(24 40) scale(0.52)">
                <HorseHead size={100} ink={ink} />
            </g>
        </svg>
    );
}

/**
 * MAPAE, built from geometry so the two A-counters can carry the boundary mark.
 *
 * Set as paths rather than as text on purpose. The counter of each A holds a red
 * triangle, and doing that with a webfont means overlaying an absolutely
 * positioned shape onto a glyph whose metrics differ per platform — it drifts on
 * the first machine that substitutes the face. As geometry the relationship is
 * fixed, and the wordmark needs no font to load before it is correct.
 */
export function Wordmark({
    height = 28,
    ink = "var(--ink)",
    accent = "var(--red)",
    title = "MAPAE",
}: {
    height?: number;
    ink?: string;
    accent?: string;
    title?: string;
}) {
    return (
        <svg
            height={height}
            viewBox="0 0 515 100"
            fill="none"
            role="img"
            aria-label={title}
            style={{width: "auto"}}
        >
            <g fill={ink}>
                {/* M */}
                <path d="M0 100 V0 H16 L52 54 L88 0 H104 V100 H88 V28 L57 70 H47 L16 28 V100 Z" />
                {/* A */}
                <path d="M123 100 L161 0 H177 L215 100 H197 L169 22 L141 100 Z" />
                {/* P */}
                <path
                    fillRule="evenodd"
                    clipRule="evenodd"
                    d="M233 0 H281 A29 29 0 0 1 281 58 H249 V100 H233 Z M249 15 H279 A14 14 0 0 1 279 43 H249 Z"
                />
                {/* A */}
                <path d="M331 100 L369 0 H385 L423 100 H405 L377 22 L349 100 Z" />
                {/* E */}
                <path d="M441 0 H515 V16 H457 V42 H505 V58 H457 V84 H515 V100 H441 Z" />
            </g>
            {/* The boundary, seated in each counter. */}
            <g fill={accent}>
                <path d="M155 74 L169 52 L183 74 Z" />
                <path d="M363 74 L377 52 L391 74 Z" />
            </g>
        </svg>
    );
}

/**
 * The chevron that rides the dial and cuts the A's — one shape, three jobs.
 * Drawn pointing up; the dial rotates it.
 */
export function Chevron({size = 14, fill = "var(--red)"}: {size?: number; fill?: string}) {
    return (
        <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true" focusable="false">
            <path d="M14 4 L26 24 H20 L14 13 L8 24 H2 Z" fill={fill} />
        </svg>
    );
}

/** The full lockup: emblem, wordmark, and the tagline the sheet sets beneath it. */
export function Lockup({compact = false}: {compact?: boolean}) {
    return (
        <span className="lockup" data-compact={compact}>
            <PassEmblem size={compact ? 22 : 34} />
            <Wordmark height={compact ? 16 : 22} />
        </span>
    );
}
