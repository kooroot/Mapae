import {BrandSelect} from "../components/BrandSelect";
import {PlaySettings} from "./PlaySettings";
import {useEffect, useRef, useState} from "react";
import {Volume2, VolumeX, ArrowLeft, Compass, Flag, Store, Stamp} from "lucide-react";
import type {ActivityOutcome, AgentDecision, AgentProfile, GameId} from "@mapae/arcade";
import {useLocale, LocaleSwitch} from "../lib/locale";
import {localizePath} from "../lib/i18n";
import {useArcadeState} from "./useArcadeState";
import {saveArcadeState} from "./state-store";
import {selectedCharacter, selectCharacter, updateCharacter} from "./state";
import {admitActivity, completeActivity, type Activity} from "./activity";
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
import {GiwaAllowance} from "./GiwaAllowance";
import "./arcade.css";
import "./agent-arcade.css";
import "./arcade-brand.css";

export function Arcade() {
    return <Web3Providers><WalletGate>{(owner, initialGame) => <AgentArcade key={owner.toLowerCase()} owner={owner} initialGame={initialGame} />}</WalletGate></Web3Providers>;
}

type Outing = {characterId: string; choice: GameId | "auto"};

function AgentArcade({owner, initialGame}: {owner: Address; initialGame: GameId}) {
    const [practice, setPractice] = useState(false);
    const onPractice = () => setPractice(true);
    const {locale} = useLocale();
    const ko = locale === "ko";
    const giwa = useGiwaTickets(locale);
    const store = useArcadeState(owner);
    const {demo, ready, saved, update} = store;
    const current = useRef(demo); current.current = demo;
    const [sound] = useState(() => new ArcadeSound());
    const [screen, setScreen] = useState<"lobby" | "thinking" | "game" | "receipt">("lobby");
    const [activity, setActivity] = useState<Activity | null>(null);
    const [activeProfile, setActiveProfile] = useState<AgentProfile | null>(null);
    const [decision, setDecision] = useState<AgentDecision | null>(null);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [service, setService] = useState<ServiceStatus | null>(null);
    const [requested, setRequested] = useState<GameId | "auto">(initialGame);
    const [left, setLeft] = useState(0);
    const queue = useRef<Outing[]>([]);
    const [selection, setSelection] = useState<string[] | null>(null);
    const [historyId, setHistoryId] = useState("all");
    const selected = (selection ?? (demo.selectedCharacterId ? [demo.selectedCharacterId] : [])).filter(id => demo.characters.some(c => c.id === id));
    const members = demo.characters.filter(c => selected.includes(c.id));
    const admissions = members.reduce((total, c) => total + c.agent.rounds, 0);
    const character = selectedCharacter(demo);
    const history = historyId === "all" ? demo.activities : demo.activities.filter(a => a.characterId === historyId);
    const busy = useRef(false);
    const giwaSetup = useRef<HTMLDetailsElement>(null);
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
        if (screen !== "receipt" || left === 0) return;
        const timer = setTimeout(() => {
            const next = queue.current.shift();
            setLeft(queue.current.length);
            if (next) void launch(next);
        }, 5000);
        return () => clearTimeout(timer);
    }, [screen, left]);
    async function toggleSound() {
        const enabled = !current.current.sound;
        const ok = await sound.enable(enabled);
        update(v => ({...v, sound: ok && enabled}));
        if (ok && enabled) sound.play("hit");
    }
    function clearQueue() {queue.current = []; setLeft(0);}
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
        if (recorded) {giwa.acknowledge(); setActivity(recorded); clearQueue(); setScreen("receipt"); return;}
        const choice = pending?.game ?? job.choice;
        const rounds = member.agent.rounds;
        busy.current = true;
        abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
        update(v => selectCharacter(v, member.id));
        setActivity(null); setDecision(null); setError(""); setNotice(""); setScreen("thinking");
        try {
            const request = {kind: "outing" as const, profile: {name: member.name, color: member.color, temperament: member.temperament, goal: member.agent.goal}, locale,
                observation: {allowance: giwa.remaining, balance: Math.floor(Number(giwa.balance ?? 0) / ARCADE_TICKET_COST),
                    free: false, requested: pending?.game ?? choice,
                    visited: value.activities.filter(a => a.status === "complete" && a.characterId === characterId).slice(0, 3).map(a => a.game),
                    games: ["stamp", "race", "shop"], maxAdmissions: Math.min(rounds, 3),
                    rules: "Choose enter and game. Never exceed the owner's admission limit. Race is a three-race season ticket; shop is one three-customer shift."}};
            const nextDecision: AgentDecision = pending
                ? {source: member.agent.mode, action: {enter: true, game: pending.game}, explanation: ko ? "새 결제 없이 진행 중인 입장권을 복구해요." : "Recovering the pending ticket without a new payment."}
                : member.agent.mode === "rules" ? ruleDecision(request) : await modelDecision(request, controller.signal);
            if (controller.signal.aborted) return;
            const plan = parseOutingDecision(nextDecision, pending?.game ?? choice);
            setDecision(nextDecision);
            if (!plan.enter) {setNotice(nextDecision.explanation); clearQueue(); setScreen("lobby"); return;}
            const id = pending?.requestId ?? crypto.randomUUID();
            if (!saved) throw new Error(ko ? "기록 저장을 허용한 브라우저에서 결제해 주세요." : "Enable browser storage before paying.");
            const receipt = await giwa.buy(plan.game, id, characterId);
            if (controller.signal.aborted) return;
            let admitted: Activity | null = null;
            const admittedDemo = update(v => {
                const result = admitActivity(v, {id, characterId, game: plan.game, mode: member.agent.mode, source: "mapae-giwa", ticketId: receipt.transaction,
                    model: nextDecision.model ?? null, reason: nextDecision.explanation, giwa: {balanceAfter: receipt.balanceAfter, allowanceAfter: receipt.allowanceAfter}}, Date.now());
                if (!result.ok) throw new Error(ko ? "용돈이 부족하거나 이미 사용한 입장권이에요." : "Allowance exhausted or ticket already used.");
                admitted = result.activity;
                return updateCharacter(result.demo, characterId, {configured: true});
            });
            if (!saveArcadeState(owner, admittedDemo)) throw new Error(ko ? "입장 기록 저장에 실패했어요. 같은 입장권을 복구해 주세요." : "Admission was not saved. Recover the same ticket.");
            giwa.acknowledge();
            setActivity(admitted); setActiveProfile(request.profile); await sound.enable(value.sound); if (!controller.signal.aborted) setScreen("game");
        } catch (e) {
            if (!controller.signal.aborted) {
                setError(e instanceof Error ? e.message : "Agent failed"); setScreen("lobby"); clearQueue();}
        } finally {if (abort.current === controller) busy.current = false;}
    }
    function complete(outcome: ActivityOutcome) {
        if (!activity) return;
        const next = update(v => completeActivity(v, activity.id, outcome));
        const finished = next.activities.find(a => a.id === activity.id);
        if (!finished || finished.status !== "complete") {setError(ko ? "결과 검증에 실패했어요." : "Result validation failed."); return;}
        setActivity(finished); setScreen("receipt");
    }
    const playingProfile = activeProfile ?? profile;
    const gameProps = {appearance: activity?.appearance, locale, mode: activity?.mode ?? character?.agent.mode ?? "rules", seed: activity ? parseInt(activity.id.slice(0, 8), 16) >>> 0 : 1,
        budget: {balance: Number(giwa.balance ?? 0), allowance: giwa.remaining * ARCADE_TICKET_COST}, decide: modelDecision,
        reducedMotion: demo.reducedMotion, onComplete: complete, onExit: stop};
    const canLaunch = ready && saved && (!!giwa.pending || (members.length > 0 && members.every(c => c.agent.mode !== "llm" || !!service?.model.configured)));
    function quickLaunch() {
        if (!giwa.pending && giwa.remaining < 1) {
            if (giwaSetup.current) {giwaSetup.current.open = true; giwaSetup.current.scrollIntoView({block: "center", behavior: "instant"});}
            return;
        }
        const pending = giwa.pending;
        startOutings(pending ? [{characterId: pending.characterId, choice: pending.game}] :
            members.flatMap(c => Array.from({length: c.agent.rounds}, () => ({characterId: c.id, choice: requested}))));
    }
    const launchLabel = giwa.pending ? ko ? "입장권 복구" : "Recover ticket" : !members.length ? ko ? "보낼 캐릭터를 선택해 주세요" : "Select who is heading out" : giwa.remaining < 1 ? ko ? "GIWA 용돈 준비" : "Set GIWA allowance" : ko ? `${members.length}명 놀러 보내기` : `Send ${members.length} out`;
    const entryLabel = giwa.pending ? ko ? "진행 중인 입장권 · 새 결제 없음" : "Pending ticket · no new payment" : ko ? `1회 ${ARCADE_TICKET_COST} ${MOCK_USDC.symbol} · 이번 외출 최대 ${(admissions * ARCADE_TICKET_COST).toFixed(2)} ${MOCK_USDC.symbol}` : `${ARCADE_TICKET_COST} ${MOCK_USDC.symbol} per visit · up to ${(admissions * ARCADE_TICKET_COST).toFixed(2)} ${MOCK_USDC.symbol} total`;
    if (practice && character) return <PracticeArcade store={store} character={character} onBack={() => setPractice(false)} />;
    return <main data-screen={screen} className={`arcade agent-arcade ${screen === "lobby" ? "agent-in-lobby" : ""} ${demo.reducedMotion ? "arc-still" : ""}`}>
        <header className="arc-header"><a className="arc-wordmark" href={localizePath("/", locale)} aria-label={ko ? "Mapae 홈" : "Mapae home"}><ArcadeBrand /></a>
            <span className="arc-demo-label"><i />{ko ? "GIWA 테스트넷 · 테스트 토큰" : "GIWA SEPOLIA · TEST TOKENS"}</span>
            <div className="arc-header-actions"><button className="arc-sound" aria-label={ko ? demo.sound ? "소리 켬" : "소리 끔" : demo.sound ? "Sound on" : "Sound off"} aria-pressed={demo.sound} onClick={() => void toggleSound()}>{demo.sound ? <Volume2 size={18} /> : <VolumeX size={18} />}</button><PlaySettings ko={ko} reducedMotion={demo.reducedMotion} onReducedMotionChange={reducedMotion => update(v => ({...v, reducedMotion}))} />{screen === "lobby" && <LocaleSwitch />}</div>
        </header>
        <div className="arc-main">
            {!saved && <p className="arc-notice" role="alert">{ko ? "이 브라우저는 기록을 저장하지 못해요. 페이지를 떠나면 외출 기록이 사라질 수 있어요." : "This browser cannot save progress. Records may be lost on leaving."}</p>}
            {error && <p className="arc-notice" role="alert">{error}</p>}
            {notice && <p className="arc-notice" role="status">{notice}</p>}
            {screen === "lobby" && <>
                <div className="arc-wallet-identity"><span>{giwa.walletName} · {owner.slice(0, 6)}…{owner.slice(-4)}</span><button className="arc-text-button" onClick={giwa.disconnect}>{ko ? "지갑 바꾸기 / 연결 해제" : "Change / disconnect wallet"}</button></div>
                <ArcadeRoom locale={locale} selected={requested} onSelect={setRequested} reducedMotion={demo.reducedMotion}>
                    {demo.characters.length === 0 ? <div className="arc-empty-departure"><div><h2>{ko ? "첫 친구를 만나볼까요?" : "Meet your first little friend"}</h2><p>{ko ? "캐릭터를 만들고, 함께 놀 거리를 골라요." : "Create your character, then pick an adventure."}</p></div><a className="arc-button" href="#arcade-crew">{ko ? "캐릭터 만들러 가기" : "Create a character"} ↓</a></div> : <>
                <section className="agent-quickstart" aria-label={ko ? "선택한 놀이 시작" : "Start selected activity"}>
                    <div className="agent-quick-profile">{character && <GuardianAvatar appearance={character.appearance} color={character.color} />}<div><strong>{requested === "auto" ? ko ? "에이전트가 고를게요" : "Let my agent choose" : names[requested]}</strong><span>{ko ? `${members.length}명 · 최대 ${admissions}회 · 차례로` : `${members.length} friends · up to ${admissions} visits`}</span><span className="agent-mobile-budget">{ko ? "용돈" : "Allowance"} {(giwa.remaining * ARCADE_TICKET_COST).toFixed(2)} / {ko ? "잔액" : "Balance"} {giwa.balance ?? "—"} {MOCK_USDC.symbol}</span></div></div>
                    <div className="agent-quick-budget"><span>GIWA · {MOCK_USDC.symbol}</span><strong>{(giwa.remaining * ARCADE_TICKET_COST).toFixed(2)}<small> / {giwa.balance ?? "—"} {ko ? "보유" : "balance"}</small></strong></div>
                    <div className="agent-quick-action"><button className="arc-button" disabled={!canLaunch} onClick={quickLaunch}>{launchLabel} <span aria-hidden="true">→</span></button><small>{entryLabel}</small></div>
                </section>
                    </>}
                </ArcadeRoom>
                {demo.characters.length > 0 && selected.length === 0 && <p className="arc-crew-hint" role="status">{ko ? "놀러 보낼 친구를 아래에서 선택해 주세요." : "Choose the friends you want to send below."} <a href="#arcade-crew">{ko ? "캐릭터 고르기 ↓" : "Choose characters ↓"}</a></p>}
                <CharacterRoster demo={demo} ready={ready} update={update} selected={selected} onSelect={setSelection} ko={ko} />
                <GiwaAllowance ref={giwaSetup} giwa={giwa} admissions={admissions} saved={saved} ko={ko} />
                {members.some(c => c.agent.mode === "llm") && <p className="agent-model-note">{service?.model.configured ? `${service.model.provider} / ${service.model.model} · ${service.model.remainingCalls} ${ko ? "호출 남음" : "calls left"}` : ko ? "선택한 LLM 캐릭터를 보내려면 모델 서버를 연결해 주세요. 규칙 봇은 바로 보낼 수 있어요." : "Connect the model service to send selected LLM characters. Rule bots can play now."}</p>}
                <label className="arc-history-filter">{ko ? "놀러 갈 곳" : "Destination"}<BrandSelect<GameId | "auto"> value={requested} onValueChange={setRequested} options={[
                    {value: "auto", label: ko ? "각 캐릭터가 고르기" : "Let each character choose", icon: <Compass />},
                    {value: "race", label: names.race, icon: <Flag />}, {value: "shop", label: names.shop, icon: <Store />}, {value: "stamp", label: names.stamp, icon: <Stamp />},
                ]} /></label>
                <div className="agent-history"><div className="arc-section-label"><h2>{ko ? "놀다 온 이야기" : "Postcards from the arcade"}</h2><button className="arc-text-button" disabled={!ready || !character} onClick={onPractice}>{ko ? "내가 직접 연습하기 ↗" : "Practice by hand ↗"}</button></div><label className="arc-history-filter">{ko ? "캐릭터별 기록" : "Character history"}<BrandSelect value={historyId} onValueChange={setHistoryId} options={[{value: "all", label: ko ? "모두" : "Everyone"}, ...demo.characters.map(c => ({value: c.id, label: c.name}))]} /></label>{history.length === 0 ? <p>{ko ? "아직 비어 있어요. 첫 외출을 보내 주세요." : "A blank page. Send your agent on its first outing."}</p> : <ol>{history.slice(0, 12).map(a => <li key={a.id}><button onClick={() => {setActivity(a); clearQueue(); setScreen("receipt");}}><b>{a.name} · {names[a.game]}</b><span>{a.outcome?.summary[locale] ?? (ko ? "중단 또는 진행 중" : "Stopped or in progress")}</span><small>{a.mode === "llm" ? a.model ?? "LLM" : "RULE BOT"} · {a.source}</small></button></li>)}</ol>}<small>{ko ? "연결한 지갑별로 이 브라우저에 저장돼요. 다른 기기로는 동기화되지 않아요." : "Records are saved per wallet in this browser. They do not sync across devices."}</small></div>
            </>}
            {screen === "thinking" && character && <section className="agent-wait"><GuardianAvatar appearance={character.appearance} color={character.color} /><p className="arc-overline">{controllerName}</p><h1>{ko ? `${character.name}, 외출 준비 중이에요.` : `${character.name} is getting ready.`}</h1><p>{ko ? "목표와 남은 용돈을 확인하고 입장권을 준비해요." : "Checking the goal and allowance, then preparing a ticket."}</p><button className="arc-text-button" onClick={stop}>{ko ? "외출 취소" : "Cancel outing"}</button></section>}
            {screen === "game" && activity && playingProfile && <><div className="agent-watching"><div><b>{activity.name} / {names[activity.game]}</b>{left > 0 && <small>{ko ? `다음 외출 ${left}회 대기 중` : `${left} visits queued`}</small>}<small>{activity.mode === "llm" ? activity.model ?? "LLM AGENT" : "RULE BOT"} · {activity.source}</small></div><button className="arc-text-button" onClick={stop}>{ko ? "외출 중단" : "Stop outing"}</button></div>{decision && <p className="agent-thought">“{decision.explanation}”</p>}{activity.game === "race" ? <RaceGame key={activity.id} {...gameProps} profile={playingProfile} /> : activity.game === "shop" ? <ShopGame key={activity.id} {...gameProps} profile={playingProfile} /> : <StampAgent key={activity.id} {...gameProps} profile={playingProfile} sound={sound} />}</>}
            {screen === "receipt" && activity && <><AgentReceipt activity={activity} best={demo.characters.find(c => c.id === activity.characterId)?.bests[activity.game] ?? 0} locale={locale} />{left > 0 && <p className="arc-notice" role="status">{ko ? `5초 뒤 ${demo.characters.find(c => c.id === queue.current[0]?.characterId)?.name ?? "다음 친구"} 출발! ${left}회 남았어요.` : `Choosing the next activity in 5 seconds. Up to ${left} admissions left.`}<button className="arc-text-button" onClick={() => {clearQueue();}}>{ko ? "여기서 외출 마치기" : "Finish outing here"}</button></p>}<div className="agent-receipt-actions"><button className="arc-button" onClick={() => {clearQueue(); setScreen("lobby");}}><ArrowLeft size={18} />{ko ? "오락실로 돌아가기" : "Back to the arcade"}</button><button className="arc-button arc-button-paper" onClick={() => startOutings([{characterId: activity.characterId, choice: activity.game}])}>{ko ? "같은 놀이 다시 보내기" : "Send again"} →</button></div></>}
            <footer className="arc-footer"><p>MAPAE ARCADE · {ko ? "작은 자유, 분명한 한도." : "A little freedom. A clear limit."}</p><a href={localizePath("/", locale)}>MAPAE.IO ↗</a></footer>
        </div>
    </main>;
}
