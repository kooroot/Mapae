import {Dialog} from "@base-ui/react/dialog";
import {useEffect, useState} from "react";
import {Check, ChevronDown, LoaderCircle, ShieldCheck, Wallet} from "lucide-react";
import type {ApprovalPhase} from "./useGiwaTickets";

const STEP: Record<ApprovalPhase, number> = {idle: 0, catalogue: 0, wallet: 0, switching: 0, preparing: 1, signing: 1, authorizing: 1, bootstrap: 2, verifying: 3};

/** Stages follow the real approval request. Elapsed time is not a completion estimate. */
export function AllowanceProgress({phase, walletName, ko, reducedMotion}: {
    phase: ApprovalPhase; walletName: string; ko: boolean; reducedMotion: boolean;
}) {
    const [open, setOpen] = useState(true);
    const [started] = useState(Date.now);
    const [elapsed, setElapsed] = useState(0);
    useEffect(() => {
        const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
        return () => window.clearInterval(timer);
    }, [started]);
    const step = STEP[phase];
    const walletAction = phase === "signing" || phase === "switching";
    const labels = ko ? ["지갑 연결 확인", "용돈 한도 서명", "테스트 계정 준비", "잔액·권한 확인"] : ["Check wallet", "Sign allowance", "Prepare test account", "Verify balance & permission"];
    const title = phase === "switching" ? ko ? "지갑에서 GIWA로 전환해 주세요" : "Switch to GIWA in your wallet"
        : phase === "signing" ? ko ? "지갑에서 서명을 기다리고 있어요" : "Waiting for your wallet signature"
        : phase === "preparing" ? ko ? "서명할 용돈 한도를 준비해요" : "Preparing your allowance to sign"
        : phase === "authorizing" ? ko ? "지갑에서 받은 서명을 확인해요" : "Checking your wallet signature"
        : phase === "bootstrap" ? ko ? "내 테스트 계정을 준비해요" : "Preparing your test account"
        : phase === "verifying" ? ko ? "출발 전 마지막으로 확인해요" : "One last check before the adventure"
        : ko ? "GIWA와 지갑을 확인하고 있어요" : "Checking GIWA and your wallet";
    const description = phase === "signing" ? ko ? `${walletName}에서 용돈 한도 메시지에 서명해 주세요. 지갑 앱이나 확장 프로그램에 요청이 열려 있는지 확인해 주세요.` : `Sign the allowance message in ${walletName}. Check your wallet app or extension for the request.`
        : phase === "switching" ? ko ? `${walletName}에서 네트워크 전환 요청을 확인해 주세요.` : `Confirm the network change in ${walletName}.`
        : phase === "authorizing" ? ko ? "서명을 받았어요. 정해 둔 용돈 한도와 권한이 맞는지 확인하고 있어요." : "Signature received. Checking that it matches your allowance and permission."
        : phase === "bootstrap" ? ko ? "필요한 스마트 계정 생성과 테스트 토큰 충전을 요청했어요. GIWA의 응답을 받으면 자동으로 다음 단계로 넘어가요." : "Requesting smart-account setup and test tokens if needed. We will continue when GIWA responds."
        : phase === "verifying" ? ko ? "스마트 계정의 잔액과 서명한 권한을 확인하고 있어요. 확인이 끝나야 용돈을 사용할 수 있어요." : "Checking the smart-account balance and signed permission before the allowance becomes available."
        : ko ? "입장권과 연결한 지갑을 확인하고 있어요. 필요한 단계에서 지갑 서명을 안내할게요." : "Checking tickets and your connected wallet. We will guide you when a signature is needed.";
    return <Dialog.Root open={open} onOpenChange={setOpen} disablePointerDismissal>
        <Dialog.Trigger className="arc-progress-inline"><LoaderCircle size={18} className={reducedMotion ? "" : "arc-loading-icon"} /><span aria-live={open ? "off" : "polite"}>{title}<small>{ko ? "진행 상황 보기" : "View progress"} ↗</small></span></Dialog.Trigger>
        <Dialog.Portal className="arc-ui-theme">
            <Dialog.Backdrop className="arc-editor-backdrop" />
            <Dialog.Popup className={`arc-approval-dialog ${reducedMotion ? "arc-progress-still" : ""}`}>
                <div className="arc-progress-top"><span>MAPAE · GIWA SEPOLIA</span><Dialog.Close aria-label={ko ? "진행 창 접기 · 요청은 계속돼요" : "Minimize progress · request continues"}><ChevronDown size={20} /></Dialog.Close></div>
                <div className="arc-progress-art" aria-hidden="true"><span /><img src="/arcade/guardians/horse-256.webp" width={256} height={256} alt="" /><i>{walletAction ? <Wallet size={22} /> : <LoaderCircle size={22} className="arc-loading-icon" />}</i></div>
                <div role="status" aria-live="polite" aria-atomic="true"><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description></div>
                <ol className="arc-progress-steps" aria-label={ko ? "용돈 준비 단계" : "Allowance setup steps"}>{labels.map((label, index) => <li key={label} data-state={index < step ? "done" : index === step ? "current" : "next"} aria-current={index === step ? "step" : undefined}><span aria-hidden="true">{index < step ? <Check size={15} /> : index + 1}</span><b>{label}</b><small>{index < step ? ko ? "완료" : "Done" : index === step ? ko ? "진행 중" : "In progress" : ko ? "대기" : "Waiting"}</small></li>)}</ol>
                <div className="arc-progress-time"><span><LoaderCircle size={14} className="arc-loading-icon" />{ko ? "요청 진행 중" : "Request in progress"}</span><time aria-label={ko ? `경과 시간 ${elapsed}초` : `${elapsed} seconds elapsed`}>{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}</time></div>
                {elapsed >= 30 && <p className="arc-progress-slow">{walletAction ? ko ? "요청이 안 보이면 지갑 앱을 직접 열어 주세요. 같은 요청을 다시 보내지 않고 기다리고 있어요." : "If no prompt appears, open your wallet directly. We are waiting without sending a duplicate request." : ko ? "평소보다 응답이 늦어지고 있어요. 이 탭을 유지해 주세요. 완료 또는 오류가 확인되면 바로 알려드릴게요." : "The response is taking longer. Keep this tab open; we will show the confirmed result or error."}</p>}
                <p className="arc-progress-foot"><ShieldCheck size={16} />{ko ? "준비가 끝나면 직접 출발해요. 아직 입장권을 구매하지 않아요." : "You choose when to head out. No admission ticket is purchased yet."}</p>
                <Dialog.Close className="arc-progress-minimize">{ko ? "접어 두기 · 요청은 계속 진행돼요" : "Minimize · request will keep running"}</Dialog.Close>
            </Dialog.Popup>
        </Dialog.Portal>
    </Dialog.Root>;
}
