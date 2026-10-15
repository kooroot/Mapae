import {useId} from 'react';
import {ZODIAC_NAMES} from '@mapae/arcade/guardian-art';
import type {SeasonMark as Mark} from '@mapae/arcade/hall';
import type {Locale} from '../../lib/i18n';
import './ranking.css';

/** What a mark is called: its accessible name here, its line in the hall and the share card elsewhere. */
export function seasonMarkName(mark: Mark, locale: Locale): string {
    return `${locale === 'ko' ? `시즌 ${mark.season} ` : `Season ${mark.season} `}${seasonMarkShortName(mark, locale)}`;
}
/** The mark without its season, for a line that has already named the season: 시상대 2위 문양 · 참가 문양. */
export function seasonMarkShortName(mark: Mark, locale: Locale): string {
    const ko = locale === 'ko';
    switch (mark.kind) {
    case 'podium': return ko ? `시상대 ${mark.place}위 문양` : `podium #${mark.place}`;
    case 'team': return ko ? `우승 ${ZODIAC_NAMES.ko[mark.zodiac]}팀 표식` : `winning team · ${ZODIAC_NAMES.en[mark.zodiac]}`;
    case 'entrant': return ko ? '참가 문양' : 'entrant mark';
    }
}
/** The marks a line shows, podium first and never more than three; the entrant mark is never the one left out. */
export const shownMarks = (marks: readonly Mark[]): Mark[] => marks.slice(0, 3);

/**
 * A season mark drawn from the design tokens alone: the entrant stamp (a jade ring with four notches around the season number),
 * the winning team's pennant (vermilion on an ink pole) and the podium plaque (a hexagon in the place's medal with its numeral
 * and a ribbon). The numeral and the name always travel with the colour.
 */
export function SeasonMark({mark, locale, size = 18, decorative = false}: {mark: Mark; locale: Locale; size?: number; decorative?: boolean}) {
    const id = useId(), name = seasonMarkName(mark, locale);
    const a11y = decorative ? {'aria-hidden': true as const} : {role: 'img', 'aria-labelledby': `${id}-title`};
    return <svg viewBox="0 0 24 24" width={size} height={size} className={`season-mark is-${mark.kind}${mark.kind === 'podium' ? ` is-place-${mark.place}` : ''}`} focusable="false" {...a11y}>
        {!decorative && <title id={`${id}-title`}>{name}</title>}
        <SeasonMarkGlyph mark={mark} id={id} />
    </svg>;
}
/** The mark's shapes alone, for an `<svg>` of this component's or of a portrait's making. */
export function SeasonMarkGlyph({mark, id}: {mark: Mark; id: string}) {
    switch (mark.kind) {
    case 'entrant': return <g className="season-mark-glyph is-entrant">
        <circle cx="12" cy="12" r="9" fill="none" stroke="var(--jade)" strokeWidth="1.5" />
        <path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3" stroke="var(--jade)" strokeWidth="1.5" strokeLinecap="round" />
        <text x="12" y="12.5" textAnchor="middle" dominantBaseline="central" fill="var(--jade)">{mark.season}</text>
    </g>;
    case 'team': return <g className="season-mark-glyph is-team">
        <rect x="5" y="2" width="2" height="20" rx="1" fill="var(--card-ink)" />
        <polygon points="7,3.5 21,8 7,12.5" fill="var(--vermilion)" />
        <circle cx="11.5" cy="8" r="1.6" fill="#fff" />
    </g>;
    case 'podium': return <g className="season-mark-glyph is-podium">
        <defs><radialGradient id={`${id}-plaque`} cx="35%" cy="30%" r="80%">
            <stop offset="0" className="season-mark-light" /><stop offset="1" className="season-mark-medal" />
        </radialGradient></defs>
        <polygon points="12,2.5 20.2,7.25 20.2,16.75 12,21.5 3.8,16.75 3.8,7.25" fill={`url(#${id}-plaque)`} stroke="var(--medal-rim)" strokeWidth="1.5" strokeLinejoin="round" />
        <polygon points="8.5,18.5 15.5,18.5 14.5,23 12,21.6 9.5,23" fill="var(--ribbon)" />
        <text x="12" y="12.5" textAnchor="middle" dominantBaseline="central" fill="var(--medal-ink)">{mark.place}</text>
    </g>;
    }
}
/** A guardian's marks in a row beside its name, podium first. */
export function SeasonMarks({marks, locale, size = 18}: {marks: readonly Mark[]; locale: Locale; size?: number}) {
    const shown = shownMarks(marks);
    if (!shown.length) return null;
    return <span className="season-marks">{shown.map(mark => <SeasonMark key={mark.kind} mark={mark} locale={locale} size={size} />)}</span>;
}
