import {useEffect, useRef, useState, type ReactNode} from "react";
import useEmblaCarousel from "embla-carousel-react";
import {ChevronLeft, ChevronRight} from "lucide-react";
import type {GameId} from "@mapae/arcade";
import type {Locale} from "../lib/i18n";
import {ArcadeBrand} from "./ArcadeBrand";
import {GAME_NAMES} from "./game-names";
import "./arcade-room.css";

const GAMES: GameId[] = ["race", "shop", "stamp"];
const DESCRIPTIONS = {
    ko: {race: "작전은 에이전트에게. 나는 결승선을 기다려요.", shop: "손님 마음을 읽고, 흥정으로 한 푼 더.", stamp: "톡! 탁! 도깨비만 골라 도장을 찍어요."},
    en: {race: "Your agent picks the tactics. You watch the finish.", shop: "Read the room. Strike a little bargain.", stamp: "Tap, stamp, repeat. Catch the cheeky goblins."},
};

/** The illustrated room stays separate from wallet permissions and game admission. */
export function ArcadeRoom({locale, selected, onSelect, locked = false, reducedMotion = false, children}: {
    locale: Locale; selected: GameId | "auto"; onSelect: (game: GameId) => void;
    locked?: boolean; reducedMotion?: boolean; children: ReactNode;
}) {
    const ko = locale === "ko";
    const [visible, setVisible] = useState(selected === "auto" ? 0 : GAMES.indexOf(selected));
    const [systemReduced, setSystemReduced] = useState(false);
    const still = reducedMotion || systemReduced;
    const [viewport, carousel] = useEmblaCarousel({
        align: "center", containScroll: false, duration: still ? 0 : 25,
        active: false, breakpoints: {"(max-width: 620px)": {active: true}},
    });
    const cabinets = useRef<(HTMLButtonElement | null)[]>([]);
    const current = useRef({selected, visible}); current.current = {selected, visible};
    const resetting = useRef(false);
    const names = GAME_NAMES[locale];

    useEffect(() => {
        const media = window.matchMedia("(prefers-reduced-motion: reduce)");
        const sync = () => setSystemReduced(media.matches);
        sync(); media.addEventListener("change", sync);
        return () => media.removeEventListener("change", sync);
    }, []);
    useEffect(() => {
        if (!carousel) return;
        const sync = () => {
            if (resetting.current || carousel.scrollSnapList().length !== GAMES.length) return;
            const index = carousel.selectedScrollSnap();
            setVisible(index); onSelect(GAMES[index]!);
        };
        const realign = () => {
            const index = current.current.selected === "auto" ? current.current.visible : GAMES.indexOf(current.current.selected);
            // A resize must preserve the choice, including "let my agent choose".
            resetting.current = true; carousel.scrollTo(index, true); resetting.current = false;
        };
        realign(); carousel.on("select", sync).on("reInit", realign);
        return () => {carousel.off("select", sync).off("reInit", realign);};
    }, [carousel, onSelect]);
    useEffect(() => {
        if (selected === "auto") return;
        const index = GAMES.indexOf(selected);
        setVisible(index); carousel?.scrollTo(index, still);
    }, [selected, carousel, still]);

    function choose(index: number) {
        const game = GAMES[index];
        if (!game) return;
        setVisible(index); onSelect(game); carousel?.scrollTo(index, still);
    }
    return <section className="arc-room" aria-labelledby="arc-room-title">
        <picture className="arc-room-background"><source media="(max-width: 620px)" srcSet="/arcade/hanok-room-768.webp" /><img src="/arcade/hanok-room-1536.webp" width={1536} height={1024} alt="" fetchPriority="high" /></picture>
        <div className="arc-room-sign"><ArcadeBrand /><h1 id="arc-room-title">{ko ? "오늘은 뭐 하고 놀까요?" : "What shall we play today?"}</h1></div>
        <div className="arc-room-viewport" ref={viewport}>
        <div className="arc-room-cabinets" role="group" aria-label={ko ? "놀이 선택" : "Choose a game"}>
            {GAMES.map((game, index) => <button type="button" key={game} ref={node => {cabinets.current[index] = node;}}
                className={`arc-room-cabinet arc-room-cabinet-${game}`} aria-pressed={selected === game}
                aria-label={`${names[game]} — ${DESCRIPTIONS[locale][game]}`} onClick={() => choose(index)}
                onKeyDown={event => {
                    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                    event.preventDefault();
                    const next = event.key === "Home" ? 0 : event.key === "End" ? GAMES.length - 1 : Math.max(0, Math.min(GAMES.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)));
                    choose(next); cabinets.current[next]?.focus({preventScroll: true});
                }}>
                <img src={`/arcade/cabinet-${game}-640.webp`} srcSet={`/arcade/cabinet-${game}-384.webp 384w, /arcade/cabinet-${game}-640.webp 640w`} sizes="(max-width: 620px) 72vw, (max-width: 1000px) 28vw, 300px" width={640} height={960} alt="" draggable={false} />
                <span className="arc-room-marquee" lang={locale}>{names[game]}</span>
                <span className="arc-room-crt" aria-hidden="true" />
                <span className="arc-room-slot">{locked ? ko ? "연결 후 플레이" : "CONNECT TO PLAY" : selected === game ? ko ? "선택 완료 ✓" : "SELECTED ✓" : ko ? "놀이 선택 ↗" : "SELECT GAME ↗"}</span>
            </button>)}
        </div></div>
        <div className="arc-room-navigation" role="group" aria-label={ko ? "게임기 넘기기" : "Browse cabinets"}>
            <button type="button" aria-label={ko ? "이전 게임기" : "Previous cabinet"} disabled={visible === 0} onClick={() => choose(visible - 1)}><ChevronLeft size={19} /></button>
            {GAMES.map((game, index) => <button type="button" key={game} className="arc-room-dot" aria-label={names[game]} aria-current={visible === index ? "true" : undefined} onClick={() => choose(index)}><span /></button>)}
            <button type="button" aria-label={ko ? "다음 게임기" : "Next cabinet"} disabled={visible === GAMES.length - 1} onClick={() => choose(visible + 1)}><ChevronRight size={19} /></button>
        </div>
        <div className="arc-room-selection" role="status" aria-live="polite" aria-atomic="true"><strong>{names[GAMES[visible]!]}</strong><span>{DESCRIPTIONS[locale][GAMES[visible]!]}</span></div>
        <p className="arc-room-hint"><span className="arc-room-swipe-hint">{ko ? "← 좌우로 밀어서 고르세요 →" : "← Swipe to choose →"}</span><span className="arc-room-click-hint">{ko ? "게임기를 눌러 놀 거리를 골라 보세요" : "Pick a cabinet. Find your next little adventure."}</span></p>
        {children && <div className="arc-room-dock">{children}</div>}
    </section>;
}
