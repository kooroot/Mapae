import {ProfileSyncStatus} from "./ProfileSync";
import {BrandSelect} from "../components/BrandSelect";
import {PlaySettings} from "./PlaySettings";
import {useEffect, useRef, useState} from "react";
import {ArrowLeft, Volume2, VolumeX} from "lucide-react";
import {LocaleSwitch, useLocale} from "../lib/locale";
import {localizePath, type Locale} from "../lib/i18n";
import {ArcadeBrand} from "./ArcadeBrand";
import {Arena} from "./Arena";
import {CharacterEditor} from "./CharacterRoster";
import {GuardianAvatar} from "./GuardianAvatar";
import {Goblin, GameArt} from "./Characters";
import {admitPracticeRun, selectCharacter, updateCharacter, finishPracticeRun, type Companion, type ArcadeState, type Run} from "./state";
import type {Game} from "./game";
import type {useArcadeState} from "./useArcadeState";
import {ArcadeSound} from "./sound";
import {ResultImage} from "./ResultImage";
import "./arcade.css";

const COPY = {
    en: {
        home: "Back to Mapae", demo: "HUMAN PRACTICE · FREE", soundOn: "Sound on", soundOff: "Sound off",
        settings: "Play settings", reducedMotion: "Reduce motion", heading: "A little break. A little mischief.",
        intro: "Take the controls and practice your stamps.", choose: "HUMAN PRACTICE", game: "Dokkaebi Stamp",
        gameSub: "Goblins get the stamp. Couriers get a pass.", sixty: "60 SEC", tap: "TAP TO PLAY", play: "Start practice",
        oneTicket: "Practice is always free. No tokens or allowance are spent.",
        how: "THE ENTIRE RULEBOOK", hit: "Stamp a goblin", hitSub: "+100 points · combos multiply", skip: "Let the courier pass", skipSub: "Wrong stamp: −100 · combo resets",
        player: "YOUR AGENT", edit: "Customize", newPlayer: "Your little troublemaker.", personality: "Personality is for character only; everyone plays by the same rules.",


        history: "PLAY LOG", empty: "Your first adventure goes here.", best: "PERSONAL BEST", points: "pts", unfinished: "Interrupted / in progress",
        setup: "MEET YOUR AGENT", setupTitle: "Who's heading to the arcade?", name: "Agent name", color: "Scarf color", temperament: "Personality",
        red: "Vermilion", jade: "Jade", ink: "Ink", curious: "Curious", bold: "Bold", calm: "Easygoing",
        cancel: "Back", save: "Save character", nameHelp: "1–12 characters", controls: "Tap the windows, or use keys 1–9.",
        result: "ROUND RECEIPT", finished: "Good work, little agent.", early: "A short but sweet round.", record: "NEW PERSONAL BEST!",
        maxCombo: "Best combo", stamped: "Goblins stamped", errors: "Couriers hit", missed: "Goblins missed", spent: "Spent this round",
        free: "FREE PRACTICE", human: "Human played · no autoplay",
        retry: "Practice again", lobby: "Back to the arcade",

        duplicate: "That round already has a ticket.",
        soundError: "Audio isn't available in this browser. You can still play silently.",
        ruleMiss: "Miss a goblin and your combo resets. Every 5 stamps increases the multiplier, up to ×4.",
        loading: "Opening the arcade…",
    },
    ko: {
        home: "마패로 돌아가기", demo: "직접 연습 · 무료", soundOn: "소리 켬", soundOff: "소리 끔",
        settings: "플레이 설정", reducedMotion: "움직임 줄이기", heading: "잠깐, 한 판 하고 갈까요?",
        intro: "이번에는 내가 직접 도장찍기를 연습해요.", choose: "직접 연습하기", game: "도깨비 도장찍기",
        gameSub: "도깨비는 콕! 마패 배달부는 통과!", sixty: "60초 한 판", tap: "톡 누르면 끝", play: "연습 시작하기",
        oneTicket: "직접 연습은 무료예요. 테스트 토큰과 용돈을 사용하지 않아요.",
        how: "설명은 이게 전부!", hit: "도깨비는 찍어요", hitSub: "+100점 · 콤보를 쌓으면 배수 UP", skip: "배달부는 보내줘요", skipSub: "잘못 찍으면 −100점 · 콤보 초기화",
        player: "나의 에이전트", edit: "꾸미기", newPlayer: "같이 놀러 갈 작은 친구.", personality: "성향은 캐릭터 설정이에요. 게임 능력치는 모두 같아요.",


        history: "놀다 온 기록", empty: "첫 번째 모험을 기다리는 중.", best: "나의 최고 기록", points: "점", unfinished: "중단 또는 진행 중",
        setup: "에이전트 출석부", setupTitle: "누구랑 놀러 갈까요?", name: "에이전트 이름", color: "목도리 색", temperament: "성향",
        red: "주홍", jade: "비취", ink: "먹색", curious: "호기심쟁이", bold: "돌격대장", calm: "느긋한 친구",
        cancel: "돌아가기", save: "꾸미기 저장", nameHelp: "1–12자", controls: "창문을 톡 누르거나, 키보드 숫자 1–9로 찍어요.",
        result: "오늘의 오락 영수증", finished: "잘 놀았다, 우리 에이전트.", early: "짧고 굵게 놀았어요.", record: "최고 기록 경신!",
        maxCombo: "최대 콤보", stamped: "퇴치한 도깨비", errors: "잘못 찍은 배달부", missed: "놓친 도깨비", spent: "이번 판 사용",
        free: "무료 연습", human: "사람이 직접 플레이 · 자동 플레이 없음",
        retry: "한 번 더 연습하기", lobby: "오락실로 돌아가기",

        duplicate: "이미 입장권을 사용한 판이에요.",
        soundError: "이 브라우저에서 소리를 켤 수 없어요. 소리 없이도 플레이할 수 있어요.",
        ruleMiss: "도깨비를 놓치면 콤보가 끊겨요. 5번 연속 찍을 때마다 점수 배수가 올라가요. 최대 ×4!",
        loading: "오락실 문 여는 중…",
    },
} satisfies Record<Locale, Record<string, string>>;
type Screen = "lobby" | "setup" | "play" | "result";

