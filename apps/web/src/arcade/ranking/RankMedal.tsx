import type {Locale} from '../../lib/i18n';
import {medalName, placeLabel} from './format';

/**
 * A place as a coin: gold, silver or bronze for 1–3, an embossed number chip after that. The numeral is always drawn and the
 * accessible name always says the place, so the colour never carries the rank alone.
 */
export function RankMedal({rank, locale, size = 'md', decorative = false}: {rank: number; locale: Locale; size?: 'sm' | 'md' | 'lg'; decorative?: boolean}) {
    const medal = medalName(rank, locale), label = medal ? `${placeLabel(rank, locale)} · ${medal}` : placeLabel(rank, locale);
    const a11y = decorative ? {'aria-hidden': true as const} : {role: 'img', 'aria-label': label};
    return <span className={`rank-medal is-${size} ${medal ? `is-place-${rank}` : 'is-plain'}`} {...a11y}><b>{rank}</b></span>;
}
