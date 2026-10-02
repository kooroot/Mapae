import {Dialog} from "@base-ui/react/dialog";
import type {ReactNode} from "react";
import "./brand-controls.css";

export function ConfirmDialog({open, onOpenChange, title, children, confirm, cancel, onConfirm}: {
    open: boolean; onOpenChange: (open: boolean) => void; title: string; children: ReactNode;
    confirm: string; cancel: string; onConfirm: () => void;
}) {
    return <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal><Dialog.Backdrop className="mapae-dialog-backdrop" />
            <Dialog.Popup className="mapae-confirm arc-ui-theme">
                <Dialog.Title>{title}</Dialog.Title>
                <Dialog.Description render={<div />}>{children}</Dialog.Description>
                <div className="mapae-confirm-actions">
                    <Dialog.Close className="mapae-action mapae-action-primary">{cancel}</Dialog.Close>
                    <button className="mapae-action mapae-action-secondary" onClick={() => {onOpenChange(false); onConfirm();}}>{confirm}</button>
                </div>
            </Dialog.Popup>
        </Dialog.Portal>
    </Dialog.Root>;
}
