import type {GameId} from "@mapae/arcade";
import {isAddress, isHash, type Address, type Hex} from "viem";

export type GiwaReceipt = {code: string; transaction: Hex; payer: Address};
export type GiwaPending = {requestId: string; characterId: string; game: GameId; owner: Address; payer: Address;
    header: string | null; receipt: GiwaReceipt | null};
const KEY = "mapae.arcade.giwa.pending";
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function parseGiwaPending(raw: string): GiwaPending {
    const v: unknown = JSON.parse(raw);
    if (!object(v) || typeof v.requestId !== "string" || !/^[a-f0-9-]{36}$/i.test(v.requestId) ||
        typeof v.characterId !== "string" || !v.characterId || v.characterId.length > 64 ||
        !["stamp", "race", "shop"].includes(String(v.game)) || typeof v.owner !== "string" || !isAddress(v.owner) ||
        typeof v.payer !== "string" || !isAddress(v.payer) || (v.header !== null && (typeof v.header !== "string" || v.header.length > 24_000 || !/^[A-Za-z0-9+/=]+$/.test(v.header))) ||
        !(v.receipt === null || (object(v.receipt) && typeof v.receipt.code === "string" && /^[a-zA-Z0-9_-]{8,100}$/.test(v.receipt.code) &&
            typeof v.receipt.transaction === "string" && isHash(v.receipt.transaction) && v.receipt.payer === v.payer))) throw new Error("Invalid pending GIWA ticket. Check the seller receipt before another payment.");
    return {requestId: v.requestId, characterId: v.characterId, game: v.game as GameId, owner: v.owner, payer: v.payer,
        header: v.header, receipt: v.receipt === null ? null : {code: String(v.receipt.code), transaction: v.receipt.transaction as Hex, payer: v.payer}};
}
export function readGiwaPending(): GiwaPending | null {
    const raw = sessionStorage.getItem(KEY);
    return raw === null ? null : parseGiwaPending(raw);
}
/**
 * Only the already signed, one-shot admission ticket is retained in this tab for exact
 * retries after reload. The owner/agent private keys are never persisted. A root
 * alone cannot sign a new leaf; this existing leaf is recipient/amount/redeemer
 * bound on chain. Clear it only after admission is durably recorded.
 */
export function writeGiwaPending(value: GiwaPending): void {
    sessionStorage.setItem(KEY, JSON.stringify(parseGiwaPending(JSON.stringify(value))));
}
export function clearGiwaPending(): void {sessionStorage.removeItem(KEY);}
