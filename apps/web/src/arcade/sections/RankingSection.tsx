import {useEffect, useState} from 'react';
import {useLocation} from '@tanstack/react-router';
import {CalendarDays, CircleAlert, Compass, Flag, LoaderCircle, RefreshCw} from 'lucide-react';
import type {GameId} from '@mapae/arcade';
import {guardianName} from '@mapae/arcade/guardians';
import {
    BOARD_ROWS, DEVOTION_DAYS, GAME_PERIODS, RANKED_ATTEMPTS, RANKED_GAMES, STREAK_FREEZE_EVERY, STREAK_FREEZE_MAX, WEEKLY_COUNTED_DAYS,
    type GamePeriod, type RankingBoardId, type RankingRow, type RankingStandings,
} from '@mapae/arcade/ranking';
import {SEASON, SEASON_MAX_DAY_POINTS, SEASON_STREAK_BONUS, SEASON_STREAK_DAYS} from '@mapae/arcade/season';
import type {Locale} from '../../lib/i18n';
import {GAME_NAMES} from '../game-names';
import {GuardianAvatar} from '../GuardianAvatar';
import type {GuardianDesk} from '../nft/useGuardianDesk';
import {useRankingBoard} from '../ranking/client';
import {placeLabel, points, streakCopy, titlesOnNft} from '../ranking/format';
import {Board, BoardChips, boardSpan} from '../ranking/Board';
import {FullBoard} from '../ranking/FullBoard';
import {SeasonBoard} from '../ranking/SeasonBoard';
import {GameThumb} from '../Characters';
import {RankLine, TitleChips} from '../ranking/RankLine';
import {DeskGate, SectionHeading} from './SectionFrame';

const BOARDS = ['season', ...RANKED_GAMES, 'devotion'] as const satisfies readonly RankingBoardId[];
type GameBoardId = Exclude<RankingBoardId, 'season'>;
const PERIOD_NAMES: Record<Locale, Record<GamePeriod, string>> = {
    ko: {today: '오늘', week: '이번 주', yesterday: '어제', lastweek: '지난주'},
    en: {today: 'Today', week: 'This week', yesterday: 'Yesterday', lastweek: 'Last week'},
};
const DEVOTION_NAME = {ko: '꾸준함', en: 'Devotion'};
const SEASON_NAME = {ko: `시즌 ${SEASON.id}`, en: `Season ${SEASON.id}`};

/**
 * Rankings: the season race, each game's boards for today, this week, yesterday and last week, the 28-day devotion board, and
 * where the owner's guardians stand with a way to send the next ranked round. The boards are public; only the "my guardians"
 * panels need a wallet. A `#season` hash opens the season tab, read after hydration so the server and client agree on the first paint.
 */
export function RankingSection({desk, walletWaiting, onSendOuting}: {desk: GuardianDesk; walletWaiting: boolean; onSendOuting: (game: GameId, tokenId: string) => void}) {
    const {ko, locale} = desk;
    const [board, setBoard] = useState<RankingBoardId>('stamp'), hash = useLocation({select: location => location.hash});
    useEffect(() => {if (hash === 'season') setBoard('season');}, [hash]);
    return <div className="nft-arcade">
        <SectionHeading section="ranking" desk={desk} />
        <div className="rank-tabs" role="group" aria-label={ko ? '순위표 고르기' : 'Choose a board'}>
            {BOARDS.map(id => <button key={id} type="button" aria-pressed={board === id} onClick={() => setBoard(id)}>
                {id === 'season' ? <Flag size={20} aria-hidden="true" /> : id === 'devotion' ? <CalendarDays size={20} aria-hidden="true" /> : <GameThumb game={id} />}
                <span>{id === 'season' ? SEASON_NAME[locale] : id === 'devotion' ? DEVOTION_NAME[locale] : GAME_NAMES[locale][id]}</span>
            </button>)}
        </div>
        {board === 'season' ? <SeasonBoard desk={desk} walletWaiting={walletWaiting} /> : <>
            <GameBoard key={board} desk={desk} board={board} />
            <DeskGate desk={desk} walletWaiting={walletWaiting} need="guardian"><MyGuardians desk={desk} onSendOuting={onSendOuting} /></DeskGate>
        </>}
        <Rules locale={locale} />
    </div>;
}

