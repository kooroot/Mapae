import {ArrowRight, Check, Cloud, LoaderCircle, ShieldCheck} from "lucide-react";
import type {useArcadeState} from "./useArcadeState";
import {ArcadeBrand} from "./ArcadeBrand";

type Props = {store: ReturnType<typeof useArcadeState>; ko: boolean};
export function ProfileAccess({store, ko, onDisconnect}: Props & {onDisconnect: () => void}) {
    const waiting = store.status === "loading" || store.status === "signing" || store.status === "saving";
    return <main className="arcade agent-arcade arc-profile-access"><a className="arc-wordmark" href={ko ? "/ko/arcade" : "/arcade"}><ArcadeBrand /></a><section>
        <div className="arc-profile-cloud">{waiting ? <LoaderCircle size={34} className="arc-loading-icon" /> : <Cloud size={34} />}</div>
        <span className="arc-overline">MY MAPAE · {ko ? "지갑으로 이어지는 모험" : "YOUR WALLET, YOUR ADVENTURES"}</span>
        <h1>{store.status === "signing" ? ko ? "지갑에서 로그인을 승인해 주세요" : "Approve sign-in in your wallet" : store.status === "loading" ? ko ? "내 친구들을 데려오고 있어요" : "Bringing your friends over" : ko ? "어디서든, 나의 친구들과" : "Your friends, on every device"}</h1>
        <p>{ko ? "지갑에 서명하고 캐릭터와 기록을 불러오세요." : "Sign in with your wallet to load your characters and records."}</p>
        {!waiting && <button className="arc-button" onClick={() => void (store.status === "login" ? store.login() : store.refresh())}>{ko ? store.status === "login" ? "서명하고 내 기록 불러오기" : "다시 불러오기" : store.status === "login" ? "Sign in to load my friends" : "Try again"}<ArrowRight size={19} /></button>}
        {store.errorMessage(ko) && <p className="arc-notice" role="alert">{store.errorMessage(ko)}</p>}
        <small><ShieldCheck size={16} />{ko ? "로그인용 메시지 서명 · 결제·지출 권한 승인 아님" : "Sign-in message only · no payments or spending permission"}</small>
        <button className="arc-text-button" disabled={waiting} onClick={onDisconnect}>{ko ? "다른 지갑으로 연결" : "Connect another wallet"}</button>
    </section></main>;
}
export function ProfileSyncStatus({store, ko}: Props) {
    const busy = store.status === "saving" || store.status === "loading" || store.status === "signing";
    return <div className={`arc-profile-sync ${store.saved ? "is-synced" : ""}`} role="status">
        {store.saved ? <Check size={15} /> : busy ? <LoaderCircle size={15} className="arc-loading-icon" /> : <Cloud size={15} />}
        <span>{store.saved ? ko ? "저장됨" : "Saved" : busy ? ko ? "동기화 중…" : "Syncing…" : store.errorMessage(ko)}</span>
        {!busy && <button className="arc-text-button" onClick={() => void (store.status === "login" ? store.login() : store.status === "conflict" ? store.useServerCopy() : store.refresh())}>{ko ? store.status === "login" ? "다시 로그인" : store.status === "conflict" ? "서버 기록 불러오기" : store.saved ? "새로고침" : "다시 시도" : store.status === "login" ? "Sign in again" : store.status === "conflict" ? "Load server record" : store.saved ? "Refresh" : "Retry"}</button>}
    </div>;
}
