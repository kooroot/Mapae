import type {ReactNode} from 'react';
import {Link} from '@tanstack/react-router';
import {ArrowUpRight, CircleAlert, Gamepad2, LoaderCircle, RefreshCw, Sparkles, Ticket} from 'lucide-react';
import {guardianName} from '@mapae/arcade/guardians';
import {WalletPicker} from '../../components/WalletPicker';
import {GuardianAvatar} from '../GuardianAvatar';
import {FaucetHint} from '../FaucetHint';
import {FAUCET_HINT, faucetHintUrl} from '../faucet-hint';
import {SignInCard} from '../SignInCard';
import {TransactionRecovery} from '../nft/TransactionRecovery';
import type {GuardianDesk} from '../nft/useGuardianDesk';
import {arcadeSectionLink, SECTION_COPY, type ArcadeSubsection} from '../sections';
import '../nft/nft.css';

/** A section's page heading: the `h1` the shell focuses on arrival, with the line the menu shows for the same place. */
export function SectionHeading({section, desk, children}: {section: ArcadeSubsection; desk: GuardianDesk; children?: ReactNode}) {
    const {ko, locale} = desk, copy = SECTION_COPY[locale][section];
    return <div className="nft-page-heading"><div><span className="arc-overline">{ko ? 'Mapae 오락실' : 'MAPAE ARCADE'}</span><h1 id="arc-section-title" tabIndex={-1}>{copy.label}</h1><p>{copy.description}</p></div>{children}</div>;
}

/** The three promises and the wallet picker, wherever a guest is asked to connect; secondary when free play leads the card. */
export function ConnectInvite({ko, walletWaiting, secondary = false}: {ko: boolean; walletWaiting: boolean; secondary?: boolean}) {
    return <>
        <ol className="arc-entry-steps"><li><Sparkles size={17} aria-hidden="true" />{ko ? '나만의 전령' : 'Your own guardian'}</li><li><Ticket size={17} aria-hidden="true" />{ko ? '한도 있는 용돈' : 'A bounded allowance'}</li><li><Gamepad2 size={17} aria-hidden="true" />{ko ? '작은 모험 시작' : 'A little adventure'}</li></ol>
        <WalletPicker reconnecting={walletWaiting} variant={secondary ? "secondary" : "primary"} />
        <small>{ko ? '같은 지갑으로 로그인하면 전령과 기록이 이어져요' : 'Sign in with the same wallet to continue with your guardians and records'}</small>
    </>;
}

/**
 * What a section needs before it can show itself: a wallet (`owner`), a signed-in profile (`session`) or a revealed guardian
 * (`guardian`). Anything missing becomes the one next step, so a deep link never lands on a broken page.
 */
