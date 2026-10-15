import {useState} from 'react';
import {CircleAlert, LoaderCircle, RefreshCw} from 'lucide-react';
import {guardianName, guardianZodiac} from '@mapae/arcade/guardians';
import {SEASON, seasonPeriod} from '@mapae/arcade/season';
import type {TeamBoard as Teams, TeamRow} from '@mapae/arcade/team';
import type {Locale} from '../../lib/i18n';
import {guardianAsset} from '../guardian';
import {GuardianAvatar} from '../GuardianAvatar';
import type {GuardianDesk} from '../nft/useGuardianDesk';
import {DeskGate} from '../sections/SectionFrame';
import {BoardChips} from './Board';
import {useSeasonStatus, useTeamBoard} from './client';
import {myTeamShare, points, seasonPhaseLabel, teamCheerCopy, teamIntro, teamName, teamRowDetail} from './format';
import {RankMedal} from './RankMedal';

type View = 'week' | 'season';

/**
 * The zodiac team tab: the twelve teams this week (open all year) or this season, ranked by the total their members brought,
 * and where the owner's guardians' teams stand. The season view opens by itself once the season runs; before that it says in
 * plain words what the race will be and leaves the weekly board as the one to watch.
 */
export function TeamBoard({desk, walletWaiting}: {desk: GuardianDesk; walletWaiting: boolean}) {
    const {ko, locale} = desk, status = useSeasonStatus(), phase = status.value?.phase;
    const racing = phase === 'open' || phase === 'closed', seasonId = status.value ? seasonPeriod(status.value) : seasonPeriod(SEASON);
    // Until the season status is known, no view is chosen: showing the week first and switching to the season would swap boards mid-read.
    const [choice, setChoice] = useState<View | null>(null), view: View | null = choice ?? (status.value ? racing ? 'season' : 'week' : status.error ? 'week' : null);
    const week = view === 'week', enabled = week || racing, remote = useTeamBoard(week ? 'week' : seasonId, enabled);
    const mine = new Set(desk.revealed.map(token => guardianZodiac(token.seed)));
    const overline = week ? remote.value ? `${ko ? '이번 주' : 'This week'} ${remote.value.from} – ${remote.value.to}` : ko ? '이번 주' : 'This week'
        : status.value ? seasonPhaseLabel(status.value, locale) : ko ? '시즌' : 'Season';
    return <>
        <section className="nft-panel rank-board" aria-labelledby="rank-board-title" aria-busy={status.loading || remote.loading}>
            <div className="rank-board-head">
                <div><span className="arc-overline">{overline}</span><h2 id="rank-board-title">{ko ? '띠 팀전 순위' : 'Zodiac team board'}</h2></div>
                {enabled && remote.value && <BoardChips entrants={remote.value.entrants} closesAt={remote.value.closesAt} period={week ? 'week' : 'season'} locale={locale} />}
            </div>
            <div className="rank-periods is-two" role="group" aria-label={ko ? '기간 고르기' : 'Choose a period'}>
                <button type="button" aria-pressed={week} onClick={() => setChoice('week')}>{ko ? '이번 주' : 'This week'}</button>
                <button type="button" aria-pressed={view === 'season'} onClick={() => setChoice('season')}>{ko ? `시즌 ${SEASON.id}` : `Season ${SEASON.id}`}</button>
            </div>
            {!week && !status.value ? status.error
                ? <div className="rank-error" role="alert"><CircleAlert size={18} aria-hidden="true" /><p>{ko ? '시즌 정보를 불러오지 못했어요. 잠시 뒤 저절로 다시 읽어 와요.' : 'The season could not load. It will try again shortly.'}</p></div>
                : <Loading ko={ko} />
                : !enabled ? <><p className="rank-team-note">{ko ? `시즌 ${SEASON.id}이 열리면 띠 팀전 시즌 순위가 시작돼요. 그동안은 이번 주 팀 순위를 봐요.` : `The season team race starts when Season ${SEASON.id} opens. Until then, see this week's team board.`}</p>
                    <TeamIntro locale={locale} /></>
                : remote.value ? <><Rows board={remote.value} mine={mine} locale={locale} />
                    <details className="rank-season-more"><summary>{ko ? '팀전 규칙과 우승 표식' : 'Team rules and the winners’ mark'}</summary><TeamIntro locale={locale} /></details></>
                : remote.error ? <div className="rank-error" role="alert"><CircleAlert size={18} aria-hidden="true" /><p>{ko ? '순위표를 불러오지 못했어요. 잠시 뒤 저절로 다시 읽어 와요.' : 'The board could not load. It will try again shortly.'}</p>
                    <button type="button" className="arc-button arc-button-paper" disabled={remote.loading} onClick={remote.retry}><RefreshCw size={16} aria-hidden="true" />{ko ? '지금 다시 불러오기' : 'Retry now'}</button></div>
                : <Loading ko={ko} />}
        </section>
        {enabled && remote.value && remote.value.entrants > 0 && <DeskGate desk={desk} walletWaiting={walletWaiting} need="guardian"><MyTeam desk={desk} board={remote.value} week={week} /></DeskGate>}
    </>;
}
const Loading = ({ko}: {ko: boolean}) => <p role="status" className="rank-empty"><LoaderCircle size={16} className="arc-loading-icon" aria-hidden="true" /> {ko ? '순위표를 불러오고 있어요…' : 'Loading the board…'}</p>;

