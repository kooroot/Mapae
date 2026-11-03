import {Dialog} from "@base-ui/react/dialog";
import {createRoot} from "react-dom/client";
import type {BrowserKeyRequest} from "../lib/browser-key-connector";
import "./brand-controls.css";
import "./wallet-picker.css";

type Locale = "ko" | "en";

/** What is about to be signed or sent, in the words the visitor needs to decide. Props only. */
export function BrowserKeyRequestSummary({request, locale}: {request: BrowserKeyRequest; locale: Locale}) {
    const ko = locale === "ko";
    const rows: [string, string][] = request.kind === "message"
        ? [[ko ? "사이트" : "Domain", request.domain ?? (ko ? "알 수 없음 (로그인 메시지가 아님)" : "Unknown (not a sign-in message)")], ["URI", request.uri ?? "—"]]
        : request.kind === "typed"
            ? [[ko ? "서명 종류" : "Type", request.primaryType], [ko ? "검증 컨트랙트" : "Verifying contract", request.verifyingContract ?? "—"]]
            : [[ko ? "받는 곳" : "To", request.to ?? (ko ? "새 컨트랙트 생성" : "Contract creation")], [ko ? "보내는 금액" : "Value", `${request.valueEth} ETH`]];
    return <div className="arc-browser-key-summary">
        <p>{request.kind === "message" ? ko ? "로그인 메시지에 서명해요. 돈은 나가지 않아요." : "Sign a sign-in message. No funds move." : request.kind === "typed" ? ko ? "구조화된 데이터(권한 위임 등)에 서명해요." : "Sign structured data, such as a delegation." : ko ? "GIWA Sepolia로 거래를 보내요. 테스트 ETH 가스비가 들어요." : "Send a transaction on GIWA Sepolia. It spends test ETH for gas."}</p>
        <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    </div>;
}

/** The in-page dialog the browser key waits on before every signature. */
export function BrowserKeyConfirmDialog({request, locale, onAnswer}: {request: BrowserKeyRequest; locale: Locale; onAnswer: (approved: boolean) => void}) {
    const ko = locale === "ko";
    return <Dialog.Root open onOpenChange={open => {if (!open) onAnswer(false);}}>
        <Dialog.Portal><Dialog.Backdrop className="mapae-dialog-backdrop" />
            <Dialog.Popup className="mapae-confirm arc-ui-theme">
                <Dialog.Title>{ko ? "브라우저 키로 서명할까요?" : "Sign with your browser key?"}</Dialog.Title>
                <Dialog.Description render={<div />}><BrowserKeyRequestSummary request={request} locale={locale} /></Dialog.Description>
                <div className="mapae-confirm-actions">
                    <Dialog.Close className="mapae-action mapae-action-secondary">{ko ? "거절" : "Reject"}</Dialog.Close>
                    <button className="mapae-action mapae-action-primary" onClick={() => onAnswer(true)}>{ko ? "서명" : "Sign"}</button>
                </div>
            </Dialog.Popup>
        </Dialog.Portal>
    </Dialog.Root>;
}

/** Mounts the dialog on its own root and resolves with the visitor's answer; declines without a DOM. */
export function confirmInPage(request: BrowserKeyRequest): Promise<boolean> {
    if (typeof document === "undefined") return Promise.resolve(false);
    const locale: Locale = document.documentElement.lang.startsWith("ko") ? "ko" : "en";
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    return new Promise(resolve => {
        let done = false;
        const answer = (approved: boolean) => {
            if (done) return; done = true;
            root.unmount(); host.remove(); resolve(approved);
        };
        root.render(<BrowserKeyConfirmDialog request={request} locale={locale} onAnswer={answer} />);
    });
}
