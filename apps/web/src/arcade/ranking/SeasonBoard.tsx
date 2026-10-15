import {CircleAlert, Coffee, LoaderCircle, RefreshCw} from 'lucide-react';
import {guardianName} from '@mapae/arcade/guardians';
import {BOARD_ROWS, type RankingStandings} from '@mapae/arcade/ranking';
import {SEASON, SEASON_MAX_DAY_POINTS, SEASON_STREAK_BONUS, SEASON_STREAK_DAYS, seasonPeriod, type SeasonStatus} from '@mapae/arcade/season';
import type {Locale} from '../../lib/i18n';
import {GuardianAvatar} from '../GuardianAvatar';
import type {GuardianDesk} from '../nft/useGuardianDesk';
import {DeskGate} from '../sections/SectionFrame';
import {Board, BoardChips} from './Board';
import {useRankingBoard, useSeasonStatus} from './client';
import {FullBoard} from './FullBoard';
import {points, seasonPhaseLabel} from './format';
import {RankMove} from './RankMove';

/**
 * The season tab: before the season opens, its rules and prizes; from the first day, the season board (total points, shared
 * places, days and runs) and where the owner's guardians stand in it. The seller says which phase today is in, so the page
 * never reads a board that does not exist yet.
 */
export function SeasonBoard({desk, walletWaiting}: {desk: GuardianDesk; walletWaiting: boolean}) {
    const {ko, locale} = desk, status = useSeasonStatus(), phase = status.value?.phase;
    const active = phase === 'open' || phase === 'closed', period = status.value ? seasonPeriod(status.value) : seasonPeriod(SEASON);
    const remote = useRankingBoard('season', period, active), mine = desk.revealed.map(t => t.tokenId);
    return <>
        <section className="nft-panel rank-board" aria-labelledby="rank-board-title" aria-busy={status.loading || remote.loading}>
            <div className="rank-board-head">
                <div><span className="arc-overline">{status.value ? seasonPhaseLabel(status.value, locale) : ko ? '시즌' : 'Season'}</span>
                    <h2 id="rank-board-title">{ko ? `시즌 ${SEASON.id} 순위` : `Season ${SEASON.id} board`}</h2></div>
                {remote.value && <BoardChips board={remote.value} locale={locale} />}
            </div>
            {!status.value ? status.error
                ? <div className="rank-error" role="alert"><CircleAlert size={18} aria-hidden="true" /><p>{ko ? '시즌 정보를 불러오지 못했어요. 잠시 뒤 저절로 다시 읽어 와요.' : 'The season could not load. It will try again shortly.'}</p></div>
                : <Loading ko={ko} />
                : !active ? <SeasonIntro status={status.value} locale={locale} />
                : remote.value ? <><Board board={remote.value} mine={new Set(mine)} locale={locale} />
                    <FullBoard key={period} board={remote.value} mine={mine} mineBelow={placesBelow(desk.ranking.standings)} locale={locale} />
                    <details className="rank-season-more"><summary>{ko ? '시즌 규칙과 상품' : 'Season rules and prizes'}</summary><SeasonIntro status={status.value} locale={locale} /></details></>
                : remote.error ? <div className="rank-error" role="alert"><CircleAlert size={18} aria-hidden="true" /><p>{ko ? '순위표를 불러오지 못했어요. 잠시 뒤 저절로 다시 읽어 와요.' : 'The board could not load. It will try again shortly.'}</p>
                    <button type="button" className="arc-button arc-button-paper" disabled={remote.loading} onClick={remote.retry}><RefreshCw size={16} aria-hidden="true" />{ko ? '지금 다시 불러오기' : 'Retry now'}</button></div>
                : <Loading ko={ko} />}
        </section>
        {active && <DeskGate desk={desk} walletWaiting={walletWaiting} need="guardian"><MySeason desk={desk} period={period} closed={phase === 'closed'} /></DeskGate>}
    </>;
}
const Loading = ({ko}: {ko: boolean}) => <p role="status" className="rank-empty"><LoaderCircle size={16} className="arc-loading-icon" aria-hidden="true" /> {ko ? '순위표를 불러오고 있어요…' : 'Loading the board…'}</p>;
/** Whether one of the owner's guardians places below the top rows of the season board; null before the standings load. */
const placesBelow = (standings: RankingStandings | null) => standings && standings.guardians.some(g => (g.season?.rank ?? 0) > BOARD_ROWS);

