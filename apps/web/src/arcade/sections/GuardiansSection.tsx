import {Link} from '@tanstack/react-router';
import {Check, Clock, ExternalLink, Pause, RefreshCw} from 'lucide-react';
import {formatEther} from 'viem';
import {GAME_NAMES, type GameId} from '@mapae/arcade';
import {ZODIAC_NAMES} from '@mapae/arcade/guardian-art';
import {guardianName} from '@mapae/arcade/guardians';
import {explorerAddressUrl} from '../../lib/config';
import {GuardianAvatar} from '../GuardianAvatar';
import {nftCompanion, TEMPERAMENT_NAMES} from '../nft/model';
import type {GuardianDesk} from '../nft/useGuardianDesk';
import type {GuardianToken} from '../profile/guardians';
import {SeasonMarks} from '../ranking/SeasonMark';
import {arcadeSectionLink} from '../sections';
import {FaucetHint} from '../FaucetHint';
import {DeskGate, NftStatus, SectionHeading} from './SectionFrame';

const GAMES = ['stamp', 'race', 'shop'] as const;

/** My guardians: the roster and draws, a draw still being revealed, and the chosen guardian's born talents with free practice. */
export function GuardiansSection({desk, walletWaiting, onPractice}: {desk: GuardianDesk; walletWaiting: boolean; onPractice: (token: GuardianToken, game: GameId) => void}) {
    return <div className="nft-arcade">
        <SectionHeading section="guardians" desk={desk} />
        <DeskGate desk={desk} walletWaiting={walletWaiting} need="session"><Guardians desk={desk} onPractice={onPractice} /></DeskGate>
    </div>;
}

