import {useId} from 'react';
import {LoaderCircle, LogOut} from 'lucide-react';
import type {Address} from 'viem';
import {LocaleSwitch} from '../../lib/locale';
import {ArcadeBrand} from '../ArcadeBrand';

export const shortAddress=(address:Address)=>`${address.slice(0,6)}…${address.slice(-4)}`;

/** Signed-in arcade chrome: network label, the connected wallet and its disconnect control. */
export function GuardianHeader({owner,ko,network,disconnecting,blocked,onDisconnect}:{owner:Address;ko:boolean;network:string;disconnecting:boolean;blocked:boolean;onDisconnect:()=>void}){
    const hint=useId(),label=disconnecting?(ko?'연결 해제 중…':'Disconnecting…'):(ko?'연결 해제':'Disconnect');
    return <header className="arc-header"><a className="arc-wordmark" href={ko?'/ko/arcade':'/arcade'}><ArcadeBrand/></a><span className="arc-demo-label"><i/>{network}</span>
        <div className="arc-header-actions"><div className="arc-account"><span className="arc-account-address" title={owner}><i aria-hidden="true"/>{shortAddress(owner)}</span>
            <button type="button" className="arc-account-disconnect" aria-label={label} aria-describedby={blocked&&!disconnecting?hint:undefined} disabled={disconnecting||blocked} onClick={onDisconnect}>{disconnecting?<LoaderCircle size={16} className="arc-loading-icon" aria-hidden="true"/>:<LogOut size={16} aria-hidden="true"/>}<span>{label}</span></button>
            {blocked&&!disconnecting&&<span id={hint} className="arc-account-hint">{ko?'진행 중인 작업이 끝나면 연결을 해제할 수 있어요':'You can disconnect once the current task finishes'}</span>}</div><LocaleSwitch/></div></header>;
}
