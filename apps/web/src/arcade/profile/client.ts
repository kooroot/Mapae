import {isAddress, type Address} from "viem";
import {parseSiweMessage} from "viem/siwe";

export class ProfileError extends Error {
    constructor(readonly code: string, readonly retryAt = 0) {super(code);}
}
export async function profileRequest(owner: Address, path: string, method = "GET", body?: unknown): Promise<unknown> {
    let response: Response;
    try {response = await fetch(`/api/arcade/profile${path}`, {method, credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20_000), headers: {"Content-Type": "application/json", "X-Mapae-Wallet": owner}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});}
    catch {throw new ProfileError("network");}
    let value: unknown;
    try {value = await response.json();} catch {throw new ProfileError("invalid_response");}
    if (!response.ok) {
        const code = value && typeof value === "object" && "error" in value && value.error && typeof value.error === "object" && "code" in value.error && typeof value.error.code === "string" ? value.error.code : "profile_unavailable";
        throw new ProfileError(code, response.status === 429 ? Date.now() + Math.min(300, Math.max(1, Number(response.headers.get("Retry-After")) || 60)) * 1000 : 0);
    }
    return value;
}
export async function readSession(owner: Address): Promise<void> {
    const value = await profileRequest(owner, "/session");
    if (!value || typeof value !== "object" || !("owner" in value) || typeof value.owner !== "string" || !isAddress(value.owner) || value.owner.toLowerCase() !== owner.toLowerCase()) throw new ProfileError("invalid_response");
}
export const logoutProfile = (owner: Address) => profileRequest(owner, "/logout", "POST");
export async function loginProfile(owner: Address, sign: (message: string) => Promise<string>): Promise<void> {
    const value = await profileRequest(owner, "/challenge", "POST", {address: owner});
    if (!value || typeof value !== "object" || !("message" in value) || typeof value.message !== "string") throw new ProfileError("invalid_response");
    const parsed = parseSiweMessage(value.message);
    // Never ask a wallet to sign an unexpected domain, account or chain.
    if (parsed.address?.toLowerCase() !== owner.toLowerCase() || parsed.domain !== location.host || parsed.chainId !== 91342 || parsed.uri !== `${location.origin}/ko/arcade`) throw new ProfileError("invalid_response");
    const signature = await sign(value.message);
    await profileRequest(owner, "/login", "POST", {signature});
}
export function profileErrorMessage(e: unknown, ko: boolean): string {
    const code = e instanceof ProfileError ? e.code : e instanceof Error ? e.message : "unknown";
    if (code === "signature_cancelled") return ko ? "로그인 서명이 완료되지 않았어요. 지갑에서 요청을 확인하고 다시 시도해 주세요." : "Sign-in was not completed. Check the request in your wallet and retry.";
    if (code === "login_required") return ko ? "지갑으로 다시 로그인해 주세요." : "Sign in again to continue.";
    if (code === "rate_limited") return ko ? "요청이 많아요. 잠시 후 다시 시도해 주세요." : "Too many requests. Please try again shortly.";
    return ko ? "로그인 상태를 확인하지 못했어요. 연결을 확인하고 다시 시도해 주세요." : "Could not verify your session. Check your connection and retry.";
}
