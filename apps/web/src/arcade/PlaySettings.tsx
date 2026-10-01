import {Popover} from "@base-ui/react/popover";
import {Switch} from "@base-ui/react/switch";
import {Settings2} from "lucide-react";
import "../components/brand-controls.css";

export function PlaySettings({ko, reducedMotion, onReducedMotionChange}: {ko: boolean; reducedMotion: boolean; onReducedMotionChange: (checked: boolean) => void}) {
    return <Popover.Root>
        <Popover.Trigger className="mapae-settings-trigger" aria-label={ko ? "플레이 설정" : "Play settings"}><Settings2 size={18} /></Popover.Trigger>
        <Popover.Portal><Popover.Positioner className="mapae-select-positioner" align="end" sideOffset={10} collisionPadding={12}>
            <Popover.Popup className="mapae-popover">
                <Popover.Title>{ko ? "편안하게 즐기세요" : "Make yourself comfortable"}</Popover.Title>
                <label className="mapae-switch-row"><span>{ko ? "움직임 줄이기" : "Reduce motion"}<small>{ko ? "화면 흔들림과 효과를 줄여요" : "Less screen shake and animation"}</small></span><Switch.Root checked={reducedMotion} onCheckedChange={onReducedMotionChange} className="mapae-switch"><Switch.Thumb className="mapae-switch-thumb" /></Switch.Root></label>
            </Popover.Popup>
        </Popover.Positioner></Popover.Portal>
    </Popover.Root>;
}
