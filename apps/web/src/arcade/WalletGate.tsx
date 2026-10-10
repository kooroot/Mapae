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
import {GuestArcade} from './guest/GuestArcade';
import {useGuestPractice} from './guest/useGuestPractice';
import {trackEngagement} from './engagement/client';
import './guest/guest.css';

/** Wallet connection identifies the owner; profile login and spending are separate signatures. */
export function WalletGate({reducedMotion, children}: {reducedMotion: boolean; children: (owner: Address, selected: GameId | "auto", onGuest: () => void) => ReactNode}) {
    const {address, status, connector} = useAccount();
    const {connectors} = useConnect();
    const {locale} = useLocale();
    const ko = locale === "ko";
    const [selected, setSelected] = useState<GameId | "auto">("stamp");
    const [guest, setGuest] = useState<GameId | null>(null);
    const guestStore = useGuestPractice();
    const namedWallets = connectors.filter(c => c.id !== "injected");
    const waiting = status === "connecting" || status === "reconnecting";
    if (guest) return <GuestArcade game={guest} store={guestStore} onBack={() => setGuest(null)} onGuardian={game => {setSelected(game); setGuest(null);}} />;
    if (status === "connected" && address && (connector?.id !== "injected" || namedWallets.length === 0)) return children(address, selected, () => {
        const game = selected === 'auto' ? 'stamp' : selected;
        trackEngagement({event: 'arcade_entered', game, locale});
        setGuest(game);
    });
    return <main className="arcade agent-arcade arc-wallet-gate">
        <header className="arc-header"><a className="arc-wordmark" href={localizePath("/", locale)} aria-label={ko ? "Mapae 홈" : "Mapae home"}><ArcadeBrand /></a><span className="arc-demo-label"><i />GIWA SEPOLIA</span><div className="arc-header-actions"><LocaleSwitch /></div></header>
        <div className="arc-main">
            <ArcadeRoom locale={locale} selected={selected} onSelect={setSelected} reducedMotion={reducedMotion}>
                <div className="arc-entry-dock">
                    <h2>{ko ? "먼저 한 판, 가볍게 놀아보세요" : "Try a round. Make yourself at home."}</h2>
                    <p>{ko ? "지갑 없이 직접 플레이하고, 마음에 들면 나의 전령을 만나보세요." : "Play without a wallet, then meet your own guardian."}</p>
                    <div className="arc-entry-free"><button className="arc-button" onClick={() => {const game = selected === 'auto' ? 'stamp' : selected; trackEngagement({event: 'arcade_entered', game, locale}); setGuest(game);}}>{ko ? "지갑 없이 무료 체험" : "Play free without a wallet"} →</button><small>{ko ? "연습 기록은 이 탭에만 저장돼요" : "Practice records stay in this tab"}</small></div>
                    <ol className="arc-entry-steps"><li><Sparkles size={17} />{ko ? "나만의 친구" : "Your own guardian"}</li><li><Ticket size={17} />{ko ? "한도 있는 용돈" : "A bounded allowance"}</li><li><Gamepad2 size={17} />{ko ? "작은 모험 시작" : "A little adventure"}</li></ol>
                    <p>{ko ? "내 전령과 이어서 모험하려면" : "To continue with your own guardian"}</p><WalletPicker reconnecting={waiting} />
                    <small>{ko ? "같은 지갑으로 로그인하면 캐릭터와 기록이 이어져요" : "Sign in with the same wallet to continue with your characters and records"}</small>
                </div>
            </ArcadeRoom>
            <footer className="arc-footer"><p>{ko ? "작은 자유, 분명한 한도." : "A little freedom. A clear limit."}</p><span>GIWA SEPOLIA · {ko ? "테스트 토큰 사용" : "TEST TOKENS"}</span></footer>
        </div>
    </main>;
}
