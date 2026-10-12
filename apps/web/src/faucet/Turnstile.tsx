import {useCallback, useEffect, useRef} from "react";
import {TURNSTILE_ORIGIN} from "../lib/security";
import {FaucetError} from "./client";

/**
 * Cloudflare Turnstile, rendered explicitly and only when a claim is pressed.
 *
 * Each solve is bound to one claim: `action` names the kind and `cData` the signed-in
 * owner, and the Worker refuses a token whose hostname, action or cData differ. So a
 * fresh widget is rendered per claim and removed after it answers. `interaction-only`
 * keeps it invisible unless Cloudflare wants a click, in which case it appears in the
 * slot this hook returns. The script is loaded from Cloudflare's origin, which the
 * faucet's CSP admits (and no other surface's does).
 */

interface TurnstileOptions {
    sitekey: string;
    action: string;
    cData: string;
    appearance: "interaction-only";
    theme: "light";
    language: string;
    callback: (token: string) => void;
    "error-callback": () => boolean;
    "expired-callback": () => void;
    "timeout-callback": () => void;
}
interface TurnstileApi {
    render: (container: HTMLElement, options: TurnstileOptions) => string | undefined;
    remove: (widgetId: string) => void;
}
declare global {
    interface Window {turnstile?: TurnstileApi}
}

const SCRIPT_URL = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js?render=explicit`;
/** Long enough for a visitor asked to click; short enough that a blocked widget is reported. */
const SOLVE_TIMEOUT_MS = 120_000;
let loading: Promise<TurnstileApi> | undefined;

function loadTurnstile(): Promise<TurnstileApi> {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    loading ??= new Promise<TurnstileApi>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = SCRIPT_URL;
        script.async = true;
        script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile")));
        script.onerror = () => reject(new Error("turnstile"));
        document.head.appendChild(script);
    }).catch((e: unknown) => {
        loading = undefined; // A blocked load may be retried after the visitor unblocks it.
        throw e;
    });
    return loading;
}

export function useTurnstile() {
    const slot = useRef<HTMLDivElement>(null);
    const widget = useRef<string | undefined>(undefined);
    const clear = useCallback(() => {
        if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
        widget.current = undefined;
    }, []);
    useEffect(() => clear, [clear]);

    const solve = useCallback(async (input: {siteKey: string; action: string; cData: string; language: string}): Promise<string> => {
        let api: TurnstileApi;
        try {api = await loadTurnstile();} catch {throw new FaucetError("turnstile_unavailable");}
        const container = slot.current;
        if (!container) throw new FaucetError("turnstile_unavailable");
        clear();
        try {
            return await new Promise<string>((resolve, reject) => {
                const timer = setTimeout(() => reject(new FaucetError("turnstile_failed")), SOLVE_TIMEOUT_MS);
                const done = (fn: () => void) => () => {clearTimeout(timer); fn();};
                widget.current = api.render(container, {
                    sitekey: input.siteKey,
                    action: input.action,
                    cData: input.cData,
                    appearance: "interaction-only",
                    theme: "light",
                    language: input.language,
                    callback: (token) => done(() => resolve(token))(),
                    // Returning true tells Turnstile the error is handled here, so it logs nothing of its own.
                    "error-callback": () => {done(() => reject(new FaucetError("turnstile_failed")))(); return true;},
                    "expired-callback": done(() => reject(new FaucetError("turnstile_failed"))),
                    "timeout-callback": done(() => reject(new FaucetError("turnstile_failed"))),
                });
                if (!widget.current) done(() => reject(new FaucetError("turnstile_unavailable")))();
            });
        } finally {clear();}
    }, [clear]);

    return {slot, solve};
}
