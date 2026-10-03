import {BrandSelect} from "../../components/BrandSelect";
import {Radio} from "@base-ui/react/radio";
import {RadioGroup} from "@base-ui/react/radio-group";
import {Store, ShoppingBag} from "lucide-react";
import {useEffect, useRef, useState} from "react";
import {GameGuide} from "../GameGuide";
import {HumanShopControls} from "./HumanShopControls";
import type {PlayableGameProps} from "../agent-contract";
import {GuardianAvatar} from "../GuardianAvatar";
import {GameArt} from "../Characters";
import {applyBuyerAction, applySellerAction, createShop, DEFAULT_SHOP_CONFIG, nextShopCustomer,
    ruleBuyerAction, ruleSellerAction, shopBuyerObservation, shopMetrics, shopOutcome, shopSellerObservation,
    SHOP_BUYER_BALANCE, SHOP_GOALS, SHOP_INITIAL_CAPITAL, SHOP_PRODUCTS, SHOP_STORIES, SHOP_TEMPERAMENT_COPY, shopOffersRemaining, type ShopConfig, type ShopState} from "@mapae/arcade/shop";
import "./shop.css";
import "./counter.css";
import "./shop-scene.css";

const COPY = {
    ko: {tag: "흥정상회 · 에이전트 장터", title: "흥정은 맡기고, 구경하세요.", sub: "에이전트가 필요한 것을 묻고, 제안하고, 가격을 비교해요.",
        seller: "가게 주인", buyer: "구매자", role: "나의 역할", name: "가게 이름", focus: "진열 상품", balanced: "골고루", everyday: "먹고 마시기", gifts: "응원 선물",
        pricing: "표시 가격", bargain: "알뜰 80%", standard: "기본 100%", premium: "고급 125%", ad: "광고", none: "입소문 · 0냥", poster: "포스터 · 4냥", parade: "거리 홍보 · 8냥",
        style: "협상 목표", profit: "이익 우선", loyalty: "단골 만들기", goal: "주인이 정한 구매 목표", cap: "구매 허용 한도", begin: "에이전트에게 맡기기 →",
        initial: "동일 초기 자본", units: "냥", funds: "장터 안에서만 쓰는 놀이 돈이에요. 오락실 용돈이나 실제 자금과 별개예요.",
        buyerHelp: "하나의 지갑으로 시스템 가게 3곳을 방문해요. 가게가 바뀌어도 지출 한도는 그대로예요.", sellerHelp: "시스템이 배정한 손님 3명을 맞아요. 상대의 정확한 잔액·한도는 비공개예요.",
        rules: "규칙 기반 에이전트", llm: "실제 LLM 에이전트", opponent: "상대 · 시스템 규칙 봇", pause: "잠깐 멈춤", resume: "다시 맡기기", exit: "로비로", customer: "손님", store: "가게",
        rounds: "제안", stock: "남은 재고", cash: "가게 현금", net: "순이익", achieved: "목표 달성", remaining: "내 남은 한도", acquired: "구매 목록", waiting: "에이전트가 생각하는 중…",
        next: "다음 만남을 준비해요…", done: "장터 영업 끝!", chat: "흥정 구경하기", receipt: "거래 영수증", noReceipt: "아직 거래가 없어요. 필요와 가격이 맞아야 도장이 찍혀요.",
        satisfaction: "만족도", thought: "내 에이전트의 판단", stopped: "관전을 멈췄어요. 새 결정과 거래도 멈춰 있어요.", error: "에이전트 결정을 받지 못했어요. 연결 또는 응답을 확인하고 다시 시도해 주세요.",
        retry: "같은 차례 다시 시도", failureNote: "규칙 봇으로 바꾸지 않았고, 실패한 차례의 돈도 쓰지 않았어요.", offer: "현재 제안", paid: "결제", noGoods: "아직 없어요", newCustomer: "시스템이 배정한 만남", result: "결과 보기", capSeparate: "한도를 지키는 것과 잘 사는 것은 달라요. 구매 목표와 만족도도 평가해요.",
    },
    en: {tag: "TINY SHOP · AGENT MARKET", title: "They bargain. You watch.", sub: "Your agent asks, makes offers, and compares what is worth buying.",
        seller: "Shop owner", buyer: "Buyer", role: "Your role", name: "Shop name", focus: "Stock focus", balanced: "A little of everything", everyday: "Food & drink", gifts: "Good-luck gifts",
        pricing: "Sticker price", bargain: "Value 80%", standard: "Standard 100%", premium: "Premium 125%", ad: "Advertising", none: "Word of mouth · 0", poster: "Posters · 4", parade: "Street campaign · 8",
        style: "Negotiation goal", profit: "Profit first", loyalty: "Win regulars", goal: "Owner's shopping goal", cap: "Authorized spending cap", begin: "Send my agent →",
        initial: "Equal starting capital", units: "coins", funds: "Play money for this market only. Separate from arcade allowance and real funds.",
        buyerHelp: "Visit 3 system shops with one wallet. The spending cap carries across every visit.", sellerHelp: "Meet 3 system-assigned customers. Their exact balances and spending limits stay private.",
        rules: "Rule-based agent", llm: "Real LLM agent", opponent: "Opponent · system rules", pause: "Pause", resume: "Resume agent", exit: "Lobby", customer: "Customer", store: "Shop",
        rounds: "Offer", stock: "In stock", cash: "Shop cash", net: "Net profit", achieved: "Goal achieved", remaining: "My remaining cap", acquired: "Shopping bag", waiting: "Your agent is thinking…",
        next: "Preparing the next meeting…", done: "Market closed!", chat: "Watch the bargaining", receipt: "Trade receipts", noReceipt: "No trade yet. Needs and price must both fit before the stamp lands.",
        satisfaction: "Satisfaction", thought: "My agent's reasoning", stopped: "Paused. No new decisions or purchases will run.", error: "The agent could not make this decision. Check the connection or response, then retry.",
        retry: "Retry this turn", failureNote: "No switch to a rule bot. No money spent for this failed turn.", offer: "Current offer", paid: "Paid", noGoods: "Nothing yet", newCustomer: "SYSTEM MATCH", result: "View result", capSeparate: "Respecting a cap and making a good purchase are different. Goals and satisfaction count too.",
    },
};

