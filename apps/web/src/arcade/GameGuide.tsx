import type {GameId} from "@mapae/arcade";
import type {Locale} from "../lib/i18n";
import "./game-guide.css";

const STEPS = {
    race: {ko: ["출발 작전 선택", "안쪽에서 체력 비축, 바깥으로 추월", "승부수는 딱 한 번! 체력 20 사용"], en: ["Choose your starting strategy", "Follow inside to save stamina; pass outside", "One burst per race costs 20 stamina"]},
    shop: {ko: ["손님의 사연과 주문 읽기", "맞춤 추천·넉넉한 꾸러미·거래 확정", "예고 손님의 주문 완수 → 다음 방문 후일담"], en: ["Read the customer's story", "Recommend, add a little, or close the deal", "Fulfill the featured guest’s order for a follow-up visit"]},
    stamp: {ko: ["도깨비 창문을 톡!", "배달부는 건너뛰기", "피버 충전 후 원하는 순간에 발동"], en: ["Tap a goblin's window", "Let couriers pass", "Charge fever, then choose your moment"]},
} as const;

export function GameGuide({game, locale}: {game: GameId; locale: Locale}) {
    return <ol className="game-quick-guide" aria-label={locale === "ko" ? "이렇게 플레이해요" : "How to play"}>
        {STEPS[game][locale].map((step, i) => <li key={step}><span aria-hidden="true">{i + 1}</span>{step}</li>)}
    </ol>;
}
