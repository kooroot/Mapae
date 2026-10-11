import {useEffect, useLayoutEffect, useRef, useState} from "react";
import {useLocation, useNavigate, useParams} from "@tanstack/react-router";
import {useAccount, useConnect} from "wagmi";
import type {GameId} from "@mapae/arcade";
import {dailyChallenge} from "@mapae/arcade/challenge";
import {useLocale} from "../lib/locale";
import {ArcadeRoom} from "./ArcadeRoom";
import {ArcadeHeader} from "./ArcadeHeader";
import {ArcadeMenu, type SectionBadges} from "./ArcadeMenu";
import {swapScreen} from "./motion";
import {LobbyDock} from "./LobbyDock";
import {GuestArcade} from "./guest/GuestArcade";
import {useGuestPractice} from "./guest/useGuestPractice";
import {trackEngagement} from "./engagement/client";
import {useGuardianDesk} from "./nft/useGuardianDesk";
import {GuardiansSection} from "./sections/GuardiansSection";
import {WalletSection} from "./sections/WalletSection";
import {OutingsSection} from "./sections/OutingsSection";
import {JournalSection} from "./sections/JournalSection";
import {NftPractice} from "./nft/NftPractice";
import type {GuardianToken} from "./profile/guardians";
import {arcadeSectionFromParam, arcadeSectionLink, outingStatusLabel, SECTION_COPY, type ArcadeSection} from "./sections";
import "./arcade-shell.css";
import "./guest/guest.css";

type Screen = {kind: "section"} | {kind: "guest"; game: GameId} | {kind: "practice"; token: GuardianToken; game: GameId; seed: number};

/**
 * One arcade for every visitor, across five addresses. The route only changes a param, so this shell stays mounted while the
 * visitor moves between sections. Games open over the shell without changing the URL and return to the section they were opened
 * from, with the same cabinet chosen.
 */
