import {useEffect, useState} from 'react';
import {CircleAlert, Compass, LoaderCircle} from 'lucide-react';
import type {GameId} from '@mapae/arcade';
import {guardianName} from '@mapae/arcade/guardians';
import {
    DEVOTION_DAYS, GAME_PERIODS, RANKED_ATTEMPTS, RANKED_GAMES, STREAK_FREEZE_EVERY, STREAK_FREEZE_MAX, WEEKLY_COUNTED_DAYS,
    type GamePeriod, type RankingBoard, type RankingBoardId, type RankingRow,
} from '@mapae/arcade/ranking';
import type {Locale} from '../../lib/i18n';
import {GAME_NAMES} from '../game-names';
import {GuardianAvatar} from '../GuardianAvatar';
import {guardianPortrait} from '../nft/model';
import type {GuardianDesk} from '../nft/useGuardianDesk';
import {useRankingBoard} from '../ranking/client';
import {boardScore, countdown, placeLabel, streakCopy} from '../ranking/format';
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
            {BOARDS.map(id => <button key={id} type="button" aria-pressed={board === id} onClick={() => setBoard(id)}>{id === 'devotion' ? DEVOTION_NAME[locale] : GAME_NAMES[locale][id]}</button>)}
        </div>
        {board !== 'devotion' && <div className="rank-periods" role="group" aria-label={ko ? '기간 고르기' : 'Choose a period'}>
            {GAME_PERIODS.map(id => <button key={id} type="button" aria-pressed={period === id} onClick={() => setPeriod(id)}>{PERIOD_NAMES[locale][id]}</button>)}
        </div>}
        <section className="nft-panel" aria-labelledby="rank-board-title" aria-busy={remote.loading}>
            <div className="rank-board-head">
                <div><span className="arc-overline">{board === 'devotion' ? (ko ? `최근 ${DEVOTION_DAYS}일` : `LAST ${DEVOTION_DAYS} DAYS`) : PERIOD_NAMES[locale][period]}</span>
                    <h2 id="rank-board-title">{board === 'devotion' ? (ko ? '랭크 도전에 나온 날' : 'Days with a ranked round') : ko ? `${GAME_NAMES.ko[board]} 순위` : `${GAME_NAMES.en[board]} board`}</h2></div>
                {remote.value && <BoardMeta board={remote.value} desk={desk} />}
            </div>
            {remote.value ? <Board board={remote.value} mine={mine} locale={locale} />
                : remote.error ? <p className="arc-notice nft-notice" role="alert"><CircleAlert size={16} aria-hidden="true" />{ko ? '순위표를 불러오지 못했어요. 잠시 뒤 다시 읽어 와요.' : 'The board could not load. It will try again shortly.'}</p>
                : <p role="status" className="rank-empty"><LoaderCircle size={16} className="arc-loading-icon" aria-hidden="true" /> {ko ? '순위표를 불러오고 있어요…' : 'Loading the board…'}</p>}
        </section>
        <DeskGate desk={desk} walletWaiting={walletWaiting} need="guardian"><MyGuardians desk={desk} onSendOuting={onSendOuting} /></DeskGate>
        <Rules locale={locale} />
    </div>;
}

function BoardMeta({board, desk}: {board: RankingBoard; desk: GuardianDesk}) {
    const {ko, locale, now} = desk;
    // The visitor's clock is read after hydration, so the server and the first client render agree on KST.
    const [offset, setOffset] = useState(KST_OFFSET_MINUTES);
    useEffect(() => setOffset(-new Date().getTimezoneOffset()), []);
    const entrants = ko ? `참가 ${board.entrants}` : `${board.entrants} ${board.entrants === 1 ? 'entrant' : 'entrants'}`;
    const span = board.from === board.to ? board.from : `${board.from} – ${board.to}`;
    const closes = board.closesAt === null ? (ko ? '마감된 기록' : 'Final') : countdown({now, closesAt: board.closesAt, period: board.period === 'week' ? 'week' : 'day', locale, offsetMinutes: offset});
    return <p>{span} · {entrants} · {closes}</p>;
}

function Board({board, mine, locale}: {board: RankingBoard; mine: ReadonlySet<string>; locale: Locale}) {
    const ko = locale === 'ko';
    if (!board.rows.length) {
        const open = board.closesAt !== null;
        return <div className="rank-empty"><p><b>{open ? (ko ? '아직 오른 기록이 없어요' : 'No records yet') : (ko ? '이 기간에는 기록이 없어요' : 'No records in this window')}</b></p>
            {open && <p>{ko ? '랭크 도전 한 판이면 첫 줄에 이름이 올라가요.' : 'One ranked round puts a name on the first line.'}</p>}</div>;
    }
    const podium = board.rows.slice(0, 3), rest = board.rows.slice(3);
    return <>
        <ol className="rank-podium" aria-label={ko ? '상위 3' : 'Top three'}>
            {podium.map((row, i) => <li key={row.tokenId} className={`${['is-first', 'is-second', 'is-third'][i]}${mine.has(row.tokenId) ? ' is-mine' : ''}`}>
                <Portrait row={row} /><b>{placeLabel(row.rank, locale)}</b><strong>{guardianName(row.tokenId, locale)}{mine.has(row.tokenId) && <MineTag ko={ko} />}</strong><span>{boardScore(board.board, row.score, locale)}</span>
            </li>)}
        </ol>
        {rest.length > 0 && <ol className="rank-list" aria-label={ko ? '4위부터' : 'From fourth place'}>
            {rest.map(row => <li key={row.tokenId} className={`rank-row${mine.has(row.tokenId) ? ' is-mine' : ''}`}>
                <b>{placeLabel(row.rank, locale)}</b><Portrait row={row} /><span>{guardianName(row.tokenId, locale)}{mine.has(row.tokenId) && <MineTag ko={ko} />}</span><strong>{boardScore(board.board, row.score, locale)}</strong>
            </li>)}
        </ol>}
    </>;
}
function Portrait({row}: {row: RankingRow}) {
    const {appearance, color} = guardianPortrait(row.seed);
    return <GuardianAvatar appearance={appearance} color={color} portrait />;
}
const MineTag = ({ko}: {ko: boolean}) => <span className="rank-mine-tag">{ko ? '내 전령' : 'Mine'}</span>;

