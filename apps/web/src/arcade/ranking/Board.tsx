import {useEffect, useState} from 'react';
import {Link} from '@tanstack/react-router';
import {Compass, Crown, Lock, Timer, Users} from 'lucide-react';
import {guardianName} from '@mapae/arcade/guardians';
import type {RankingBoard} from '@mapae/arcade/ranking';
import type {Locale} from '../../lib/i18n';
import {arcadeSectionLink} from '../sections';
import {BoardRow, MineTag, Move, Portrait, type MarksOf} from './BoardRow';
import {boardScore, countdown, resetClock, type ClockPeriod} from './format';
import {RankMedal} from './RankMedal';
import {SeasonMarks} from './SeasonMark';

const KST_OFFSET_MINUTES = 9 * 60;

/** The dates a board covers, as its overline reads them. */
export const boardSpan = (board: RankingBoard) => board.from === board.to ? board.from : `${board.from} – ${board.to}`;
/** How a board's clock reads: the season counts days, a weekly window the week, and any other window the day. */
export const clockPeriod = (board: RankingBoard): ClockPeriod => board.board === 'season' ? 'season' : board.period === 'week' ? 'week' : 'day';

/** Entrants, and the reset as a ticking chip that turns urgent in the last hour; a closed window reads as final. */
export function BoardChips({entrants, closesAt, period, locale}: {entrants: number; closesAt: number | null; period: ClockPeriod; locale: Locale}) {
    const ko = locale === 'ko', now = useSecondClock(closesAt !== null);
    const [offset, setOffset] = useState(KST_OFFSET_MINUTES);
    // The visitor's clock is read after hydration, so the server and the first client render agree on KST.
    useEffect(() => setOffset(-new Date().getTimezoneOffset()), []);
    const reset = closesAt === null ? null : resetClock({now, closesAt, period, locale});
    return <div className="rank-chips">
        <span className="rank-chip"><Users size={15} aria-hidden="true" />{ko ? `참가 ${entrants}` : `${entrants} ${entrants === 1 ? 'entrant' : 'entrants'}`}</span>
        {reset ? <span className={`rank-chip is-clock${reset.soon ? ' is-soon' : ''}${reset.final ? ' is-final' : ''}`} title={countdown({now, closesAt: closesAt!, period, locale, offsetMinutes: offset})}>
            {reset.final ? <i className="rank-pulse" aria-hidden="true" /> : <Timer size={15} aria-hidden="true" />}<span>{reset.label}</span></span>
            : <span className="rank-chip is-closed"><Lock size={14} aria-hidden="true" />{ko ? '마감' : 'Final'}</span>}
    </div>;
}
/** Wall-clock milliseconds, every second while `running`. */
export function useSecondClock(running: boolean) {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {if (!running) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t);}, [running]);
    return now;
}

/**
 * A board's top rows: the podium on risers, then the places below it; an empty open board invites the first ranked round.
 * `marksOf` puts each guardian's season marks beside its name once the season has sealed.
 */
export function Board({board, mine, locale, marksOf}: {board: RankingBoard; mine: ReadonlySet<string>; locale: Locale; marksOf?: MarksOf}) {
    const ko = locale === 'ko';
    if (!board.rows.length) {
        const open = board.closesAt !== null;
        return <div className="rank-empty">
            <ol className="rank-ghost" aria-hidden="true">{[2, 1, 3].map(place => <li key={place} className={`is-place-${place}`}><RankMedal rank={place} locale={locale} size="lg" decorative /></li>)}</ol>
            <p><b>{open ? (ko ? '아직 오른 기록이 없어요' : 'No records yet') : (ko ? '이 기간에는 기록이 없어요' : 'No records in this window')}</b></p>
            {open && <><p>{ko ? '랭크 도전 한 판이면 첫 메달이 내 전령에게 가요.' : 'One ranked round puts the first medal on your guardian.'}</p>
                <Link className="arc-button" {...arcadeSectionLink('outings', locale)}><Compass size={18} aria-hidden="true" />{ko ? '랭크 도전 보내기' : 'Send a ranked round'}</Link></>}
        </div>;
    }
    const podium = board.rows.slice(0, 3), rest = board.rows.slice(3);
    const lead = board.rows[1] && board.rows[0]!.score > board.rows[1].score ? board.rows[0]!.score - board.rows[1].score : 0;
    return <>
        <ol className="rank-podium" aria-label={ko ? '상위 3' : 'Top three'}>
            {podium.map((row, i) => <li key={row.tokenId} className={`rank-step is-pos-${i + 1} is-place-${row.rank}${mine.has(row.tokenId) ? ' is-mine' : ''}`}>
                <div className="rank-card">
                    {mine.has(row.tokenId) && <MineTag ko={ko} />}
                    {row.rank === 1 && <Crown className="rank-crown" size={22} aria-hidden="true" />}
                    <div className="rank-portrait"><Portrait row={row} /><RankMedal rank={row.rank} locale={locale} size="lg" /><Move board={board} row={row} locale={locale} /></div>
                    <strong>{guardianName(row.tokenId, locale)}{marksOf && <SeasonMarks marks={marksOf(row)} locale={locale} size={16} />}</strong>
                    <span className="rank-score">{boardScore(board.board, row.score, locale)}</span>
                    {i === 0 && lead > 0 && <small className="rank-lead">{ko ? `2위보다 ${boardScore(board.board, lead, locale)} 앞섬` : `${boardScore(board.board, lead, locale)} ahead`}</small>}
                </div>
                <div className="rank-riser" aria-hidden="true" />
            </li>)}
        </ol>
        {rest.length > 0 && <ol className="rank-list" aria-label={ko ? '4위부터' : 'From fourth place'}>
            {rest.map(row => <BoardRow key={row.tokenId} board={board} row={row} mine={mine.has(row.tokenId)} locale={locale} marksOf={marksOf} />)}
        </ol>}
    </>;
}
