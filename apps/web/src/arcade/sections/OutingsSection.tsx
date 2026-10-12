import {useEffect, useRef, useState, type RefObject} from 'react';
import {Link} from '@tanstack/react-router';
import {ArrowRight, Check} from 'lucide-react';
import type {AgentGoal, GameId} from '@mapae/arcade';
import {BrandSelect} from '../../components/BrandSelect';
import {GiwaAllowance} from '../GiwaAllowance';
import {OutingBoard} from '../OutingBoard';
import {GAME_NAMES} from '../game-names';
import {RANKED_ATTEMPTS, RANKED_GAMES} from '@mapae/arcade/ranking';
import {countdown} from '../ranking/format';
import {RankLine} from '../ranking/RankLine';
import type {GuardianDesk} from '../nft/useGuardianDesk';
import {arcadeSectionLink} from '../sections';
import {DeskGate, GuardianSwitcher, SectionHeading} from './SectionFrame';

const GAMES = ['stamp', 'race', 'shop'] as const;

/**
 * Outings: today's ranked rounds, the strategy and allowance to send the chosen guardian with, then every running and recent outing.
 * Running outings and a pending submission stay reachable even when no guardian is ready to plan a new one.
 */
export function OutingsSection({desk, walletWaiting}: {desk: GuardianDesk; walletWaiting: boolean}) {
    const {ko, giwa, nft, member, crew} = desk;
    const read = (tokenId: string) => {if (tokenId !== nft.selected && nft.roster?.guardians.some(t => t.tokenId === tokenId)) void nft.select(tokenId);};
    return <div className="nft-arcade">
        <SectionHeading section="outings" desk={desk}><GuardianSwitcher desk={desk} /></SectionHeading>
        <DeskGate desk={desk} walletWaiting={walletWaiting} need="session">
            <DeskGate desk={desk} walletWaiting={walletWaiting} need="guardian"><Plan desk={desk} /></DeskGate>
            <OutingBoard giwa={giwa} characters={crew} ko={ko} onRead={read} />
            {giwa.submission && !member && <section className="nft-panel"><p>{ko ? '전송했던 외출 요청이 남아 있어요. 새 서명 없이 같은 요청을 확인하세요.' : 'An outing submission is pending. Recover the same request without signing again.'}</p><button type="button" className="arc-button" disabled={giwa.busy} onClick={() => void giwa.recoverSubmission()}>{ko ? '외출 요청 복구' : 'Recover outing submission'}</button></section>}
        </DeskGate>
    </div>;
}

function Plan({desk}: {desk: GuardianDesk}) {
    const {ko, locale, session, giwa, nft, token, member, traits, activeJob, identity} = desk, op = desk.operation, update = desk.setOperation;
    const allowance = useRef<HTMLElement>(null), names = GAME_NAMES[locale], active = !!activeJob;
    if (!member || !token) return null;
    const locked = active || giwa.busy, best = traits ? Math.max(...GAMES.map(g => traits.aptitudes[g])) : 0;
    const aptitude = (g: GameId) => traits ? (ko ? `적성 ${traits.aptitudes[g]}/6` : `Aptitude ${traits.aptitudes[g]}/6`) + (traits.aptitudes[g] === best ? ko ? ' · 가장 잘해요' : ' · Strongest' : '') : undefined;
    return <div className="nft-operations">
        <div className="nft-operations-main">
            <RankedToday desk={desk} locked={locked} allowance={allowance} />
            <section className="nft-panel nft-strategy"><span className="arc-overline">{ko ? '작전' : 'STRATEGY'}</span><h2>{ko ? `${member.name}의 이번 작전` : `${member.name}’s plan`}</h2>
                <div className="nft-controls"><label>{ko ? '이번 목표' : 'Objective'}<BrandSelect<AgentGoal> tone="paper" label={ko ? '이번 목표' : 'Objective'} value={op.goal} disabled={locked} onValueChange={goal => update({goal})} options={[{value: 'explore', label: ko ? '새 경험 쌓기' : 'Explore'}, {value: 'score', label: ko ? '최고 기록 도전' : 'Chase a record'}, {value: 'save', label: ko ? '차분하게 운영' : 'Play carefully'}]} /></label><label>{ko ? '보낼 놀이' : 'Destination'}<BrandSelect<GameId | 'auto'> tone="paper" label={ko ? '보낼 놀이' : 'Destination'} value={op.game} disabled={locked} onValueChange={game => update({game})} options={[{value: 'auto', label: ko ? '전령이 선택' : 'Agent chooses'}, ...GAMES.map(g => ({value: g, label: names[g], description: aptitude(g)}))]} /></label></div>
                {active && <p className="nft-small">{ko ? '외출 중에는 작전을 바꿀 수 없어요.' : 'The plan is fixed while an outing runs.'}</p>}
            </section>
        </div>
        <GiwaAllowance ref={allowance} giwa={giwa} members={identity ? [{...member, nft: identity}] : []} onAmountChange={(_, admissions) => update({admissions})} editable={!nft.busy && !active} authenticated={session.ready} ko={ko} choice={op.game} canLaunch={!nft.busy && !giwa.busy && (!!giwa.submission || giwa.available && !active)} onLaunch={() => void giwa.recoverSubmission()} />
    </div>;
}

