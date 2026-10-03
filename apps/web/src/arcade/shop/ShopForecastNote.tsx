import {SHOP_PRODUCTS, SHOP_REGULARS, shopReturnLine, type Basket, type ShopForecast} from "@mapae/arcade/shop";

export function ShopForecastNote({forecast, locale, inventory, arrived = false}: {
    forecast: ShopForecast; locale: "ko" | "en"; inventory?: Basket; arrived?: boolean;
}) {
    const ko = locale === "ko", name = SHOP_REGULARS[forecast.npc].name[locale];
    return <aside className="shop-forecast" aria-label={ko ? "마지막 손님 예고" : "Final guest forecast"}>
        <div className="shop-forecast-title"><span>{arrived ? ko ? "약속한 손님 도착" : "YOUR GUEST HAS ARRIVED" : ko ? "마지막 손님 예고" : "FINAL GUEST FORECAST"}</span><b>{name} · {forecast.visit}/2</b></div>
        <div className="shop-forecast-goods">{SHOP_PRODUCTS.filter(p => forecast.target[p.id] > 0).map(p => <span key={p.id}>
            <img src={`/arcade/item-${p.id}-512.webp`} width={36} height={36} alt="" />
            <span>{p.name[locale]} <b>×{forecast.target[p.id]}</b>{inventory && !arrived && <small className={inventory[p.id] < forecast.target[p.id] ? "shop-reserve-warning" : ""}>{ko ? `재고 ${inventory[p.id]}개` : `${inventory[p.id]} in stock`}</small>}</span>
        </span>)}</div>
        <p>{shopReturnLine(forecast)[locale]}</p>
        <small>{forecast.visit === 1 ? ko ? "이번 장날 → 다음 장날 · 필요한 주문 완수 + 구매 가치 85 이상이면 정가 신뢰와 제안 +1. 한도는 그대로." : "This outing → next outing · A complete useful order with value ≥85 earns retail trust and +1 offer. The cap stays fixed."
            : ko ? "두 번째 만남 · 오늘 영업이 끝나면 새 인연을 시작해요." : "Second meeting · After today's market, a new two-visit story begins."}</small>
    </aside>;
}
