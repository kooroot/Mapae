import {isAddress, type Address} from "viem";
import {parseSiweMessage} from "viem/siwe";
import {parseProfile, type ProfileSnapshot, type Profile} from "./model";

export class ProfileError extends Error {
    constructor(readonly code: string, readonly snapshot?: ProfileSnapshot) {super(code);}
}
function snapshot(value: unknown, owner: Address): ProfileSnapshot {
    if (!value || typeof value !== "object" || !("owner" in value) || !("revision" in value) || !("profile" in value) || typeof value.owner !== "string" || value.owner.toLowerCase() !== owner.toLowerCase() || !isAddress(value.owner) || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new ProfileError("invalid_response");
    const profile = parseProfile(value.profile); if (!profile) throw new ProfileError("invalid_response");
    return {owner: value.owner, revision: value.revision, profile};
}
async function request(owner: Address, path = "", method = "GET", body?: unknown): Promise<unknown> {
    let response: Response;
    try {response = await fetch(`/api/arcade/profile${path}`, {method, credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20_000), headers: {"Content-Type": "application/json", "X-Mapae-Wallet": owner}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});}
    catch {throw new ProfileError("network");}
    let value: unknown;
    try {value = await response.json();} catch {throw new ProfileError("invalid_response");}
    if (!response.ok) {
        const code = value && typeof value === "object" && "error" in value && value.error && typeof value.error === "object" && "code" in value.error && typeof value.error.code === "string" ? value.error.code : "profile_unavailable";
        throw new ProfileError(code, response.status === 409 && value && typeof value === "object" && "snapshot" in value ? snapshot(value.snapshot, owner) : undefined);
    }
    return value;
}
export const readProfile = async (owner: Address) => snapshot(await request(owner), owner);
export const logoutProfile = (owner: Address) => request(owner, "/logout", "POST");
export const writeProfile = async (owner: Address, revision: number, profile: Profile) => snapshot(await request(owner, "", "PUT", {revision, profile}), owner);
export async function loginProfile(owner: Address, sign: (message: string) => Promise<string>): Promise<void> {
    const value = await request(owner, "/challenge", "POST", {address: owner});
    if (!value || typeof value !== "object" || !("message" in value) || typeof value.message !== "string") throw new ProfileError("invalid_response");
    const parsed = parseSiweMessage(value.message);
    // Never ask a wallet to sign an unexpected domain, account or chain.
    if (parsed.address?.toLowerCase() !== owner.toLowerCase() || parsed.domain !== location.host || parsed.chainId !== 91342 || parsed.uri !== `${location.origin}/ko/arcade`) throw new ProfileError("invalid_response");
    const signature = await sign(value.message);
    await request(owner, "/login", "POST", {signature});
}
export function profileErrorMessage(e: unknown, ko: boolean): string {
    const code = e instanceof ProfileError ? e.code : e instanceof Error ? e.message : "unknown";
    if (code === "signature_cancelled") return ko ? "로그인 서명이 완료되지 않았어요. 지갑에서 요청을 확인하고 다시 시도해 주세요." : "Sign-in was not completed. Check the request in your wallet and retry.";
    if (code === "concurrent_edit") return ko ? "다른 기기에서 같은 캐릭터를 수정했어요. 현재 작업은 보관 중입니다. 서버 기록을 불러온 뒤 변경해 주세요." : "This character was edited on another device. Your draft is kept. Load the server record before editing again.";
    if (code === "character_limit") return ko ? "기기들의 캐릭터를 합치면 12명을 넘어요. 기존 기록은 그대로 보관돼 있어요." : "Combining your devices would exceed 12 characters. Existing records are preserved.";
    if (code === "login_required") return ko ? "지갑으로 다시 로그인하면 기록을 이어서 저장해요." : "Sign in again to continue syncing.";
    if (code === "rate_limited") return ko ? "로그인 요청이 많아요. 잠시 후 다시 시도해 주세요." : "Too many login requests. Please try again shortly.";
    return ko ? "서버에 기록을 저장하거나 불러오지 못했어요. 작업은 이 기기에 보관 중입니다. 연결을 확인하고 다시 시도해 주세요." : "Could not load or save your records. Your work is kept on this device. Check your connection and retry.";
}
