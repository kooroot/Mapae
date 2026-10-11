import {Check, ExternalLink, RefreshCw} from 'lucide-react';
import {explorerTxUrl} from '../../lib/config';
import {GAME_NAMES} from '../game-names';
import type {GuardianDesk} from '../nft/useGuardianDesk';
import {DeskGate, GuardianSwitcher, NftStatus, SectionHeading} from './SectionFrame';

/** Journal: the chosen guardian's recorded growth and every verified adventure, each recordable on the NFT once. */
export function JournalSection({desk, walletWaiting}: {desk: GuardianDesk; walletWaiting: boolean}) {
    return <div className="nft-arcade">
        <SectionHeading section="journal" desk={desk}><GuardianSwitcher desk={desk} /></SectionHeading>
        <DeskGate desk={desk} walletWaiting={walletWaiting} need="guardian"><NftStatus desk={desk} /><Journal desk={desk} /></DeskGate>
    </div>;
}

function Journal({desk}: {desk: GuardianDesk}) {
    const {ko, locale, giwa, nft, token, member} = desk, names = GAME_NAMES[locale];
    if (!token || !member) return null;
    const detail = nft.detail?.guardian.tokenId === token.tokenId ? nft.detail : null;
    return <section className="nft-growth" aria-labelledby="nft-growth-title">
        <span className="arc-overline">{ko ? '모험이 쌓이는 전령' : 'A GUARDIAN WITH A STORY'}</span>
        <h2 id="nft-growth-title">{member.name}</h2>
        <div className="nft-growth-stats">
            <div><span>{ko ? 'NFT에 기록한 경험치' : 'Experience recorded on NFT'}</span><strong>{token.progress.experience} XP</strong><small>{ko ? '레벨' : 'Level'} {token.progress.level} · {token.progress.victories} {ko ? '승리' : 'victories'}</small></div>
            <div><span>{ko ? '검증된 모험 전체' : 'All verified adventures'}</span>{detail ? <><strong>{detail.earned.experience} XP</strong><small>{ko ? `${detail.earned.plays}회 모험` : `${detail.earned.plays} outings`}{detail.results.some(r => !r.claimed) && (ko ? ' · 아래에서 성장 기록' : ' · Record growth below')}</small></>
                : nft.error && !nft.loading ? <><strong className="nft-stat-missing">{ko ? '불러오지 못했어요' : 'Unavailable'}</strong><button type="button" className="arc-text-button" disabled={nft.loading || nft.busy} onClick={() => void nft.refresh()}><RefreshCw size={16} aria-hidden="true" />{ko ? '다시 불러오기' : 'Retry'}</button></>
                : <strong className="nft-stat-missing" role="status">{ko ? '불러오는 중…' : 'Loading…'}</strong>}</div>
        </div>
        <div className="nft-results">
            {detail?.results.length === 0 && <p>{ko ? '첫 번째 외출을 보내 모험 기록을 시작해 보세요.' : 'Send your first outing to begin this story.'}</p>}
            {detail?.results.map(r => <article key={r.id} className="nft-result"><div><strong>{names[r.game]} · {r.score.toLocaleString()} {ko ? '점' : 'pts'}</strong><p>{r.victory ? (ko ? '목표 달성 · +15 XP' : 'Achievement · +15 XP') : (ko ? '모험 완료 · +10 XP' : 'Completed · +10 XP')}</p><small>{new Date(r.at).toLocaleString(locale)} · {r.outcome.summary[locale]}</small>{r.transaction && <a href={explorerTxUrl(r.transaction)} target="_blank" rel="noreferrer">{ko ? '입장 결제 영수증' : 'Admission receipt'}<ExternalLink size={13} aria-hidden="true" /></a>}</div>
                {r.claimed ? <span className="nft-result-claimed"><Check size={14} aria-hidden="true" />{ko ? 'NFT 기록 완료' : 'Recorded on NFT'}</span> : <button type="button" className="arc-button arc-button-paper" disabled={nft.busy || giwa.busy || !!nft.transaction} onClick={() => void nft.claim(r)}>{ko ? 'NFT에 성장 기록' : 'Record growth on NFT'}</button>}</article>)}
        </div>
        {detail?.nextCursor && <button type="button" className="arc-button arc-button-paper nft-more" onClick={() => void nft.more()}>{ko ? '이전 모험 더 보기' : 'More adventures'}</button>}
        <p className="nft-small">{ko ? '성장 기록에는 테스트 ETH 네트워크 수수료가 필요해요. 실패해도 같은 모험을 다시 기록하며, 입장권을 새로 사지 않아요.' : 'Recording growth uses test ETH for gas. Retry the same result if it fails; no new admission is purchased.'}</p>
    </section>;
}
