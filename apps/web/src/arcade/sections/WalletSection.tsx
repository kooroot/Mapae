import {ArrowUpRight, Droplets, ExternalLink} from 'lucide-react';
import {MOCK_USDC} from '@mapae/shared';
import {explorerAddressUrl, faucetUrl} from '../../lib/config';
import {shortAddress} from '../../lib/dial';
import {localizeUrl} from '../../lib/i18n';
import {lazy, Suspense} from 'react';
import type {GuardianDesk} from '../nft/useGuardianDesk';
import {DeskGate, SectionHeading} from './SectionFrame';

const ArcadeRevocations = lazy(() => import("../ArcadeRevocations").then(m => ({default: m.ArcadeRevocations})));

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
                <div><dt>{ko ? '스마트 계정 잔액' : 'Smart-account balance'}</dt><dd><strong>{giwa.balance ?? '—'} {MOCK_USDC.symbol}</strong></dd></div>
            </dl>
            <div className="arc-wallet-faucet">
                <a className="arc-button arc-button-paper" href={localizeUrl(faucetUrl, locale)}><Droplets size={18} aria-hidden="true" />{ko ? '테스트 토큰 받기' : 'Get test tokens'}<ArrowUpRight size={17} aria-hidden="true" /></a>
                <small>{ko ? `faucet.mapae.io에서 @mapae_io를 팔로우하면 하루에 한 번 ${MOCK_USDC.symbol}(테스트넷, 실제 돈 아님)를 받아요.` : `Follow @mapae_io on faucet.mapae.io to get ${MOCK_USDC.symbol} (testnet, not real money) once a day.`}</small>
            </div>
        </section>
        <Suspense fallback={<p role="status">{ko ? "권한 관리 준비 중…" : "Loading permission controls…"}</p>}><ArcadeRevocations grants={giwa.grants} ko={ko} onRevoked={giwa.revoked} /></Suspense>
    </>;
}
