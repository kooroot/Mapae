import {useEffect, useRef, useState} from "react";
import {useLocale} from "../lib/locale";
import {guardianAsset, type Zodiac} from "../arcade/guardian";
import {welcomeGuest} from "./arcade-greeter-store";
import "./arcade-invitation.css";

const COPY = {
    en: {title: "A little play break?", enter: "Enter the arcade", label: "Enter Mapae Arcade", collapse: "Minimize arcade invitation", expand: "Expand arcade invitation", arcade: "Arcade"},
    ko: {title: "잠깐, 놀다 갈까요?", enter: "오락실 놀러 가기", label: "마패 아케이드 입장", collapse: "아케이드 초대장 접기", expand: "아케이드 초대장 펼치기", arcade: "오락실"},
};
const GREETINGS: Record<Zodiac, {ko: string; en: string}> = {
    rat: {ko: "딱 한 판, 어때요?", en: "Just one more round?"},
    ox: {ko: "일했으니, 놀아야죠.", en: "Time for a play break."},
    tiger: {ko: "한 판 붙어볼까요?", en: "Up for a challenge?"},
    rabbit: {ko: "저랑 놀러 갈래요?", en: "Hop in and play!"},
    dragon: {ko: "오늘은 좀 놀아볼까?", en: "Let's make it fun."},
    snake: {ko: "재밌는 수가 있어요.", en: "I have a fun little plan."},
    horse: {ko: "오락실까지 모실게요.", en: "Your arcade escort!"},
    goat: {ko: "같이 가면 더 재밌죠.", en: "Better with a friend."},
    monkey: {ko: "재밌는 데 알아요!", en: "I know a fun place!"},
    rooster: {ko: "오락실, 문 열었어요!", en: "The arcade is open!"},
    dog: {ko: "기다렸어요. 같이 가요!", en: "There you are! Let's go."},
    pig: {ko: "놀러 갈 준비 됐어요?", en: "Ready for some fun?"},
};

/** A floating invitation, mounted outside the hero's clipping and scroll animation. */
export function ArcadeInvitation() {
    const {locale} = useLocale();
    const t = COPY[locale];
    const [guest, setGuest] = useState<Zodiac | null>(null);
    const [ready, setReady] = useState(false);
    const [minimized, setMinimized] = useState(false);
    const welcomed = useRef(false);
    useEffect(() => {
        // Client-only randomness keeps SSR hydration stable; Strict Mode must not roll twice.
        if (!welcomed.current) {
            welcomed.current = true;
            setGuest(welcomeGuest());
        }
        const onReturn = (event: PageTransitionEvent) => {
            if (!event.persisted) return;
            setReady(false);
            setGuest(welcomeGuest());
        };
        window.addEventListener("pageshow", onReturn);
        return () => window.removeEventListener("pageshow", onReturn);
    }, []);
    const title = guest ? GREETINGS[guest][locale] : t.title;
    return <aside className="arcade-invitation-widget" aria-label="Mapae Arcade" data-minimized={minimized}>
        <a className="arcade-invitation" href={locale === "ko" ? "/ko/arcade" : "/arcade"}
            aria-label={minimized ? t.label : `${title} — ${t.label}`} data-guest={guest} data-ready={ready}>
            <span className="arcade-invitation-art" aria-hidden="true">
                {guest && <img className="arcade-invitation-friend" src={guardianAsset(guest, 256)} width={256} height={256} alt="" decoding="async" onLoad={() => setReady(true)} />}
                <span className="arcade-invitation-badge">{t.arcade}</span>
            </span>
            <span className="arcade-invitation-copy" id="arcade-invitation-copy"><span>MAPAE ARCADE</span><strong>{title}</strong><small>{t.enter}<span aria-hidden="true">↗</span></small></span>
        </a>
        <button type="button" className="arcade-invitation-toggle" onClick={() => setMinimized(value => !value)}
            aria-label={minimized ? t.expand : t.collapse} aria-expanded={!minimized} aria-controls="arcade-invitation-copy">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d={minimized ? "M4 10L8 6L12 10" : "M4 6L8 10L12 6"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
    </aside>;
}
