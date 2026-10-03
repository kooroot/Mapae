import {useState} from "react";
import {SHOP_PRODUCTS, shopOfferChoices, type BuyerAction, type SellerAction, type ProductId} from "@mapae/arcade/shop";
import type {JsonValue} from "@mapae/arcade";

type Props = {locale: "ko" | "en"; observation: Record<string, JsonValue>; disabled: boolean} & (
    {role: "seller"; onAction: (action: SellerAction) => void} | {role: "buyer"; onAction: (action: BuyerAction) => void}
);
const image = (id: ProductId) => `/arcade/item-${id}-512.webp`;

/** Both the counter and the agent use the same public observation, never private buyer state. */
export function HumanShopControls(props: Props) {
    const {locale, observation: o, disabled} = props, ko = locale === "ko";
    const inventory = o.inventory as Record<ProductId, number> | undefined;
    const disclosed = Array.isArray(o.requestedItems) ? o.requestedItems : [];
    const requested = (o.requestedQuantities ?? {}) as Partial<Record<ProductId, number>>;
    const [quantities, setQuantities] = useState<Record<ProductId, number>>(() => Object.fromEntries(SHOP_PRODUCTS.map(p => [p.id,
        disclosed.includes(p.id) ? Math.min(3, inventory?.[p.id] ?? 0, requested[p.id] ?? 1) : 0])) as Record<ProductId, number>);
    const [price, setPrice] = useState(10);
    const target = o.target as Record<ProductId, number> | undefined, acquired = o.acquired as Record<ProductId, number> | undefined;
    const [wants, setWants] = useState<ProductId[]>(() => SHOP_PRODUCTS.filter(p => (target?.[p.id] ?? 0) > (acquired?.[p.id] ?? 0)).map(p => p.id));
    const unit = ko ? "냥" : "coins";
    if (props.role === "seller") {
        const items = SHOP_PRODUCTS.filter(p => quantities[p.id] > 0).map(p => ({id: p.id, quantity: quantities[p.id]}));
        const retail = items.reduce((total, item) => total + SHOP_PRODUCTS.find(p => p.id === item.id)!.retail * item.quantity, 0);
        const cost = items.reduce((total, item) => total + SHOP_PRODUCTS.find(p => p.id === item.id)!.cost * item.quantity, 0);
        const counter = o.counterOffer as {items: {id: ProductId; quantity: number}[]; price: number} | null;
        const offer = (amount: number) => {
            if (disabled || !items.length || !Number.isInteger(amount) || amount < 1 || amount > 99) return;
            const names = items.map(i => `${SHOP_PRODUCTS.find(p => p.id === i.id)!.name[locale]} ×${i.quantity}`).join(" + ");
            props.onAction({type: "offer", items, price: amount, message: ko ? `${names}, ${amount}냥에 드릴게요!` : `${names} for ${amount} coins!`});
        };
        const choices = shopOfferChoices(o, locale);
        const serve = (choice: typeof choices[number]) => {
            if (disabled || !choice.available) return;
            const names = choice.items.map(item => `${SHOP_PRODUCTS.find(p => p.id === item.id)!.name[locale]} ×${item.quantity}`).join(" + ");
            props.onAction({type: "serve", tactic: choice.tactic, message: ko ? `${names}, ${choice.price}냥에 드릴게요!` : `${names} for ${choice.price} coins!`});
        };
        return <section className="shop-hand-controls" aria-label={ko ? "판매 제안" : "Your offer"}>
            <div className="shop-turn-label"><strong>{ko ? "보따리에 무엇을 담을까요?" : "What goes in the bundle?"}</strong><span>{ko ? `${o.roundsLeft}번 제안 가능` : `${o.roundsLeft} offers left`}</span></div>
            <div className="shop-stock-rail" aria-label={ko ? "남은 재고" : "Remaining stock"}>{SHOP_PRODUCTS.map(p => <div key={p.id}><img src={image(p.id)} width={32} height={32} alt="" /><span>{p.name[locale]}<b>{inventory?.[p.id] ?? 0}{ko ? "개" : " left"}</b></span></div>)}</div>
            {counter && <div className="shop-counter-bid"><span>{ko ? "손님의 역제안" : "CUSTOMER'S COUNTEROFFER"}</span><strong>{counter.items.map(i => `${SHOP_PRODUCTS.find(p => p.id === i.id)!.name[locale]} ×${i.quantity}`).join(" + ")}</strong><b>{counter.price} {unit}</b><small>{ko ? "아래 ‘그 가격에 성사’를 누르면 이 구성으로 제안해요." : "Choose ‘Take their bid’ below to offer this exact bundle."}</small></div>}
            <div className="shop-offer-choices shop-contextual-choices">{choices.map(choice => <button key={choice.tactic} disabled={disabled || !choice.available} onClick={() => serve(choice)}>
                <strong>{choice.label}</strong><b>{choice.price} <small>{unit}</small></b>
                <span className="shop-choice-items">{choice.items.map(item => `${SHOP_PRODUCTS.find(p => p.id === item.id)!.name[locale]} ×${item.quantity}`).join(" + ")}</span>
                <span>{ko ? "거래 이익" : "Trade profit"} {choice.price - choice.cost > 0 ? "+" : ""}{choice.price - choice.cost} {unit} · {choice.completesOrder ? ko ? "요청량 충족" : "Full request" : ko ? "일부만 충족" : "Partial request"}</span>
                {Object.values(choice.reserveShortfall).some(amount => amount > 0) && <span className="shop-reserve-warning">{ko ? "이 거래 뒤 마지막 손님 재고 부족: " : "After this sale, final guest needs: "}{SHOP_PRODUCTS.filter(p => choice.reserveShortfall[p.id] > 0).map(p => `${p.name[locale]} ×${choice.reserveShortfall[p.id]}`).join(" · ")}</span>}
                <small>{!choice.available ? ko ? "재고가 부족해요" : "Not enough stock" : choice.hint}</small>
            </button>)}</div>
            {!choices.length && <p className="shop-limit-note">{ko ? "먼저 손님에게 필요한 물건을 물어보세요." : "Ask what the customer needs first."}</p>}
            <details className="shop-custom-price shop-custom-bundle"><summary>{ko ? "보따리와 가격 직접 조합" : "Build your own bundle and price"}</summary>
            <div className="shop-product-picker">{SHOP_PRODUCTS.map(p => <div className={quantities[p.id] ? "shop-picked" : ""} key={p.id}>
                <img src={image(p.id)} alt="" width={100} height={100} draggable={false} /><strong>{p.name[locale]}</strong><small>{ko ? "재고" : "Stock"} {inventory?.[p.id] ?? 0} · {ko ? "원가" : "Cost"} {p.cost}</small>
                <div className="shop-stepper"><button disabled={disabled || quantities[p.id] === 0} aria-label={`${p.name[locale]} ${ko ? "빼기" : "remove"}`} onClick={() => setQuantities(q => ({...q, [p.id]: q[p.id] - 1}))}>−</button><output aria-label={`${p.name[locale]} ${ko ? "수량" : "quantity"}`}>{quantities[p.id]}</output><button disabled={disabled || quantities[p.id] >= Math.min(3, inventory?.[p.id] ?? 0)} aria-label={`${p.name[locale]} ${ko ? "담기" : "add"}`} onClick={() => setQuantities(q => ({...q, [p.id]: q[p.id] + 1}))}>+</button></div>
            </div>)}</div>
            <form onSubmit={e => {e.preventDefault(); offer(price);}}><label>{ko ? "전체 가격" : "Total price"}<input type="number" min={1} max={99} step={1} inputMode="numeric" required disabled={disabled} value={price} onChange={e => setPrice(Number(e.target.value))} /></label><button className="arc-button" disabled={disabled || !items.length}>{ko ? "직접 제안" : "Offer"}</button></form><p className="shop-custom-margin">{ko ? "원가" : "Cost"} {cost} · {ko ? "기본가" : "Retail"} {retail} · {ko ? "거래 이익" : "Trade profit"} {Number.isFinite(price) ? price - cost : "—"} {unit}</p></details>
            <div className="shop-turn-links"><button disabled={disabled} onClick={() => props.onAction({type: "ask", message: ko ? "어떤 물건이 필요한가요?" : "What do you need?"})}>{ko ? "필요한 것 물어보기 · 제안 1회" : "Ask their needs · 1 offer"}</button><button disabled={disabled} onClick={() => props.onAction({type: "close", message: ko ? "다음에 또 들러 주세요!" : "Come back another time!"})}>{ko ? "손님 보내기" : "End meeting"}</button></div>
        </section>;
    }
    const offer = o.offer as {price: number; items: {id: ProductId; quantity: number}[]} | null;
    const remaining = Math.min(Number(o.remainingBalance), Number(o.spendingRemaining));
    return <section className="shop-hand-controls">
        <div className="shop-turn-label"><strong>{ko ? "필요한 만큼, 알뜰하게" : "Just what you need"}</strong><span>{ko ? "남은 한도" : "Your cap"} {remaining} {unit}</span></div>
        <div className="shop-product-picker shop-shopping-list">{SHOP_PRODUCTS.map(p => <button key={p.id} disabled={disabled} aria-pressed={wants.includes(p.id)} onClick={() => setWants(v => v.includes(p.id) ? v.filter(id => id !== p.id) : [...v, p.id])}>
            <img src={image(p.id)} alt="" width={100} height={100} draggable={false} /><strong>{p.name[locale]}</strong><small>{ko ? "구매 목표" : "Goal"} {acquired?.[p.id] ?? 0} / {target?.[p.id] ?? 0}</small><span>{wants.includes(p.id) ? ko ? "✓ 요청할 상품" : "✓ Selected" : ko ? "눌러서 선택" : "Tap to select"}</span>
        </button>)}</div>
        {offer && <div className="shop-buyer-offer"><span>{ko ? "상인의 제안" : "Merchant's offer"}</span><strong>{offer.items.map(i => `${SHOP_PRODUCTS.find(p => p.id === i.id)!.name[locale]} ×${i.quantity}`).join(" + ")}</strong><b>{offer.price} {unit}</b></div>}
        <div className="shop-buyer-actions">{offer && <><button className="arc-button" disabled={disabled || offer.price > remaining} onClick={() => props.onAction({type: "buy", reason: "need"})}>{ko ? `${offer.price}냥에 구매` : `Buy for ${offer.price} coins`} →</button><button className="arc-button arc-button-plain" disabled={disabled} onClick={() => props.onAction({type: "decline", reason: "price"})}>{ko ? "조금 깎아 주세요" : "Ask for a better price"}</button></>}
            <button className="arc-button arc-button-plain" disabled={disabled || !wants.length} onClick={() => props.onAction({type: "request", reason: "need", wants})}>{ko ? "고른 상품 요청" : "Request selected items"} →</button></div>
        <div className="shop-turn-links"><button disabled={disabled} onClick={() => props.onAction({type: "decline", reason: "done"})}>{ko ? "이번 가게 나가기" : "Leave this shop"}</button></div>
        {offer && offer.price > remaining && <p className="shop-limit-note" role="status">{ko ? "남은 한도를 넘어요. 흥정하거나 더 작은 묶음을 요청해요." : "Over your cap. Bargain or request a smaller bundle."}</p>}
    </section>;
}
