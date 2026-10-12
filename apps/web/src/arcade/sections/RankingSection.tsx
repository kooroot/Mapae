import {useEffect, useState} from 'react';
import {Link} from '@tanstack/react-router';
import {CalendarDays, CircleAlert, Compass, Crown, LoaderCircle, Lock, RefreshCw, Timer, Users} from 'lucide-react';
import type {GameId} from '@mapae/arcade';
import {guardianName} from '@mapae/arcade/guardians';
import {
    BOARD_ROWS, DEVOTION_DAYS, GAME_PERIODS, RANKED_ATTEMPTS, RANKED_GAMES, STREAK_FREEZE_EVERY, STREAK_FREEZE_MAX, WEEKLY_COUNTED_DAYS,
    type GamePeriod, type RankingBoard, type RankingBoardId, type RankingRow,
} from '@mapae/arcade/ranking';
import type {Locale} from '../../lib/i18n';
import {GAME_NAMES} from '../game-names';
import {GuardianAvatar} from '../GuardianAvatar';
import {guardianPortrait} from '../nft/model';
import type {GuardianDesk} from '../nft/useGuardianDesk';
import {useRankingBoard} from '../ranking/client';
import {boardScore, countdown, placeLabel, points, resetClock, streakCopy, titlesOnNft} from '../ranking/format';
import {RankMedal} from '../ranking/RankMedal';
import {RankMove} from '../ranking/RankMove';
import {GameThumb} from '../Characters';
import {arcadeSectionLink} from '../sections';
import {RankLine, TitleChips} from '../ranking/RankLine';
import {DeskGate, SectionHeading} from './SectionFrame';

const BOARDS = [...RANKED_GAMES, 'devotion'] as const satisfies readonly RankingBoardId[];
const PERIOD_NAMES: Record<Locale, Record<GamePeriod, string>> = {
    ko: {today: '오늘', week: '이번 주', yesterday: '어제', lastweek: '지난주'},
    en: {today: 'Today', week: 'This week', yesterday: 'Yesterday', lastweek: 'Last week'},
};
const DEVOTION_NAME = {ko: '꾸준함', en: 'Devotion'};
const KST_OFFSET_MINUTES = 9 * 60;

/**
 * Rankings: each game's boards for today, this week, yesterday and last week, the 28-day devotion board, and where the owner's
 * guardians stand with a way to send the next ranked round. The boards are public; only the "my guardians" panel needs a wallet.
 */
export function RankingSection({desk, walletWaiting, onSendOuting}: {desk: GuardianDesk; walletWaiting: boolean; onSendOuting: (game: GameId, tokenId: string) => void}) {
    const {ko, locale} = desk;
    const [board, setBoard] = useState<RankingBoardId>('stamp'), [period, setPeriod] = useState<GamePeriod>('today');
    const remote = useRankingBoard(board, board === 'devotion' ? '28d' : period);
    const mine = new Set(desk.revealed.map(t => t.tokenId));
    return <div className="nft-arcade">
        <SectionHeading section="ranking" desk={desk} />
        <div className="rank-tabs" role="group" aria-label={ko ? '순위표 고르기' : 'Choose a board'}>
            {BOARDS.map(id => <button key={id} type="button" aria-pressed={board === id} onClick={() => setBoard(id)}>
                {id === 'devotion' ? <CalendarDays size={20} aria-hidden="true" /> : <GameThumb game={id} />}<span>{id === 'devotion' ? DEVOTION_NAME[locale] : GAME_NAMES[locale][id]}</span>
            </button>)}
        </div>
        <section className="nft-panel rank-board" aria-labelledby="rank-board-title" aria-busy={remote.loading}>
            <div className="rank-board-head">
                <div><span className="arc-overline">{board === 'devotion' ? (ko ? `최근 ${DEVOTION_DAYS}일` : `Last ${DEVOTION_DAYS} days`) : remote.value ? span(remote.value) : PERIOD_NAMES[locale][period]}</span>
                    <h2 id="rank-board-title">{board === 'devotion' ? (ko ? '랭크 도전에 나온 날' : 'Days with a ranked round') : ko ? `${GAME_NAMES.ko[board]} 순위` : `${GAME_NAMES.en[board]} board`}</h2></div>
                {remote.value && <BoardChips board={remote.value} locale={locale} />}
            </div>
            {board !== 'devotion' && <div className="rank-periods" role="group" aria-label={ko ? '기간 고르기' : 'Choose a period'}>
                {GAME_PERIODS.map(id => <button key={id} type="button" aria-pressed={period === id} onClick={() => setPeriod(id)}>{PERIOD_NAMES[locale][id]}</button>)}
            </div>}
            {remote.value ? <Board board={remote.value} mine={mine} locale={locale} />
                : remote.error ? <div className="rank-error" role="alert"><CircleAlert size={18} aria-hidden="true" /><p>{ko ? '순위표를 불러오지 못했어요. 잠시 뒤 저절로 다시 읽어 와요.' : 'The board could not load. It will try again shortly.'}</p>
                    <button type="button" className="arc-button arc-button-paper" disabled={remote.loading} onClick={remote.retry}><RefreshCw size={16} aria-hidden="true" />{ko ? '지금 다시 불러오기' : 'Retry now'}</button></div>
                : <p role="status" className="rank-empty"><LoaderCircle size={16} className="arc-loading-icon" aria-hidden="true" /> {ko ? '순위표를 불러오고 있어요…' : 'Loading the board…'}</p>}
        </section>
        <DeskGate desk={desk} walletWaiting={walletWaiting} need="guardian"><MyGuardians desk={desk} onSendOuting={onSendOuting} /></DeskGate>
        <Rules locale={locale} />
    </div>;
}

