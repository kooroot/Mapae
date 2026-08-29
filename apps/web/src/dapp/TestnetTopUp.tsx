import type {Delegation} from "@metamask/smart-accounts-kit";
import {Droplets} from "lucide-react";
import {useMemo, useState} from "react";
import {bootstrapAvailability, explorerTxUrl} from "../lib/config";
import {FAUCET_COPY, requestTestnetTopUp, topUpMessage, type TopUpOutcome} from "../lib/faucet";
import {useLocale} from "../lib/locale";

type TopUpState =
    | {kind: "idle"}
    | {kind: "busy"}
    | {kind: "done"; outcome: TopUpOutcome}
    | {kind: "failed"; reason: string};

/**
 * "Get testnet balance" — the sponsor's faucet, from the account page.
 *
 * Renders nothing without a configured sponsor: there is no other path to testnet money
 * from the browser, and a button that explains its own absence is a support ticket. The
 * signed root is the authorisation, so this only ever appears on an opened grant. The
 * parent keys it by permission context, so the outcome line never outlives the grant it
 * describes.
 */
export function TestnetTopUp({root, onMinted}: {root: Delegation; onMinted: () => void}) {
    const {locale} = useLocale();
    const t = FAUCET_COPY[locale];
    const sponsor = useMemo(() => bootstrapAvailability(), []);
    const [state, setState] = useState<TopUpState>({kind: "idle"});
    const endpoint = sponsor.kind === "configured" ? sponsor.url : undefined;
    if (endpoint === undefined) return null;

    async function topUp(url: string) {
        setState({kind: "busy"});
        try {
            const outcome = await requestTestnetTopUp({endpoint: url, root, locale});
            setState({kind: "done", outcome});
            if (outcome.kind === "minted") onMinted();
        } catch (error) {
            setState({kind: "failed", reason: error instanceof Error ? error.message : t.failed});
        }
    }

    const busy = state.kind === "busy";
    const minted = state.kind === "done" && state.outcome.kind === "minted";
    const tone = state.kind === "failed" ? "error" : minted ? "ok" : "note";
    const message =
        state.kind === "done"
            ? topUpMessage(state.outcome, locale)
            : state.kind === "failed"
              ? state.reason
              : t.hint;
    const transaction =
        state.kind === "done" && state.outcome.kind === "minted"
            ? state.outcome.transaction
            : undefined;

    return (
        <div className="studio-topup" data-tone={tone}>
            <button
                type="button"
                className="studio-secondary-button"
                onClick={() => void topUp(endpoint)}
                disabled={busy}
            >
                <Droplets size={14} />
                {busy ? t.busy : t.action}
            </button>
            <p className="studio-amount-note" role={state.kind === "failed" ? "alert" : "status"}>
                {message}
                {transaction ? (
                    <>
                        {" "}
                        <a href={explorerTxUrl(transaction)} target="_blank" rel="noreferrer">
                            {t.viewTransaction}
                        </a>
                    </>
                ) : null}
            </p>
        </div>
    );
}
