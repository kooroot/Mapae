import {useId} from 'react';
import {Gamepad2, LoaderCircle, LogOut, Sparkles} from 'lucide-react';
import type {Address} from 'viem';
import {LocaleSwitch} from '../lib/locale';
import {localizePath} from '../lib/i18n';
import {ArcadeBrand} from './ArcadeBrand';
import {shortAddress} from '../lib/dial';

export type ArcadeTab = 'lobby' | 'guardians';

/** The one arcade header for every visitor: the two places to be, then the connected wallet and its disconnect control. */
export function ArcadeHeader({tab, onTab, owner, ko, disconnecting, blocked, onDisconnect}: {
    tab: ArcadeTab; onTab: (tab: ArcadeTab) => void; owner?: Address; ko: boolean;
    disconnecting: boolean; blocked: boolean; onDisconnect: () => void;
}) {
    const hint = useId(), label = disconnecting ? (ko ? '연결 해제 중…' : 'Disconnecting…') : (ko ? '연결 해제' : 'Disconnect');
    const tabs = [
        {id: 'lobby' as const, icon: <Gamepad2 size={18} aria-hidden="true" />, label: ko ? '오락실' : 'Arcade'},
        {id: 'guardians' as const, icon: <Sparkles size={18} aria-hidden="true" />, label: ko ? '나의 전령단' : 'My guardians'},
    ];
    return <header className="arc-header arc-shell-header">
        <a className="arc-wordmark" href={localizePath('/', ko ? 'ko' : 'en')} aria-label={ko ? 'Mapae 홈' : 'Mapae home'}><ArcadeBrand /></a>
        <nav className="arc-tabs" aria-label={ko ? '오락실 메뉴' : 'Arcade sections'}>
            {tabs.map(item => <button key={item.id} type="button" className="arc-tab" aria-current={tab === item.id ? 'page' : undefined} onClick={() => onTab(item.id)}>{item.icon}<span>{item.label}</span></button>)}
        </nav>
        <div className="arc-header-actions">
            {owner && <div className="arc-account"><span className="arc-account-address" title={owner}><i aria-hidden="true" />{shortAddress(owner)}</span>
                <button type="button" className="arc-account-disconnect" aria-label={label} aria-describedby={blocked && !disconnecting ? hint : undefined} disabled={disconnecting || blocked} onClick={onDisconnect}>{disconnecting ? <LoaderCircle size={16} className="arc-loading-icon" aria-hidden="true" /> : <LogOut size={16} aria-hidden="true" />}<span>{label}</span></button>
                {blocked && !disconnecting && <span id={hint} className="arc-account-hint">{ko ? '진행 중인 작업이 끝나면 연결을 해제할 수 있어요' : 'You can disconnect once the current task finishes'}</span>}</div>}
            <LocaleSwitch />
        </div>
    </header>;
}
