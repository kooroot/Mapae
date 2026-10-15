import {useState} from 'react';
import {Drawer} from '@base-ui/react/drawer';
import {Link, useLocation} from '@tanstack/react-router';
import {ArrowUpRight, Droplets, Menu, X} from 'lucide-react';
import type {Address} from 'viem';
import {WalletPicker} from '../components/WalletPicker';
import {LocaleSwitch} from '../lib/locale';
import {localizePath, type Locale} from '../lib/i18n';
import {FAUCET_HINT, faucetHintUrl} from './faucet-hint';
import {AccountChip, SECTION_ICONS} from './ArcadeHeader';
import {ARCADE_SECTIONS, arcadeSectionLink, SECTION_COPY, type SectionBadges} from './sections';

/**
 * The narrow-screen menu: a left drawer with every section, the wallet and the language. Base UI's drawer brings the focus
 * trap, Esc, outside-click dismissal, scroll lock and swipe-to-close. Any route change (a link here, or back/forward) or a
 * wallet change closes it. Section links stay plain links rather than close buttons, so they are announced as navigation.
 */
export function ArcadeMenu({locale, owner, walletWaiting, badges, disconnecting, blocked, onDisconnect}: {
    locale: Locale; owner?: Address; walletWaiting: boolean; badges: SectionBadges;
    disconnecting: boolean; blocked: boolean; onDisconnect: () => void;
}) {
    const ko = locale === 'ko', copy = SECTION_COPY[locale];
    const [open, setOpen] = useState(false);
    const pathname = useLocation({select: location => location.pathname});
    const [at, setAt] = useState({pathname, owner});
    if (at.pathname !== pathname || at.owner !== owner) {setAt({pathname, owner}); setOpen(false);}
    return <Drawer.Root open={open} onOpenChange={setOpen} swipeDirection="left">
        <Drawer.Trigger className="arc-menu-toggle" aria-label={ko ? '메뉴 열기' : 'Open menu'}><Menu size={22} aria-hidden="true" /></Drawer.Trigger>
        <Drawer.Portal className="arc-ui-theme">
            <Drawer.Backdrop className="arc-menu-backdrop" />
            <Drawer.Viewport className="arc-menu-viewport">
                <Drawer.Popup className="arc-menu-popup">
                    <div className="arc-menu-top">
                        <Drawer.Title className="arc-menu-title">{ko ? 'Mapae 오락실' : 'Mapae Arcade'}</Drawer.Title>
                        <Drawer.Close className="arc-menu-close" aria-label={ko ? '메뉴 닫기' : 'Close menu'}><X size={20} aria-hidden="true" /></Drawer.Close>
                    </div>
                    <Drawer.Description className="sr-only">{ko ? '오락실 구역과 지갑, 언어를 고를 수 있어요.' : 'Arcade sections, your wallet and language.'}</Drawer.Description>
                    <nav className="arc-menu-nav" aria-label={ko ? '오락실 메뉴' : 'Arcade sections'}>
                        {ARCADE_SECTIONS.map(id => {const Icon = SECTION_ICONS[id]; return <Link key={id} {...arcadeSectionLink(id, locale)} activeOptions={{exact: true, includeHash: false}} onClick={() => setOpen(false)}>
                            <Icon size={20} aria-hidden="true" /><span><b>{copy[id].label}</b><small>{copy[id].description}</small></span>{badges[id] && <em>{badges[id]}</em>}
                        </Link>;})}
                    </nav>
                    <div className="arc-menu-account">
                        {owner ? <AccountChip owner={owner} ko={ko} disconnecting={disconnecting} blocked={blocked} onDisconnect={onDisconnect} />
                            : <><p>{ko ? '지갑을 연결하면 나의 전령과 기록이 이어져요.' : 'Connect a wallet to continue with your guardians and records.'}</p><WalletPicker reconnecting={walletWaiting} /></>}
                    </div>
                    <a className="arc-menu-faucet" href={faucetHintUrl(locale, 'musdc')}><Droplets size={20} aria-hidden="true" /><span><b>{FAUCET_HINT[locale].action}</b><small>{ko ? '@mapae_io 팔로우 한 번이면 무료, 테스트넷 토큰이라 실제 돈 아님' : 'Free for a follow of @mapae_io — testnet tokens, not real money'}</small></span><ArrowUpRight size={16} aria-hidden="true" /></a>
                    <div className="arc-menu-foot"><LocaleSwitch /><a href={localizePath('/', locale)}>{ko ? 'Mapae 홈' : 'Mapae home'}<ArrowUpRight size={16} aria-hidden="true" /></a></div>
                </Drawer.Popup>
            </Drawer.Viewport>
        </Drawer.Portal>
    </Drawer.Root>;
}
