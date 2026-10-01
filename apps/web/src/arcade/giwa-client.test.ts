import type {Address, Hex, Log} from "viem";
import {encodeAbiParameters, toEventSelector, pad} from "viem";
import {afterEach, beforeEach, describe, expect, test} from "bun:test";
import {ARCADE_PAY_TO, ARCADE_REDEEMER, ARCADE_SELLER} from "@mapae/arcade/tickets";
import {GIWA_SEPOLIA_CAIP2, MOCK_USDC, encodePaymentRequiredHeader, type PaymentRequired, type Erc7710PaymentRequirements} from "@mapae/shared";
import {arcadePolicy, buyGiwaTicket, checkGiwaCatalogue, parseGiwaReceipt, hasGiwaTicketTransfer} from "./giwa-client";
import {parseGiwaPending, readGiwaPending, writeGiwaPending} from "./giwa-store";

const payer: Address = "0x1111111111111111111111111111111111111111", owner: Address = "0x2222222222222222222222222222222222222222";
const manager: Address = "0x3333333333333333333333333333333333333333", tx: Hex = `0x${"a".repeat(64)}`;
const order = {ticket: {code: "ticket-12345678", shop: {slug: "mapae-arcade"}, item: {key: "race"}, amount: "1.00 mUSDC", transaction: tx},
    receipt: {method: "erc7710", transaction: tx, payer, network: GIWA_SEPOLIA_CAIP2, amount: "1.0", asset: MOCK_USDC.address, payTo: ARCADE_PAY_TO}};