const span = (board: RankingBoard) => board.from === board.to ? board.from : `${board.from} – ${board.to}`;

/** Entrants, and the reset as a ticking chip that turns urgent in the last hour; a closed window reads as final. */
function BoardChips({board, locale}: {board: RankingBoard; locale: Locale}) {
    const ko = locale === 'ko', now = useSecondClock(board.closesAt !== null);
    const [offset, setOffset] = useState(KST_OFFSET_MINUTES);
    // The visitor's clock is read after hydration, so the server and the first client render agree on KST.
    useEffect(() => setOffset(-new Date().getTimezoneOffset()), []);
    const period = board.period === 'week' ? 'week' : 'day';
    const reset = board.closesAt === null ? null : resetClock({now, closesAt: board.closesAt, period, locale});
    return <div className="rank-chips">
        <span className="rank-chip"><Users size={15} aria-hidden="true" />{ko ? `참가 ${board.entrants}` : `${board.entrants} ${board.entrants === 1 ? 'entrant' : 'entrants'}`}</span>
        {reset ? <span className={`rank-chip is-clock${reset.soon ? ' is-soon' : ''}${reset.final ? ' is-final' : ''}`} title={countdown({now, closesAt: board.closesAt!, period, locale, offsetMinutes: offset})}>
            {reset.final ? <i className="rank-pulse" aria-hidden="true" /> : <Timer size={15} aria-hidden="true" />}<span>{reset.label}</span></span>
            : <span className="rank-chip is-closed"><Lock size={14} aria-hidden="true" />{ko ? '마감' : 'Final'}</span>}
    </div>;
}
/** Wall-clock milliseconds, every second while `running`. */
function useSecondClock(running: boolean) {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {if (!running) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t);}, [running]);
    return now;
}

function Board({board, mine, locale}: {board: RankingBoard; mine: ReadonlySet<string>; locale: Locale}) {
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
                    <strong>{guardianName(row.tokenId, locale)}</strong>
                    <span className="rank-score">{boardScore(board.board, row.score, locale)}</span>
                    {i === 0 && lead > 0 && <small className="rank-lead">{ko ? `2위보다 ${boardScore(board.board, lead, locale)} 앞섬` : `${boardScore(board.board, lead, locale)} ahead`}</small>}
                </div>
                <div className="rank-riser" aria-hidden="true" />
            </li>)}
        </ol>
        {rest.length > 0 && <ol className="rank-list" aria-label={ko ? '4위부터' : 'From fourth place'}>
            {rest.map(row => <li key={row.tokenId} className={`rank-row${mine.has(row.tokenId) ? ' is-mine' : ''}`}>
                <span className="rank-place"><RankMedal rank={row.rank} locale={locale} /><Move board={board} row={row} locale={locale} /></span><Portrait row={row} /><span>{guardianName(row.tokenId, locale)}{mine.has(row.tokenId) && <MineTag ko={ko} />}</span><strong>{boardScore(board.board, row.score, locale)}</strong>
            </li>)}
        </ol>}
    </>;
}
const Move = ({board, row, locale}: {board: RankingBoard; row: RankingBoard['rows'][number]; locale: Locale}) =>
    <RankMove rank={row.rank} move={{moves: board.moves, prev: row.prev}} period={board.period} locale={locale} />;