/** How season points are earned and what they win: the whole of it in six lines, the same before and during the season. */
export function SeasonIntro({status, locale}: {status: SeasonStatus; locale: Locale}) {
    const ko = locale === 'ko', [first, second, third] = [10, 7, 5];
    const items = ko ? [
        `시즌 점수는 매일 놀이마다 1위 ${first}점, 2위 ${second}점, 3위 ${third}점, 4–${BOARD_ROWS}위 3점, 참가만 해도 1점. 하루 최대 ${SEASON_MAX_DAY_POINTS}점이에요.`,
        `시즌 안에서 출석 도장 ${SEASON_STREAK_DAYS}일을 이어 찍을 때마다 +${SEASON_STREAK_BONUS}점. 쉼표는 평소처럼 빠진 하루를 지켜 줘요.`,
        '시즌 안의 날만 세고, 점수는 자정에 갱신돼요. 순위 옆 ▲▼는 어제와 견줘요.',
        `시즌 상위 3명에게 커피 기프티콘, ${SEASON_STREAK_DAYS}일 연속 출석한 전령 중 추첨으로 한 명 더.`,
        `참가한 전령은 시즌 ${status.id} 한정 문양을 영구히 달고, 상위권은 명예의 전당에 남아요. 문양과 전당은 시즌이 끝난 뒤 열려요.`,
        '테스트넷이라 실제 돈은 오가지 않아요. 상품 전달 방법은 시즌이 끝난 뒤 안내해요.',
    ] : [
        `Season points, per game per day: #1 ${first}, #2 ${second}, #3 ${third}, #4–${BOARD_ROWS} 3, and 1 for taking part — up to ${SEASON_MAX_DAY_POINTS} a day.`,
        `+${SEASON_STREAK_BONUS} for every ${SEASON_STREAK_DAYS}-day attendance run inside the season; rest days cover a missed day as usual.`,
        'Only days inside the season count; points refresh at midnight KST and ▲▼ compare with yesterday.',
        `Coffee gift cards for the top 3, and a raffle among every guardian with a ${SEASON_STREAK_DAYS}-day run.`,
        `Every entrant keeps a permanent Season ${status.id} mark and the top places enter the hall of fame — both open after the season.`,
        'Testnet only — no real money moves. How prizes reach you is announced after the season.',
    ];
    return <ul className="rank-season-intro">{items.map((item, i) => <li key={item}>{i === 3 ? <Coffee size={16} aria-hidden="true" /> : <span className="rank-season-dot" aria-hidden="true" />}<span>{item}</span></li>)}</ul>;
}

/** One line per guardian: season points and place with its movement, today's take (while the season runs), days, run and bonus. */
function MySeason({desk, period, closed}: {desk: GuardianDesk; period: `s${number}`; closed: boolean}) {
    const {ko, locale, revealed, crew, ranking} = desk, standings = ranking.standings;
    return <section className="nft-panel" aria-labelledby="rank-season-mine-title">
        <span className="arc-overline">{ko ? '내 전령의 시즌' : 'My guardians this season'}</span>
        <h2 id="rank-season-mine-title">{ko ? '시즌 점수' : 'Season points'}</h2>
        {!standings ? ranking.error
            ? <div className="rank-error" role="alert"><CircleAlert size={18} aria-hidden="true" /><p>{ko ? '내 전령의 순위를 불러오지 못했어요. 잠시 뒤 저절로 다시 읽어 와요.' : 'Your guardians’ standings could not load. They will try again shortly.'}</p></div>
            : <p role="status"><LoaderCircle size={16} className="arc-loading-icon" aria-hidden="true" /> {ko ? '순위를 확인하고 있어요…' : 'Checking standings…'}</p>
            : <ul className="rank-guardians">
                {revealed.map((token, index) => {
                    const season = standings.guardians.find(g => g.tokenId === token.tokenId)?.season, member = crew[index];
                    return <li key={token.tokenId} className="rank-guardian">
                        <GuardianAvatar appearance={member?.appearance} color={member?.color} portrait />
                        <div><h3>{guardianName(token.tokenId, locale)}</h3>
                            {season ? <p className="rank-line"><b>{points(season.points, locale)}</b><span>{ko ? `${season.rank}위/${season.entrants}` : `#${season.rank} of ${season.entrants}`}
                                <RankMove rank={season.rank} move={season} period={period} locale={locale} /></span></p>
                                : <p className="rank-line"><span>{closed ? ko ? '이번 시즌에는 기록이 없어요' : 'No record this season' : ko ? '아직 시즌 점수가 없어요 · 랭크 도전 한 판이면 1점' : 'No season points yet · one ranked round earns 1'}</span></p>}
                            {season && <small>{[...closed ? [] : [ko ? `오늘 +${season.today}점` : `today +${season.today} ${season.today === 1 ? 'pt' : 'pts'}`],
                                ko ? `${season.days}일 참가 · 연속 ${season.streak}일 · 보너스 +${season.bonus}` : `${season.days} ${season.days === 1 ? 'day' : 'days'} · ${season.streak}-day run · bonus +${season.bonus}`].join(' · ')}</small>}
                        </div>
                    </li>;
                })}
            </ul>}
    </section>;
}
