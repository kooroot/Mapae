import {BrandSelect} from "../../components/BrandSelect";
import {Radio} from "@base-ui/react/radio";
import {RadioGroup} from "@base-ui/react/radio-group";
import {Store, ShoppingBag} from "lucide-react";
import {useEffect, useRef, useState} from "react";
import type {AutonomousGameProps} from "../agent-contract";
import {GuardianAvatar} from "../GuardianAvatar";
import {Horse, Goblin, GameArt} from "../Characters";
import {applyBuyerAction, applySellerAction, createShop, DEFAULT_SHOP_CONFIG, nextShopCustomer,
    ruleBuyerAction, ruleSellerAction, shopBuyerObservation, shopMetrics, shopOutcome, shopSellerObservation,
    SHOP_BUYER_BALANCE, SHOP_GOALS, SHOP_INITIAL_CAPITAL, SHOP_PRODUCTS, type ShopConfig, type ShopState} from "@mapae/arcade/shop";
import "./shop.css";

const COPY = {
    ko: {tag: "흥정상회 · 에이전트 장터", title: "흥정은 맡기고, 구경하세요.", sub: "에이전트가 필요한 것을 묻고, 제안하고, 가격을 비교해요.",
        seller: "가게 주인", buyer: "구매자", role: "나의 역할", name: "가게 이름", focus: "진열 상품", balanced: "골고루", everyday: "먹고 마시기", gifts: "응원 선물",
        pricing: "표시 가격", bargain: "알뜰 80%", standard: "기본 100%", premium: "고급 125%", ad: "광고", none: "입소문 · 0냥", poster: "포스터 · 4냥", parade: "거리 홍보 · 8냥",
        style: "협상 목표", profit: "이익 우선", loyalty: "단골 만들기", goal: "주인이 정한 구매 목표", cap: "구매 허용 한도", begin: "에이전트에게 맡기기 →",
        autoStart: "초 뒤 기본 설정으로 영업을 시작해요.", edit: "설정 바꾸기", editing: "자동 시작을 멈췄어요. 설정을 고른 뒤 에이전트에게 맡겨 주세요.",
        initial: "동일 초기 자본", units: "냥", funds: "장터 안에서만 쓰는 놀이 돈이에요. 오락실 용돈이나 실제 자금과 별개예요.",
        buyerHelp: "하나의 지갑으로 시스템 가게 3곳을 방문해요. 가게가 바뀌어도 지출 한도는 그대로예요.", sellerHelp: "시스템이 배정한 손님 3명을 맞아요. 상대의 정확한 잔액·한도는 비공개예요.",
        rules: "규칙 기반 에이전트", llm: "실제 LLM 에이전트", opponent: "상대 · 시스템 규칙 봇", pause: "잠깐 멈춤", resume: "다시 맡기기", exit: "로비로", customer: "손님", store: "가게",
        rounds: "제안", stock: "남은 재고", cash: "가게 현금", net: "순이익", achieved: "목표 달성", remaining: "내 남은 한도", acquired: "구매 목록", waiting: "에이전트가 생각하는 중…",
        next: "다음 만남을 준비해요…", done: "장터 영업 끝!", chat: "흥정 구경하기", receipt: "거래 영수증", noReceipt: "아직 거래가 없어요. 필요와 가격이 맞아야 도장이 찍혀요.",
        satisfaction: "만족도", thought: "내 에이전트의 판단", stopped: "관전을 멈췄어요. 새 결정과 거래도 멈춰 있어요.", error: "에이전트 결정을 받지 못했어요. 연결 또는 응답을 확인하고 다시 시도해 주세요.",
        retry: "같은 차례 다시 시도", failureNote: "규칙 봇으로 바꾸지 않았고, 실패한 차례의 돈도 쓰지 않았어요.", offer: "현재 제안", paid: "결제", noGoods: "아직 없어요", newCustomer: "SYSTEM MATCH", result: "결과 보기", capSeparate: "한도를 지키는 것과 잘 사는 것은 달라요. 구매 목표와 만족도도 평가해요.",
    },
    en: {tag: "TINY SHOP · AGENT MARKET", title: "They bargain. You watch.", sub: "Your agent asks, makes offers, and compares what is worth buying.",
        seller: "Shop owner", buyer: "Buyer", role: "Your role", name: "Shop name", focus: "Stock focus", balanced: "A little of everything", everyday: "Food & drink", gifts: "Good-luck gifts",
        pricing: "Sticker price", bargain: "Value 80%", standard: "Standard 100%", premium: "Premium 125%", ad: "Advertising", none: "Word of mouth · 0", poster: "Posters · 4", parade: "Street campaign · 8",
        style: "Negotiation goal", profit: "Profit first", loyalty: "Win regulars", goal: "Owner's shopping goal", cap: "Authorized spending cap", begin: "Send my agent →",
        autoStart: "seconds until your agent opens with these settings.", edit: "Change settings", editing: "Automatic start paused. Choose your settings, then send your agent.",
        initial: "Equal starting capital", units: "coins", funds: "Play money for this market only. Separate from arcade allowance and real funds.",
        buyerHelp: "Visit 3 system shops with one wallet. The spending cap carries across every visit.", sellerHelp: "Meet 3 system-assigned customers. Their exact balances and spending limits stay private.",
        rules: "Rule-based agent", llm: "Real LLM agent", opponent: "Opponent · system rules", pause: "Pause", resume: "Resume agent", exit: "Lobby", customer: "Customer", store: "Shop",
        rounds: "Offer", stock: "In stock", cash: "Shop cash", net: "Net profit", achieved: "Goal achieved", remaining: "My remaining cap", acquired: "Shopping bag", waiting: "Your agent is thinking…",
        next: "Preparing the next meeting…", done: "Market closed!", chat: "Watch the bargaining", receipt: "Trade receipts", noReceipt: "No trade yet. Needs and price must both fit before the stamp lands.",
        satisfaction: "Satisfaction", thought: "My agent's reasoning", stopped: "Paused. No new decisions or purchases will run.", error: "The agent could not make this decision. Check the connection or response, then retry.",
        retry: "Retry this turn", failureNote: "No switch to a rule bot. No money spent for this failed turn.", offer: "Current offer", paid: "Paid", noGoods: "Nothing yet", newCustomer: "SYSTEM MATCH", result: "View result", capSeparate: "Respecting a cap and making a good purchase are different. Goals and satisfaction count too.",
    },
};

