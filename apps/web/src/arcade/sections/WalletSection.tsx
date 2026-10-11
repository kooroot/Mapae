import {useId} from 'react';
import {ExternalLink, LoaderCircle, LogOut} from 'lucide-react';
import {MOCK_USDC} from '@mapae/shared';
import {appUrl, explorerAddressUrl} from '../../lib/config';
import {shortAddress} from '../../lib/dial';
import {localizeUrl} from '../../lib/i18n';
import {ArcadeRevocations} from '../ArcadeRevocations';
import type {GuardianDesk} from '../nft/useGuardianDesk';
import {DeskGate, SectionHeading} from './SectionFrame';

/** Wallet & approvals: who is connected, the smart account that pays for outings, every signed permission, and the way out. */
export function WalletSection({desk, walletWaiting, blocked, onDisconnect}: {desk: GuardianDesk; walletWaiting: boolean; blocked: boolean; onDisconnect: () => void}) {
    return <div className="nft-arcade">
        <SectionHeading section="wallet" desk={desk} />
        <DeskGate desk={desk} walletWaiting={walletWaiting} need="owner"><Wallet desk={desk} blocked={blocked} onDisconnect={onDisconnect} /></DeskGate>
    </div>;
}

function Wallet({desk, blocked, onDisconnect}: {desk: GuardianDesk; blocked: boolean; onDisconnect: () => void}) {
    const {ko, locale, giwa, owner, disconnecting} = desk, hint = useId();
    if (!owner) return null;
    const address = (value: string) => <a className="arc-inline-link arc-wallet-address" href={explorerAddressUrl(value)} target="_blank" rel="noreferrer" title={value}>{shortAddress(value)}<ExternalLink size={14} aria-hidden="true" /></a>;
    return <>
        <section className="arc-queue-panel arc-wallet-account" aria-labelledby="arc-wallet-title">
            <h2 id="arc-wallet-title">{ko ? '연결한 지갑' : 'Connected wallet'}</h2>
            <dl>
                <div><dt>{ko ? '소유자 지갑' : 'Owner wallet'}</dt><dd>{address(owner)}{giwa.walletName && <small>{giwa.walletName}</small>}</dd></div>
                <div><dt>{ko ? '외출 결제용 스마트 계정' : 'Outing smart account'}</dt><dd>{giwa.payer ? address(giwa.payer) : <small>{ko ? '로그인하면 확인할 수 있어요' : 'Shown after you sign in'}</small>}</dd></div>
                <div><dt>{ko ? '스마트 계정 잔액' : 'Smart-account balance'}</dt><dd><strong>{giwa.balance ?? '—'} {MOCK_USDC.symbol}</strong><a className="arc-inline-link" href={localizeUrl(appUrl, locale)}>{ko ? '테스트 토큰 충전' : 'Get test tokens'}<ExternalLink size={14} aria-hidden="true" /></a></dd></div>
            </dl>
            <div>
                <button type="button" className="arc-button arc-button-paper" aria-describedby={blocked && !disconnecting ? hint : undefined} disabled={disconnecting || blocked} onClick={onDisconnect}>{disconnecting ? <LoaderCircle size={18} className="arc-loading-icon" aria-hidden="true" /> : <LogOut size={18} aria-hidden="true" />}{disconnecting ? (ko ? '연결 해제 중…' : 'Disconnecting…') : (ko ? '연결 해제' : 'Disconnect')}</button>
                {blocked && !disconnecting && <p id={hint}>{ko ? '진행 중인 작업이 끝나면 연결을 해제할 수 있어요' : 'You can disconnect once the current task finishes'}</p>}
            </div>
        </section>
        <ArcadeRevocations grants={giwa.grants} ko={ko} onRevoked={giwa.revoked} />
    </>;
}