function MyGuardians({desk, onSendOuting}: {desk: GuardianDesk; onSendOuting: (game: GameId, tokenId: string) => void}) {
    const {ko, locale, revealed, crew, ranking, busy} = desk, standings = ranking.standings;
    return <section className="nft-panel" aria-labelledby="rank-mine-title">
        <span className="arc-overline">{ko ? '오늘의 랭크 도전' : 'TODAY’S RANKED ROUNDS'}</span>
        <h2 id="rank-mine-title">{ko ? '내 전령의 자리' : 'Where my guardians stand'}</h2>
        {!standings ? ranking.error
            ? <p className="arc-notice nft-notice" role="alert"><CircleAlert size={16} aria-hidden="true" />{ko ? '내 전령의 순위를 불러오지 못했어요.' : 'Your guardians’ standings could not load.'}</p>
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
                        <div><h3>{guardianName(token.tokenId, locale)}</h3><p className="rank-line">{streak.title}</p><small>{streak.detail} · {devotion}</small><TitleChips locale={locale} titles={standing.titles} /></div>
                        <div className="rank-guardian-games">
                            {RANKED_GAMES.map(game => {
                                const left = RANKED_ATTEMPTS - standing.games[game].attemptsUsed;
                                return <div key={game}><RankLine locale={locale} game={game} guardian={standing} leader={standings.leaders[game]} />
                                    {left > 0 && <button type="button" className="arc-text-button" disabled={busy} onClick={() => onSendOuting(game, token.tokenId)}><Compass size={16} aria-hidden="true" />{ko ? '랭크 도전 보내기' : 'Send a ranked round'}</button>}
                                </div>;
                            })}
                        </div>
                    </li>;
                })}
            </ul>}
    </section>;
}

function Rules({locale}: {locale: Locale}) {
    const ko = locale === 'ko';
    const items = ko ? [
        `놀이마다 한국 시간 하루 처음 ${RANKED_ATTEMPTS}판이 랭크 도전이에요. 그다음 판도 전령은 자라지만 순위에는 들어가지 않아요.`,
        '랭크 도전의 코스는 전령·날짜·차수마다 정해져 있어서, 다시 굴려 더 좋은 판을 고를 수 없어요.',
        `오늘 순위는 그날 가장 좋은 점수, 주간 순위는 7일 중 가장 좋은 ${WEEKLY_COUNTED_DAYS}일의 점수를 더해요. 이틀은 쉬어도 괜찮아요.`,
        `출석 도장은 랭크 도전을 한 날마다 하나씩 찍혀요. ${STREAK_FREEZE_EVERY}일마다 쉼표가 하나 생겨(최대 ${STREAK_FREEZE_MAX}개) 빠진 하루를 지켜 줘요.`,
        '지난주 1위는 장원, 2–3위는 급제, 4–10위는 입격 칭호를 달아요. 칭호는 꾸밈일 뿐이에요.',
        '같은 점수면 먼저 낸 기록이 앞서요. 순위는 한국 시간 자정과 월요일 0시에 새로 시작해요.',
    ] : [
        `In each game, the first ${RANKED_ATTEMPTS} rounds of a Korean-time day are ranked. Later rounds still grow your guardian but stay off the boards.`,
        'Each ranked course is fixed per guardian, day and attempt, so it cannot be rerolled for a better one.',
        `Today’s board takes the day’s best score; the weekly board adds the best ${WEEKLY_COUNTED_DAYS} of 7 daily bests, so two days off cost nothing.`,
        `Every day with a ranked round stamps your streak. Every ${STREAK_FREEZE_EVERY} days earn a rest day (up to ${STREAK_FREEZE_MAX}) that covers a missed day.`,
        'Last week’s #1 is Champion, #2–3 Podium and #4–10 Top 10. Titles are cosmetic.',
        'On equal scores the earlier record leads. Boards restart at midnight KST, and weekly ones on Monday 00:00 KST.',
    ];
    return <details className="rank-rules"><summary>{ko ? '랭킹 규칙' : 'How rankings work'}</summary><ul>{items.map(item => <li key={item}>{item}</li>)}</ul></details>;
}
