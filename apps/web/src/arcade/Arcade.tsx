import {ConfirmDialog} from "../components/ConfirmDialog";
import {PlaySettings} from "./PlaySettings";
import {useEffect, useRef, useState} from "react";
import {Volume2, VolumeX, ArrowLeft, LoaderCircle} from "lucide-react";
import type {ActivityOutcome, AgentProfile, GameId} from "@mapae/arcade";
import {useLocale, LocaleSwitch} from "../lib/locale";
import {localizePath} from "../lib/i18n";
import {useArcadeState} from "./useArcadeState";
import {ProfileAccess, ProfileSyncStatus} from "./ProfileSync";
import {logoutProfile} from "./profile/client";
import {selectedCharacter, selectCharacter, updateCharacter} from "./state";
import {admitActivity, completeActivity, practiceBest, paidBest, latestShopMemory, type Activity} from "./activity";
import {modelDecision} from "./agents";
import {GuardianAvatar} from "./GuardianAvatar";
import {ArcadeSound} from "./sound";
import {PracticeArcade} from "./PracticeArcade";
import {StampAgent} from "./StampAgent";
import {RaceGame} from "./race/RaceGame";
import {ShopGame} from "./shop/ShopGame";
import {ArcadeBrand} from "./ArcadeBrand";
import {ArcadeRoom} from "./ArcadeRoom";
import {GAME_NAMES} from "./game-names";
import {CharacterRoster} from "./CharacterRoster";
import {AgentReceipt} from "./AgentReceipt";
import {Web3Providers} from "../dapp/Web3Providers";
import {useGiwaTickets} from "./useGiwaTickets";
import type {Address} from "viem";
import {MOCK_USDC} from "@mapae/shared";
import {ARCADE_TICKET_COST} from "@mapae/arcade/tickets";
import {WalletGate} from "./WalletGate";
import {ArcadeHistory} from "./ArcadeHistory";
import {ArcadeJourney, ArcadeDestination} from "./ArcadeJourney";
import {OutingBoard} from "./OutingBoard";
import {DailyChallenge} from "./DailyChallenge";
import {GiwaAllowance} from "./GiwaAllowance";
import {gameSeed, replaySeed, withReplay} from "./replay";
import "./arcade.css";
import "./agent-arcade.css";
import "./arcade-brand.css";
import "./arcade-lobby.css";

export function Arcade() {
    return <Web3Providers><WalletGate>{(owner, initialGame) => <AgentArcade key={owner.toLowerCase()} owner={owner} initialGame={initialGame} />}</WalletGate></Web3Providers>;
}

