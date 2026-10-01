import type {GameId} from "./contracts.js";
import {toTokenAmount} from "@mapae/shared/token";

/** Existing GIWA Sepolia seller and redeemer, verified against their public manifests. */
export const ARCADE_SELLER = "https://seller.mapae.io/s/mapae-arcade";
export const ARCADE_PAY_TO = "0x550e9180fD747f218Aff714F37Df816Ea1BB2A55";
export const ARCADE_REDEEMER = "0x5eA109EDC7E89b6A752032Aa2B6F1092e081E7eC";
export const ARCADE_TICKET_PRICE = "1.00";
export const ARCADE_TICKET_COST = Number(ARCADE_TICKET_PRICE);
export const ARCADE_TICKET_AMOUNT = toTokenAmount(ARCADE_TICKET_PRICE);
export const ARCADE_TICKETS: Readonly<Record<GameId, {name: string; description: string}>> = {
    stamp: {name: "도깨비 도장찍기", description: "60초 도장 놀이 입장권 · GIWA Sepolia 테스트 토큰"},
    race: {name: "Auto Race", description: "3경기 시즌 입장권 · GIWA Sepolia 테스트 토큰"},
    shop: {name: "Tiny Shop", description: "손님 3명 또는 가게 3곳 입장권 · GIWA Sepolia 테스트 토큰"},
};
