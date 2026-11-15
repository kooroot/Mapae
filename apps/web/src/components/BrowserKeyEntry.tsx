import {ArrowRight, KeyRound, LoaderCircle, TriangleAlert, Wallet} from "lucide-react";

/**
 * "Play without installing", shown only when this browser has no wallet. Props only, so the
 * picker owns connecting and exporting and this renders under renderToStaticMarkup.
 */
export function BrowserKeyEntry({locale, busy = false, exportState = "idle", onPlay, onExport}: {
    locale: "ko" | "en"; busy?: boolean; exportState?: "idle" | "confirm" | "copied" | "missing" | "failed";
    onPlay?: (() => void) | undefined; onExport?: ((step: "ask" | "confirm" | "cancel") => void) | undefined;
}) {
    const ko = locale === "ko";
    return <div className="arc-browser-key">
        <div className="arc-wallet-list"><button type="button" disabled={busy} onClick={onPlay}>
            <span className="arc-wallet-symbol"><KeyRound size={22} /></span>
            <span><strong>{ko ? "설치 없이 바로 놀기" : "Play without installing"}</strong><small>{ko ? "이 브라우저에 지갑 키를 만들어요" : "Creates a wallet key in this browser"}</small></span>
            {busy ? <LoaderCircle size={19} className="mapae-spinner" /> : <ArrowRight size={19} />}
        </button></div>
        <p className="arc-browser-key-warning"><TriangleAlert size={15} />{ko ? "키는 이 브라우저에만 보관돼요. 사이트 데이터를 지우면 사라지니 먼저 내보내 두세요." : "The key is kept in this browser only and is lost if site data is cleared — export it first."}</p>
        {exportState === "confirm"
            ? <div className="arc-browser-key-export" role="group">
                <span>{ko ? "키를 아는 사람은 이 지갑을 쓸 수 있어요. 클립보드에 복사할까요?" : "Anyone with this key controls the wallet. Copy it to the clipboard?"}</span>
                <button type="button" className="mapae-action mapae-action-secondary" onClick={() => onExport?.("cancel")}>{ko ? "취소" : "Cancel"}</button>
                <button type="button" className="mapae-action mapae-action-primary" onClick={() => onExport?.("confirm")}>{ko ? "복사" : "Copy"}</button>
            </div>
            : <button type="button" className="arc-browser-key-export-action" onClick={() => onExport?.("ask")}>{ko ? "키 내보내기" : "Export key"}
                {exportState === "copied" && <small>{ko ? " · 복사했어요. MetaMask에서 가져오면 같은 전령을 이어서 써요." : " · Copied. Import it into MetaMask to keep the same guardians."}</small>}
                {exportState === "missing" && <small>{ko ? " · 이 브라우저에 만든 키가 아직 없어요." : " · No key in this browser yet."}</small>}
                {exportState === "failed" && <small>{ko ? " · 복사하지 못했어요." : " · Could not copy."}</small>}
            </button>}
    </div>;
}

export type ExportStep = "ask" | "confirm" | "cancel";
export type ExportState = NonNullable<Parameters<typeof BrowserKeyEntry>[0]["exportState"]>;

/**
 * The chooser's body: detected wallets, or — only when none is detected — the browser-key entry
 * beside the MetaMask deep link. Props only; `WalletPicker` supplies state and handlers.
 */
export function WalletPickerOptions({locale, wallets, busy, selected, error, mobileHref, browserKey, onPick}: {
    locale: "ko" | "en"; wallets: readonly {uid: string; label: string; icon?: string | undefined}[]; busy: boolean; selected: string; error: string; mobileHref: string;
    browserKey?: {busy: boolean; exportState: ExportState; onPlay?: () => void; onExport?: (step: ExportStep) => void} | undefined;
    onPick?: (uid: string) => void;
}) {
    const ko = locale === "ko";
    return <>
        {wallets.length > 0 && <div className="arc-wallet-list">{wallets.map(wallet => <button key={wallet.uid} disabled={busy} onClick={() => onPick?.(wallet.uid)}>
            {wallet.icon && /^data:image\/(png|svg\+xml|webp|jpeg);/.test(wallet.icon) ? <img src={wallet.icon} width={36} height={36} alt="" /> : <span className="arc-wallet-symbol"><Wallet size={22} /></span>}
            <span><strong>{wallet.label}</strong><small>{busy && selected === wallet.uid ? ko ? "지갑에서 연결을 승인해 주세요" : "Approve the connection in your wallet" : ko ? "설치된 지갑" : "Available in this browser"}</small></span>
            {busy && selected === wallet.uid ? <LoaderCircle size={19} className="mapae-spinner" /> : <ArrowRight size={19} />}
        </button>)}</div>}
        {error && <p className="arc-wallet-error" role="alert">{error}</p>}
        {wallets.length === 0 && browserKey && <BrowserKeyEntry locale={locale} busy={browserKey.busy} exportState={browserKey.exportState} onPlay={browserKey.onPlay} onExport={browserKey.onExport} />}
        <div className="arc-wallet-mobile-entry"><span>{wallets.length ? ko ? "휴대폰 브라우저에서 접속했나요?" : "On a mobile browser?" : ko ? "이 브라우저에서 지갑을 찾지 못했어요" : "No wallet detected in this browser"}</span><a className="mapae-action mapae-action-secondary" href={mobileHref}><Wallet size={18} />{ko ? "MetaMask 앱으로 열기" : "Open in MetaMask"}<ArrowRight size={17} /></a><small>{ko ? "다른 지갑은 앱 안의 브라우저에서 이 페이지를 열어 주세요. PC에서는 지갑 확장 프로그램을 켜 주세요." : "For other wallets, open this page in the wallet’s browser. On desktop, enable your wallet extension."}</small></div>
    </>;
}