function Guardians({desk, onPractice}: {desk: GuardianDesk; onPractice: (token: GuardianToken, game: GameId) => void}) {
    const {ko, locale, giwa, nft, token, member, traits} = desk, names = GAME_NAMES[locale], roster = nft.roster;
    const drawStatus = roster && roster.minted >= 3 ? {icon: <Check size={15} />, label: ko ? '이번 지갑의 뽑기 완료' : 'Wallet draw limit reached'}
        : roster?.pendingTokenId ? {icon: <Clock size={15} />, label: ko ? '진행 중인 뽑기 확인' : 'Draw in progress'}
        : nft.paused ? {icon: <Pause size={15} />, label: ko ? '뽑기 잠시 준비 중' : 'Draws currently paused'} : null;
    return <>
        <NftStatus desk={desk} />
        {!roster ? null : !roster.enabled ? <section className="nft-panel"><h2>{ko ? '전령단이 곧 문을 열어요' : 'Guardians are preparing to arrive'}</h2><p>{ko ? '지금은 무료 게임을 즐길 수 있어요. NFT 뽑기는 준비가 끝나면 열립니다.' : 'Play the free games while NFT draws are being prepared.'}</p><Link className="arc-button" {...arcadeSectionLink('lobby', locale)}>{ko ? '무료 게임 하러 가기' : 'Play the free games'}</Link></section> : <>
            <section className="nft-roster" aria-labelledby="nft-roster-title">
                <div className="nft-section-heading"><div><span className="arc-overline">{ko ? '전령 명부' : 'ROSTER'}</span><h2 id="nft-roster-title">{ko ? '함께할 친구를 골라요' : 'Choose your companion'}</h2></div><div className="nft-section-tools"><span>{ko ? `전령 ${roster.guardians.length}명 · 최대 3명` : `${roster.guardians.length} of 3 guardians`}</span><button type="button" className="arc-text-button" disabled={nft.loading || nft.busy} onClick={() => void nft.refresh()}><RefreshCw size={16} className={nft.loading ? 'arc-loading-icon' : undefined} aria-hidden="true" />{nft.loading ? (ko ? '불러오는 중…' : 'Refreshing…') : (ko ? '새로고침' : 'Refresh')}</button></div></div>
                <div className="nft-roster-grid">
                    {roster.guardians.map(t => {const c = t.revealed ? nftCompanion(t, locale) : null, marks = desk.marksOf(t.tokenId); return <button type="button" key={t.tokenId} className={`nft-token ${t.tokenId === nft.selected ? 'is-selected' : ''}`} aria-pressed={t.tokenId === nft.selected} onClick={() => void nft.select(t.tokenId)}>{c ? <GuardianAvatar appearance={c.appearance} color={c.color} portrait marks={marks} /> : <div className="nft-pending-art" aria-hidden="true">封</div>}<strong>{guardianName(t.tokenId, locale)}<SeasonMarks marks={marks} locale={locale} size={16} /></strong><span>{c?.appearance ? `${ZODIAC_NAMES[locale][c.appearance.zodiac]} · ${ko ? '레벨' : 'Level'} ${t.progress.level} · ${t.progress.plays}${ko ? '회 모험' : ' outings'}` : ko ? '탄생을 기다리는 중' : 'Waiting to reveal'}</span></button>;})}
                    {roster.guardians.length < 3 && <div className="nft-draw"><span className="nft-draw-symbol" aria-hidden="true">✦</span><h3>{ko ? '새 전령 만나기' : 'Meet a new guardian'}</h3><p>{ko ? '외형·성향·적성이 함께 정해져요. 적성의 총합은 모두 같아요.' : 'Appearance, temperament and aptitudes are drawn together. Every aptitude total is equal.'}</p>{drawStatus ? <p className="nft-draw-status" role="status">{drawStatus.icon}{drawStatus.label}</p> : <button type="button" className="arc-button" disabled={nft.busy || giwa.busy || !!nft.transaction} onClick={() => void nft.mint()}>{ko ? '온체인으로 전령 뽑기' : 'Draw a guardian onchain'}</button>}<small>{roster.mintFee ? `${formatEther(BigInt(roster.mintFee))} test ETH + ${ko ? '네트워크 수수료' : 'network fee'}` : '—'}<br />{ko ? `지갑당 평생 3회 · ${roster.minted}/3회 사용` : `3 lifetime draws per wallet · ${roster.minted}/3 used`}</small><FaucetHint locale={locale} compact /></div>}
                    {Array.from({length: Math.max(0, 2 - roster.guardians.length)}, (_, i) => <div key={i} className="nft-slot" aria-hidden="true"><span>{roster.guardians.length + i + 2}</span></div>)}
                </div>
                {roster.collection && <a className="arc-inline-link" href={explorerAddressUrl(roster.collection)} target="_blank" rel="noreferrer">{ko ? 'NFT 계약 확인' : 'View NFT collection'}<ExternalLink size={14} aria-hidden="true" /></a>}
            </section>
            {token && !token.revealed && <section className="nft-panel" role="status"><h2>{ko ? '전령의 탄생을 기다리고 있어요' : 'Your guardian is on the way'}</h2><p>{ko ? `${guardianName(token.tokenId, 'ko')} · 뽑기 요청 ${token.sequence}. 이 요청의 결과는 한 번만 정해져요. 화면을 닫아도 이어서 확인할 수 있어요.` : `${guardianName(token.tokenId, 'en')} · Request ${token.sequence}. This request reveals once. You can close the page and return.`}</p><div className="nft-panel-actions"><button type="button" className="arc-button" disabled={nft.busy} onClick={() => void nft.refresh()}>{ko ? '결과 다시 확인' : 'Check reveal'}</button><button type="button" className="arc-button arc-button-paper" disabled={nft.busy || !!nft.transaction} onClick={() => void nft.recover(token)}>{ko ? '같은 뽑기 결과 복구' : 'Recover this same draw'}</button></div><small>{ko ? '복구는 같은 난수 증명을 다시 전달하며, 새 뽑기가 아니에요. 네트워크 수수료가 필요할 수 있어요.' : 'Recovery submits the same randomness proof. It may require a network fee.'}</small></section>}
            {member && traits && token && <section className="nft-panel nft-talents"><span className="arc-overline">{ko ? '타고난 재능' : 'BORN THIS WAY'}</span><h2>{member.name}</h2><p>{ZODIAC_NAMES[locale][traits.zodiac]} · {TEMPERAMENT_NAMES[locale][traits.temperament]}</p>
                <div className="nft-aptitudes">{GAMES.map(g => <div key={g}><span>{names[g]}</span><meter min={0} max={6} value={traits.aptitudes[g]} aria-label={`${names[g]} ${traits.aptitudes[g]} / 6`} /><b>{traits.aptitudes[g]} / 6</b></div>)}</div>
                <p className="nft-small">{ko ? '외형과 타고난 특성은 바뀌지 않아요. 작전은 외출에서 내가 정해요.' : 'Birth traits stay fixed. You choose the strategy for each outing.'}</p>
                <div className="nft-practice-pick"><h3>{ko ? '무료로 작전 연습' : 'Practice your strategy'}</h3><div className="nft-practice-links">{GAMES.map(g => <button type="button" className="nft-practice-game" key={g} onClick={() => onPractice(token, g)}><strong>{names[g]}</strong><small>{ko ? '적성' : 'Aptitude'} {traits.aptitudes[g]}/6 · {ko ? '무료 연습' : 'Free practice'} →</small></button>)}</div></div>
            </section>}
        </>}
    </>;
}
