import {ArrowRight, Gamepad2, LoaderCircle, ShieldCheck} from 'lucide-react';
import type {Address} from 'viem';
import type {useArcadeSession} from './useArcadeSession';
import {GuardianHeader, shortAddress} from './nft/GuardianHeader';

export function SessionAccess({owner, session, ko, disconnecting, onDisconnect, onGuest}: {owner: Address; session: ReturnType<typeof useArcadeSession>; ko: boolean; disconnecting: boolean; onDisconnect: () => void; onGuest?: () => void}) {
    const waiting = session.status === 'loading' || session.status === 'signing';
    return <main className="arcade agent-arcade arc-profile-access">
        <GuardianHeader owner={owner} ko={ko} network="GIWA SEPOLIA" disconnecting={disconnecting} blocked={waiting} onDisconnect={onDisconnect} />
        <section>
        <div className="arc-profile-cloud">{waiting ? <LoaderCircle size={34} className="arc-loading-icon" /> : <ShieldCheck size={34} />}</div>
        <span className="arc-overline">MY MAPAE GUARDIANS</span>
        <h1>{session.status === 'signing' ? ko ? '지갑에서 로그인을 승인해 주세요' : 'Approve sign-in in your wallet' : session.status === 'loading' ? ko ? '로그인 상태를 확인하고 있어요' : 'Checking your session' : ko ? '나의 전령단에 로그인' : 'Sign in to your guardians'}</h1>
        <p>{ko ? '지갑 소유자를 확인한 뒤 보유한 NFT 전령과 모험 기록을 조회해요.' : 'Verify your wallet to view your NFT guardians and their adventures.'}</p>
        <p className="arc-profile-wallet" title={owner}><i aria-hidden="true" />{ko ? '서명할 지갑' : 'Signing wallet'}<span>{shortAddress(owner)}</span></p>
        {!waiting && <button className="arc-button" onClick={() => void (session.status === 'login' ? session.login() : session.refresh())}>{ko ? session.status === 'login' ? '서명하고 로그인' : '다시 확인' : session.status === 'login' ? 'Sign in with wallet' : 'Try again'}<ArrowRight size={19} /></button>}
        {session.errorMessage(ko) && <p className="arc-notice" role="alert">{session.errorMessage(ko)}</p>}
        <small><ShieldCheck size={16} />{ko ? '로그인 서명은 결제나 지출을 승인하지 않아요.' : 'Signing in does not authorize payments or spending.'}</small>
        {onGuest && <div className="arc-profile-guest"><button className="arc-button arc-button-paper" onClick={onGuest}><Gamepad2 size={18} />{ko ? '로그인 없이 무료로 한 판' : 'Play free without signing in'}</button></div>}
    </section></main>;
}