function Portrait({row}: {row: RankingRow}) {
    const {appearance, color} = guardianPortrait(row.seed);
    return <GuardianAvatar appearance={appearance} color={color} portrait />;
}
const MineTag = ({ko}: {ko: boolean}) => <span className="rank-mine-tag">{ko ? '내 전령' : 'Mine'}</span>;

function MyGuardians({desk, onSendOuting}: {desk: GuardianDesk; onSendOuting: (game: GameId, tokenId: string) => void}) {
    const {ko, locale, revealed, crew, ranking, busy} = desk, standings = ranking.standings;
    return <section className="nft-panel" aria-labelledby="rank-mine-title">
        <span className="arc-overline">{ko ? '오늘의 랭크 도전' : 'Today’s ranked rounds'}</span>
        <h2 id="rank-mine-title">{ko ? '내 전령의 자리' : 'Where my guardians stand'}</h2>
        {!standings ? ranking.error
            ? <div className="rank-error" role="alert"><CircleAlert size={18} aria-hidden="true" /><p>{ko ? '내 전령의 순위를 불러오지 못했어요. 잠시 뒤 저절로 다시 읽어 와요.' : 'Your guardians’ standings could not load. They will try again shortly.'}</p></div>
            : <p role="status"><LoaderCircle size={16} className="arc-loading-icon" aria-hidden="true" /> {ko ? '순위를 확인하고 있어요…' : 'Checking standings…'}</p>
            : <ul className="rank-guardians">
                {revealed.map((token, index) => {
                    const standing = standings.guardians.find(g => g.tokenId === token.tokenId);
                    if (!standing) return null;
                    const streak = streakCopy(standing.streak, locale), member = crew[index];
                    const devotion = standing.devotion.rank === null ? (ko ? `최근 ${DEVOTION_DAYS}일 출석 없음` : `No ranked days in the last ${DEVOTION_DAYS}`)
                        : ko ? `최근 ${DEVOTION_DAYS}일 중 ${standing.devotion.days}일 · 꾸준함 ${standing.devotion.rank}위` : `${standing.devotion.days} of the last ${DEVOTION_DAYS} days · devotion #${standing.devotion.rank}`;
                    return <li key={token.tokenId} className="rank-guardian">
                        <GuardianAvatar appearance={member?.appearance} color={member?.color} portrait />
                        <div><h3>{guardianName(token.tokenId, locale)}</h3><p className="rank-line">{streak.title}</p><small>{streak.detail} · {devotion}</small><TitleChips locale={locale} titles={standing.titles} onNft={titlesOnNft(token.honors, standings.week)} /></div>
                        <ul className="rank-games">
                            {RANKED_GAMES.map(game => {
                                const left = RANKED_ATTEMPTS - standing.games[game].attemptsUsed, today = standing.games[game].today;
                                return <li key={game}><RankLine locale={locale} game={game} guardian={standing} leader={standings.leaders[game]} />
                                    {left > 0 && <button type="button" className="arc-text-button" disabled={busy} onClick={() => onSendOuting(game, token.tokenId)}><Compass size={16} aria-hidden="true" />{ko ? '랭크 도전 보내기' : 'Send a ranked round'}</button>}
                                    {today && today.rank > BOARD_ROWS && <Nearby rows={today.nearby} self={token.tokenId} locale={locale} />}
                                </li>;
                            })}
                        </ul>
                    </li>;
                })}
            </ul>}
    </section>;
}