export function PracticeArcade({onBack, store, character}: {onBack: () => void; store: ReturnType<typeof useArcadeState>; character: Companion}) {
    const {locale} = useLocale();
    const t = COPY[locale];
    const {demo, ready, update} = store;
    const characterRuns = demo.runs.filter(r => r.characterId === character.id);
    const [screen, setScreen] = useState<Screen>("lobby");
    const [sound] = useState(() => new ArcadeSound());
    const [ticket, setTicket] = useState<Run | null>(null);
    const [result, setResult] = useState<Run | null>(null);
    const [early, setEarly] = useState(false);
    const [record, setRecord] = useState(false);
    const [notice, setNotice] = useState("");
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [editing, setEditing] = useState(false);
    const entryLock = useRef(false);
    const focusHeading = useRef<HTMLHeadingElement>(null);
    useEffect(() => () => sound.dispose(), [sound]);
    useEffect(() => {
        entryLock.current = false;
        if (screen !== "play") focusHeading.current?.focus({preventScroll: true});
        window.scrollTo({top: 0, behavior: "instant"});
    }, [screen]);

    function begin(next: ArcadeState = demo) {
        if (entryLock.current || !ready) return;
        entryLock.current = true;
        const admission = admitPracticeRun(next, crypto.randomUUID(), Date.now());
        if (!admission.ok) {
            setNotice(admission.reason === "character" ? t.setupTitle : t.duplicate);
            entryLock.current = false;
            return;
        }
        update(() => admission.demo);
        setTicket(admission.ticket);
        setNotice("");
        void sound.enable(next.sound).then(ok => {if (!ok) setNotice(t.soundError);});
        setScreen("play");
    }
    function finish(game: Game, stopped: boolean) {
        if (!ticket) return;
        setRecord((game.score > (demo.characters.find(c => c.id === ticket.characterId)?.best ?? 0)));
        const next = update(value => finishPracticeRun(value, ticket.id, game));
        const run = next.runs.find(r => r.id === ticket.id);
        if (run) setResult(run);
        setEarly(stopped);
        setScreen("result");
    }
    function lobby() {setNotice(""); setScreen("lobby");}
    async function toggleSound() {
        const enabled = !demo.sound;
        const ok = await sound.enable(enabled);
        update(value => ({...value, sound: ok && enabled}));
        if (ok && enabled) sound.play("hit");
        if (!ok) setNotice(t.soundError);
    }
    return (
        <main className={`arcade arc-practice ${demo.reducedMotion ? "arc-still" : ""}`}>
            <header className="arc-header"><button className="arc-back" onClick={onBack} aria-label={locale === "ko" ? "에이전트 오락실로 돌아가기" : "Back to agent arcade"}><ArrowLeft size={20} /></button>
                <a className="arc-wordmark" href={localizePath("/", locale)} aria-label={t.home}><ArcadeBrand /></a>
                <span className="arc-demo-label"><i /> {t.demo}</span>
                <div className="arc-header-actions">
                    <button className="arc-sound" aria-label={demo.sound ? t.soundOn : t.soundOff} aria-pressed={demo.sound} onClick={() => void toggleSound()}>{demo.sound ? <Volume2 size={17} /> : <VolumeX size={17} />}<span>{demo.sound ? t.soundOn : t.soundOff}</span></button>
                    <PlaySettings onOpenChange={setSettingsOpen} ko={locale === "ko"} reducedMotion={demo.reducedMotion} onReducedMotionChange={reducedMotion => update(v => ({...v, reducedMotion}))} />
                    {screen !== "play" && <LocaleSwitch />}
                </div>
            </header>
            <div className="arc-main">
                <ProfileSyncStatus store={store} ko={locale === "ko"} />
                {notice && <p className="arc-notice" role="status">{notice}</p>}
                {screen === "lobby" && <>
                    <div className="arc-intro"><div><h1 ref={focusHeading} tabIndex={-1}>{t.heading}</h1><p>{t.intro}</p></div></div>
                    <div className="arc-lobby-grid">
                        <div className="arc-machines">
                            <div className="arc-section-label"><span>01 — {t.choose}</span></div>
                            <section className="arc-cabinet">
                                <div className="arc-cabinet-marquee"><span className="arc-bulbs" aria-hidden="true">● ● ●</span><span>{t.game}</span><span className="arc-bulbs" aria-hidden="true">● ● ●</span></div>
                                <div className="arc-cabinet-screen">
                                    <div className="arc-game-tags"><span>{t.sixty}</span><span>{t.tap}</span></div>
                                    <h2>{t.game}</h2><p>{t.gameSub}</p>
                                    <GameArt game="stamp" className="arc-practice-cover" />

                                </div>
                                <div className="arc-control-deck"><div className="arc-joystick" aria-hidden="true"><i /><b /></div><button className="arc-button" disabled={!ready} onClick={() => {
                                    if (!character.configured) {setEditing(false); setScreen("setup");} else begin();
                                }}>{!ready ? t.loading : t.play}<span>→</span></button><div className="arc-arcade-buttons" aria-hidden="true"><i /><i /></div></div>
                                <p className="arc-cabinet-caption">{t.oneTicket}</p>
                            </section>
                            <div className="arc-instructions"><span className="arc-overline">{t.how}</span><div className="arc-rule-pair"><div><Goblin /><span><b>{t.hit}</b><small>{t.hitSub}</small></span></div><div><GuardianAvatar appearance={character.appearance} color={character.color} /><span><b>{t.skip}</b><small>{t.skipSub}</small></span></div></div><p>{t.ruleMiss}</p></div>

                        </div>
                        <aside className="arc-side">
                            <section className="arc-player-pass"><div className="arc-section-label"><span>{t.player}</span><button onClick={() => {setEditing(true); setScreen("setup");}}>{t.edit} ↗</button></div>
                                <BrandSelect className="arc-practice-character-select" tone="paper" label={locale === "ko" ? "플레이할 캐릭터" : "Playing as"} value={character.id} onValueChange={id => update(v => selectCharacter(v, id))} options={demo.characters.map(c => ({value: c.id, label: c.name}))} /><div className="arc-pass-portrait"><GuardianAvatar appearance={character.appearance} color={character.color} /><span className="arc-pass-stamp">PLAYER<br />01</span></div><h2>{character.name}</h2><p>{t[character.temperament]} <span>· {t.newPlayer}</span></p>
                                <div className="arc-personal-best"><span>{t.best}</span><strong>{character.best.toLocaleString()}<small>{t.points}</small></strong></div>
                            </section>
                            <section className="arc-history"><h2 className="arc-overline">{t.history}</h2>{characterRuns.length === 0 ? <p className="arc-empty">{t.empty}</p> : <ol>{characterRuns.slice(0, 4).map(run => <li key={run.id}><span><b>{run.name}</b><small>{run.status === "complete" ? `${run.score.toLocaleString()} ${t.points} · ${run.bestCombo} COMBO` : t.unfinished}</small></span><span>{t.free}</span></li>)}</ol>}</section>
                        </aside>
                    </div>
                </>}
                {screen === "setup" && <CharacterEditor member={character} creating={false} ko={locale === "ko"} onClose={lobby} onSave={draft => {
                    const next = update(v => updateCharacter(v, character.id, {name: draft.name, color: draft.color, appearance: draft.appearance, temperament: draft.temperament, agent: draft.agent, configured: true}));
                    if (editing) lobby(); else begin(next);
                }} />}
                {screen === "play" && ticket && <Arena suspended={settingsOpen} key={ticket.id} locale={locale} character={{...character, name: ticket.name, color: ticket.color, appearance: ticket.appearance}} reducedMotion={demo.reducedMotion} sound={sound} onFinish={finish} />}
                {screen === "result" && result && <section className="arc-result-layout"><div className="arc-result-paper">
                    <div className="arc-section-label"><span>{t.result}</span><span>NO. {demo.runs.length.toString().padStart(3, "0")}</span></div>
                    <div className="arc-result-character"><GuardianAvatar appearance={result.appearance} color={result.color} /><span>{result.name}<small>{t.human}</small></span><span className="arc-result-seal">{locale === "ko" ? early ? "수고" : "완주" : "GG!"}</span></div>
                    <h1 ref={focusHeading} tabIndex={-1}>{early ? t.early : t.finished}</h1>
                    <div className="arc-result-score"><span>{record ? t.record : t.game}</span><strong>{result.score.toLocaleString()}</strong><small>{t.points}</small></div>
                    <div className="arc-result-stats"><div><span>{t.maxCombo}</span><b>{result.bestCombo}</b></div><div><span>{t.stamped}</span><b>{result.hits}</b></div><div><span>{t.errors}</span><b>{result.mistakes}</b></div><div><span>{t.missed}</span><b>{result.missed}</b></div></div>
                    <dl className="arc-receipt-lines"><div><dt>{t.spent}</dt><dd>{t.free}</dd></div><div><dt>{t.best}</dt><dd>{(demo.characters.find(c => c.id === result.characterId)?.best ?? 0).toLocaleString()} {t.points}</dd></div></dl>
                    <p className="arc-receipt-disclaimer">{t.demo}</p>
                </div><div className="arc-result-actions"><button className="arc-button" onClick={() => begin(update(v => selectCharacter(v, result.characterId)))}>{t.retry} →</button><button className="arc-button arc-button-paper" onClick={onBack}><ArrowLeft size={16} /> {t.lobby}</button><ResultImage run={result} best={demo.characters.find(c => c.id === result.characterId)?.best ?? 0} locale={locale} /></div></section>}
                {screen !== "play" && <footer className="arc-footer"><p>{t.demo}</p><a href={localizePath("/", locale)}>MAPAE.IO ↗</a></footer>}
            </div>
        </main>
    );
}
