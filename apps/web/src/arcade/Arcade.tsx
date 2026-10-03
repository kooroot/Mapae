import {ConfirmDialog} from "../components/ConfirmDialog";
import {PlaySettings} from "./PlaySettings";
import {useEffect, useRef, useState} from "react";
import {Volume2, VolumeX, ArrowLeft, LoaderCircle} from "lucide-react";
import type {ActivityOutcome, AgentDecision, AgentProfile, GameId} from "@mapae/arcade";
import {useLocale, LocaleSwitch} from "../lib/locale";
import {localizePath} from "../lib/i18n";
import {useArcadeState} from "./useArcadeState";
import {ProfileAccess, ProfileSyncStatus} from "./ProfileSync";
import {logoutProfile} from "./profile/client";
import {selectedCharacter, selectCharacter, updateCharacter} from "./state";
import {admitActivity, completeActivity, practiceBest, type Activity} from "./activity";
import {modelDecision, parseOutingDecision, readServiceStatus, ruleDecision, type ServiceStatus} from "./agents";
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
import {planOutings, type Outing} from "./allowance";
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
    const [practiceChallenge, setPracticeChallenge] = useState<({seed: number; name: string; score: number} & Pick<NonNullable<ActivityOutcome["replay"]>, "shop">) | undefined>();
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
    const [screen, setScreen] = useState<"lobby" | "thinking" | "game" | "receipt" | "rest">("lobby");
    const [activity, setActivity] = useState<Activity | null>(null);
    const [activeProfile, setActiveProfile] = useState<AgentProfile | null>(null);
    const [decision, setDecision] = useState<AgentDecision | null>(null);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [disconnecting, setDisconnecting] = useState(false);
    const [service, setService] = useState<ServiceStatus | null>(null);
    const [requested, setRequested] = useState<GameId | "auto">(initialGame);
    const [left, setLeft] = useState(0);
    const [autoAdvance, setAutoAdvance] = useState(true);
    const [exitOpen, setExitOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const queue = useRef<Outing[]>([]);
    const [selection, setSelection] = useState<string[] | null>(null);
    const selected = (selection ?? (demo.selectedCharacterId ? [demo.selectedCharacterId] : [])).filter(id => demo.characters.some(c => c.id === id));
    const members = demo.characters.filter(c => selected.includes(c.id));
    const selectedRemaining = members.reduce((total, c) => total + giwa.remainingFor(c.id), 0);
    const prepared = members.length > 0 && members.every(c => giwa.remainingFor(c.id) > 0);
    const admissions = members.reduce((total, c) => total + (giwa.remainingFor(c.id) || c.agent.rounds), 0);
    const character = selectedCharacter(demo);
    const busy = useRef(false);
    const giwaSetup = useRef<HTMLElement>(null);
    const abort = useRef<AbortController | null>(null);
    const profile: AgentProfile | null = character ? {name: character.name, color: character.color, temperament: character.temperament, goal: character.agent.goal} : null;
    const names = GAME_NAMES[locale];
    const controllerName = character?.agent.mode === "llm" ? "LLM AGENT" : ko ? "규칙 기반 봇" : "RULE BOT";

    function refreshService() {
        void readServiceStatus().then(s => {setService(s);}).catch(() => setService(null));
    }
    useEffect(() => () => {abort.current?.abort(); sound.dispose();}, []);
    useEffect(() => {if (screen === "lobby") refreshService();}, [screen]);
    useEffect(() => {window.scrollTo({top: 0, behavior: "instant"});}, [screen]);
    useEffect(() => {
        if (!ready || practice || (screen !== "receipt" && screen !== "rest") || left === 0 || !autoAdvance || exitOpen || settingsOpen || document.hidden) return;
        const timer = setTimeout(() => {
            advanceOuting();
        }, 5000);
        return () => clearTimeout(timer);
    }, [ready, screen, left, autoAdvance, exitOpen, settingsOpen, practice]);
    useEffect(() => {
        const pause = () => {if (document.hidden && screen !== "lobby") setAutoAdvance(false);};
        document.addEventListener("visibilitychange", pause);
        return () => document.removeEventListener("visibilitychange", pause);
    }, [screen]);
    useEffect(() => {
        const bar = quickStart.current;
        const root = arcadeRoot.current;
        if (!bar || !root) return;
        // Reserve the actual action bar height, including wrapped labels and text zoom.
        const resize = new ResizeObserver(() => root.style.setProperty("--arc-quick-height", `${bar.getBoundingClientRect().height}px`));
        resize.observe(bar);
        return () => {resize.disconnect(); root.style.removeProperty("--arc-quick-height");};
    }, [screen, practice, ready, demo.characters.length]);
    function advanceOuting() {
        if (busy.current || !ready) return;
        const next = queue.current.shift(); setLeft(queue.current.length);
        if (next) void launch(next);
    }
    async function toggleSound() {
        const enabled = !current.current.sound;
        const ok = await sound.enable(enabled);
        update(v => ({...v, sound: ok && enabled}));
        if (ok && enabled) sound.play("hit");
    }
    function clearQueue() {queue.current = []; setLeft(0);}
    async function disconnect() {
        setDisconnecting(true);
        try {
            if (ready) await store.flush();
            await logoutProfile(owner);
        } catch { /* The recovery draft is retained; a different wallet cannot access this session. */ }
        finally {giwa.disconnect();}
    }
    function startOutings(jobs: Outing[]) {
        if (busy.current || !ready || !jobs.length) return;
        queue.current = jobs.slice(1); setLeft(queue.current.length);
        void launch(jobs[0]!);
    }
    function stop() {
        abort.current?.abort(); busy.current = false; clearQueue();
        if (activity) update(v => completeActivity(v, activity.id, null));
        setScreen("lobby"); setError("");
    }
    async function launch(job: Outing) {
        if (busy.current || !ready) return;
        const value = current.current;
        const pending = giwa.pending;
        const characterId = pending?.characterId ?? job.characterId;
        const member = value.characters.find(c => c.id === characterId);
        if (!member) {clearQueue(); setError(ko ? "캐릭터를 찾지 못했어요." : "Character not found."); return;}
        const recorded = giwa.pending && value.activities.find(a => a.id === giwa.pending?.requestId && a.source === "mapae-giwa");
        if (recorded) {
            try {
                await store.flush();
                const claimed = await giwa.acknowledge();
                setActivity(recorded); clearQueue();
                setActiveProfile({name: member.name, color: member.color, temperament: member.temperament, goal: member.agent.goal});
                setScreen(claimed && recorded.status !== "complete" ? "game" : "receipt");
            } catch {setError(ko ? "입장 기록을 확인하지 못했어요. 다시 복구해 주세요." : "Admission could not be confirmed. Recover again.");}
            return;
        }
        const choice = pending?.game ?? job.choice;
        const remaining = giwa.remainingFor(characterId);
        if (!pending && remaining < 1) {clearQueue(); setScreen("lobby"); setNotice(ko ? `${member.name}의 용돈을 다시 준비해 주세요.` : `Prepare a new allowance for ${member.name}.`); return;}
        busy.current = true;
        abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
        update(v => selectCharacter(v, member.id));
        setActivity(null); setDecision(null); setError(""); setNotice(""); setScreen("thinking");
        try {
            const request = {kind: "outing" as const, profile: {name: member.name, color: member.color, temperament: member.temperament, goal: member.agent.goal}, locale,
                observation: {allowance: remaining, balance: Math.floor(Number(giwa.balance ?? 0) / ARCADE_TICKET_COST),
                    free: false, requested: pending?.game ?? choice,
                    visited: value.activities.filter(a => a.source === "mapae-giwa" && a.status === "complete" && a.characterId === characterId).slice(0, 3).map(a => a.game),
                    games: ["stamp", "race", "shop"], maxAdmissions: remaining,
                    rules: "Choose enter and game. Never exceed the owner's admission limit. Race is a three-race season ticket; shop is one three-customer shift."}};
            const nextDecision: AgentDecision = pending
                ? {source: member.agent.mode, action: {enter: true, game: pending.game}, explanation: ko ? "새 결제 없이 진행 중인 입장권을 복구해요." : "Recovering the pending ticket without a new payment."}
                : member.agent.mode === "rules" ? ruleDecision(request) : await modelDecision(request, controller.signal);
            if (controller.signal.aborted) return;
            const plan = parseOutingDecision(nextDecision, pending?.game ?? choice);
            setDecision(nextDecision);
            if (!plan.enter) {
                queue.current = queue.current.filter(next => next.characterId !== characterId);
                setLeft(queue.current.length); setNotice(`${member.name}: ${nextDecision.explanation}`); setScreen(queue.current.length ? "rest" : "lobby"); return;
            }
            const id = pending?.requestId ?? crypto.randomUUID();
            await store.flush();
            const receipt = await giwa.buy(plan.game, id, characterId);
            if (controller.signal.aborted) return;
            let admitted: Activity | null = null;
            update(v => {
                const result = admitActivity(v, {id, characterId, game: plan.game, mode: member.agent.mode, source: "mapae-giwa", ticketId: receipt.transaction,
                    model: nextDecision.model ?? null, reason: nextDecision.explanation, giwa: {balanceAfter: receipt.balanceAfter, allowanceAfter: receipt.allowanceAfter}}, Date.now());
                if (!result.ok) throw new Error(ko ? "용돈이 부족하거나 이미 사용한 입장권이에요." : "Allowance exhausted or ticket already used.");
                admitted = result.activity;
                return updateCharacter(result.demo, characterId, {configured: true});
            });
            await store.flush();
            const claimed = await giwa.acknowledge();
            if (!claimed) {await store.refresh(); setActivity(admitted); setScreen("receipt"); return;}
            setActivity(admitted); setActiveProfile(request.profile); await sound.enable(value.sound); if (!controller.signal.aborted) setScreen("game");
        } catch (e) {
            if (!controller.signal.aborted) {
                setError(e instanceof Error ? e.message : "Agent failed"); setScreen("lobby"); clearQueue();}
        } finally {if (abort.current === controller) busy.current = false;}
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
        budget: {balance: Number(giwa.balance ?? 0), allowance: (activity ? giwa.remainingFor(activity.characterId) : 0) * ARCADE_TICKET_COST}, decide: modelDecision,
        reducedMotion: demo.reducedMotion, suspended: exitOpen || settingsOpen, autoAdvance, onComplete: complete, onExit: () => setExitOpen(true)};
    const canLaunch = ready && saved && giwa.recoveryReady && !giwa.busy && (!!giwa.pending || (members.length > 0 && members.every(c => c.agent.mode !== "llm" || !!service?.model.configured)));
    function quickLaunch() {
        if (!giwa.pending && !prepared) {
            if (giwaSetup.current) {giwaSetup.current.scrollIntoView({block: "center", behavior: "instant"}); giwaSetup.current.focus({preventScroll: true});}
            return;
        }
        const pending = giwa.pending;
        startOutings(pending ? [{characterId: pending.characterId, choice: pending.game}] :
            planOutings(members.map(c => c.id), giwa.allowances, requested));
    }
    const launchLabel = giwa.busy ? ko ? "용돈 준비 중…" : "Preparing allowance…" : giwa.pending ? ko ? "입장권 복구" : "Recover ticket" : !members.length ? ko ? "보낼 캐릭터를 선택해 주세요" : "Select who is heading out" : !prepared ? ko ? "친구별 용돈 준비" : "Set GIWA allowance" : ko ? `${members.length}명 놀러 보내기` : `Send ${members.length} out`;
    const entryLabel = giwa.pending ? ko ? "진행 중인 입장권 · 새 결제 없음" : "Pending ticket · no new payment" : ko ? `1회 ${ARCADE_TICKET_COST} ${MOCK_USDC.symbol} · 이번 외출 최대 ${(admissions * ARCADE_TICKET_COST).toFixed(2)} ${MOCK_USDC.symbol}` : `${ARCADE_TICKET_COST} ${MOCK_USDC.symbol} per visit · up to ${(admissions * ARCADE_TICKET_COST).toFixed(2)} ${MOCK_USDC.symbol} total`;
    if (!ready) return <ProfileAccess store={store} ko={ko} onDisconnect={() => void disconnect()} />;
    function practiceResult(a: Activity) {
        const seed = replaySeed(a.outcome);
        if (seed === undefined || !a.outcome) return;
        clearQueue(); setAutoAdvance(false);
        update(v => selectCharacter(v, a.characterId));
        setPracticeChallenge({seed, name: a.name, score: a.outcome.score, shop: a.outcome.replay?.shop}); setPractice(a.game);
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
            {notice && <p className="arc-notice" role="status">{notice}</p>}
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
                        {members.some(c => c.agent.mode === "llm") && <p className="agent-model-note">{service?.model.configured ? `${service.model.provider} / ${service.model.model} · ${service.model.remainingCalls} ${ko ? "호출 남음" : "calls left"}` : ko ? "선택한 LLM 캐릭터를 보내려면 모델 서버를 연결해 주세요. 규칙 봇은 바로 보낼 수 있어요." : "Connect the model service to send selected LLM characters. Rule bots can play now."}</p>}
                    </div>
                    <GiwaAllowance ref={giwaSetup} giwa={giwa} members={members} editable={store.status !== "conflict"} onAmountChange={(id, rounds) => update(v => {const member = v.characters.find(c => c.id === id); return member ? updateCharacter(v, id, {agent: {...member.agent, rounds}}) : v;})} autoAdvance={autoAdvance} onAutoAdvance={setAutoAdvance} saved={saved} ko={ko} reducedMotion={demo.reducedMotion} onLaunch={quickLaunch} canLaunch={canLaunch} />
                </div>
                <ArcadeHistory demo={demo} locale={locale} busy={giwa.busy} canPractice={ready && !!character && !giwa.busy} onPractice={onPractice} onOpen={a => {setActivity(a); clearQueue(); setScreen("receipt");}} />
            </>}
            {screen === "receipt" && activity && <AgentReceipt activity={activity} best={activity.source === "practice" ? practiceBest(demo, activity.characterId, activity.game) : demo.characters.find(c => c.id === activity.characterId)?.bests[activity.game] ?? 0} locale={locale} onReplay={() => practiceResult(activity)} />}
            {(screen === "receipt" || screen === "rest") && left > 0 && <section className="arc-queue-panel" aria-label={ko ? "다음 외출" : "Next outing"}><div><strong>{ko ? `${demo.characters.find(c => c.id === queue.current[0]?.characterId)?.name ?? "다음 친구"}의 외출이 기다려요` : "Your next friend is ready"}</strong><p>{ko ? `${left}회 남음 · 다음 입장 ${ARCADE_TICKET_COST} ${MOCK_USDC.symbol}` : `${left} visits left · Next admission ${ARCADE_TICKET_COST} ${MOCK_USDC.symbol}`}</p></div><label className="mapae-check"><input type="checkbox" checked={autoAdvance} onChange={e => setAutoAdvance(e.target.checked)} />{ko ? "결과 확인 후 5초마다 자동 진행" : "Continue automatically after 5 seconds"}</label><p role="status">{autoAdvance ? ko ? "자동 진행 중 · 체크를 끄면 여기서 기다려요" : "Automatic continuation on · Uncheck to wait here" : ko ? "다음 외출을 누르기 전에는 추가 결제하지 않아요" : "No new admission until you continue"}</p><div><button className="mapae-action mapae-action-primary" onClick={advanceOuting}>{ko ? "다음 친구 보내기" : "Send next friend"} →</button><button className="mapae-action mapae-action-secondary" onClick={() => {clearQueue(); if (screen === "rest") setScreen("lobby");}}>{ko ? "남은 외출 취소" : "Cancel remaining visits"}</button></div></section>}
            {screen === "thinking" && character && <section className="agent-wait"><GuardianAvatar appearance={character.appearance} color={character.color} /><p className="arc-overline">{controllerName}</p><h1>{ko ? `${character.name}, 외출 준비 중이에요.` : `${character.name} is getting ready.`}</h1><p role="status" className="arc-outing-status"><LoaderCircle size={18} className="arc-loading-icon" />{decision ? ko ? "GIWA에서 입장권 정산을 확인하고 있어요." : "Confirming your ticket settlement on GIWA." : ko ? "목표와 남은 용돈으로 오늘의 놀이를 고르고 있어요." : "Choosing a game within the goal and allowance."}</p><small>{ko ? "확인이 끝나면 자동으로 시작해요. 탭을 유지해 주세요." : "Play starts after confirmation. Keep this tab open."}</small><button className="arc-text-button" onClick={() => setExitOpen(true)}>{ko ? "로비로 돌아가기" : "Back to lobby"}</button></section>}
            {screen === "game" && activity && playingProfile && <><div className="agent-watching"><div><b>{activity.name} / {names[activity.game]}</b>{left > 0 && <small>{ko ? `다음 외출 ${left}회 대기 중` : `${left} visits queued`}</small>}<small>{activity.mode === "llm" ? activity.model ?? "LLM" : ko ? "규칙 기반 봇" : "Rule bot"} · GIWA Sepolia</small></div><button className="arc-text-button" onClick={() => setExitOpen(true)}>{ko ? "외출 중단" : "Stop outing"}</button></div><label className="mapae-check"><input type="checkbox" checked={autoAdvance} onChange={event => setAutoAdvance(event.target.checked)} />{ko ? `다음 경기·외출 자동 진행${left ? ` · 다음 입장 ${ARCADE_TICKET_COST} ${MOCK_USDC.symbol}` : ""}` : `Continue games and visits automatically${left ? ` · Next ticket ${ARCADE_TICKET_COST} ${MOCK_USDC.symbol}` : ""}`}</label>{decision && <p className="agent-thought">“{decision.explanation}”</p>}{activity.game === "race" ? <RaceGame key={activity.id} {...gameProps} profile={playingProfile} /> : activity.game === "shop" ? <ShopGame key={activity.id} {...gameProps} profile={playingProfile} /> : <StampAgent key={activity.id} {...gameProps} profile={playingProfile} sound={sound} />}</>}
            {screen === "receipt" && activity && <><div className="agent-receipt-actions"><button className="arc-button" onClick={() => {clearQueue(); setScreen("lobby");}}><ArrowLeft size={18} />{ko ? "오락실로 돌아가기" : "Back to the arcade"}</button><button className="arc-button arc-button-paper" onClick={() => {if (activity.source === "practice") {update(v => selectCharacter(v, activity.characterId)); setPractice(activity.game); return;} if (giwa.remainingFor(activity.characterId) < 1 && !giwa.pending) {clearQueue(); setSelection([activity.characterId]); setRequested(activity.game); setScreen("lobby");} else startOutings([{characterId: activity.characterId, choice: activity.game}]);}}>{activity.source === "practice" ? ko ? "다시 연습하기" : "Practice again" : giwa.remainingFor(activity.characterId) < 1 && !giwa.pending ? ko ? "용돈 준비하고 다시 하기" : "Prepare allowance to play again" : ko ? "같은 놀이 다시 보내기" : "Send again"} →</button></div></>}
            <ConfirmDialog open={exitOpen} onOpenChange={setExitOpen} title={ko ? "외출을 마칠까요?" : "End this outing?"} confirm={ko ? "외출 마치기" : "End outing"} cancel={ko ? "계속하기" : "Keep going"} onConfirm={stop}>
                <p>{screen === "thinking" ? ko ? "이미 전송한 입장 결제는 취소되지 않아요. 처리 중인 입장권은 로비에서 새 결제 없이 복구할 수 있어요." : "A submitted payment cannot be cancelled. Recover a pending ticket from the lobby without paying again." : ko ? `사용한 입장권 ${ARCADE_TICKET_COST} ${MOCK_USDC.symbol}는 환불되지 않아요. 이번 놀이는 중단으로 기록되고 점수는 저장되지 않아요.` : `The used ${ARCADE_TICKET_COST} ${MOCK_USDC.symbol} ticket is not refunded. This visit is recorded as interrupted, without a score.`}</p>
                {left > 0 && <p>{ko ? `대기 중인 ${left}회 외출도 취소해요.` : `${left} queued visits will also be cancelled.`}</p>}
            </ConfirmDialog>
            <footer className="arc-footer"><p>MAPAE ARCADE · {ko ? "작은 자유, 분명한 한도." : "A little freedom. A clear limit."}</p><a href={localizePath("/", locale)}>MAPAE.IO ↗</a></footer>
        </div>
    </main>;
}
