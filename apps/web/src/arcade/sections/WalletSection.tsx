import {ExternalLink} from 'lucide-react';
import {MOCK_USDC} from '@mapae/shared';
import {appUrl, explorerAddressUrl} from '../../lib/config';
import {shortAddress} from '../../lib/dial';
import {localizeUrl} from '../../lib/i18n';
import {ArcadeRevocations} from '../ArcadeRevocations';
import type {GuardianDesk} from '../nft/useGuardianDesk';
import {DeskGate, SectionHeading} from './SectionFrame';

/**
 * Wallet: who is connected, the smart account that pays for outings and every signed permission. Disconnecting
 * lives once, on the account chip in the header (wide) or the menu (narrow).
 */
export function WalletSection({desk, walletWaiting}: {desk: GuardianDesk; walletWaiting: boolean}) {
    return <div className="nft-arcade">
        <SectionHeading section="wallet" desk={desk} />
        <DeskGate desk={desk} walletWaiting={walletWaiting} need="owner"><Wallet desk={desk} /></DeskGate>
    </div>;
}

function Wallet({desk}: {desk: GuardianDesk}) {
    const {ko, locale, giwa, owner} = desk;
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
        </section>
        <ArcadeRevocations grants={giwa.grants} ko={ko} onRevoked={giwa.revoked} />
    </>;
}
