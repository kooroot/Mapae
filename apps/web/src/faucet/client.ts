import {
    FAUCET_REFUSALS,
    parseFaucetAccount,
    parseFaucetClaimView,
    parseFaucetEligibility,
    parseFaucetStatus,
    type FaucetAccount,
    type FaucetClaimView,
    type FaucetEligibility,
    type FaucetKind,
    type FaucetMissionId,
    type FaucetStatus,
} from "@mapae/delegation/faucet-policy";
import type {Address} from "viem";
import {parseSiweMessage} from "viem/siwe";

/**
 * The faucet page's side of `/api/faucet/*` — every reply validated before React sees it.
 *
 * Same-origin only: faucet.mapae.io's Worker answers its own documents, and the session
 * is an HttpOnly `__Host-` cookie the page never touches. A wallet is named on every
 * session-bound request so a wallet switch reads as `login_required`, never as another
 * wallet's standing.
 */

/** What the page may show for a failure: the service's closed set plus the page's own. */
export const FAUCET_PAGE_ERRORS = [...FAUCET_REFUSALS, "signature_cancelled", "turnstile_unavailable", "network", "invalid_response"] as const;
export type FaucetPageError = (typeof FAUCET_PAGE_ERRORS)[number];

export class FaucetError extends Error {
    constructor(readonly code: FaucetPageError, readonly nextAt?: number) {super(code);}
}

export type FaucetPageStatus = FaucetStatus & {siteKey: string};

/** A Worker code outside the page's set (an origin or body refusal) reads as plain unavailability. */
function pageCode(value: unknown): FaucetPageError {
    return typeof value === "string" && (FAUCET_PAGE_ERRORS as readonly string[]).includes(value) ? value as FaucetPageError : "unavailable";
}

async function request(path: string, init: {method?: "GET" | "POST"; owner?: Address; body?: unknown} = {}): Promise<unknown> {
    let response: Response;
    try {
        response = await fetch(`/api/faucet${path}`, {
            method: init.method ?? "GET",
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            // A claim waits for the receipt on the service side, up to about 45 seconds.
            signal: AbortSignal.timeout(path === "/claim" ? 60_000 : 20_000),
            headers: {
                ...(init.method === "POST" ? {"Content-Type": "application/json"} : {}),
                ...(init.owner ? {"X-Mapae-Wallet": init.owner} : {}),
            },
            ...(init.body === undefined ? {} : {body: JSON.stringify(init.body)}),
        });
    } catch {throw new FaucetError("network");}
    let value: unknown;
    try {value = await response.json();} catch {throw new FaucetError(response.ok ? "invalid_response" : "unavailable");}
    if (!response.ok) {
        const error = value && typeof value === "object" && "error" in value && value.error && typeof value.error === "object" ? value.error as {code?: unknown; nextAt?: unknown} : {};
        const nextAt = typeof error.nextAt === "number" && Number.isSafeInteger(error.nextAt) ? error.nextAt : undefined;
        throw new FaucetError(response.status === 401 ? "login_required" : pageCode(error.code), nextAt);
    }
    return value;
}

function validated<T>(parse: () => T): T {
    try {return parse();} catch {throw new FaucetError("invalid_response");}
}

export async function readFaucetStatus(): Promise<FaucetPageStatus> {
    const value = await request("/status");
    return validated(() => {
        const siteKey = value && typeof value === "object" && "siteKey" in value ? value.siteKey : undefined;
        if (typeof siteKey !== "string" || !/^[\w-]{1,128}$/.test(siteKey)) throw new Error("siteKey");
        return {...parseFaucetStatus(value), siteKey};
    });
}

/** The signed-in wallet's standing, or `login_required` when this browser has no session for it. */
export async function readFaucetAccount(owner: Address): Promise<FaucetAccount> {
    const value = await request("/session", {owner});
    const account = validated(() => parseFaucetAccount(value));
    if (account.owner.toLowerCase() !== owner.toLowerCase()) throw new FaucetError("invalid_response");
    return account;
}

/** Whether the connected wallet meets the ETH rule — asked before any signature, so it needs no session. */
export async function readFaucetEligibility(owner: Address): Promise<FaucetEligibility> {
    const value = await request("/eligibility", {owner});
    return validated(() => parseFaucetEligibility(value));
}

/**
 * Never ask a wallet to sign a message for another site, account or chain: the challenge
 * must name this host, this origin's root, GIWA Sepolia and the connected wallet.
 */
export function checkFaucetSiweMessage(message: string, expected: {owner: Address; host: string; origin: string}): boolean {
    try {
        const parsed = parseSiweMessage(message);
        return parsed.address?.toLowerCase() === expected.owner.toLowerCase() && parsed.domain === expected.host &&
            parsed.chainId === 91342 && parsed.uri === `${expected.origin}/`;
    } catch {return false;}
}

export async function loginFaucet(owner: Address, sign: (message: string) => Promise<string>): Promise<void> {
    const value = await request("/challenge", {method: "POST", body: {address: owner}});
    const message = value && typeof value === "object" && "message" in value && typeof value.message === "string" ? value.message : "";
    if (!checkFaucetSiweMessage(message, {owner, host: location.host, origin: location.origin})) throw new FaucetError("invalid_response");
    let signature: string;
    try {signature = await sign(message);} catch {throw new FaucetError("signature_cancelled");}
    await request("/login", {method: "POST", body: {signature}});
}

export async function claimFaucet(owner: Address, claim: {kind: FaucetKind; turnstile: string; missions: readonly FaucetMissionId[]}): Promise<FaucetClaimView> {
    const value = await request("/claim", {method: "POST", owner, body: {kind: claim.kind, turnstile: claim.turnstile, missions: claim.missions}});
    return validated(() => parseFaucetClaimView(value, claim.kind));
}

export async function logoutFaucet(owner: Address): Promise<void> {
    await request("/logout", {method: "POST", owner, body: {}});
}