/**
 * Today's ranked rounds for the chosen guardian: each game's rank line and a way to aim the plan at it, the reset, and how many
 * rounds of the planned outing will count. Rounds past the daily three still grow the guardian; they just stay off the boards.
 */
function RankedToday({desk, locked, allowance}: {desk: GuardianDesk; locked: boolean; allowance: RefObject<HTMLElement | null>}) {
    const {ko, locale, token, traits, ranking, now, operation: op} = desk, standings = ranking.standings;
    const best = traits ? Math.max(...RANKED_GAMES.map(g => traits.aptitudes[g])) : 0;
    // The visitor's clock is read after hydration, so the server and the first client render agree on KST.
    const [offset, setOffset] = useState(9 * 60);
    useEffect(() => setOffset(-new Date().getTimezoneOffset()), []);
    const standing = standings?.guardians.find(g => g.tokenId === token?.tokenId);
    const left = (game: typeof RANKED_GAMES[number]) => standing ? RANKED_ATTEMPTS - standing.games[game].attemptsUsed : null;
    const planned = op.game === 'auto' ? null : left(op.game);
    const hint = op.game === 'auto'
        ? ko ? '전령이 고른 놀이에 랭크 도전이 남아 있으면 그 판부터 순위에 올라가요.' : 'If the game your guardian picks has ranked tries left, those rounds count first.'
        : planned === null ? null
        : planned === 0 ? ko ? `${GAME_NAMES.ko[op.game]}의 오늘 랭크 도전은 끝났어요. 이번 외출은 전령의 성장에만 쌓여요.` : `Today’s ${GAME_NAMES.en[op.game]} ranked tries are spent; this outing only grows your guardian.`
        : ko ? `이번 외출 ${op.admissions}판 중 ${Math.min(op.admissions, planned)}판이 ${GAME_NAMES.ko[op.game]} 랭크 도전이에요.` : `${Math.min(op.admissions, planned)} of this outing’s ${op.admissions} ${op.admissions === 1 ? 'round is' : 'rounds are'} ranked ${GAME_NAMES.en[op.game]} tries.`;
    function aim(game: typeof RANKED_GAMES[number]) {
        desk.setOperation({game});
        allowance.current?.scrollIntoView({block: 'center'});
        allowance.current?.focus({preventScroll: true});
    }
    return <section className="nft-panel nft-daily" aria-labelledby="ranked-today-title">
        <span className="arc-overline">{ko ? '랭크 도전' : 'Ranked'}{standings && ` · ${standings.day}`}</span>
        <h2 id="ranked-today-title">{ko ? '오늘의 랭크 도전' : 'Today’s ranked rounds'}</h2>
        <p>{ko ? `놀이마다 하루 처음 ${RANKED_ATTEMPTS}판이 순위에 올라가요.` : `The first ${RANKED_ATTEMPTS} rounds of each game a day go on the boards.`}{standings && ` ${countdown({now, closesAt: standings.closesAt.day, period: 'day', locale, offsetMinutes: offset})}`}</p>
        {standing ? <ul className="rank-games">{RANKED_GAMES.map(game => <li key={game}>
            <RankLine locale={locale} game={game} guardian={standing} leader={standings!.leaders[game]} aptitude={traits ? {value: traits.aptitudes[game], best: traits.aptitudes[game] === best} : undefined} weekly />
            {(left(game) ?? 0) > 0 && <button type="button" className="arc-text-button" disabled={locked} aria-pressed={op.game === game} onClick={() => aim(game)}>{op.game === game && <Check size={16} aria-hidden="true" />}{ko ? '이 놀이로 준비' : 'Plan this game'}</button>}
        </li>)}</ul> : <p className="nft-small" role="status">{ranking.error ? (ko ? '순위를 불러오지 못했어요. 외출은 그대로 보낼 수 있어요.' : 'Standings could not load. Outings still work as usual.') : (ko ? '순위를 확인하고 있어요…' : 'Checking standings…')}</p>}
        {hint && <p className="nft-small">{hint}</p>}
        <Link className="arc-inline-link" {...arcadeSectionLink('ranking', locale)}>{ko ? '랭킹 보기' : 'See the rankings'}<ArrowRight size={17} aria-hidden="true" /></Link>
    </section>;
}