function resultFor(state: ShopState, props: PlayableGameProps, model: string) {
    const outcome = shopOutcome(state, props.profile.name, props.locale);
    outcome.replay = {version: 1, seed: state.seed, shop: {...state.config}};
    const c = COPY[props.locale];
    outcome.transcript.unshift({speaker: "MAPAE", text: `${props.profile.name} · ${state.config.role === "seller" ? c.seller : c.buyer} · ${props.mode === "human" ? props.locale === "ko" ? "직접 플레이" : "Human play" : props.mode === "llm" ? `${c.llm}${model ? ` (${model})` : ""}` : c.rules}. ${c.opponent}.`});
    return outcome;
}

export function ShopGame(props: PlayableGameProps & {initialConfig?: ShopConfig}) {
    const {appearance, profile, locale, mode, seed, decide, reducedMotion, suspended = false, autoAdvance = false, onComplete, onExit} = props;
    const human = mode === "human", ko = locale === "ko";
    const c = {...COPY[locale], ...(human ? {
        tag: ko ? "흥정상회 · 직접 연습" : "TINY SHOP · HUMAN PRACTICE",
        title: ko ? "오늘은 내가 상인! 혹은 알뜰 손님?" : "Be the merchant. Or the savvy shopper.",
        sub: ko ? "적게 팔까, 넉넉히 챙길까? 세 손님의 사연을 듣고 장사해요." : "A small pack or a generous one? Read three customers and make your offer.",
        begin: ko ? "직접 흥정 시작 →" : "Start bargaining →", rules: ko ? "직접 플레이 · 무료" : "Human play · Free",
        waiting: ko ? "상대가 고르는 중…" : "Opponent is choosing…", stopped: ko ? "잠시 멈췄어요. 계속하기를 누르면 이어져요." : "Paused. Choose Continue to resume.",
        resume: ko ? "계속하기" : "Continue", chat: ko ? "우리의 흥정" : "Your negotiation", thought: ko ? "나의 선택" : "Your choice",
    } : {})};
    const [config, setConfig] = useState<ShopConfig>(() => props.initialConfig ? {...props.initialConfig} : ({...DEFAULT_SHOP_CONFIG, name: locale === "ko" ? `${profile.name.slice(0, 10)} 잡화점` : `${profile.name.slice(0, 10)}'s shop`}));
    const [state, setState] = useState<ShopState | null>(null);
    const [paused, setPaused] = useState(false);
    const [speed, setSpeed] = useState(1);
    const blocked = paused || suspended;
    const [error, setError] = useState(false);
    const [retry, setRetry] = useState(0);
    const [thought, setThought] = useState("");
    const [model, setModel] = useState("");
    const [busy, setBusy] = useState(false);
    const delivered = useRef(false);
    const chat = useRef<HTMLDivElement>(null);
    const counter = useRef<HTMLDivElement>(null);
    const sellerRole = config.role === "seller";

    useEffect(() => {
        if (!human || state?.customer === undefined) return;
        counter.current?.focus({preventScroll: true});
        counter.current?.scrollIntoView({block: "start", behavior: reducedMotion ? "instant" : "smooth"});
    }, [state?.customer, human, reducedMotion]);

    useEffect(() => {
        if (state || !autoAdvance || blocked) return;
        const timer = window.setTimeout(() => setState(createShop(seed, config)), 5000);
        return () => window.clearTimeout(timer);
    }, [state, autoAdvance, blocked, seed, config]);

    useEffect(() => {
        const hide = () => { if (document.hidden) setPaused(true); };
        const pause = (event: KeyboardEvent) => {if (!suspended && !event.defaultPrevented && event.key === "Escape") setPaused(p => !p);};
        document.addEventListener("visibilitychange", hide);
        window.addEventListener("keydown", pause);
        return () => {document.removeEventListener("visibilitychange", hide); window.removeEventListener("keydown", pause);};
    }, [suspended]);
    useEffect(() => { chat.current?.scrollTo({top: chat.current.scrollHeight, behavior: reducedMotion ? "instant" : "smooth"}); }, [state?.transcript.length, reducedMotion]);

    useEffect(() => {
        if (!state || blocked || error || state.phase === "finished") return;
        const ownTurn = (state.phase === "seller") === (state.config.role === "seller");
        if (human && (ownTurn || state.phase === "transition")) return;
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
        }, (state.phase === "transition" ? 1700 : 1050) / speed);
        return () => { live = false; controller.abort(); window.clearTimeout(timer); };
    }, [state, blocked, error, retry, mode, decide, profile, locale, speed]);

    useEffect(() => {
        if (!state || state.phase !== "finished" || blocked || !autoAdvance) return;
        const timer = window.setTimeout(() => {
            if (!delivered.current) { delivered.current = true; onComplete(resultFor(state, props, model)); }
        }, 2500);
        return () => window.clearTimeout(timer);
    }, [state, blocked, autoAdvance, onComplete, profile.name, locale, mode, model]);

    const finish = () => {
        if (state?.phase === "finished" && !delivered.current) { delivered.current = true; onComplete(resultFor(state, props, model)); }
    };
    const patch = (change: Partial<ShopConfig>) => { setConfig(current => ({...current, ...change})); };

    if (!state) return <section className={`shop-game ${reducedMotion ? "shop-still" : ""}`} aria-labelledby="shop-title">
        <header className="shop-heading"><span>{c.tag}</span><button type="button" className="arc-text-button" onClick={onExit}>{c.exit}</button><h1 id="shop-title">{c.title}</h1><p>{c.sub}</p></header>
        {autoAdvance && <p role="status">{locale === "ko" ? "자동 진행 · 5초 뒤 시작해요. 위에서 자동 진행을 끄면 편하게 설정할 수 있어요." : "Automatic play · Starts in 5 seconds. Turn it off above to configure at your pace."}</p>}
        <form className="shop-setup"
            onSubmit={event => { event.preventDefault(); setPaused(false); setState(createShop(seed, config)); }}>
            <div className="shop-owner"><GameArt game="shop" className="shop-owner-art" /><GuardianAvatar appearance={appearance} color={profile.color} /><strong>{profile.name}</strong><span>{mode === "llm" ? c.llm : c.rules}</span><p>{sellerRole ? c.sellerHelp : c.buyerHelp}</p></div>
            <div className="shop-config">
                {human && sellerRole && <GameGuide game="shop" locale={locale} />}
                <fieldset className="shop-roles"><legend>{c.role}</legend><RadioGroup className="mapae-roles" value={config.role} onValueChange={(role: ShopConfig["role"]) => patch({role})} aria-label={c.role}>{(["seller", "buyer"] as const).map(role => <Radio.Root key={role} value={role} className="mapae-role" render={<button type="button" />} nativeButton>{role === "seller" ? <Store size={17} /> : <ShoppingBag size={17} />}{c[role]}</Radio.Root>)}</RadioGroup></fieldset>
                {sellerRole ? <>
                    <label>{c.name}<input value={config.name} required maxLength={18} onChange={event => patch({name: event.target.value})} /></label>
                    <div className="shop-options"><label>{c.focus}<BrandSelect<ShopConfig["focus"]> tone="paper" value={config.focus} onValueChange={focus => patch({focus})} options={[{value: "balanced", label: c.balanced}, {value: "everyday", label: c.everyday}, {value: "gifts", label: c.gifts}]} /></label>
                        {!human && <label>{c.pricing}<BrandSelect<ShopConfig["pricing"]> tone="paper" value={config.pricing} onValueChange={pricing => patch({pricing})} options={[{value: 80, label: c.bargain}, {value: 100, label: c.standard}, {value: 125, label: c.premium}]} /></label>}
                        <label>{c.ad}<BrandSelect<ShopConfig["advertising"]> tone="paper" value={config.advertising} onValueChange={advertising => patch({advertising})} options={[{value: "none", label: c.none}, {value: "poster", label: c.poster}, {value: "parade", label: c.parade}]} /></label>
                        {!human && <label>{c.style}<BrandSelect<ShopConfig["negotiation"]> tone="paper" value={config.negotiation} onValueChange={negotiation => patch({negotiation})} options={[{value: "profit", label: c.profit}, {value: "loyalty", label: c.loyalty}]} /></label>}</div>
                </> : <><label>{c.goal}<BrandSelect<ShopConfig["buyerGoal"]> tone="paper" value={config.buyerGoal} onValueChange={buyerGoal => patch({buyerGoal})} options={(Object.keys(SHOP_GOALS) as ShopConfig["buyerGoal"][]).map(value => ({value, label: SHOP_GOALS[value][locale]}))} /></label>
                    <label>{c.cap} · 6–30<input type="number" min={6} max={30} step={1} required value={config.buyerCap} onChange={event => patch({buyerCap: Number(event.target.value)})} /></label><p>{c.capSeparate}</p></>}
                <div className="shop-capital"><span>{c.initial}</span><strong>{sellerRole ? SHOP_INITIAL_CAPITAL : SHOP_BUYER_BALANCE} {c.units}</strong></div>
                <p className="shop-funds">{c.funds}</p><button type="submit" className="arc-button" disabled={!config.name.trim()}>{c.begin}</button>
            </div>
        </form>
    </section>;

    const stats = shopMetrics(state);
    const buyer = state.buyers[state.customer]!;
    const humanTurn = human && (state.phase === "seller" || state.phase === "buyer") && (state.phase === "seller") === sellerRole;
    const ownObservation = sellerRole ? shopSellerObservation(state) : shopBuyerObservation(state);
    const otherLine = state.conversation.filter(line => line.speaker === (sellerRole ? "buyer" : "seller")).at(-1);
    const settled = state.phase === "transition" || state.phase === "finished";
    const traded = settled && state.conversation.at(-1)?.speaker === "system" && !state.rejected;
    const declined = !!state.lastOffer && !!state.rejected;
    const receipt = traded ? state.receipts.at(-1) : null;
    const requestItems = sellerRole ? (ownObservation.requestedQuantities ?? {}) as Record<string, number> : null;
    const lesson = state.finalOffer && !receipt ? ko ? "마지막 제안을 골라 이번 흥정이 끝났어요. 재흥정 여지를 남기려면 다른 제안을 먼저 건네 보세요." : "Your final offer ended this meeting. Another opening offer would leave room to bargain."
        : state.rejected === "price" || state.rejected === "CAP_BLOCKED" ? ko ? "가격이 맞지 않았어요. 다음에는 묶음을 줄이거나 손님의 역제안을 확인해 보세요." : "The price did not fit. Try a smaller bundle or the customer's counteroffer."
        : state.rejected === "fit" ? ko ? "필요한 구성과 달랐어요. 바쁜 손님은 한 번에 전부, 꼼꼼한 손님은 꼭 필요한 것만 원해요." : "The bundle did not fit. Hurried buyers want everything; careful buyers reject extras."
        : receipt ? receipt.goalAchievement < 100 ? ko ? "거래는 됐지만 주문을 전부 채우진 못했어요. 다음엔 필요한 수량까지 확인해 보세요." : "A deal, but an incomplete errand. Check the requested quantities next time."
        : receipt.price < receipt.cost ? ko ? "만족스러운 주문이지만 원가보다 싸게 팔았어요. 다음엔 거래 이익도 확인해요." : "The order was filled, but below cost. Check your margin next time."
        : ko ? "주문과 가격이 잘 맞았어요. 남은 재고로 다음 손님도 맞아 봐요." : "A good fit for needs and price. Keep an eye on stock for your next guest."
        : ko ? "거래를 마치지 않았어요. 주문에 맞는 구성부터 제안해 보세요." : "No completed trade. Start with a bundle that matches the request.";
    const nextMeeting = () => {
        if (blocked || state.phase !== "transition") return;
        const next = nextShopCustomer(state); setState(next);
        if (next.phase === "finished" && !delivered.current) { delivered.current = true; onComplete(resultFor(next, props, model)); }
    };
    return <section className={`shop-game ${reducedMotion ? "shop-still" : ""}`} aria-labelledby="shop-title">
        <header className="shop-heading shop-running"><span>{c.tag}</span><h1 id="shop-title">{sellerRole ? config.name : ko ? "오늘의 장보기" : "A day at the market"}</h1><div className="shop-controls">{!human && <div className="mapae-speed" role="group" aria-label={ko ? "관전 속도" : "Playback speed"}>{[1, 2].map(value => <button key={value} aria-pressed={speed === value} onClick={() => setSpeed(value)}>{value}×</button>)}</div>}<button type="button" onClick={() => {setPaused(p => !p); setBusy(false);}}>{paused ? c.resume : c.pause}</button><button type="button" onClick={onExit}>{c.exit}</button></div></header>
        <div className="shop-agent-line"><b>{profile.name} · {mode === "llm" ? `${c.llm}${model ? ` (${model})` : ""}` : c.rules}</b><span>{c.opponent}</span></div>
        <div className="shop-scoreboard"><span>{sellerRole ? c.customer : c.store}<b>{state.customer + 1}<small> / 3</small></b></span><span>{ko ? "남은 제안" : "Offers left"}<b>{shopOffersRemaining(state)}</b></span><span>{sellerRole ? c.cash : c.remaining}<b>{sellerRole ? state.cash : buyer.cap - buyer.spent}<small> {c.units}</small></b></span><span>{sellerRole ? c.net : c.achieved}<b>{sellerRole ? stats.profit : stats.goal}<small>{sellerRole ? ` ${c.units}` : "%"}</small></b></span></div>
        <div className="shop-counter-layout" ref={counter} tabIndex={-1} aria-label={ko ? "손님과 흥정하기" : "Bargain at the counter"}>
            <div className="shop-stage-column"><section className={`shop-customer-stage ${traded ? "shop-deal-done" : ""} ${declined ? "shop-deal-rejected" : ""}`} aria-label={ko ? "오늘의 만남" : "Today's meeting"}>
                <img src="/arcade/shop-market.webp" width={960} height={960} alt="" className="shop-stall-backdrop" draggable={false} />
                <div className="shop-meeting-tag">{ko ? "흥정상회" : "TINY SHOP"}<span>{String(state.customer + 1).padStart(2, "0")} / 03</span></div>
                <div className="shop-guest" key={state.customer}>
                    {sellerRole ? <GuardianAvatar appearance={{version: 1, seed: "0000000000000001", zodiac: (["rabbit", "tiger", "pig"] as const)[(state.customer + Math.abs(seed % 3)) % 3]!, backdrop: "jade", charm: "none"}} color="jade" /> : <GuardianAvatar appearance={appearance} color={profile.color} />}
                    <div><span>{sellerRole ? ko ? "오늘의 손님" : "YOUR CUSTOMER" : ko ? "나의 장보기" : "YOUR SHOPPING TRIP"}</span><strong>{sellerRole ? buyer.name : profile.name}</strong></div>
                    {traded && <span className="shop-guest-reaction" aria-label={ko ? "기뻐하는 손님" : "A happy customer"}>♥</span>}
                    {declined && <span className="shop-guest-reaction" aria-label={ko ? "거절한 손님" : "Customer declined"}>…</span>}
                </div>
                <div className="shop-speech" role="status"><span>{blocked ? c.stopped : otherLine?.text[locale] || (sellerRole ? ko ? "안녕하세요! 필요한 물건을 살펴보고 있어요." : "Hello! Let me see what you have." : SHOP_GOALS[config.buyerGoal][locale])}</span></div>
                <div className="shop-counter-edge"><span>{settled ? traded ? ko ? "거래 성사!" : "IT'S A DEAL!" : ko ? "다음 기회에 만나요" : "UNTIL NEXT TIME" : humanTurn ? ko ? "내 차례 · 제안해 주세요" : "YOUR TURN" : ko ? "상대의 답변을 기다려요" : "WAITING FOR A REPLY"}</span><b aria-hidden="true">馬牌</b></div>
            </section>
            {sellerRole && <div className="shop-story-note"><span>{SHOP_STORIES[buyer.story].title[locale]}</span><p>{SHOP_STORIES[buyer.story].hint[locale]}</p><small>{SHOP_TEMPERAMENT_COPY[buyer.temperament][locale]} · {SHOP_TEMPERAMENT_COPY[buyer.temperament].hint[locale]}</small>
                {state.referral && <strong className="shop-referral-note">{ko ? `${state.referral.from}의 소개로 왔어요 · 제안 기회 +1` : `Recommended by ${state.referral.from} · +1 offer`}</strong>}
            </div>}
            </div>
            <div className="shop-trading-table" aria-busy={busy && !blocked}>
                {human && sellerRole && !settled && <div className="shop-order-note">
                    <div><strong>{buyer.name} · {SHOP_TEMPERAMENT_COPY[buyer.temperament][locale]}</strong><span>{ko ? `남은 제안 ${shopOffersRemaining(state)}회` : `${shopOffersRemaining(state)} offers left`}</span></div>
                    <p>{SHOP_PRODUCTS.filter(p => (requestItems?.[p.id] ?? 0) > 0).map(p => `${p.name[locale]} ×${requestItems![p.id]}`).join(" · ") || (ko ? "주문을 듣고 있어요…" : "Listening to the order…")}</p>
                    <small>{state.counterOffer ? ko ? `역제안 도착 · ${state.counterOffer.price}냥` : `Counteroffer: ${state.counterOffer.price} coins` : SHOP_TEMPERAMENT_COPY[buyer.temperament].hint[locale]}</small>
                </div>}

                {humanTurn ? <HumanShopControls key={`${state.customer}:${state.rounds}:${state.phase}`} locale={locale} disabled={blocked}
                    {...(sellerRole ? {role: "seller" as const, observation: ownObservation, onAction: (action: Parameters<typeof applySellerAction>[1]) => setState(current => current === state ? applySellerAction(current, action) : current)} :
                        {role: "buyer" as const, observation: ownObservation, onAction: (action: Parameters<typeof applyBuyerAction>[1]) => setState(current => current === state ? applyBuyerAction(current, action) : current)})} /> : settled ? <div className="shop-meeting-result" role="status">
                    <span className="shop-deal-seal">{traded ? ko ? "성사" : "DEAL" : ko ? "마감" : "CLOSED"}</span><h2>{traded ? ko ? "좋은 거래였어요!" : "A deal to remember!" : ko ? "이번에는 거래 없이 마쳤어요" : "No deal this time"}</h2>
                    {receipt ? <><p>{receipt.items.map(i => `${SHOP_PRODUCTS.find(p => p.id === i.id)!.name[locale]} ×${i.quantity}`).join(" + ")}</p><div className="shop-deal-totals"><span>{ko ? "거래 금액" : "Trade price"}<b>{receipt.price} {c.units}</b></span><span>{c.satisfaction}<b>{receipt.satisfaction}%</b></span><span>{sellerRole ? ko ? "거래 이익" : "Trade profit" : c.achieved}<b>{sellerRole ? `${receipt.price - receipt.cost} ${c.units}` : `${receipt.goalAchievement}%`}</b></span></div></> : <p>{ko ? "필요한 상품과 가격이 맞아야 거래가 성사돼요. 다음 만남에서 다시 도전해요." : "Needs and price both need to fit. Try a different offer next time."}</p>}
                    <aside className="game-coach"><strong>{ko ? "이번 흥정의 한 수" : "AT THIS COUNTER"}</strong><p>{lesson}</p></aside>
                    {human && state.phase === "transition" && <button className="arc-button" disabled={blocked} onClick={nextMeeting}>{state.customer === 2 ? c.result : sellerRole ? ko ? "다음 손님 맞이하기" : "Welcome the next customer" : ko ? "다음 가게로" : "Visit the next shop"} →</button>}
                    {state.phase === "finished" && <button className="arc-button" onClick={finish}>{c.result} →</button>}
                    {!human && state.phase === "transition" && <p>{blocked ? c.stopped : c.next}</p>}
                </div> : <div className="shop-waiting-table">
                    <span className="arc-overline">{ko ? "보따리를 살펴보는 중" : "AT THE COUNTER"}</span>
                    <div className="shop-offered-goods">{(state.offer?.items ?? []).map(item => <div key={item.id}><img src={`/arcade/item-${item.id}-512.webp`} width={96} height={96} alt={SHOP_PRODUCTS.find(p => p.id === item.id)!.name[locale]} /><b>×{item.quantity}</b></div>)}</div>
                    {state.offer && <strong>{state.offer.price} {c.units}</strong>}
                    <p role="status">{blocked ? c.stopped : c.waiting}</p><span className="shop-waiting-dots" aria-hidden="true">● ● ●</span>
                </div>}
                {error && <div className="shop-notice shop-error" role="alert"><p>{c.error}</p><small>{c.failureNote}</small><button type="button" onClick={() => {setError(false); setRetry(v => v + 1);}}>{c.retry}</button></div>}
            </div>
        </div>
        <details className="shop-ledger"><summary>{c.chat} · {state.conversation.length}</summary><div className="shop-chat" ref={chat} role="log" aria-live="polite">{state.conversation.map((entry, index) => <div key={index} className={`shop-bubble shop-bubble-${entry.speaker}`}><b>{entry.speaker === "seller" ? c.seller : entry.speaker === "buyer" ? c.buyer : "MAPAE"}</b><p>{entry.text[locale]}</p></div>)}</div>{thought && <p className="shop-thought">{thought}</p>}</details>
        <details className="shop-ledger"><summary>{c.receipt} · {state.receipts.length}</summary><div className="shop-receipt-list">{state.receipts.map((receipt, index) => <article key={index}><span className="shop-paid">{ko ? "놀이 거래" : "PLAY TRADE"} ✓</span><strong>{receipt.items.map(item => `${SHOP_PRODUCTS.find(p => p.id === item.id)!.name[locale]} ×${item.quantity}`).join(" + ")}</strong><b>{receipt.price} {c.units}</b><small>{c.satisfaction} {receipt.satisfaction}% · {c.achieved} {receipt.goalAchievement}%</small></article>)}</div></details>
        <p className="shop-funds">{c.funds}</p>
    </section>;
}
