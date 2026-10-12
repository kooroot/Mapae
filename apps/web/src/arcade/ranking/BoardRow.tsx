import type {Ref} from 'react';
import {guardianName} from '@mapae/arcade/guardians';
import type {RankingBoard, RankingRow} from '@mapae/arcade/ranking';
import type {Locale} from '../../lib/i18n';
import {GuardianAvatar} from '../GuardianAvatar';
import {guardianPortrait} from '../nft/model';
import {boardScore} from './format';
import {RankMedal} from './RankMedal';
import {RankMove} from './RankMove';

/** What a row needs of the board it sits on, whether the top rows or a page of the whole board. */
export type RowBoard = Pick<RankingBoard, 'board' | 'period' | 'moves'>;

/**
 * One place below the podium: medal and movement, portrait, name and score. Mine adds the jade bar and tag; `focused` adds the
 * podium's jade ring and takes keyboard focus when a jump lands on it.
 */
export function BoardRow({board, row, mine, focused = false, locale, ref}: {
    board: RowBoard; row: RankingBoard['rows'][number]; mine: boolean; focused?: boolean; locale: Locale; ref?: Ref<HTMLLIElement>;
}) {
    return <li ref={ref} tabIndex={focused ? -1 : undefined} className={`rank-row${mine ? ' is-mine' : ''}${focused ? ' is-focus' : ''}`}>
        <span className="rank-place"><RankMedal rank={row.rank} locale={locale} /><Move board={board} row={row} locale={locale} /></span><Portrait row={row} />
        <span>{guardianName(row.tokenId, locale)}{mine && <MineTag ko={locale === 'ko'} />}</span><strong>{boardScore(board.board, row.score, locale)}</strong>
    </li>;
}
export const Move = ({board, row, locale}: {board: RowBoard; row: RankingBoard['rows'][number]; locale: Locale}) =>
    <RankMove rank={row.rank} move={{moves: board.moves, prev: row.prev}} period={board.period} locale={locale} />;
export function Portrait({row}: {row: RankingRow}) {
    const {appearance, color} = guardianPortrait(row.seed);
    return <GuardianAvatar appearance={appearance} color={color} portrait />;
}
export const MineTag = ({ko}: {ko: boolean}) => <span className="rank-mine-tag">{ko ? '내 전령' : 'Mine'}</span>;