function resultFor(state: ShopState, props: AutonomousGameProps, model: string) {
    const outcome = shopOutcome(state, props.profile.name, props.locale);
    const c = COPY[props.locale];
    outcome.transcript.unshift({speaker: "MAPAE", text: `${props.profile.name} · ${state.config.role === "seller" ? c.seller : c.buyer} · ${props.mode === "llm" ? `${c.llm}${model ? ` (${model})` : ""}` : c.rules}. ${c.opponent}.`});
    return outcome;
}

export function ShopGame(props: AutonomousGameProps) {
    const {appearance, profile, locale, mode, seed, decide, reducedMotion, onComplete, onExit} = props;
    const c = COPY[locale];
    const [config, setConfig] = useState<ShopConfig>(() => ({...DEFAULT_SHOP_CONFIG, name: locale === "ko" ? `${profile.name.slice(0, 10)} 잡화점` : `${profile.name.slice(0, 10)}'s shop`}));
    const [state, setState] = useState<ShopState | null>(null);
    const [countdown, setCountdown] = useState<number | null>(5);
    const [paused, setPaused] = useState(false);
    const [error, setError] = useState(false);
    const [retry, setRetry] = useState(0);
    const [thought, setThought] = useState("");
    const [model, setModel] = useState("");
    const [busy, setBusy] = useState(false);
    const delivered = useRef(false);
    const chat = useRef<HTMLDivElement>(null);
    const sellerRole = config.role === "seller";

    useEffect(() => {
        if (state || countdown === null) return;
        const timer = window.setTimeout(() => {
            if (countdown > 1) setCountdown(countdown - 1);
            else setState(createShop(seed, config));
        }, 1000);
        return () => window.clearTimeout(timer);
    }, [state, countdown, seed, config]);

    useEffect(() => {
        const hide = () => { if (document.hidden) setPaused(true); };
        document.addEventListener("visibilitychange", hide);
        return () => document.removeEventListener("visibilitychange", hide);
    }, []);
    useEffect(() => { chat.current?.scrollTo({top: chat.current.scrollHeight, behavior: reducedMotion ? "instant" : "smooth"}); }, [state?.transcript.length, reducedMotion]);

    useEffect(() => {
        if (!state || paused || error || state.phase === "finished") return;
        const controller = new AbortController();
        let live = true;
        const timer = window.setTimeout(async () => {
            if (state.phase === "transition") { setState(nextShopCustomer(state)); setThought(""); return; }
            const ownTurn = (state.phase === "seller") === (state.config.role === "seller");
            const observation = state.phase === "seller" ? shopSellerObservation(state) : shopBuyerObservation(state);
            try {
                setBusy(true);
                let action: unknown;
                if (ownTurn && mode === "llm") {
                    const decision = await decide({kind: state.phase === "seller" ? "shop-seller" : "shop-buyer", profile, locale, observation}, controller.signal);
                    if (decision.source !== "llm") throw new Error("AGENT_SOURCE_MISMATCH");
                    action = decision.action;
                    if (live) { setThought(decision.explanation); setModel(decision.model ?? ""); }
                } else {
                    action = state.phase === "seller" ? ruleSellerAction(observation, locale) : ruleBuyerAction(observation);
                    if (live && ownTurn) setThought(locale === "ko" ? "공개된 필요와 가격, 남은 재고를 기준으로 규칙에 따라 결정했어요." : "Applied explicit rules to needs, price, and available stock.");
                }
                const next = state.phase === "seller" ? applySellerAction(state, action) : applyBuyerAction(state, action);
                if (live) setState(next);
            } catch {
                if (live && !controller.signal.aborted) setError(true);
            } finally { if (live) setBusy(false); }
        }, state.phase === "transition" ? 1700 : 1050);
        return () => { live = false; controller.abort(); window.clearTimeout(timer); };
    }, [state, paused, error, retry, mode, decide, profile, locale]);

    useEffect(() => {
        if (!state || state.phase !== "finished" || paused) return;
        const timer = window.setTimeout(() => {
            if (!delivered.current) { delivered.current = true; onComplete(resultFor(state, props, model)); }
        }, 2500);
        return () => window.clearTimeout(timer);
    }, [state, paused, onComplete, profile.name, locale, mode, model]);

    const finish = () => {
        if (state?.phase === "finished" && !delivered.current) { delivered.current = true; onComplete(resultFor(state, props, model)); }
    };
    const cancelAutoStart = () => setCountdown(null);
    const patch = (change: Partial<ShopConfig>) => { cancelAutoStart(); setConfig(current => ({...current, ...change})); };

    if (!state) return <section className={`shop-game ${reducedMotion ? "shop-still" : ""}`} aria-labelledby="shop-title">
        <header className="shop-heading"><span>{c.tag}</span><button type="button" className="arc-text-button" onClick={onExit}>{c.exit}</button><h1 id="shop-title">{c.title}</h1><p>{c.sub}</p></header>
        <div className="shop-auto-start"><p role="status">{countdown === null ? c.editing : <><strong>{countdown}</strong> {c.autoStart}</>}</p>{countdown !== null && <button type="button" onClick={cancelAutoStart}>{c.edit}</button>}</div>
        <form className="shop-setup" onFocusCapture={cancelAutoStart} onPointerDownCapture={cancelAutoStart} onChangeCapture={cancelAutoStart}
            onSubmit={event => { event.preventDefault(); cancelAutoStart(); setPaused(false); setState(createShop(seed, config)); }}>
            <div className="shop-owner"><GameArt game="shop" className="shop-owner-art" /><GuardianAvatar appearance={appearance} color={profile.color} /><strong>{profile.name}</strong><span>{mode === "llm" ? c.llm : c.rules}</span><p>{sellerRole ? c.sellerHelp : c.buyerHelp}</p></div>
            <div className="shop-config">
                <fieldset className="shop-roles"><legend>{c.role}</legend><RadioGroup className="mapae-roles" value={config.role} onValueChange={(role: ShopConfig["role"]) => patch({role})} aria-label={c.role}>{(["seller", "buyer"] as const).map(role => <Radio.Root key={role} value={role} className="mapae-role" render={<button type="button" />} nativeButton>{role === "seller" ? <Store size={17} /> : <ShoppingBag size={17} />}{c[role]}</Radio.Root>)}</RadioGroup></fieldset>
                {sellerRole ? <>
                    <label>{c.name}<input value={config.name} required maxLength={18} onChange={event => patch({name: event.target.value})} /></label>
                    <div className="shop-options"><label>{c.focus}<BrandSelect<ShopConfig["focus"]> tone="paper" value={config.focus} onValueChange={focus => patch({focus})} options={[{value: "balanced", label: c.balanced}, {value: "everyday", label: c.everyday}, {value: "gifts", label: c.gifts}]} /></label>
                        <label>{c.pricing}<BrandSelect<ShopConfig["pricing"]> tone="paper" value={config.pricing} onValueChange={pricing => patch({pricing})} options={[{value: 80, label: c.bargain}, {value: 100, label: c.standard}, {value: 125, label: c.premium}]} /></label>
                        <label>{c.ad}<BrandSelect<ShopConfig["advertising"]> tone="paper" value={config.advertising} onValueChange={advertising => patch({advertising})} options={[{value: "none", label: c.none}, {value: "poster", label: c.poster}, {value: "parade", label: c.parade}]} /></label>
                        <label>{c.style}<BrandSelect<ShopConfig["negotiation"]> tone="paper" value={config.negotiation} onValueChange={negotiation => patch({negotiation})} options={[{value: "profit", label: c.profit}, {value: "loyalty", label: c.loyalty}]} /></label></div>
                </> : <><label>{c.goal}<BrandSelect<ShopConfig["buyerGoal"]> tone="paper" value={config.buyerGoal} onValueChange={buyerGoal => patch({buyerGoal})} options={(Object.keys(SHOP_GOALS) as ShopConfig["buyerGoal"][]).map(value => ({value, label: SHOP_GOALS[value][locale]}))} /></label>
                    <label>{c.cap} · 6–30<input type="number" min={6} max={30} step={1} required value={config.buyerCap} onChange={event => patch({buyerCap: Number(event.target.value)})} /></label><p>{c.capSeparate}</p></>}
                <div className="shop-capital"><span>{c.initial}</span><strong>{sellerRole ? SHOP_INITIAL_CAPITAL : SHOP_BUYER_BALANCE} {c.units}</strong></div>
                <p className="shop-funds">{c.funds}</p><button type="submit" className="arc-button" disabled={!config.name.trim()}>{c.begin}</button>
            </div>
        </form>
    </section>;

    const stats = shopMetrics(state);
    const buyer = state.buyers[state.customer]!;
    const speaker = state.phase === "seller" ? c.seller : state.phase === "buyer" ? c.buyer : "";
    return <section className={`shop-game ${reducedMotion ? "shop-still" : ""}`} aria-labelledby="shop-title">
        <header className="shop-heading shop-running"><span>{c.tag}</span><h1 id="shop-title">{sellerRole ? config.name : SHOP_GOALS[config.buyerGoal][locale]}</h1><div className="shop-controls"><button type="button" onClick={() => { setPaused(p => !p); setBusy(false); }}>{paused ? c.resume : c.pause}</button><button type="button" onClick={onExit}>{c.exit}</button></div></header>
        <div className="shop-agent-line"><b>{profile.name} · {mode === "llm" ? `${c.llm}${model ? ` (${model})` : ""}` : c.rules}</b><span>{c.opponent}</span></div>
        <div className="shop-scoreboard"><span>{sellerRole ? c.customer : c.store}<b>{state.customer + 1} / 3</b></span><span>{c.rounds}<b>{Math.min(3, state.rounds)} / 3</b></span><span>{sellerRole ? c.cash : c.remaining}<b>{sellerRole ? state.cash : buyer.cap - buyer.spent} {c.units}</b></span><span>{sellerRole ? c.net : c.achieved}<b>{sellerRole ? `${stats.profit} ${c.units}` : `${stats.goal}%`}</b></span></div>
        <div className="shop-watch">
            <div className="shop-scene"><div className="shop-sign">{sellerRole ? config.name : `${c.store} ${state.customer + 1}`}</div><GameArt game="shop" className="shop-scene-banner" />
                <div className="shop-shelves">{SHOP_PRODUCTS.map(item => <div key={item.id}><img className="shop-item" src={`/arcade/item-${item.id}-512.webp`} width={1024} height={1024} alt="" draggable={false} /><strong>{item.name[locale]}</strong><small>{c.stock} {state.inventory[item.id]}</small></div>)}</div>
                <div className="shop-characters"><div>{sellerRole ? <GuardianAvatar appearance={appearance} color={profile.color} /> : <Horse color="red" />}<span>{sellerRole ? profile.name : c.seller}</span></div><div className="shop-visitor">{sellerRole ? <Goblin /> : <GuardianAvatar appearance={appearance} color={profile.color} />}<span>{sellerRole ? buyer.name : profile.name}</span></div></div>
                <div className="shop-counter"><span>{c.newCustomer}</span><strong>{state.phase === "finished" ? c.done : state.phase === "transition" ? c.next : `${speaker} · ${c.waiting}`}</strong></div>
                {state.offer && <div className="shop-current-offer"><span>{c.offer}</span><strong>{state.offer.items.map(item => `${SHOP_PRODUCTS.find(p => p.id === item.id)!.name[locale]} ×${item.quantity}`).join(" + ")}</strong><b>{state.offer.price} {c.units}</b></div>}
            </div>
            <div className="shop-dialogue"><h2>{c.chat}</h2><div className="shop-chat" ref={chat} role="log" aria-live="polite">{state.conversation.map((entry, index) => <div key={index} className={`shop-bubble shop-bubble-${entry.speaker}`}><b>{entry.speaker === "seller" ? c.seller : entry.speaker === "buyer" ? c.buyer : "MAPAE"}</b><p>{entry.text[locale]}</p></div>)}{busy && <p className="shop-thinking">{c.waiting}</p>}</div>
                {thought && <details className="shop-thought"><summary>{c.thought}</summary><p>{thought}</p></details>}
                {paused && <p className="shop-notice" role="status">{c.stopped}</p>}
                {error && <div className="shop-notice shop-error" role="alert"><p>{c.error}</p><small>{c.failureNote}</small><button type="button" onClick={() => { setError(false); setRetry(v => v + 1); }}>{c.retry}</button></div>}
            </div>
        </div>
        <div className="shop-receipts"><h2>{c.receipt} <span>{state.receipts.length}</span></h2>{state.receipts.length === 0 ? <p>{c.noReceipt}</p> : <div className="shop-receipt-list">{state.receipts.map((receipt, index) => <article key={index}><span className="shop-paid">{c.paid} ✓</span><strong>{receipt.items.map(item => `${SHOP_PRODUCTS.find(p => p.id === item.id)!.name[locale]} ×${item.quantity}`).join(" + ")}</strong><b>{receipt.price} {c.units}</b><small>{c.satisfaction} {receipt.satisfaction}% · {c.achieved} {receipt.goalAchievement}%</small></article>)}</div>}</div>
        <p className="shop-funds">{c.funds}</p>{state.phase === "finished" && <button type="button" className="arc-button" onClick={finish}>{c.result} →</button>}
    </section>;
}
