import type {Ref} from 'react';
import {guardianName} from '@mapae/arcade/guardians';
import type {SeasonMark} from '@mapae/arcade/hall';
import type {RankingBoard, RankingRow} from '@mapae/arcade/ranking';
import type {Locale} from '../../lib/i18n';
import {GuardianAvatar} from '../GuardianAvatar';
import {guardianPortrait} from '../nft/model';
import {boardScore} from './format';
import {RankMedal} from './RankMedal';
import {RankMove} from './RankMove';
import {SeasonMarks} from './SeasonMark';

/** What a row needs of the board it sits on, whether the top rows or a page of the whole board. */
export type RowBoard = Pick<RankingBoard, 'board' | 'period' | 'moves'>;

/** The season marks a row's guardian wears, from the sealed hall; nothing before it seals. */
export type MarksOf = (row: RankingRow) => SeasonMark[];
/**
 * One place below the podium: medal and movement, portrait, name (with its season marks once there are any) and score. Mine
 * adds the jade bar and tag; `focused` adds the podium's jade ring and takes keyboard focus when a jump lands on it.
 */
export function BoardRow({board, row, mine, focused = false, locale, marksOf, ref}: {
    board: RowBoard; row: RankingBoard['rows'][number]; mine: boolean; focused?: boolean; locale: Locale; marksOf?: MarksOf; ref?: Ref<HTMLLIElement>;
}) {
    return <li ref={ref} tabIndex={focused ? -1 : undefined} className={`rank-row${mine ? ' is-mine' : ''}${focused ? ' is-focus' : ''}`}>
        <span className="rank-place"><RankMedal rank={row.rank} locale={locale} /><Move board={board} row={row} locale={locale} /></span><Portrait row={row} />
        <span>{guardianName(row.tokenId, locale)}{marksOf && <SeasonMarks marks={marksOf(row)} locale={locale} size={16} />}{mine && <MineTag ko={locale === 'ko'} />}{board.board === 'season' && row.days !== undefined && row.streak !== undefined && <SeasonDays days={row.days} streak={row.streak} locale={locale} />}</span>
        <strong>{boardScore(board.board, row.score, locale)}</strong>
    </li>;
}
/** A season row's second line: days played in the season and the attendance run inside it. */
export const SeasonDays = ({days, streak, locale}: {days: number; streak: number; locale: Locale}) =>
    <small className="rank-season-days">{locale === 'ko' ? `${days}일 참가 · 연속 ${streak}일` : `${days} ${days === 1 ? 'day' : 'days'} · ${streak}-day run`}</small>;
export const Move = ({board, row, locale}: {board: RowBoard; row: RankingBoard['rows'][number]; locale: Locale}) =>
    <RankMove rank={row.rank} move={{moves: board.moves, prev: row.prev}} period={board.period} locale={locale} />;
export function Portrait({row}: {row: RankingRow}) {
    const {appearance, color} = guardianPortrait(row.seed);
    return <GuardianAvatar appearance={appearance} color={color} portrait />;
}
export const MineTag = ({ko}: {ko: boolean}) => <span className="rank-mine-tag">{ko ? '내 전령' : 'Mine'}</span>;
