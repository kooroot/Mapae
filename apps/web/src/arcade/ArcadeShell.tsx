import {useEffect, useRef, useState} from "react";
import {useAccount, useConnect} from "wagmi";
import type {GameId} from "@mapae/arcade";
import {dailyChallenge} from "@mapae/arcade/challenge";
import {useLocale} from "../lib/locale";
import {ArcadeRoom} from "./ArcadeRoom";
import {ArcadeHeader, type ArcadeTab} from "./ArcadeHeader";
import {swapScreen} from "./motion";
import {LobbyDock} from "./LobbyDock";
import {GuestArcade} from "./guest/GuestArcade";
import {useGuestPractice} from "./guest/useGuestPractice";
import {trackEngagement} from "./engagement/client";
import {useGuardianDesk} from "./nft/useGuardianDesk";
import {GuardianArcade} from "./nft/GuardianArcade";
import {NftPractice} from "./nft/NftPractice";
import type {GuardianToken} from "./profile/guardians";
import "./arcade-shell.css";
import "./guest/guest.css";

type Screen = {kind: "tabs"} | {kind: "guest"; game: GameId} | {kind: "practice"; token: GuardianToken; game: GameId; seed: number};

/**
 * One arcade for every visitor. The lobby is where everyone lands; connecting, signing in and disconnecting change what the dock
 * offers, never the screen. Games open over the shell and return to the tab they were opened from, with the same cabinet chosen.
 */
export function ArcadeShell({reducedMotion}: {reducedMotion: boolean}) {
    const {address, status, connector} = useAccount();
    const {connectors} = useConnect();
    const {locale} = useLocale(), ko = locale === "ko";
    // A bare injected provider stays a guest while named wallets exist: the picker asks which one is meant.
    const owner = status === "connected" && address && (connector?.id !== "injected" || connectors.every(c => c.id === "injected")) ? address : undefined;
    const walletWaiting = status === "connecting" || status === "reconnecting";
    const [tab, setTab] = useState<ArcadeTab>("lobby");
    const [selected, setSelected] = useState<GameId>("stamp");
    const [screen, setScreen] = useState<Screen>({kind: "tabs"});
    const [focusAllowance, setFocusAllowance] = useState(false);
    const desk = useGuardianDesk(owner, walletWaiting, selected);
    const guestStore = useGuestPractice();
    const panel = useRef<HTMLDivElement>(null), arrived = useRef(false);
    // A wallet change closes its guardian's practice; leaving altogether returns to the lobby as a guest.
    const [shown, setShown] = useState(owner);
    if (shown !== owner) {
        setShown(owner);
        if (screen.kind === "practice") setScreen({kind: "tabs"});
        if (!owner) setTab("lobby");
    }
    // Moving between places hands focus to the new panel, so keyboard and screen-reader users start at its top.
    useEffect(() => {
        if (!arrived.current) {arrived.current = true; return;}
        if (screen.kind !== "tabs" || focusAllowance) return;
        panel.current?.focus({preventScroll: true});
        window.scrollTo({top: 0});
    }, [tab, screen.kind]);

    const go = (change: () => void) => swapScreen(reducedMotion, change);
    function openTab(next: ArcadeTab) {if (next !== tab || screen.kind !== "tabs") go(() => {setTab(next); setScreen({kind: "tabs"});});}
    function playGuest(game: GameId) {trackEngagement({event: "arcade_entered", game, locale}); go(() => {setSelected(game); setScreen({kind: "guest", game});});}
    function practice(token: GuardianToken, game: GameId) {go(() => {setSelected(game); setScreen({kind: "practice", token, game, seed: dailyChallenge(game, desk.now).seed});});}
    function meetGuardian(game: GameId) {go(() => {setSelected(game); setTab("guardians"); setScreen({kind: "tabs"});});}
    function sendOuting(game: GameId) {
        // A running outing keeps its own destination; otherwise the cabinet being browsed becomes the plan.
        if (!desk.activeJob) desk.setOperation({game});
        go(() => {setTab("guardians"); setScreen({kind: "tabs"});});
        setFocusAllowance(true);
    }
    const back = () => go(() => setScreen({kind: "tabs"}));

    if (screen.kind === "guest") return <GuestArcade game={screen.game} store={guestStore} onBack={back} onGuardian={meetGuardian} />;
    if (screen.kind === "practice") return <NftPractice token={screen.token} game={screen.game} seed={screen.seed} ko={ko} reducedMotion={reducedMotion} returnLabel={tab === "lobby" ? ko ? "오락실로 돌아가기" : "Back to the arcade" : ko ? "전령단으로 돌아가기" : "Back to guardians"} onClose={back} />;
    return <main className="arcade agent-arcade arc-shell">
        <ArcadeHeader tab={tab} onTab={openTab} owner={owner} ko={ko} disconnecting={desk.disconnecting} blocked={desk.busy || desk.session.status === "signing"} onDisconnect={() => void desk.disconnect()} />
        <div className="arc-main arc-panel" ref={panel} tabIndex={-1} aria-label={tab === "lobby" ? ko ? "오락실" : "Arcade" : ko ? "나의 전령단" : "My guardians"}>
            {tab === "lobby" ? <ArcadeRoom locale={locale} selected={selected} onSelect={setSelected} reducedMotion={reducedMotion}>
                <LobbyDock desk={desk} game={selected} walletWaiting={walletWaiting} onPlayGuest={playGuest} onPractice={practice} onSendOuting={sendOuting} onOpenGuardians={() => openTab("guardians")} />
            </ArcadeRoom> : <GuardianArcade desk={desk} walletWaiting={walletWaiting} focusAllowance={focusAllowance} onAllowanceFocused={() => setFocusAllowance(false)} onPractice={practice} onLobby={() => openTab("lobby")} />}
            <footer className="arc-footer"><p>{ko ? "작은 자유, 분명한 한도." : "A little freedom. A clear limit."}</p><span>GIWA SEPOLIA · {ko ? "테스트 토큰 사용" : "TEST TOKENS"}</span></footer>
        </div>
    </main>;
}