export function ArcadeShell({reducedMotion}: {reducedMotion: boolean}) {
    const {address, status, connector} = useAccount();
    const {connectors} = useConnect();
    const {locale} = useLocale(), ko = locale === "ko";
    const section = arcadeSectionFromParam(useParams({strict: false}).section);
    const hash = useLocation({select: location => location.hash});
    const navigate = useNavigate();
    // A bare injected provider stays a guest while named wallets exist: the picker asks which one is meant.
    const owner = status === "connected" && address && (connector?.id !== "injected" || connectors.every(c => c.id === "injected")) ? address : undefined;
    const walletWaiting = status === "connecting" || status === "reconnecting";
    const [selected, setSelected] = useState<GameId>("stamp");
    const [screen, setScreen] = useState<Screen>({kind: "section"});
    // The only desk on the page: sections and the menu read it through props. A second instance would sign in twice and could
    // send the same transaction twice.
    const desk = useGuardianDesk(owner, walletWaiting, selected);
    const guestStore = useGuestPractice();
    // A wallet change closes its guardian's practice; browser back or forward closes any game, since the URL never held it.
    const [shown, setShown] = useState(owner);
    if (shown !== owner) {
        setShown(owner);
        if (screen.kind === "practice") setScreen({kind: "section"});
    }
    const [at, setAt] = useState(section);
    if (at !== section) {
        setAt(section);
        if (screen.kind !== "section") setScreen({kind: "section"});
    }
    // Arriving somewhere hands focus to its heading (or the linked panel), so keyboard and screen-reader users start there. The
    // router owns scrolling, including hash targets and back/forward restoration; only a return from a game scrolls here.
    const place = `${section}#${hash}`, last = useRef<string | null>(null);
    useEffect(() => {
        if (screen.kind !== "section") return;
        const previous = last.current;
        last.current = place;
        if (previous === null) return;
        const target = (hash ? document.getElementById(hash) : null) ?? document.getElementById(section === "lobby" ? "arc-room-title" : "arc-section-title");
        if (!target) return;
        if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
        target.focus({preventScroll: true});
        // Back from a game at the same address: the page under it was gone, so bring the place itself back into view.
        if (previous === place) {if (hash) target.scrollIntoView({block: "center"}); else window.scrollTo({top: 0});}
    }, [place, screen.kind]);

    // A game replaces the whole page, so it starts at its own top, not where the section was scrolled to before it was opened.
    useLayoutEffect(() => {if (screen.kind !== "section") window.scrollTo({top: 0});}, [screen.kind]);

    const go = (change: () => void) => swapScreen(reducedMotion, change);
    const visit = (next: ArcadeSection, target?: string) => void navigate(arcadeSectionLink(next, locale, target));
    function playGuest(game: GameId) {trackEngagement({event: "arcade_entered", game, locale}); go(() => {setSelected(game); setScreen({kind: "guest", game});});}
    function practice(token: GuardianToken, game: GameId) {go(() => {setSelected(game); setScreen({kind: "practice", token, game, seed: dailyChallenge(game, desk.now).seed});});}
    function meetGuardian(game: GameId) {setSelected(game); visit("guardians");}
    function sendOuting(game: GameId) {
        // A running outing keeps its own destination; otherwise the cabinet being browsed becomes the plan.
        if (!desk.activeJob) desk.setOperation({game});
        visit("outings", desk.activeJob ? "outings-title" : "arcade-allowance");
    }
    async function disconnect() {
        await desk.disconnect();
        visit("lobby");
    }
    const back = () => go(() => setScreen({kind: "section"}));
    // Shown only inside the open drawer, which never renders on the server, so wallet-derived values cannot split hydration.
    const roster = desk.nft.roster, badges: SectionBadges = {
        guardians: desk.stage === "waiting" ? ko ? "탄생 대기" : "Revealing" : roster?.guardians.length ? `${roster.guardians.length}/3` : undefined,
        outings: desk.activeJob ? outingStatusLabel(desk.activeJob.status, locale) ?? undefined : undefined,
        wallet: desk.giwa.grants.length ? String(desk.giwa.grants.length) : undefined,
    };
    const blocked = desk.busy || desk.session.status === "signing", leave = () => void disconnect();

    if (screen.kind === "guest") return <GuestArcade game={screen.game} store={guestStore} onBack={back} onGuardian={meetGuardian} />;
    if (screen.kind === "practice") return <NftPractice token={screen.token} game={screen.game} seed={screen.seed} ko={ko} reducedMotion={reducedMotion} returnLabel={SECTION_COPY[locale][section].back} onClose={back} />;
    return <main className="arcade agent-arcade arc-shell">
        <ArcadeHeader section={section} locale={locale} owner={owner} disconnecting={desk.disconnecting} blocked={blocked} onDisconnect={leave}
            menu={<ArcadeMenu locale={locale} owner={owner} walletWaiting={walletWaiting} badges={badges} disconnecting={desk.disconnecting} blocked={blocked} onDisconnect={leave} />} />
        <div className="arc-main">
            {section === "lobby" ? <ArcadeRoom locale={locale} selected={selected} onSelect={setSelected} reducedMotion={reducedMotion}>
                <LobbyDock desk={desk} game={selected} walletWaiting={walletWaiting} onPlayGuest={playGuest} onPractice={practice} onSendOuting={sendOuting} />
            </ArcadeRoom> : section === "guardians" ? <GuardiansSection desk={desk} walletWaiting={walletWaiting} onPractice={practice} />
                : section === "wallet" ? <WalletSection desk={desk} walletWaiting={walletWaiting} blocked={blocked} onDisconnect={leave} />
                : section === "outings" ? <OutingsSection desk={desk} walletWaiting={walletWaiting} />
                : <JournalSection desk={desk} walletWaiting={walletWaiting} />}
            <footer className="arc-footer"><p>{ko ? "작은 자유, 분명한 한도." : "A little freedom. A clear limit."}</p><span>GIWA SEPOLIA · {ko ? "테스트 토큰 사용" : "TEST TOKENS"}</span></footer>
        </div>
    </main>;
}
