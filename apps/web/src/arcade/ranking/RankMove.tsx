import type {RankingMove, RankingPeriod} from '@mapae/arcade/ranking';
import type {Locale} from '../../lib/i18n';
import {rankShift, shiftCopy} from './format';

/**
 * A place's movement since the board one window earlier: ▲ jade, ▼ vermilion, a muted dash, or a NEW pill. The mark is text
 * and the accessible name is a full sentence, so neither colour nor arrow carries it alone. Nothing when there is no comparison.
 */
export function RankMove({rank, move, period, locale}: {rank: number; move: RankingMove; period: RankingPeriod; locale: Locale}) {
    const shift = rankShift(rank, move);
    if (!shift) return null;
    const {mark, label} = shiftCopy(shift, period, locale);
    return <span className={`rank-move is-${shift.kind}`} title={label}><span aria-hidden="true">{mark}</span><span className="sr-only">{label}</span></span>;
}