/** One game's boards across its four periods, or the devotion board: the top rows, then the whole board on request. */
function GameBoard({desk, board}: {desk: GuardianDesk; board: GameBoardId}) {
    const {ko, locale} = desk, [period, setPeriod] = useState<GamePeriod>('today');
    const boardPeriod = board === 'devotion' ? '28d' : period, remote = useRankingBoard(board, boardPeriod);
    const mine = desk.revealed.map(t => t.tokenId);
    return <section className="nft-panel rank-board" aria-labelledby="rank-board-title" aria-busy={remote.loading}>
        <div className="rank-board-head">
            <div><span className="arc-overline">{board === 'devotion' ? (ko ? `최근 ${DEVOTION_DAYS}일` : `Last ${DEVOTION_DAYS} days`) : remote.value ? boardSpan(remote.value) : PERIOD_NAMES[locale][period]}</span>
                <h2 id="rank-board-title">{board === 'devotion' ? (ko ? '랭크 도전에 나온 날' : 'Days with a ranked round') : ko ? `${GAME_NAMES.ko[board]} 순위` : `${GAME_NAMES.en[board]} board`}</h2></div>
            {remote.value && <BoardChips board={remote.value} locale={locale} />}
        </div>
        {board !== 'devotion' && <div className="rank-periods" role="group" aria-label={ko ? '기간 고르기' : 'Choose a period'}>
            {GAME_PERIODS.map(id => <button key={id} type="button" aria-pressed={period === id} onClick={() => setPeriod(id)}>{PERIOD_NAMES[locale][id]}</button>)}
        </div>}
        {remote.value ? <><Board board={remote.value} mine={new Set(mine)} locale={locale} />
            <FullBoard key={boardPeriod} board={remote.value} mine={mine} mineBelow={placesBelow(desk.ranking.standings, board, period)} locale={locale} /></>
            : remote.error ? <div className="rank-error" role="alert"><CircleAlert size={18} aria-hidden="true" /><p>{ko ? '순위표를 불러오지 못했어요. 잠시 뒤 저절로 다시 읽어 와요.' : 'The board could not load. It will try again shortly.'}</p>
                <button type="button" className="arc-button arc-button-paper" disabled={remote.loading} onClick={remote.retry}><RefreshCw size={16} aria-hidden="true" />{ko ? '지금 다시 불러오기' : 'Retry now'}</button></div>
            : <p role="status" className="rank-empty"><LoaderCircle size={16} className="arc-loading-icon" aria-hidden="true" /> {ko ? '순위표를 불러오고 있어요…' : 'Loading the board…'}</p>}
    </section>;
}

/** Whether one of the owner's guardians places below the top rows; null where the standings do not say (yesterday, last week). */
function placesBelow(standings: RankingStandings | null, board: GameBoardId, period: GamePeriod): boolean | null {
    if (board === 'devotion') return standings && standings.guardians.some(g => (g.devotion.rank ?? 0) > BOARD_ROWS);
    if (!standings || period === 'yesterday' || period === 'lastweek') return null;
    return standings.guardians.some(g => (g.games[board][period]?.rank ?? 0) > BOARD_ROWS);
}

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
                                return <li key={game}><RankLine locale={locale} game={game} guardian={standing} leader={standings.leaders[game]} weekly />
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
        `시즌 점수는 매일 놀이마다 1위 10점, 2위 7점, 3위 5점, 4–${BOARD_ROWS}위 3점, 참가만 해도 1점. 하루 최대 ${SEASON_MAX_DAY_POINTS}점이에요.`,
        `시즌 안에서 출석 도장 ${SEASON_STREAK_DAYS}일을 이어 찍을 때마다 +${SEASON_STREAK_BONUS}점. 쉼표는 평소처럼 빠진 하루를 지켜 줘요.`,
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
        `Season points, per game per day: #1 10, #2 7, #3 5, #4–${BOARD_ROWS} 3, and 1 for taking part — up to ${SEASON_MAX_DAY_POINTS} a day.`,
        `+${SEASON_STREAK_BONUS} for every ${SEASON_STREAK_DAYS}-day attendance run inside the season; rest days cover a missed day as usual.`,
        'Free play and practice scores never count; only verified outing results reach the boards. Test tokens only.',
    ];
    return <details className="rank-rules"><summary>{ko ? '랭킹 규칙' : 'How rankings work'}</summary><ul>{items.map(item => <li key={item}>{item}</li>)}</ul></details>;
}
