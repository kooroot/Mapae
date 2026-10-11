import {useRef} from 'react';
import type {AgentGoal, GameId} from '@mapae/arcade';
import {BrandSelect} from '../../components/BrandSelect';
import {GiwaAllowance} from '../GiwaAllowance';
import {OutingBoard} from '../OutingBoard';
import {GAME_NAMES} from '../game-names';
import {dailyObjective} from '../nft/model';
import type {GuardianDesk} from '../nft/useGuardianDesk';
import {DeskGate, GuardianSwitcher, SectionHeading} from './SectionFrame';

const GAMES = ['stamp', 'race', 'shop'] as const;

/**
 * Outings: today's objective, the strategy and allowance to send the chosen guardian with, then every running and recent outing.
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
    const {ko, locale, session, giwa, nft, token, member, activeJob, now, identity} = desk, op = desk.operation, update = desk.setOperation;
    const allowance = useRef<HTMLElement>(null), names = GAME_NAMES[locale], active = !!activeJob;
    if (!member || !token) return null;
    const detail = nft.detail?.guardian.tokenId === token.tokenId ? nft.detail : null;
    const objective = dailyObjective(detail?.results ?? [], now), locked = active || giwa.busy;
    return <div className="nft-operations">
        <div className="nft-operations-main">
            <section className="nft-panel nft-daily"><div><span className="arc-overline">{objective.day} · DAILY</span><h2>{objective.completed ? (ko ? '오늘의 외출 완료!' : 'Today’s outing complete!') : (ko ? `오늘은 ${names[objective.game]}에 도전해요` : `Today, try ${names[objective.game]}`)}</h2><p>{ko ? '한국 시간 자정에 새 놀이가 열려요. 전령의 강점과 다른 작전도 시험해 보세요.' : 'A new destination each midnight in Korea. Try another strategy with your guardian.'}</p></div><button type="button" className="arc-button" disabled={locked} onClick={() => {update({game: objective.game}); allowance.current?.scrollIntoView({block: 'center'}); allowance.current?.focus({preventScroll: true});}}>{ko ? '오늘의 작전 준비' : 'Prepare today’s outing'}</button></section>
            <section className="nft-panel nft-strategy"><span className="arc-overline">{ko ? '작전' : 'STRATEGY'}</span><h2>{ko ? `${member.name}의 이번 작전` : `${member.name}’s plan`}</h2>
                <div className="nft-controls"><label>{ko ? '이번 목표' : 'Objective'}<BrandSelect<AgentGoal> tone="paper" label={ko ? '이번 목표' : 'Objective'} value={op.goal} disabled={locked} onValueChange={goal => update({goal})} options={[{value: 'explore', label: ko ? '새 경험 쌓기' : 'Explore'}, {value: 'score', label: ko ? '최고 기록 도전' : 'Chase a record'}, {value: 'save', label: ko ? '차분하게 운영' : 'Play carefully'}]} /></label><label>{ko ? '보낼 놀이' : 'Destination'}<BrandSelect<GameId | 'auto'> tone="paper" label={ko ? '보낼 놀이' : 'Destination'} value={op.game} disabled={locked} onValueChange={game => update({game})} options={[{value: 'auto', label: ko ? '전령이 선택' : 'Agent chooses'}, ...GAMES.map(g => ({value: g, label: names[g]}))]} /></label></div>
                <p className="nft-small">{active ? (ko ? '외출 중에는 작전을 바꿀 수 없어요.' : 'The plan is fixed while an outing runs.') : (ko ? '타고난 적성은 나의 전령단에서 볼 수 있어요.' : 'Born aptitudes are listed under My guardians.')}</p>
            </section>
        </div>
        <GiwaAllowance ref={allowance} giwa={giwa} members={identity ? [{...member, nft: identity}] : []} onAmountChange={(_, admissions) => update({admissions})} editable={!nft.busy && !active} authenticated={session.ready} ko={ko} choice={op.game} canLaunch={!nft.busy && !giwa.busy && (!!giwa.submission || giwa.available && !active)} onLaunch={() => void giwa.recoverSubmission()} />
    </div>;
}
