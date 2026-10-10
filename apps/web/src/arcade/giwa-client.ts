import {OUTING_PERMISSION_SECONDS} from "@mapae/arcade/outings";
import {ARCADE_PAY_TO, ARCADE_SELLER, ARCADE_TICKETS, ARCADE_TICKET_PRICE, ARCADE_TICKET_AMOUNT} from "@mapae/arcade/tickets";
import type {PeriodPolicy} from "@mapae/delegation/policy";
import {GIWA_SEPOLIA_CAIP2, MOCK_USDC} from "@mapae/shared";
import {getAddress, isAddress} from "viem";
import {validAllowance, MAX_ALLOWANCE_ADMISSIONS} from "./allowance";

export class GiwaTicketError extends Error {}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function arcadePolicy(admissions: number): PeriodPolicy {
    if (!validAllowance(admissions)) throw new GiwaTicketError(`Select 1–${MAX_ALLOWANCE_ADMISSIONS} admissions per character.`);
    return {role: "vendor-agent", token: MOCK_USDC.address, periodAmount: BigInt(admissions) * ARCADE_TICKET_AMOUNT,
        lifetimeTotalAmount: BigInt(admissions) * ARCADE_TICKET_AMOUNT, periodDurationSeconds: 60, expiresAfterSeconds: OUTING_PERMISSION_SECONDS, recipient: ARCADE_PAY_TO};
}
export async function checkGiwaCatalogue(fetcher: typeof fetch = fetch): Promise<void> {
    const response = await fetcher("/api/arcade/giwa", {redirect: "error", signal: AbortSignal.timeout(15_000)});
    const v: unknown = await response.json();
    const items = object(v) && Array.isArray(v.items) ? v.items : [];
    if (!response.ok || !object(v) || v.slug !== "mapae-arcade" || v.network !== GIWA_SEPOLIA_CAIP2 ||
        typeof v.payTo !== "string" || !isAddress(v.payTo) || getAddress(v.payTo) !== ARCADE_PAY_TO ||
        typeof v.asset !== "string" || !isAddress(v.asset) || getAddress(v.asset) !== getAddress(MOCK_USDC.address) ||
        Object.keys(ARCADE_TICKETS).some(game => !items.some((item: unknown) =>
            object(item) && item.key === game && item.price === ARCADE_TICKET_PRICE && item.url === `${ARCADE_SELLER}/${game}`))) {
        throw new GiwaTicketError("GIWA 아케이드 입장권이 아직 열리지 않았어요. 무료 체험을 이용해 주세요. / GIWA tickets are not available yet.");
    }
}
