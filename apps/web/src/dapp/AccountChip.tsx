import {LoaderCircle, LogOut} from "lucide-react";
import {useAccount, useDisconnect} from "wagmi";
import {chain} from "../lib/config";
import {shortAddress} from "../lib/dial";
import {useLocale} from "../lib/locale";

/**
 * The connected wallet, on every Studio screen. It lives in the topbar rather than in the
 * create flow so the owner can see which wallet is signing — and leave it — from any
 * section, including the wrong-network state where the wizard cannot advance.
 */
export function AccountChip() {
    const {locale} = useLocale();
    const {address, chainId} = useAccount();
    const {disconnect, isPending} = useDisconnect();
    if (!address) return null;
    const label = locale === "ko" ? "연결 해제" : "Disconnect";
    const wrongChain = chainId !== chain.id;
    return (
        <div className="studio-account" data-tone={wrongChain ? "warning" : undefined}>
            <span title={address}>
                <i aria-hidden="true" />
                {shortAddress(address)}
            </span>
            <button type="button" disabled={isPending} aria-label={`${label} ${shortAddress(address)}`} onClick={() => disconnect()}>
                {isPending ? <LoaderCircle size={15} className="mapae-spinner" /> : <LogOut size={15} />}
                <span>{label}</span>
            </button>
        </div>
    );
}
