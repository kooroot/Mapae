import {Dialog} from "@base-ui/react/dialog";
import {ArrowRight, Check, LoaderCircle, Wallet, X} from "lucide-react";
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
    const named = connectors.filter(c => c.id !== "injected");
    const injected = connectors.find(c => c.id === "injected");
    useEffect(() => {
        let active = true;
        void injected?.getProvider().then(provider => {if (active) setBrowserWallet(!!provider);}).catch(() => {if (active) setBrowserWallet(false);});
        return () => {active = false;};
    }, [injected]);
    const wallets = named.length ? named : browserWallet && injected ? [injected] : [];
    const busy = isPending || reconnecting;
    const destination = context === "arcade" ? `https://mapae.io${localizePath("/arcade", locale)}` : localizeUrl(context === "faucet" ? faucetUrl : appUrl, locale);
    const mobileDestination = destination.startsWith("https://") ? destination.slice(8) : `${context === "faucet" ? "faucet" : "app"}.mapae.io${localizePath("/", locale)}`;
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
                {wallets.length > 0 && <div className="arc-wallet-list">{wallets.map(wallet => <button key={wallet.uid} disabled={busy} onClick={async () => {
                    setSelected(wallet.uid); setError("");
                    try {await connectAsync({connector: wallet}); setOpen(false);}
                    catch {setError(ko ? "연결이 완료되지 않았어요. 지갑에서 요청을 확인하고 다시 시도해 주세요." : "Connection was not completed. Check your wallet and try again.");}
                }}>
                    {wallet.icon && /^data:image\/(png|svg\+xml|webp|jpeg);/.test(wallet.icon) ? <img src={wallet.icon} width={36} height={36} alt="" /> : <span className="arc-wallet-symbol"><Wallet size={22} /></span>}
                    <span><strong>{wallet.id === "injected" ? ko ? "이 브라우저의 지갑" : "Browser wallet" : wallet.name}</strong><small>{busy && selected === wallet.uid ? ko ? "지갑에서 연결을 승인해 주세요" : "Approve the connection in your wallet" : ko ? "설치된 지갑" : "Available in this browser"}</small></span>
                    {busy && selected === wallet.uid ? <LoaderCircle size={19} className="mapae-spinner" /> : <ArrowRight size={19} />}
                </button>)}</div>}
                {error && <p className="arc-wallet-error" role="alert">{error}</p>}
                <div className="arc-wallet-mobile-entry"><span>{wallets.length ? ko ? "휴대폰 브라우저에서 접속했나요?" : "On a mobile browser?" : ko ? "이 브라우저에서 지갑을 찾지 못했어요" : "No wallet detected in this browser"}</span><a className="mapae-action mapae-action-secondary" href={`https://link.metamask.io/dapp/${mobileDestination}`}><Wallet size={18} />{ko ? "MetaMask 앱으로 열기" : "Open in MetaMask"}<ArrowRight size={17} /></a><small>{ko ? "다른 지갑은 앱 안의 브라우저에서 이 페이지를 열어 주세요. PC에서는 지갑 확장 프로그램을 켜 주세요." : "For other wallets, open this page in the wallet’s browser. On desktop, enable your wallet extension."}</small></div>
                <p className="arc-wallet-assurance"><Check size={15} />{ko ? "연결·로그인 서명에는 결제나 가스비가 없어요" : "Connecting and signing in do not spend funds or gas"}</p>
            </Dialog.Popup>
        </Dialog.Portal>
    </Dialog.Root>;
}