function AgentArcade({owner, initialGame}: {owner: Address; initialGame: GameId | "auto"}) {
    const [practice, setPractice] = useState<GameId | null>(null);
    const [practiceChallenge, setPracticeChallenge] = useState<({seed: number; name: string; score: number; daily?: boolean} & Pick<NonNullable<ActivityOutcome["replay"]>, "shop" | "shopMemory">) | undefined>();
    const arcadeRoot = useRef<HTMLElement>(null);
    const quickStart = useRef<HTMLElement>(null);
    const onPractice = () => {setPracticeChallenge(undefined); setPractice(requested === "auto" ? "stamp" : requested);};
    const {locale} = useLocale();
    const ko = locale === "ko";
    const store = useArcadeState(owner);
    const giwa = useGiwaTickets(locale, store.saved);
    const {demo, ready, saved, update} = store;
    const current = useRef(demo); current.current = demo;
    const [sound] = useState(() => new ArcadeSound());
    const [screen, setScreen] = useState<"lobby" | "thinking" | "game" | "receipt">("lobby");
    const [activity, setActivity] = useState<Activity | null>(null);
    const [activeProfile, setActiveProfile] = useState<AgentProfile | null>(null);
    const [error, setError] = useState("");
    const [disconnecting, setDisconnecting] = useState(false);
    const [requested, setRequested] = useState<GameId | "auto">(initialGame);
    const [exitOpen, setExitOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [selection, setSelection] = useState<string[] | null>(null);
    const selected = (selection ?? (demo.selectedCharacterId ? [demo.selectedCharacterId] : [])).filter(id => demo.characters.some(c => c.id === id));
    const members = demo.characters.filter(c => selected.includes(c.id));
    const selectedRemaining = giwa.jobs.filter(j => members.some(c => c.id === j.characterId) && ["queued", "running", "paused"].includes(j.status)).reduce((total, j) => total + j.admissions - j.spent, 0);
    const prepared = members.length > 0 && members.every(c => giwa.jobs.some(j => j.characterId === c.id && ["queued", "running"].includes(j.status)));
    const admissions = members.reduce((total, c) => total + c.agent.rounds, 0);
    const character = selectedCharacter(demo);
    const busy = useRef(false);
    const giwaSetup = useRef<HTMLElement>(null);
    const abort = useRef<AbortController | null>(null);
    const profile: AgentProfile | null = character ? {name: character.name, color: character.color, temperament: character.temperament, goal: character.agent.goal} : null;
    const names = GAME_NAMES[locale];

    useEffect(() => () => {abort.current?.abort(); sound.dispose();}, []);
    useEffect(() => {window.scrollTo({top: 0, behavior: "instant"});}, [screen]);
    const imported = giwa.jobs.map(j => `${j.id}:${j.spent}:${j.status}`).join("|");
    useEffect(() => {if (ready) void store.refresh();}, [imported, ready]);
    useEffect(() => {
        const bar = quickStart.current;
        const root = arcadeRoot.current;
        if (!bar || !root) return;
        // Reserve the actual action bar height, including wrapped labels and text zoom.
        const resize = new ResizeObserver(() => root.style.setProperty("--arc-quick-height", `${bar.getBoundingClientRect().height}px`));
        resize.observe(bar);
        return () => {resize.disconnect(); root.style.removeProperty("--arc-quick-height");};
    }, [screen, practice, ready, demo.characters.length]);
    async function toggleSound() {
        const enabled = !current.current.sound;
        const ok = await sound.enable(enabled);
        update(v => ({...v, sound: ok && enabled}));
        if (ok && enabled) sound.play("hit");
    }
    async function disconnect() {
        setDisconnecting(true);
        try {
            if (ready) await store.flush();
            await logoutProfile(owner);
        } catch { /* The recovery draft is retained; a different wallet cannot access this session. */ }
        finally {giwa.disconnect();}
    }
    function stop() {
        abort.current?.abort(); busy.current = false;
        if (activity) update(v => completeActivity(v, activity.id, null));
        setScreen("lobby"); setError("");
    }
    // Already-paid, unresolved admissions remain recoverable; new outings run on the server.
    async function recoverTicket() {
        const pending = giwa.pending;
        if (!pending || busy.current || !ready) return;
        const member = current.current.characters.find(c => c.id === pending.characterId);
        if (!member) return;
        busy.current = true; setError(""); setScreen("thinking");
        const controller = new AbortController(); abort.current = controller;
        try {
            let recorded = current.current.activities.find(a => a.id === pending.requestId);
            if (!recorded) {
                const receipt = await giwa.buy(pending.game, pending.requestId, pending.characterId);
                update(v => {
                    const admitted = admitActivity(v, {id: pending.requestId, characterId: pending.characterId, game: pending.game, mode: "rules", source: "mapae-giwa", ticketId: receipt.transaction, model: null, reason: ko ? "추가 결제 없이 입장권을 복구했어요." : "Recovered without a new payment.", giwa: {balanceAfter: receipt.balanceAfter, allowanceAfter: receipt.allowanceAfter}}, Date.now());
                    if (!admitted.ok) throw new Error("Admission could not be saved");
                    recorded = admitted.activity; return admitted.demo;
                });
            }
            await store.flush();
            const claimed = await giwa.acknowledge();
            if (controller.signal.aborted || !recorded) return;
            setActivity(recorded); setActiveProfile({name: member.name, color: member.color, temperament: member.temperament, goal: member.agent.goal});
            setScreen(claimed && recorded.status === "active" ? "game" : "receipt");
        } catch {if (!controller.signal.aborted) {setError(ko ? "입장권을 확인하지 못했어요. 같은 입장권으로 다시 복구해 주세요." : "Could not confirm admission. Recover the same ticket again."); setScreen("lobby");}}
        finally {busy.current = false;}
    }
    function complete(outcome: ActivityOutcome) {
        if (!activity) return;
        const next = update(v => completeActivity(v, activity.id, withReplay(outcome, gameSeed(activity))));
        const finished = next.activities.find(a => a.id === activity.id);
        if (!finished || finished.status !== "complete") {setError(ko ? "결과 검증에 실패했어요." : "Result validation failed."); return;}
        setActivity(finished); setScreen("receipt");
    }
    const playingProfile = activeProfile ?? profile;
    const gameProps = {appearance: activity?.appearance, locale, mode: activity?.source === "mapae-giwa" ? activity.mode : character?.agent.mode ?? "rules", seed: activity ? gameSeed(activity) : 1,
        budget: {balance: Number(giwa.balance ?? 0), allowance: 0}, decide: modelDecision,
        reducedMotion: demo.reducedMotion, suspended: exitOpen || settingsOpen, autoAdvance: true, onComplete: complete, onExit: () => setExitOpen(true)};
    const canLaunch = ready && saved && giwa.recoveryReady && !giwa.busy && (!!giwa.pending || !!giwa.submission || (giwa.available && members.length > 0 && members.every(c => c.agent.mode === "rules" && !giwa.jobs.some(j => j.characterId === c.id && ["queued", "running", "paused"].includes(j.status)))));
    function quickLaunch() {
        if (giwa.pending) {void recoverTicket(); return;}
        if (giwa.submission) {void giwa.recoverSubmission(); return;}
        giwaSetup.current?.scrollIntoView({block: "center", behavior: "instant"}); giwaSetup.current?.focus({preventScroll: true});
    }
    const launchLabel = giwa.busy ? ko ? "출발 준비 중…" : "Preparing…" : giwa.pending ? ko ? "입장권 복구" : "Recover ticket" : giwa.submission ? ko ? "외출 요청 확인" : "Recover outing request" : ko ? "용돈 정하고 보내기" : "Set allowance and send";
    const entryLabel = ko ? `1회 ${ARCADE_TICKET_COST} ${MOCK_USDC.symbol} · 최대 ${admissions}회` : `${ARCADE_TICKET_COST} ${MOCK_USDC.symbol} per admission · Up to ${admissions} visits`;
    if (!ready) return <ProfileAccess store={store} ko={ko} onDisconnect={() => void disconnect()} />;
    function practiceResult(a: Activity) {
        const seed = replaySeed(a.outcome);
        if (seed === undefined || !a.outcome) return;
        update(v => selectCharacter(v, a.characterId));
        setPracticeChallenge({seed, name: a.name, score: a.outcome.score, shop: a.outcome.replay?.shop, shopMemory: a.outcome.replay?.shopMemory}); setPractice(a.game);
    }
    if (practice && character) return <PracticeArcade initialGame={practice} initialReplay={practiceChallenge} store={store} character={character} onBack={() => {setPractice(null); setPracticeChallenge(undefined);}} />;
    return <main ref={arcadeRoot} data-screen={screen} className={`arcade agent-arcade ${screen === "lobby" ? "agent-in-lobby" : ""} ${demo.reducedMotion ? "arc-still" : ""}`}>
        <header className="arc-header"><a className="arc-wordmark" href={localizePath("/", locale)} aria-label={ko ? "Mapae 홈" : "Mapae home"}><ArcadeBrand /></a>
            <span className="arc-demo-label"><i />{ko ? "GIWA 테스트넷 · 테스트 토큰" : "GIWA SEPOLIA · TEST TOKENS"}</span>
            <div className="arc-header-actions"><button className="arc-sound" aria-label={ko ? demo.sound ? "소리 켬" : "소리 끔" : demo.sound ? "Sound on" : "Sound off"} aria-pressed={demo.sound} onClick={() => void toggleSound()}>{demo.sound ? <Volume2 size={18} /> : <VolumeX size={18} />}</button><PlaySettings onOpenChange={setSettingsOpen} ko={ko} reducedMotion={demo.reducedMotion} onReducedMotionChange={reducedMotion => update(v => ({...v, reducedMotion}))} />{screen === "lobby" && <LocaleSwitch />}</div>
        </header>
        <div className="arc-main">
            {screen !== "lobby" && <ProfileSyncStatus store={store} ko={ko} />}
            {error && <p className="arc-notice" role="alert">{error}</p>}
            {screen === "lobby" && <>
                <div className="arc-wallet-identity"><span>{giwa.walletName} · {owner.slice(0, 6)}…{owner.slice(-4)}</span><button className="arc-text-button" disabled={giwa.busy || disconnecting} onClick={() => void disconnect()}>{ko ? "지갑 바꾸기 / 연결 해제" : "Change / disconnect wallet"}</button></div>
                <ArcadeRoom locale={locale} selected={requested} onSelect={setRequested} reducedMotion={demo.reducedMotion}>
                    {demo.characters.length === 0 ? <div className="arc-empty-departure"><div><h2>{ko ? "첫 친구를 만나볼까요?" : "Meet your first little friend"}</h2><p>{ko ? "캐릭터를 만들고, 함께 놀 거리를 골라요." : "Create your character, then pick an adventure."}</p></div><a className="arc-button" href="#arcade-crew">{ko ? "캐릭터 만들러 가기" : "Create a character"} ↓</a></div> : null}
                </ArcadeRoom>
                {demo.characters.length > 0 && <section ref={quickStart} className="agent-quickstart" aria-label={ko ? "선택한 놀이 시작" : "Start selected activity"}>
                    <div className="agent-quick-profile">{character && <GuardianAvatar appearance={character.appearance} color={character.color} />}<div><strong>{requested === "auto" ? ko ? "에이전트가 고를게요" : "Let my agent choose" : names[requested]}</strong><span>{ko ? `${members.length}명 · 최대 ${admissions}회 · 차례로` : `${members.length} friends · up to ${admissions} visits`}</span><span className="agent-mobile-budget">{ko ? "용돈" : "Allowance"} {(selectedRemaining * ARCADE_TICKET_COST).toFixed(2)} / {ko ? "잔액" : "Balance"} {giwa.balance ?? "—"} {MOCK_USDC.symbol}</span></div></div>
                    <div className="agent-quick-budget"><span>GIWA · {MOCK_USDC.symbol}</span><strong>{(selectedRemaining * ARCADE_TICKET_COST).toFixed(2)}<small> / {giwa.balance ?? "—"} {ko ? "보유" : "balance"}</small></strong></div>
                    <div className="agent-quick-action"><button className="arc-button" disabled={!canLaunch} onClick={quickLaunch}>{launchLabel} <span aria-hidden="true">→</span></button><small>{entryLabel}</small><button className="mapae-action mapae-action-secondary" disabled={!character || giwa.busy} onClick={onPractice}>{ko ? "직접 연습하기 · 무료" : "Play yourself · Free"}</button></div>
                </section>}

                {demo.characters.length > 0 && selected.length === 0 && <p className="arc-crew-hint" role="status">{ko ? "놀러 보낼 친구를 아래에서 선택해 주세요." : "Choose the friends you want to send below."} <a href="#arcade-crew">{ko ? "캐릭터 고르기 ↓" : "Choose characters ↓"}</a></p>}
                <ProfileSyncStatus store={store} ko={ko} />
                <ArcadeJourney ko={ko} selectedCount={members.length} prepared={prepared} />
                <div className="arc-preparation">
                    <div className="arc-crew-desk">
                        <CharacterRoster demo={demo} ready={ready && !giwa.busy && store.status !== "conflict"} update={update} selected={selected} onSelect={setSelection} ko={ko} />
                        <ArcadeDestination ko={ko} value={requested} onChange={setRequested} />
                        {members.some(c => c.agent.mode === "llm") && <p className="agent-model-note">{ko ? "자동 외출은 규칙 기반 봇을 지원해요. 캐릭터의 실행 방식을 바꿔 주세요." : "Away outings support rule bots. Change this character’s mode to continue."}</p>}
                    </div>
                    <GiwaAllowance ref={giwaSetup} giwa={giwa} members={members} editable={store.status !== "conflict"} onAmountChange={(id, rounds) => update(v => {const member = v.characters.find(c => c.id === id); return member ? updateCharacter(v, id, {agent: {...member.agent, rounds}}) : v;})} choice={requested} saved={saved} ko={ko} reducedMotion={demo.reducedMotion} onLaunch={quickLaunch} canLaunch={canLaunch} />
                </div>
                <OutingBoard giwa={giwa} demo={demo} ko={ko} onOpen={a => {setActivity(a); setScreen("receipt");}} />
                <DailyChallenge demo={demo} ko={ko} onPlay={(game, seed) => {setPracticeChallenge({seed, name: ko ? "오늘의 도전" : "Daily challenge", score: 0, daily: true}); setPractice(game);}} />
                <ArcadeHistory demo={demo} locale={locale} busy={giwa.busy} canPractice={ready && !!character && !giwa.busy} onPractice={onPractice} onOpen={a => {setActivity(a); setScreen("receipt");}} />
            </>}
            {screen === "receipt" && activity && <AgentReceipt activity={activity} best={activity.source === "practice" ? practiceBest(demo, activity.characterId, activity.game) : paidBest(demo, activity.characterId, activity.game)} locale={locale} onReplay={() => practiceResult(activity)} />}
            {screen === "thinking" && <section className="agent-wait"><LoaderCircle className="arc-loading-icon" /><h1>{ko ? "입장권을 확인하고 있어요" : "Recovering your admission"}</h1><p>{ko ? "같은 결제만 조회해요. 추가로 결제하지 않아요." : "Checking the same payment. No extra charge."}</p></section>}
            {screen === "game" && activity && playingProfile && <>{activity.game === "race" ? <RaceGame key={activity.id} {...gameProps} profile={playingProfile} /> : activity.game === "shop" ? <ShopGame key={activity.id} {...gameProps} profile={playingProfile} memory={latestShopMemory(demo, activity.characterId)} /> : <StampAgent key={activity.id} {...gameProps} profile={playingProfile} sound={sound} />}</>}
            {screen === "receipt" && activity && <div className="agent-receipt-actions"><button className="arc-button" onClick={() => setScreen("lobby")}><ArrowLeft size={18} />{ko ? "오락실로 돌아가기" : "Back to the arcade"}</button><button className="arc-button arc-button-paper" onClick={() => practiceResult(activity)} disabled={replaySeed(activity.outcome) === undefined}>{ko ? "같은 조건으로 직접 도전 · 무료" : "Try the same scenario · Free"} →</button></div>}
            <ConfirmDialog open={exitOpen} onOpenChange={setExitOpen} title={ko ? "외출을 마칠까요?" : "End this outing?"} confirm={ko ? "외출 마치기" : "End outing"} cancel={ko ? "계속하기" : "Keep going"} onConfirm={stop}>
                <p>{screen === "thinking" ? ko ? "이미 전송한 입장 결제는 취소되지 않아요. 처리 중인 입장권은 로비에서 새 결제 없이 복구할 수 있어요." : "A submitted payment cannot be cancelled. Recover a pending ticket from the lobby without paying again." : ko ? `사용한 입장권 ${ARCADE_TICKET_COST} ${MOCK_USDC.symbol}는 환불되지 않아요. 이번 놀이는 중단으로 기록되고 점수는 저장되지 않아요.` : `The used ${ARCADE_TICKET_COST} ${MOCK_USDC.symbol} ticket is not refunded. This visit is recorded as interrupted, without a score.`}</p>
            </ConfirmDialog>
            <footer className="arc-footer"><p>MAPAE ARCADE · {ko ? "작은 자유, 분명한 한도." : "A little freedom. A clear limit."}</p><a href={localizePath("/", locale)}>MAPAE.IO ↗</a></footer>
        </div>
    </main>;
}