let values: Map<string, string>;
const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
beforeEach(() => {
    values = new Map();
    Object.defineProperty(globalThis, "sessionStorage", {configurable: true, value: {
        getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key),
    }});
});
afterEach(() => {if (original) Object.defineProperty(globalThis, "sessionStorage", original); else Reflect.deleteProperty(globalThis, "sessionStorage");});
describe("GIWA ticket client", () => {
    test("owner permission has a lifetime budget, fixed payee, token and expiry", async () => {
        const p = arcadePolicy(36);
        expect(p.periodAmount).toBe(36_000_000n); expect(p.lifetimeTotalAmount).toBe(36_000_000n);
        expect(p.recipient).toBe(ARCADE_PAY_TO); expect(p.expiresAfterSeconds).toBe(1800);
        for (const count of [0, -1, 37, 0.5, NaN]) expect(() => arcadePolicy(count)).toThrow();
        const catalogue = {slug: "mapae-arcade", network: GIWA_SEPOLIA_CAIP2, payTo: ARCADE_PAY_TO, asset: MOCK_USDC.address,
            items: ["race", "shop", "stamp"].map(key => ({key, price: "1.00", url: `${ARCADE_SELLER}/${key}`}))};
        const fetcher = (price: string) => Object.assign(async () => Response.json({...catalogue,
            items: catalogue.items.map(item => ({...item, price}))}), {preconnect: fetch.preconnect});
        await checkGiwaCatalogue(fetcher("1.00"));
        await expect(checkGiwaCatalogue(fetcher("0.01"))).rejects.toThrow("tickets are not available");
        await expect(checkGiwaCatalogue(fetcher("2.00"))).rejects.toThrow("tickets are not available");
    });
    test("pending persistence strips unknown fields and keys; malformed state is a blocking error", () => {
        const pending = {requestId: crypto.randomUUID(), characterId: "maru", game: "race" as const, owner, payer, header: "YQ==", receipt: null,
            privateKey: "NEVER_PERSIST_THIS", agent: {privateKey: "ALSO_PRIVATE"}};
        writeGiwaPending(pending);
        expect([...values.values()].join()).not.toMatch(/PRIVATE|privateKey|agent/);
        expect(readGiwaPending()?.game).toBe("race");
        expect(() => parseGiwaPending('{"header":"garbage"}')).toThrow();
    });
    test("receipt must bind game, price, payer, recipient, token, network and transaction", () => {
        expect(parseGiwaReceipt(order, "race", payer).transaction).toBe(tx);
        expect(() => parseGiwaReceipt(order, "shop", payer)).toThrow();
        expect(parseGiwaReceipt({...order, ticket: {...order.ticket, amount: "입장권 1장"}}, "race", payer).transaction).toBe(tx);
        for (const amount of ["0.01", "1.000001", "2", "1e0", "1.0000000"]) {
            expect(() => parseGiwaReceipt({...order, receipt: {...order.receipt, amount}}, "race", payer)).toThrow();
        }
        for (const field of ["transaction", "payer", "network", "amount", "asset", "payTo"]) {
            expect(() => parseGiwaReceipt({...order, receipt: {...order.receipt, [field]: "wrong"}}, "race", payer)).toThrow();
        }
        const log: Pick<Log, "address" | "topics" | "data"> = {address: MOCK_USDC.address, topics: [toEventSelector("Transfer(address,address,uint256)"), pad(payer), pad(ARCADE_PAY_TO)], data: encodeAbiParameters([{type: "uint256"}], [1_000_000n])};
        expect(hasGiwaTicketTransfer([log], payer)).toBe(true);
        expect(hasGiwaTicketTransfer([log], owner)).toBe(false);
        expect(hasGiwaTicketTransfer([{...log, address: manager}], payer)).toBe(false);
        expect(hasGiwaTicketTransfer([{...log, data: encodeAbiParameters([{type: "uint256"}], [2_000_000n])}], payer)).toBe(false);
    });
    test("lost submission and reload replay exactly one leaf, and never silently switch game or owner", async () => {
        let signs = 0, sends = 0; const headers: string[] = [];
        const offer: PaymentRequired<Erc7710PaymentRequirements> = {x402Version: 2 as const, resource: {url: "https://seller.mapae.io/s/mapae-arcade/race", description: "Ticket", mimeType: "application/json"},
            accepts: [{scheme: "exact" as const, network: GIWA_SEPOLIA_CAIP2, amount: "1000000", asset: MOCK_USDC.address,
                payTo: ARCADE_PAY_TO, maxTimeoutSeconds: 60, extra: {assetTransferMethod: "erc7710" as const, paymentFlow: "upfront" as const,
                    facilitatorAddresses: [ARCADE_REDEEMER], delegationManager: manager}}]};
        const fetcher = Object.assign(async (_url: URL | RequestInfo, init?: RequestInit) => {
            if (init?.method !== "POST") return new Response(null, {status: 402, headers: {"Payment-Required": encodePaymentRequiredHeader(offer)}});
            headers.push(new Headers(init.headers).get("Payment-Signature")!);
            if (++sends === 1) throw new Error("Connection lost after sending");
            return Response.json(order);
        }, {preconnect: fetch.preconnect});
        const args = {game: "race" as const, requestId: crypto.randomUUID(), characterId: "maru", owner, payer, delegationManager: manager, fetcher,
            provider: async () => {signs++; return {delegationManager: manager, permissionContext: "0x1234" as const, delegator: payer};}};
        const expensive = Object.assign(async () => new Response(null, {status: 402, headers: {"Payment-Required": encodePaymentRequiredHeader({...offer, accepts: [{...offer.accepts[0]!, amount: "1000001"}]})}}), {preconnect: fetch.preconnect});
        await expect(buyGiwaTicket({...args, fetcher: expensive})).rejects.toThrow("SPEND_POLICY_REFUSED");
        expect(signs).toBe(0); expect(sends).toBe(0); expect(readGiwaPending()).toBeNull();
        await expect(buyGiwaTicket(args)).rejects.toThrow("SETTLEMENT_UNKNOWN");
        expect(readGiwaPending()).not.toBeNull();
        await expect(buyGiwaTicket({...args, game: "shop"})).rejects.toThrow("pending ticket");
        const recovered = await buyGiwaTicket({...args, provider: undefined});
        expect(recovered.transaction).toBe(tx); expect(signs).toBe(1); expect(headers[0]).toBe(headers[1]);
        expect(await buyGiwaTicket({...args, provider: undefined})).toEqual(recovered);
        expect(sends).toBe(2);
    });
});