/** The places either side of a guardian outside the top ten: who to catch, and who is close behind. */
function Nearby({rows, self, locale}: {rows: RankingRow[]; self: string; locale: Locale}) {
    const ko = locale === 'ko';
    return <ol className="rank-nearby" aria-label={ko ? '내 앞뒤 순위' : 'Places around mine'}>
        {rows.map(row => <li key={row.tokenId} className={row.tokenId === self ? 'is-mine' : undefined}>
            <b>{placeLabel(row.rank, locale)}</b><span>{guardianName(row.tokenId, locale)}</span><strong>{points(row.score, locale)}</strong>
        </li>)}
    </ol>;
}

function Rules({locale}: {locale: Locale}) {
    const ko = locale === 'ko';
    const items = ko ? [
        `놀이마다 한국 시간 하루 처음 ${RANKED_ATTEMPTS}판이 랭크 도전이에요. 그다음 판도 전령은 자라지만 순위에는 들어가지 않아요.`,
        '랭크 도전의 코스는 전령·날짜·차수마다 정해져 있어서, 다시 굴려 더 좋은 판을 고를 수 없어요.',
        `오늘 순위는 그날 가장 좋은 점수, 주간 순위는 7일 중 가장 좋은 ${WEEKLY_COUNTED_DAYS}일의 점수를 더해요. 이틀은 쉬어도 괜찮아요.`,
        `출석 도장은 랭크 도전을 한 날마다 하나씩 찍혀요. ${STREAK_FREEZE_EVERY}일마다 쉼표가 하나 생겨(최대 ${STREAK_FREEZE_MAX}개) 빠진 하루를 지켜 줘요.`,
        '지난주 1위는 장원, 2–3위는 급제, 4–10위는 입격 칭호를 달아요. 칭호는 꾸밈일 뿐이에요.',
        '지난주 칭호와 최장 출석은 화요일 0시(한국 시간)에 확정되고, 모험 기록에서 NFT에 함께 남겨요.',
        '같은 점수면 먼저 낸 기록이 앞서요. 순위는 한국 시간 자정과 월요일 0시에 새로 시작해요.',
        '순위 옆 ▲▼는 바로 앞 기간보다 오르내린 계단 수예요. 오늘은 어제와, 이번 주는 지난주와, 꾸준함은 어제까지의 28일과 견줘요. NEW는 그 기간에 기록이 없던 전령이고, 놀이 규칙이 바뀐 직후에는 견주지 않아요.',
        '무료 체험과 연습 점수는 들어가지 않아요. 검증된 외출 결과만 올라가요. 테스트 토큰만 써요.',
    ] : [
        `In each game, the first ${RANKED_ATTEMPTS} rounds of a Korean-time day are ranked. Later rounds still grow your guardian but stay off the boards.`,
        'Each ranked course is fixed per guardian, day and attempt, so it cannot be rerolled for a better one.',
        `Today’s board takes the day’s best score; the weekly board adds the best ${WEEKLY_COUNTED_DAYS} of 7 daily bests, so two days off cost nothing.`,
        `Every day with a ranked round stamps your streak. Every ${STREAK_FREEZE_EVERY} days earn a rest day (up to ${STREAK_FREEZE_MAX}) that covers a missed day.`,
        'Last week’s #1 is Champion, #2–3 Podium and #4–10 Top 10. Titles are cosmetic.',
        'Last week’s titles and your longest streak are final at Tuesday 00:00 KST; record them on the NFT from the journal with your outings.',
        'On equal scores the earlier record leads. Boards restart at midnight KST, and weekly ones on Monday 00:00 KST.',
        '▲▼ beside a place count the places gained or lost since the window before: today against yesterday, this week against last week, devotion against the 28 days to yesterday. NEW marks a guardian with no record then; right after a rules change nothing is compared.',
        'Free play and practice scores never count; only verified outing results reach the boards. Test tokens only.',
    ];
    return <details className="rank-rules"><summary>{ko ? '랭킹 규칙' : 'How rankings work'}</summary><ul>{items.map(item => <li key={item}>{item}</li>)}</ul></details>;
}
