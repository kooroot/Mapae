import {useState, type ReactNode} from "react";
import {useAccount, useConnect, type Connector} from "wagmi";
import {Wallet, ArrowRight} from "lucide-react";
import type {Address} from "viem";
import type {GameId} from "@mapae/arcade";
import {ArcadeRoom} from "./ArcadeRoom";
import {LocaleSwitch, useLocale} from "../lib/locale";
import {localizePath} from "../lib/i18n";
import {ArcadeBrand} from "./ArcadeBrand";
import "./wallet-gate.css";

/** Connection selects local records; spending still requires a separate signed grant. */
export function WalletGate({children}: {children: (owner: Address, selected: GameId) => ReactNode}) {
    const {address, status, connector} = useAccount();
    const {connectAsync, connectors, isPending} = useConnect();
    const {locale} = useLocale();
    const ko = locale === "ko";
    const [error, setError] = useState("");
    const [selected, setSelected] = useState<GameId>("race");
    const namedWallets = connectors.filter(c => c.id !== "injected");
    const wallets = namedWallets.length ? namedWallets : connectors;
    const waiting = isPending || status === "connecting" || status === "reconnecting";
    if (status === "connected" && address && (connector?.id !== "injected" || namedWallets.length === 0)) return children(address, selected);
    async function connect(installed: Connector | undefined) {
        if (waiting) return;
        setError("");
        if (!installed) {setError(ko ? "지갑 앱의 브라우저에서 열어 주세요." : "Open this page in your wallet browser."); return;}
        try {await connectAsync({connector: installed});}
        catch {setError(ko ? "지갑 연결을 완료해 주세요. 모바일에서는 지갑 앱의 브라우저로 열어 주세요." : "Complete the wallet connection. On mobile, open this page in your wallet browser.");}
    }
    return <main className="arcade agent-arcade arc-wallet-gate">
        <header className="arc-header"><a className="arc-wordmark" href={localizePath("/", locale)} aria-label={ko ? "Mapae 홈" : "Mapae home"}><ArcadeBrand /></a><span className="arc-demo-label"><i />GIWA SEPOLIA</span><div className="arc-header-actions"><LocaleSwitch /></div></header>
        <div className="arc-main">
            <ArcadeRoom locale={locale} selected={selected} onSelect={setSelected} locked>
                <div className="arc-entry-dock">
                    <h2>{ko ? "지갑을 연결하고 입장하세요" : "Your arcade adventure starts here"}</h2>
                    <p>{ko ? "내 캐릭터는 직접 만들어요. 용돈은 내가 정하고요." : "Create your own characters. Set their own little allowance."}</p>
                    {wallets.length > 1 && <p className="arc-wallet-prompt">{ko ? "사용할 지갑을 골라 주세요" : "Choose your wallet"}</p>}
                    <div className="arc-wallet-options">{wallets.length ? wallets.map(wallet => <button key={wallet.uid} className="arc-button" onClick={() => void connect(wallet)} disabled={waiting}><Wallet size={17} />{waiting ? ko ? "지갑 연결 확인 중…" : "Connecting…" : wallet.name}<ArrowRight size={18} /></button>) : <button className="arc-button" onClick={() => void connect(undefined)} disabled={waiting}><Wallet size={17} />{ko ? "지갑 연결하고 시작하기" : "Connect wallet to start"}<ArrowRight size={18} /></button>}</div>
                    <small>{ko ? "연결만으로 결제되지 않아요" : "Connecting makes no payment"}</small>
                    <div className="arc-mobile-wallet">
                        <p>{ko ? "휴대폰 Chrome·Safari에서 왔나요?" : "Using Chrome or Safari on your phone?"}</p>
                        <a href={`https://link.metamask.io/dapp/mapae.io${localizePath("/arcade", locale)}`} className="arc-wallet-app-link"><Wallet size={17} />{ko ? "MetaMask 앱에서 입장하기" : "Open arcade in MetaMask"}<ArrowRight size={17} /></a>
                        <small>{ko ? "앱 안에서 지갑을 연결해 주세요. 다른 지갑은 앱의 브라우저에 mapae.io를 열면 돼요." : "Connect inside the app. Other wallets can open mapae.io in their built-in browser."}</small>
                    </div>
                    {error && <p className="arc-notice" role="alert">{error}</p>}
                </div>
            </ArcadeRoom>
            <footer className="arc-footer"><p>{ko ? "작은 자유, 분명한 한도." : "A little freedom. A clear limit."}</p><span>GIWA SEPOLIA · {ko ? "테스트 토큰 사용" : "TEST TOKENS"}</span></footer>
        </div>
    </main>;
}
