import {useId, useSyncExternalStore, type ReactNode} from 'react';
import {Link} from '@tanstack/react-router';
import {BookOpen, Compass, Gamepad2, LoaderCircle, LogOut, Sparkles, Trophy, Wallet, type LucideIcon} from 'lucide-react';
import type {Address} from 'viem';
import {LocaleSwitch} from '../lib/locale';
import {localizePath, type Locale} from '../lib/i18n';
import {ArcadeBrand} from './ArcadeBrand';
import {shortAddress} from '../lib/dial';
import {WalletPicker} from '../components/WalletPicker';
import {ARCADE_SECTIONS, arcadeSectionLink, SECTION_COPY, type ArcadeSection, type SectionBadges} from './sections';

export const SECTION_ICONS: Record<ArcadeSection, LucideIcon> = {lobby: Gamepad2, guardians: Sparkles, outings: Compass, ranking: Trophy, journal: BookOpen, wallet: Wallet};

/**
 * The one arcade header for every visitor. Wide screens show every section inline, then the wallet and language; narrower
 * ones show the menu button, the brand and where the visitor is, with everything else inside the menu's drawer. A guest gets
 * the wallet connect as the header's one primary action. Badges come from the wallet, so they appear only after hydration.
 */
export function ArcadeHeader({section, locale, menu, owner, walletWaiting, badges, disconnecting, blocked, onDisconnect}: {
    section: ArcadeSection; locale: Locale; menu: ReactNode; owner?: Address; walletWaiting: boolean; badges: SectionBadges; disconnecting: boolean; blocked: boolean; onDisconnect: () => void;
}) {
    const ko = locale === 'ko', copy = SECTION_COPY[locale], hydrated = useHydrated();
    return <header className="arc-header arc-shell-header">
        {menu}
        <a className="arc-wordmark" href={localizePath('/', locale)} aria-label={ko ? 'Mapae 홈' : 'Mapae home'}><ArcadeBrand /></a>
        <span className="arc-header-title" aria-hidden="true">{copy[section].label}</span>
        <nav className="arc-nav" aria-label={ko ? '오락실 메뉴' : 'Arcade sections'}>
            {ARCADE_SECTIONS.map(id => {const Icon = SECTION_ICONS[id]; return <Link key={id} {...arcadeSectionLink(id, locale)} activeOptions={{exact: true, includeHash: false}}><Icon size={17} aria-hidden="true" /><span>{copy[id].label}</span>{hydrated && badges[id] && <em>{badges[id]}</em>}</Link>;})}
        </nav>
        <div className="arc-header-actions">
            {owner ? <AccountChip owner={owner} ko={ko} disconnecting={disconnecting} blocked={blocked} onDisconnect={onDisconnect} /> : <WalletPicker reconnecting={walletWaiting} variant="header" />}
            <LocaleSwitch />
        </div>
    </header>;
}

/** The connected wallet with its disconnect control; held back while a signature or transaction is still in flight. */
export function AccountChip({owner, ko, disconnecting, blocked, onDisconnect}: {owner: Address; ko: boolean; disconnecting: boolean; blocked: boolean; onDisconnect: () => void}) {
    const hint = useId(), label = disconnecting ? (ko ? '연결 해제 중…' : 'Disconnecting…') : (ko ? '연결 해제' : 'Disconnect');
    return <div className="arc-account"><span className="arc-account-address" title={owner}><i aria-hidden="true" />{shortAddress(owner)}</span>
        <button type="button" className="arc-account-disconnect" aria-label={label} aria-describedby={blocked && !disconnecting ? hint : undefined} disabled={disconnecting || blocked} onClick={onDisconnect}>{disconnecting ? <LoaderCircle size={16} className="arc-loading-icon" aria-hidden="true" /> : <LogOut size={16} aria-hidden="true" />}<span>{label}</span></button>
        {blocked && !disconnecting && <span id={hint} className="arc-account-hint">{ko ? '진행 중인 작업이 끝나면 연결을 해제할 수 있어요' : 'You can disconnect once the current task finishes'}</span>}</div>;
}

const subscribe = () => () => {};
/** False on the server and during hydration, true afterwards; no effect pass and no hydration mismatch. */
const useHydrated = () => useSyncExternalStore(subscribe, () => true, () => false);
