import {useState, type ReactNode} from "react";
import {useAccount, useConnect} from "wagmi";
import {Sparkles, Ticket, Gamepad2} from "lucide-react";
import type {Address} from "viem";
import type {GameId} from "@mapae/arcade";
import {ArcadeRoom} from "./ArcadeRoom";
import {LocaleSwitch, useLocale} from "../lib/locale";
import {localizePath} from "../lib/i18n";
import {ArcadeBrand} from "./ArcadeBrand";
import "./wallet-gate.css";
import {WalletPicker} from "../components/WalletPicker";

/** Wallet connection identifies the owner; profile login and spending are separate signatures. */
export function WalletGate({children}: {children: (owner: Address, selected: GameId) => ReactNode}) {
    const {address, status, connector} = useAccount();
    const {connectors} = useConnect();
    const {locale} = useLocale();
    const ko = locale === "ko";
    const [selected, setSelected] = useState<GameId>("race");
    const namedWallets = connectors.filter(c => c.id !== "injected");
    const waiting = status === "connecting" || status === "reconnecting";
    if (status === "connected" && address && (connector?.id !== "injected" || namedWallets.length === 0)) return children(address, selected);
    return <main className="arcade agent-arcade arc-wallet-gate">
        <header className="arc-header"><a className="arc-wordmark" href={localizePath("/", locale)} aria-label={ko ? "Mapae 홈" : "Mapae home"}><ArcadeBrand /></a><span className="arc-demo-label"><i />GIWA SEPOLIA</span><div className="arc-header-actions"><LocaleSwitch /></div></header>
        <div className="arc-main">
            <ArcadeRoom locale={locale} selected={selected} onSelect={setSelected} locked>
                <div className="arc-entry-dock">
                    <h2>{ko ? "지갑을 연결하고 입장하세요" : "Your arcade adventure starts here"}</h2>
                    <p>{ko ? "내 캐릭터는 직접 만들어요. 용돈은 내가 정하고요." : "Create your own characters. Set their own little allowance."}</p>
                    <ol className="arc-entry-steps"><li><Sparkles size={17} />{ko ? "나만의 친구" : "Your own guardian"}</li><li><Ticket size={17} />{ko ? "한도 있는 용돈" : "A bounded allowance"}</li><li><Gamepad2 size={17} />{ko ? "작은 모험 시작" : "A little adventure"}</li></ol>
                    <WalletPicker reconnecting={waiting} />
                    <small>{ko ? "같은 지갑으로 로그인하면 캐릭터와 기록이 이어져요" : "Sign in with the same wallet to continue with your characters and records"}</small>
                </div>
            </ArcadeRoom>
            <footer className="arc-footer"><p>{ko ? "작은 자유, 분명한 한도." : "A little freedom. A clear limit."}</p><span>GIWA SEPOLIA · {ko ? "테스트 토큰 사용" : "TEST TOKENS"}</span></footer>
        </div>
    </main>;
}