/** All twelve teams, best total first; a team nobody has played for yet still has its row, so every guardian finds its own. */
function Rows({board, mine, locale}: {board: Teams; mine: ReadonlySet<TeamRow['zodiac']>; locale: Locale}) {
    const ko = locale === 'ko';
    return <>
        {board.entrants === 0 && <p className="rank-team-note">{ko ? '아직 어느 팀도 점수가 없어요. 랭크 도전 한 판이면 우리 팀의 첫 점수예요.' : 'No team has a point yet. One ranked round opens your team’s score.'}</p>}
        <ol className="rank-list rank-teams" aria-label={ko ? '띠 팀 순위' : 'Zodiac teams'}>
            {board.rows.map(row => <li key={row.zodiac} className={`rank-row is-team${mine.has(row.zodiac) ? ' is-mine' : ''}`}>
                <span className="rank-place"><RankMedal rank={row.rank} locale={locale} /></span>
                <img src={guardianAsset(row.zodiac, 256)} alt="" width={40} height={40} loading="lazy" decoding="async" />
                <span>{teamName(row.zodiac, locale)}{mine.has(row.zodiac) && <span className="rank-mine-tag">{ko ? '우리 팀' : 'Our team'}</span>}<small className="rank-season-days">{teamRowDetail(row, locale)}</small></span>
                <strong>{points(row.points, locale)}</strong>
            </li>)}
        </ol>
    </>;
}

/** The race in five lines: who is on a team, what counts, how places are decided, who is a member, and what the winners get. */
function TeamIntro({locale}: {locale: Locale}) {
    return <ul className="rank-season-intro">{teamIntro(locale).map(item => <li key={item}><span className="rank-season-dot" aria-hidden="true" /><span>{item}</span></li>)}</ul>;
}

/** One line per guardian: its team's place and the gap to first, and what the guardian itself brought to the total. */
function MyTeam({desk, board, week}: {desk: GuardianDesk; board: Teams; week: boolean}) {
    const {ko, locale, revealed, crew, ranking} = desk, standings = ranking.standings;
    return <section className="nft-panel" aria-labelledby="rank-team-mine-title">
        <span className="arc-overline">{ko ? '띠 팀전' : 'Zodiac teams'}</span>
        <h2 id="rank-team-mine-title">{ko ? '내 팀' : 'My team'}</h2>
        {!standings ? ranking.error
            ? <div className="rank-error" role="alert"><CircleAlert size={18} aria-hidden="true" /><p>{ko ? '내 전령의 순위를 불러오지 못했어요. 잠시 뒤 저절로 다시 읽어 와요.' : 'Your guardians’ standings could not load. They will try again shortly.'}</p></div>
            : <p role="status"><LoaderCircle size={16} className="arc-loading-icon" aria-hidden="true" /> {ko ? '순위를 확인하고 있어요…' : 'Checking standings…'}</p>
            : <ul className="rank-guardians">
                {revealed.map((token, index) => {
                    const zodiac = guardianZodiac(token.seed), standing = standings.guardians.find(g => g.tokenId === token.tokenId), member = crew[index];
                    const brought = !standing ? 0 : week ? standing.weekPoints : standing.season?.points ?? 0, team = board.rows.find(row => row.zodiac === zodiac)!;
                    return <li key={token.tokenId} className="rank-guardian">
                        <GuardianAvatar appearance={member?.appearance} color={member?.color} portrait />
                        <div><h3>{guardianName(token.tokenId, locale)}</h3>
                            <p className="rank-line"><b>{teamName(zodiac, locale)}</b><span>{teamCheerCopy(board.rows, zodiac, locale)}</span></p>
                            <small>{myTeamShare(brought, team.points, locale)}</small>
                        </div>
                    </li>;
                })}
            </ul>}
    </section>;
}
