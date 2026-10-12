import {useEffect, useId, useRef, useState} from 'react';
import {ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleAlert, Crosshair, LoaderCircle, RefreshCw} from 'lucide-react';
import {BOARD_ROWS, RANKING_PAGE_ROWS, type RankingBoard} from '@mapae/arcade/ranking';
import type {Locale} from '../../lib/i18n';
import {BoardRow} from './BoardRow';
import {useRankingPage, type RankingPageAt} from './client';

/**
 * The whole board below its top rows, fifty places a page. Pages step back and forth rather than append: a jump to my guardian
 * lands on any page, and an appended list would either leave a gap above it or load every page before it. `mine` are the
 * owner's revealed guardians; `mineBelow` says whether one of them places below the top rows, null when the standings do not say
 * (yesterday, last week, or before they load), which still offers the jump. Mount it keyed by board and period so it starts closed.
 */
export function FullBoard({board, mine, mineBelow, locale}: {board: RankingBoard; mine: readonly string[]; mineBelow: boolean | null; locale: Locale}) {
    const ko = locale === 'ko', id = useId();
    const [at, setAt] = useState<RankingPageAt | null>(null);
    const page = useRankingPage(board.board, board.period, at), value = page.value, entrants = value?.entrants ?? board.entrants;
    const focus = value && at && 'around' in at ? value.focus : null;
    // Where focus goes once the asked page is shown: its heading after paging, the found row after a jump.
    const landing = useRef<'heading' | 'row' | null>(null), heading = useRef<HTMLHeadingElement>(null), found = useRef<HTMLLIElement>(null);
    const land = () => {
        const target = landing.current === 'row' && found.current ? found.current : heading.current;
        if (!landing.current || !target) return;
        landing.current = null;
        target.scrollIntoView({block: target === found.current ? 'center' : 'start'});
        target.focus({preventScroll: true});
    };
    // `land` reads only refs, so the render it closed over never goes stale.
    useEffect(() => {if (value) land();}, [value]);
    if (board.entrants <= BOARD_ROWS) return null;
    const open = at !== null;
    const go = (next: RankingPageAt, to: 'heading' | 'row') => {
        landing.current = to;
        // Asking for the page already shown fetches nothing, so land at once.
        if (value && JSON.stringify(next) === JSON.stringify(at)) land(); else setAt(next);
    };
    const jump = mine.length > 0 && mineBelow !== false;
    const range = (from: number) => {
        const to = Math.min(from + RANKING_PAGE_ROWS, entrants);
        return ko ? `${from + 1}–${to}위` : `#${from + 1}–${to}`;
    };
    return <div className="rank-full">
        <div className="rank-full-actions">
            <button type="button" className="arc-button arc-button-paper" aria-expanded={open} aria-controls={id} onClick={() => setAt(open ? null : {offset: BOARD_ROWS})}>
                {open ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
                {open ? (ko ? '전체 순위 접기' : 'Hide the full board') : ko ? `전체 순위 보기 (참가 ${board.entrants})` : `See the full board (${board.entrants} entrants)`}
            </button>
            {jump && <button type="button" className="arc-button arc-button-paper is-jump" aria-controls={id} onClick={() => go({around: mine}, 'row')}>
                <Crosshair size={18} aria-hidden="true" />{ko ? '내 전령 위치로' : 'Go to my guardian'}
            </button>}
        </div>
        {open && <section id={id} className="rank-full-page" aria-labelledby={`${id}-title`} aria-busy={page.loading}>
            <h3 id={`${id}-title`} ref={heading} tabIndex={-1}>
                {value ? range(value.offset) : ko ? '전체 순위' : 'Full board'}<small>{ko ? ` · 참가 ${entrants}` : ` of ${entrants}`}</small>
            </h3>
            {value && at && 'around' in at && value.focus === null && <p className="rank-full-note" role="status">
                {ko ? `11위 아래에는 내 전령이 없어요. ${range(BOARD_ROWS)}부터 보여 드려요.` : `None of your guardians places below #${BOARD_ROWS} here, so this starts at #${BOARD_ROWS + 1}.`}
            </p>}
            {value ? value.rows.length > 0
                ? <ol className="rank-list" aria-label={range(value.offset)}>
                    {value.rows.map(row => <BoardRow key={row.tokenId} board={value} row={row} mine={mine.includes(row.tokenId)} focused={row.tokenId === focus}
                        ref={row.tokenId === focus ? found : undefined} locale={locale} />)}
                </ol>
                : <p className="rank-full-note" role="status">{ko ? '이 쪽에는 이제 순위가 없어요. 순위표가 새로 시작됐을 수 있어요.' : 'Nothing on this page now; the board may have restarted.'}</p>
            : page.error ? <div className="rank-error" role="alert"><CircleAlert size={18} aria-hidden="true" /><p>{ko ? '이 쪽을 불러오지 못했어요.' : 'This page could not load.'}</p>
                <button type="button" className="arc-button arc-button-paper" disabled={page.loading} onClick={page.retry}><RefreshCw size={16} aria-hidden="true" />{ko ? '다시 불러오기' : 'Retry'}</button></div>
            : <p role="status" className="rank-full-note"><LoaderCircle size={16} className="arc-loading-icon" aria-hidden="true" /> {ko ? '순위를 불러오고 있어요…' : 'Loading places…'}</p>}
            {value && <nav className="rank-full-pager" aria-label={ko ? '전체 순위 쪽' : 'Full board pages'}>
                {value.offset > BOARD_ROWS && <button type="button" className="arc-button arc-button-paper" onClick={() => go({offset: value.offset - RANKING_PAGE_ROWS}, 'heading')}>
                    <ChevronLeft size={18} aria-hidden="true" /><span className="sr-only">{ko ? '이전 쪽 ' : 'Previous page, '}</span>{range(value.offset - RANKING_PAGE_ROWS)}</button>}
                {value.offset + RANKING_PAGE_ROWS < entrants && <button type="button" className="arc-button arc-button-paper is-next" onClick={() => go({offset: value.offset + RANKING_PAGE_ROWS}, 'heading')}>
                    <span className="sr-only">{ko ? '다음 쪽 ' : 'Next page, '}</span>{range(value.offset + RANKING_PAGE_ROWS)}<ChevronRight size={18} aria-hidden="true" /></button>}
            </nav>}
        </section>}
    </div>;
}
