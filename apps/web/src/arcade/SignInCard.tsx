import {useId} from 'react';
import {ArrowRight, LoaderCircle, ShieldCheck} from 'lucide-react';
import type {Address} from 'viem';
import type {ArcadeSession} from './useArcadeSession';
import {shortAddress} from '../lib/dial';

/** Profile sign-in where the visitor already is: the lobby dock or the guardians tab, never a page of its own. */
export function SignInCard({owner, session, ko}: {owner: Address; session: ArcadeSession; ko: boolean}) {
    const title = useId(), signing = session.status === 'signing', error = session.errorMessage(ko);
    return <section className="arc-signin" aria-labelledby={title}>
        <h2 id={title}>{signing ? <LoaderCircle size={20} className="arc-loading-icon" aria-hidden="true" /> : <ShieldCheck size={20} aria-hidden="true" />}{signing ? ko ? '지갑에서 로그인을 승인해 주세요' : 'Approve sign-in in your wallet' : ko ? '나의 전령단에 로그인' : 'Sign in to your guardians'}</h2>
        <p>{ko ? '지갑 소유자를 확인하면 나의 전령과 모험 기록을 불러와요.' : 'Verify your wallet to load your guardians and their adventures.'}</p>
        <p className="arc-profile-wallet" title={owner}><i aria-hidden="true" />{ko ? '서명할 지갑' : 'Signing wallet'}<span>{shortAddress(owner)}</span></p>
        {!signing && <button type="button" className="arc-button" onClick={() => void (session.status === 'error' ? session.refresh() : session.login())}>{session.status === 'error' ? ko ? '다시 확인' : 'Try again' : ko ? '서명하고 로그인' : 'Sign in with wallet'}<ArrowRight size={19} aria-hidden="true" /></button>}
        {error && <p className="arc-notice" role="alert">{error}</p>}
        <small><ShieldCheck size={16} aria-hidden="true" />{ko ? '로그인 서명은 결제나 지출을 승인하지 않아요.' : 'Signing in does not authorize payments or spending.'}</small>
    </section>;
}
