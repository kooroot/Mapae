import type {Delegation} from "@metamask/smart-accounts-kit";
import {decodeDelegations} from "@metamask/smart-accounts-kit/utils";
import {isHex, type Hex} from "viem";
import type {Locale} from "./i18n";

/**
 * Pasted text to a root delegation.
 *
 * Kept out of the route for the same reason the console keeps
 * `resolveRootDelegation` out of its own: every interesting case is an input,
 * and a render test cannot type. Splitting it also keeps the route free of the
 * one decision here that is easy to get backwards.
 */
export type ParsedPermission =
    | {kind: "empty"}
    | {kind: "invalid"; reason: string}
    | {kind: "ok"; context: Hex; root: Delegation; links: number};

/*
 * The refusal reasons are user-facing sentences, so they carry the same bilingual
 * shape as component copy: English base, Korean toggle, map local to the module.
 * The caller passes its locale; existing call sites keep compiling because the
 * parameter defaults to the base.
 */
const REASONS: Record<
    Locale,
    {notHex: string; emptyChain: string; notDelegations: string}
> = {
    en: {
        notHex: "A permission code starts with 0x. Check the value you copied.",
        emptyChain: "This permission code is empty. Copy the full approval output again.",
        notDelegations:
            "This is not a valid Mapae permission code. Check that the entire value was copied.",
    },
    ko: {
        notHex: "권한 코드는 0x로 시작해야 합니다. 복사한 값을 다시 확인해 주세요.",
        emptyChain: "비어 있는 권한 코드입니다. 승인 결과 전체를 다시 복사해 주세요.",
        notDelegations: "올바른 마패 권한 코드가 아닙니다. 값 전체가 복사됐는지 확인해 주세요.",
    },
};

/**
 * Three things here are load-bearing.
 *
 * **The root is the last link, not the first.** `decodeDelegations` returns the
 * chain leaf-first, and the leaf is the throwaway an agent mints for one
 * payment. Taking `[0]` would put a single payment's allowance on screen labelled
 * as the account's standing cap — a number too small, presented as the number
 * that matters.
 *
 * **An absent value is `empty`, never `invalid`.** That is the literal first
 * state of the field on every visit. "Paste a permission context" and "this
 * could not be decoded" send a reader to two different places, and only one of
 * them exists.
 *
 * **A bad paste returns a reason instead of throwing.** This runs during render
 * with no error boundary above it, so a throw unmounts the root and leaves a
 * blank page — no message, no hint. The console paid for that lesson twice and
 * records it at `Revocation.tsx`.
 */
export function parsePermissionContext(
    raw: string,
    locale: Locale = "en",
): ParsedPermission {
    const t = REASONS[locale];
    const value = raw.trim();
    if (!value) return {kind: "empty"};
    if (!isHex(value)) {
        return {kind: "invalid", reason: t.notHex};
    }
    try {
        const links = decodeDelegations(value);
        const root = links.at(-1);
        if (!root) {
            return {kind: "invalid", reason: t.emptyChain};
        }
        return {kind: "ok", context: value, root, links: links.length};
    } catch {
        // The likely first-run mistake is a truncated paste of a ~2 kB context,
        // which is well-formed hex and not a delegation array. Saying so is more
        // use than reporting the decoder's own message.
        return {kind: "invalid", reason: t.notDelegations};
    }
}
