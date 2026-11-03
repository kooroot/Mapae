import {Dialog} from "@base-ui/react/dialog";
import {ArrowRight, Check, LoaderCircle, Wallet, X} from "lucide-react";
import {exportBrowserKey} from "../lib/browser-key-connector";
import {WalletPickerOptions, type ExportState, type ExportStep} from "./BrowserKeyEntry";
import {useEffect, useState} from "react";
import {useConnect} from "wagmi";
import {appUrl, faucetUrl} from "../lib/config";
import {localizePath, localizeUrl} from "../lib/i18n";
import "./wallet-picker.css";
import "./brand-controls.css";
import {useLocale} from "../lib/locale";

/** A single entry point; discovered wallets belong inside the chooser. */
/**
 * In the arcade: `primary` where connecting is the next step, `secondary` beside a free-play primary, and `header` as the
 * compact primary in the wide header. Studio and the faucet each use their own primary button.
 */
export function WalletPicker({reconnecting = false, context = "arcade", variant = "primary"}: {reconnecting?: boolean; context?: "arcade" | "studio" | "faucet"; variant?: "primary" | "secondary" | "header"}) {
    const {locale} = useLocale(); const ko = locale === "ko";
    const {connectors, connectAsync, isPending} = useConnect();
    const [open, setOpen] = useState(false);
    const [selected, setSelected] = useState("");
    const [error, setError] = useState("");
    const [browserWallet, setBrowserWallet] = useState(false);
    const [exportState, setExportState] = useState<ExportState>("idle");
    /** The browser key is a fallback, never a "named" wallet: it must not hide an injected one. */
    const named = connectors.filter(c => c.id !== "injected" && c.id !== "browser-key");
    const injected = connectors.find(c => c.id === "injected");
    const browserKey = connectors.find(c => c.id === "browser-key");
    useEffect(() => {
        let active = true;
        void injected?.getProvider().then(provider => {if (active) setBrowserWallet(!!provider);}).catch(() => {if (active) setBrowserWallet(false);});
        return () => {active = false;};
    }, [injected]);
    const wallets = named.length ? named : browserWallet && injected ? [injected] : [];
    const busy = isPending || reconnecting;
    const destination = context === "arcade" ? `https://mapae.io${localizePath("/arcade", locale)}` : localizeUrl(context === "faucet" ? faucetUrl : appUrl, locale);
    const mobileDestination = destination.startsWith("https://") ? destination.slice(8) : `${context === "faucet" ? "faucet" : "app"}.mapae.io${localizePath("/", locale)}`;
    const connect = async (wallet: (typeof connectors)[number]) => {
        setSelected(wallet.uid); setError("");
        try {await connectAsync({connector: wallet}); setOpen(false);}
        catch {setError(ko ? "연결이 완료되지 않았어요. 지갑에서 요청을 확인하고 다시 시도해 주세요." : "Connection was not completed. Check your wallet and try again.");}
    };
    /** Exactly the 0x-prefixed 32-byte hex, only after the second tap. */
    const exportKey = (step: ExportStep) => {
        if (step !== "confirm") {setExportState(step === "ask" ? "confirm" : "idle"); return;}
        const key = exportBrowserKey();
        if (!key) {setExportState("missing"); return;}
        navigator.clipboard.writeText(key).then(() => setExportState("copied"), () => setExportState("failed"));
    };
    return <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger className={context === "studio" ? "mapae-action mapae-action-primary" : context === "faucet" ? "fct-action fct-action-primary" : variant === "header" ? "arc-button arc-header-connect" : `arc-button arc-entry-connect${variant === "secondary" ? " arc-button-paper" : ""}`} disabled={busy}>
            {busy ? <LoaderCircle size={variant === "header" ? 17 : 19} className="mapae-spinner" /> : <Wallet size={variant === "header" ? 17 : 19} />}
            {busy ? ko ? "지갑 연결 확인 중…" : "Connecting…" : ko ? "지갑 연결" : "Connect wallet"}{variant !== "header" && <ArrowRight size={19} />}
        </Dialog.Trigger>
        <Dialog.Portal className="arc-ui-theme"><Dialog.Backdrop className="mapae-dialog-backdrop" />
            <Dialog.Popup className="arc-wallet-dialog">
                <div className="arc-wallet-dialog-top"><span>MAPAE {context.toUpperCase()}</span><Dialog.Close aria-label={ko ? "닫기" : "Close"}><X size={20} /></Dialog.Close></div>
                <Dialog.Title>{ko ? "어떤 지갑으로 들어갈까요?" : "Choose your wallet"}</Dialog.Title>
                <Dialog.Description>{context === "arcade" ? ko ? "같은 지갑이면, 어디서든 나의 전령들과 이어서." : "The same wallet brings your guardians to every device." : context === "faucet" ? ko ? "연결한 지갑 주소로 받을 곳을 정해요. 연결만으로는 아무것도 보내지 않아요." : "Your wallet address decides where tokens arrive. Connecting sends nothing." : ko ? "연결한 지갑으로 결제 권한을 만들고 관리해요." : "Connect to create and manage spending permissions."}</Dialog.Description>
                <WalletPickerOptions locale={ko ? "ko" : "en"} wallets={wallets.map(wallet => ({uid: wallet.uid, icon: wallet.icon, label: wallet.id === "injected" ? ko ? "이 브라우저의 지갑" : "Browser wallet" : wallet.name}))}
                    busy={busy} selected={selected} error={error} mobileHref={`https://link.metamask.io/dapp/${mobileDestination}`}
                    onPick={uid => {const wallet = wallets.find(w => w.uid === uid); if (wallet) void connect(wallet);}}
                    browserKey={browserKey && {busy: busy && selected === browserKey.uid, exportState, onPlay: () => void connect(browserKey), onExport: exportKey}} />
                <p className="arc-wallet-assurance"><Check size={15} />{ko ? "연결·로그인 서명에는 결제나 가스비가 없어요" : "Connecting and signing in do not spend funds or gas"}</p>
            </Dialog.Popup>
        </Dialog.Portal>
    </Dialog.Root>;
}
