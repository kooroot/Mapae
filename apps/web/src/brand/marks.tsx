import {
    BadgeCheck,
    CircleDollarSign,
    CircleGauge,
    DoorOpen,
    HandCoins,
    ReceiptText,
    ShieldCheck,
    SlidersHorizontal,
    TimerReset,
    type LucideIcon,
} from "lucide-react";

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
 * padding. The small `pass-emblem` cell on the supplied sheet still truncates
 * the hanging loop, so product seals use the complete `emblem.png` instead.
 *
 * Icons land on a SQUARE canvas with the mark centred, because every use renders
 * them into a square box. The sheet's cells are not square, so the old crops were
 * being scaled to 38×38 and squashed on top of being cut.
 */


const INTERFACE_ICONS = {
    "asset-recipient": HandCoins,
    "amount-cadence": CircleGauge,
    "start-expiry": TimerReset,
    "owner-revoke": ShieldCheck,
    request: ReceiptText,
    scope: SlidersHorizontal,
    enforce: BadgeCheck,
    settle: CircleDollarSign,
    proceed: DoorOpen,
} satisfies Record<string, LucideIcon>;

export type InterfaceIconName = keyof typeof INTERFACE_ICONS;

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
            // The crest stays Korean in every locale — the object is named 마패 — so the
            // alt carries its own language tag instead of inheriting <html lang>.
            alt="마패"
            lang="ko"
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
 * Product UI icons use one vector system rather than the supplied concept
 * sheet. Several tiny sheet cells have artwork cut off inside the source PNG,
 * which CSS padding cannot recover. These marks stay crisp and fully visible at
 * every responsive size while the horse emblem remains the brand signature.
 */
export function InterfaceIcon({
    name,
    size = 28,
    className,
}: {
    name: InterfaceIconName;
    size?: number;
    className?: string;
}) {
    const Icon = INTERFACE_ICONS[name];

    return (
        <Icon
            width={size}
            height={size}
            className={className}
            aria-hidden="true"
            focusable="false"
            strokeWidth={1.7}
            absoluteStrokeWidth
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

