/*
 * The brand marks.
 *
 * These are the *supplied* artwork, keyed off its sheet and served from this
 * origin — not a redrawing. An earlier version of this file hand-traced the
 * horse as SVG paths, and the result was visibly cruder than the asset it was
 * imitating: a mark someone drew properly does not survive being approximated
 * from a description of itself.
 *
 * Extraction, for whoever regenerates these: the paper is sampled from each
 * crop's own edge rather than assumed white (the sheet is a JPEG whose ground is
 * not uniform, and keying against #fff leaves a grey rectangle on ivory), alpha
 * is a ramp over distance-from-paper rather than a threshold (a threshold turns
 * every curve into stairs), and pixels are sorted into two inks by saturation so
 * the red keeps its own value instead of dissolving into grey.
 *
 * Crop bounds are FOUND, never typed. The first pass typed a grid by hand and
 * clipped eighteen of the twenty marks — every icon lost an edge, and the
 * wordmark lost its baseline. The regenerator keys the sheet, takes a projection
 * profile to locate the gutters, then crops to each mark's own alpha bounds plus
 * 7% padding. The invariant it restores is checkable rather than eyeballed: no
 * asset's alpha bounding box may touch its canvas edge.
 *
 * Icons land on a SQUARE canvas with the mark centred, because every use renders
 * them into a square box. The sheet's cells are not square, so the old crops were
 * being scaled to 38×38 and squashed on top of being cut.
 */

const ICONS = [
    "pass-emblem",
    "gate-402",
    "pass-badge",
    "auto-approval",
    "agent-link",
    "credential-token",
    "agent-route",
    "checkout-flow",
    "shielded-pass",
    "autonomous-settlement",
    "monogram",
    "agent-relay",
    "paid-access-stamp",
    "authorization-coin",
    "verified-credential",
    "payment-stream",
    "m2m-settlement",
    "request-pay-proceed",
] as const;

export type IconName = (typeof ICONS)[number];

// Measured from the extracted files, not estimated: emblem 439×512, wordmark
// 900×154. These exist so width and height are both on the tag — the marks sit
// above the fold, and an <img> that arrives without dimensions reflows the
// headline the visitor is already mid-sentence in. Regenerating the assets means
// re-reading these two numbers off the output.
export const EMBLEM_ASPECT = 512 / 439;
const WORDMARK_ASPECT = 900 / 154;

/** The pass itself. */
export function PassEmblem({size = 40, className}: {size?: number; className?: string}) {
    return (
        <img
            src="/brand/emblem.png"
            alt="마패"
            width={size}
            height={Math.round(size * EMBLEM_ASPECT)}
            className={className}
            decoding="async"
        />
    );
}

export function Wordmark({height = 24, className}: {height?: number; className?: string}) {
    return (
        <img
            src="/brand/wordmark.png"
            alt="MAPAE"
            height={height}
            width={Math.round(height * WORDMARK_ASPECT)}
            className={className}
            decoding="async"
        />
    );
}

/**
 * One of the eighteen marks from the sheet.
 *
 * `alt=""` and `aria-hidden` because every use on this site sits beside the
 * words it illustrates. An icon that repeats its own caption to a screen reader
 * is noise; the caption is already the label.
 */
export function BrandIcon({
    name,
    size = 40,
    className,
}: {
    name: IconName;
    size?: number;
    className?: string;
}) {
    return (
        <img
            src={`/brand/icons/${name}.png`}
            alt=""
            aria-hidden="true"
            width={size}
            height={size}
            className={className}
            loading="lazy"
            decoding="async"
        />
    );
}

/** Emblem and wordmark, locked to one baseline. */
export function Lockup({compact = false}: {compact?: boolean}) {
    return (
        <span className="lockup">
            <PassEmblem size={compact ? 20 : 30} />
            <Wordmark height={compact ? 13 : 17} />
        </span>
    );
}

/**
 * "Pass. Pay. Proceed." set as live text rather than lifted from the sheet as a
 * raster: it is a sentence, so it should be selectable, scalable, and
 * translatable. The rules either side are the sheet's, rebuilt in CSS.
 */
export function Tagline({className}: {className?: string}) {
    return (
        <p className={`tagline ${className ?? ""}`}>
            <span>Pass.</span>
            <span>Pay.</span>
            <span>Proceed.</span>
        </p>
    );
}

/** The chevron that cuts the A's, kept as geometry because the dial rotates it. */
export function Chevron({size = 14, fill = "var(--red)"}: {size?: number; fill?: string}) {
    return (
        <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true" focusable="false">
            <path d="M14 4 L26 24 H20 L14 13 L8 24 H2 Z" fill={fill} />
        </svg>
    );
}