export function DeskGate({desk, walletWaiting, need, children}: {desk: GuardianDesk; walletWaiting: boolean; need: 'owner' | 'session' | 'guardian'; children: ReactNode}) {
    const {ko, stage, nft, revealed} = desk;
    const loading = (label: string) => <p role="status" className="arc-notice nft-notice is-info"><LoaderCircle size={16} className="arc-loading-icon" aria-hidden="true" />{label}</p>;
    if (!desk.owner) return walletWaiting ? loading(ko ? '지갑 연결을 확인하고 있어요…' : 'Checking your wallet…')
        : <section className="nft-panel nft-connect"><h2>{ko ? '지갑을 연결하고 나의 전령을 만나요' : 'Connect a wallet to meet your guardian'}</h2><ConnectInvite ko={ko} walletWaiting={walletWaiting} /></section>;
    if (need === 'owner') return children;
    if (stage === 'pending') return loading(ko ? '전령단을 불러오고 있어요…' : 'Loading your guardians…');
    if (stage === 'signin') return <SignInCard owner={desk.owner} session={desk.session} ko={ko} />;
    if (need === 'session') return children;
    const guardians = (label: string) => <Link className="arc-button" {...arcadeSectionLink('guardians', desk.locale)}><Sparkles size={18} aria-hidden="true" />{label}</Link>;
    switch (stage) {
    case 'unavailable': return <div className="arc-notice nft-notice" role="alert"><CircleAlert size={16} aria-hidden="true" /><p>{nft.error}</p><button type="button" className="arc-text-button" disabled={nft.loading} onClick={() => void nft.refresh()}><RefreshCw size={16} aria-hidden="true" />{ko ? '다시 불러오기' : 'Retry'}</button></div>;
    case 'closed': return <section className="nft-panel"><h2>{ko ? '전령단이 곧 문을 열어요' : 'Guardians are preparing to arrive'}</h2><p>{ko ? '지금은 무료 게임을 즐길 수 있어요. NFT 뽑기는 준비가 끝나면 열립니다.' : 'Play the free games while NFT draws are being prepared.'}</p><Link className="arc-button" {...arcadeSectionLink('lobby', desk.locale)}>{ko ? '무료 게임 하러 가기' : 'Play the free games'}</Link></section>;
    case 'empty': return <section className="nft-panel"><h2>{ko ? '아직 함께할 전령이 없어요' : 'No guardian yet'}</h2><p>{ko ? '첫 전령을 뽑으면 외출을 보내고 모험 기록을 쌓을 수 있어요.' : 'Draw your first guardian to send outings and build a journal.'}</p>{guardians(ko ? '첫 전령 뽑기' : 'Draw my first guardian')}<FaucetHint locale={desk.locale} /></section>;
    case 'waiting': return <section className="nft-panel"><h2>{ko ? '전령의 탄생을 기다리고 있어요' : 'Your guardian is on the way'}</h2><p>{revealed.length ? ko ? '탄생을 확인하거나, 이미 함께하는 다른 전령으로 바꿔 보세요.' : 'Check the reveal, or switch to a guardian who is already here.' : ko ? '탄생이 끝나면 이곳에서 함께할 수 있어요.' : 'Once revealed, your guardian joins you here.'}</p><div className="nft-panel-actions">{guardians(ko ? '탄생 확인하러 가기' : 'Check the reveal')}{revealed[0] && <button type="button" className="arc-text-button" onClick={() => void nft.select(revealed[0]!.tokenId)}>{ko ? '다른 전령으로 바꾸기' : 'Switch to another guardian'}</button>}</div></section>;
    default: return children;
    }
}

/** Who is in play right now, as portraits to switch between; shown only when more than one guardian has been revealed. */
export function GuardianSwitcher({desk}: {desk: GuardianDesk}) {
    const {ko, locale, nft, token, revealed, crew} = desk;
    if (revealed.length < 2) return null;
    return <div className="arc-dock-switcher" role="group" aria-label={ko ? '함께할 전령 바꾸기' : 'Switch guardian'}>
        {revealed.map((t, index) => <button key={t.tokenId} type="button" aria-pressed={t.tokenId === token?.tokenId} aria-label={guardianName(t.tokenId, locale)} title={guardianName(t.tokenId, locale)} onClick={() => void nft.select(t.tokenId)}><GuardianAvatar appearance={crew[index]?.appearance} color={crew[index]?.color} portrait /></button>)}
    </div>;
}

/** The roster's own progress: load errors, a running transaction and a transaction to recover. `phase={false}` when the page shows progress in place. */
export function NftStatus({desk, phase = true}: {desk: GuardianDesk; phase?: boolean}) {
    const {ko, locale, nft} = desk;
    return <>
        {nft.error && <div className="arc-notice nft-notice" role="alert"><CircleAlert size={16} aria-hidden="true" /><p>{nft.error}</p>{nft.gasShort && <a className="arc-button arc-button-paper" href={faucetHintUrl(locale)}>{FAUCET_HINT[locale].action}<ArrowUpRight size={16} aria-hidden="true" /></a>}<button type="button" className="arc-text-button" disabled={nft.loading || nft.busy} onClick={() => void nft.refresh()}><RefreshCw size={16} className={nft.loading ? 'arc-loading-icon' : undefined} aria-hidden="true" />{nft.loading ? (ko ? '불러오는 중…' : 'Refreshing…') : (ko ? '다시 불러오기' : 'Retry')}</button></div>}
        {phase && nft.busy && <p role="status" className="arc-notice nft-notice is-info"><LoaderCircle size={16} className="arc-loading-icon" aria-hidden="true" />{nft.phase}</p>}
        {nft.transaction && <TransactionRecovery transaction={nft.transaction} busy={nft.busy} ko={ko} onCheck={nft.checkTransaction} />}
    </>;
}
