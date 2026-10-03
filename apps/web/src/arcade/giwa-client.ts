import {PROFILE_GENERATION} from "./profile/model";
import type {GameId} from "@mapae/arcade";
import {ARCADE_PAY_TO, ARCADE_REDEEMER, ARCADE_SELLER, ARCADE_TICKETS, ARCADE_TICKET_PRICE, ARCADE_TICKET_AMOUNT} from "@mapae/arcade/tickets";
import {payForDelegatedResource, type DelegatedLeafProvider} from "@mapae/delegation/payment-client";
import type {PeriodPolicy} from "@mapae/delegation/policy";
import {GIWA_SEPOLIA_CAIP2, MOCK_USDC, toTokenAmount} from "@mapae/shared";
import {decodeEventLog, erc20Abi, getAddress, isAddress, isHash, type Address, type Log} from "viem";
import {readGiwaPending, writeGiwaPending, type GiwaPending, type GiwaReceipt} from "./giwa-store";
import {validAllowance, MAX_ALLOWANCE_ADMISSIONS} from "./allowance";

export class GiwaTicketError extends Error {}

export function hasGiwaTicketTransfer(logs: Pick<Log, "address" | "topics" | "data">[], payer: Address): boolean {
    return logs.some(log => {
        if (getAddress(log.address) !== getAddress(MOCK_USDC.address)) return false;
        try {
            const event = decodeEventLog({abi: erc20Abi, eventName: "Transfer", topics: log.topics, data: log.data});
            return getAddress(event.args.from) === getAddress(payer) && getAddress(event.args.to) === ARCADE_PAY_TO && event.args.value === ARCADE_TICKET_AMOUNT;
        } catch {return false;}
    });
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function arcadePolicy(admissions: number): PeriodPolicy {
    if (!validAllowance(admissions)) throw new GiwaTicketError(`Select 1–${MAX_ALLOWANCE_ADMISSIONS} admissions per character.`);
    return {role: "vendor-agent", token: MOCK_USDC.address, periodAmount: BigInt(admissions) * ARCADE_TICKET_AMOUNT,
        lifetimeTotalAmount: BigInt(admissions) * ARCADE_TICKET_AMOUNT, periodDurationSeconds: 60, expiresAfterSeconds: 1800, recipient: ARCADE_PAY_TO};
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
export function parseGiwaReceipt(value: unknown, game: GameId, payer: Address): GiwaReceipt {
    if (!object(value) || !object(value.ticket) || !object(value.receipt)) throw new GiwaTicketError("Invalid GIWA ticket receipt.");
    const t = value.ticket, r = value.receipt;
    let amount: bigint | null = null;
    try {if (typeof r.amount === "string") amount = toTokenAmount(r.amount);} catch { /* Invalid amounts fail the receipt match below. */ }
    // Human-readable ticket text is presentation. The structured receipt and
    // independently checked Transfer bind the token and exact payment amount.
    if (!object(t.shop) || t.shop.slug !== "mapae-arcade" || !object(t.item) || t.item.key !== game ||
        typeof t.code !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(t.code) ||
        typeof t.transaction !== "string" || !isHash(t.transaction) || r.transaction !== t.transaction ||
        typeof r.payer !== "string" || !isAddress(r.payer) || getAddress(r.payer) !== getAddress(payer) ||
        r.method !== "erc7710" || r.network !== GIWA_SEPOLIA_CAIP2 || amount !== ARCADE_TICKET_AMOUNT ||
        typeof r.asset !== "string" || !isAddress(r.asset) || getAddress(r.asset) !== getAddress(MOCK_USDC.address) ||
        typeof r.payTo !== "string" || !isAddress(r.payTo) || getAddress(r.payTo) !== ARCADE_PAY_TO) throw new GiwaTicketError("The GIWA receipt did not match this ticket. Do not pay again.");
    return {code: t.code, transaction: t.transaction, payer};
}

/** Caller serialises admissions; a pending request is always replayed byte-for-byte. */
export async function buyGiwaTicket(params: {game: GameId; requestId: string; characterId: string; owner: Address;
    payer: Address; delegationManager: Address; provider?: DelegatedLeafProvider; fetcher?: typeof fetch}): Promise<GiwaReceipt> {
    const {game, requestId, characterId, owner, payer} = params;
    const fetcher = params.fetcher ?? fetch;
    const pending = readGiwaPending();
    if (pending && (pending.requestId !== requestId || pending.game !== game || pending.characterId !== characterId ||
        getAddress(pending.owner) !== getAddress(owner) || getAddress(pending.payer) !== getAddress(payer))) throw new GiwaTicketError("Recover the pending ticket before a new payment.");
    if (pending?.receipt) return pending.receipt;
    async function submit(value: GiwaPending, signal?: AbortSignal | null) {
        if (!value.header) throw new GiwaTicketError("정산을 확인 중이에요. 다시 불러오거나 결제 식별자로 문의해 주세요. 새 결제는 만들지 않아요. / Settlement unresolved; refresh or contact support. No new charge.");
        const response = await fetcher("/api/arcade/profile/checkout", {method: "POST", credentials: "same-origin",
            headers: {"Content-Type": "application/json", "X-Mapae-Wallet": owner},
            body: JSON.stringify({generation: PROFILE_GENERATION, requestId, characterId, game, header: value.header}),
            redirect: "error", signal: signal ?? AbortSignal.timeout(70_000)});
        if (!response.ok) return response;
        const result: unknown = await response.json();
        const v = object(result) && object(result.pending) ? result.pending : null;
        const r = v && object(v.receipt) ? v.receipt : null;
        if (!v || v.requestId !== requestId || v.game !== game || v.owner !== owner.toLowerCase() || !r) throw new GiwaTicketError("Ticket unresolved; no new payment was made.");
        // Adapt the authenticated cloud receipt to the existing strict receipt parser.
        return Response.json({ticket: {code: r.code, shop: {slug: "mapae-arcade"}, item: {key: game}, transaction: r.transaction},
            receipt: {...r, method: "erc7710", amount: ARCADE_TICKET_PRICE, asset: MOCK_USDC.address, payTo: ARCADE_PAY_TO, network: GIWA_SEPOLIA_CAIP2}});
    }
    let receipt: GiwaReceipt;
    if (pending) {
        const response = await submit(pending);
        if (!response.ok) throw new GiwaTicketError("입장권 확인 중이에요. 같은 결제만 복구하며 추가 결제하지 않아요. / Ticket unresolved; no new payment was made.");
        receipt = parseGiwaReceipt(await response.json(), game, payer);
    } else {
        if (!params.provider) throw new GiwaTicketError("먼저 GIWA 용돈 한도를 승인해 주세요. / Approve the GIWA allowance first.");
        const result = await payForDelegatedResource(new URL(`${ARCADE_SELLER}/${game}`), {
            provider: params.provider, delegationManager: params.delegationManager, trustedFacilitators: [ARCADE_REDEEMER],
            preflight: async offer => offer.amount === ARCADE_TICKET_AMOUNT.toString() && getAddress(offer.payTo) === ARCADE_PAY_TO && offer.maxTimeoutSeconds <= 300
                ? {ok: true} : {ok: false, code: "SPEND_POLICY_REFUSED", detail: `Only the fixed ${ARCADE_TICKET_PRICE} ${MOCK_USDC.symbol} arcade ticket is permitted.`},
            fetchImpl: Object.assign(async (_url: RequestInfo | URL, options?: RequestInit) => {
                const header = new Headers(options?.headers).get("Payment-Signature");
                if (!header) return fetcher(`/api/arcade/giwa/${game}`, {redirect: "error", signal: options?.signal});
                const value: GiwaPending = {game, requestId, characterId, owner, payer, header, receipt: null};
                writeGiwaPending(value); // A storage failure stops before the first submission.
                return submit(value, options?.signal);
            }, {preconnect: fetcher.preconnect}),
        });
        if (!result.ok) {
            // Keep the exact request until the server confirms admission.
            throw new GiwaTicketError(`GIWA 입장권을 확인하지 못했어요 (${result.code}). 확인 전 새 결제를 만들지 않아요. / No fresh payment until resolved.`);
        }
        receipt = parseGiwaReceipt(result.resource, game, payer);
    }
    const sent = readGiwaPending();
    if (!sent) throw new GiwaTicketError("Pending payment record missing. Check the seller receipt before continuing.");
    writeGiwaPending({...sent, receipt});
    return receipt;
}
